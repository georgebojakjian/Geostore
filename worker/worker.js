/**
 * Geostore payment, delivery and customer-account server — runs free on Cloudflare Workers.
 *
 * What it does
 *  1. Creates an order (a cart of products, styles and digital items) with a UNIQUE amount to pay,
 *     in USDT (TRC20) or Bitcoin, straight to YOUR wallet.
 *  2. Watches the blockchain through free public APIs (TronGrid, mempool.space).
 *  3. When the exact amount arrives the order becomes "paid" and the customer gets a private page
 *     with the full code (and a code from your stock for digital items).
 *  4. Customers can create an account to see their orders, codes, payment history and profile.
 *
 * Needs (set in the Cloudflare dashboard — see DEPLOY-AUTOMATIC.md):
 *   KV binding   ORDERS          (storage)
 *   Secret       ADMIN_TOKEN     (a long password only you know)
 *   Variable     ALLOWED_ORIGIN  (your shop address, e.g. https://myshop.pages.dev) — optional but recommended
 *   Wallet addresses are set in your dashboard (Settings) and sent here with "Sync to server".
 *   Optional fallbacks: WALLET (TRON address), WALLET_BTC (Bitcoin address), TRONGRID_KEY, SESSION_SECRET.
 *   No Cron Trigger is needed.
 */

const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // USDT on TRON (TRC20)
const COINS = {
  usdt_trc20: { name: 'USDT (TRC20)', network: 'TRON (TRC20)', short: 'USDT', minutes: 60, graceMs: 15 * 60000, throttle: 7000 },
  btc:        { name: 'Bitcoin (BTC)', network: 'Bitcoin', short: 'BTC',  minutes: 90, graceMs: 180 * 60000, throttle: 20000 }
};
const PBKDF2_ITER = 10000;   // kept modest so it fits Cloudflare's free CPU limit; raise to 100000 on the paid plan
// Cloudflare's FREE plan allows only 1,000 KV writes and 1,000 KV list calls per day,
// so this server writes ONLY when something really changes (new order, paid, expired, account change)
// and keeps "when did I last look" in memory instead of in storage.
const lastLook = new Map();   // orderId -> time of last blockchain check
const ipHits = new Map();     // ip -> timestamps of recent order requests
const authHits = new Map();   // ip|email -> timestamps of recent sign-in attempts
let rateCache = { t: 0, v: 0 };

/* ---------------- helpers ---------------- */
// Admin + health routes are protected by the secret token, so any origin may call them
// (your dashboard runs from a file on your computer, whose origin is "null").
// Customer routes are limited to ALLOWED_ORIGIN when you set it.
function corsHeaders(env, path) {
  const open = !env.ALLOWED_ORIGIN || path.startsWith('/api/admin/') || path === '/api/health';
  return {
    'access-control-allow-origin': open ? '*' : env.ALLOWED_ORIGIN,
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'vary': 'origin'
  };
}
function json(env, data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
const fail = (env, msg, status) => json(env, { error: msg }, status || 400);
function hex(bytes) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
function randInt(max) { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % max; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function isAdmin(req, env) {
  if (!env.ADMIN_TOKEN) return false;
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') && safeEqual(h.slice(7), env.ADMIN_TOKEN);
}
const round2 = n => Math.round(n * 100) / 100;
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200;
// The shop is stored as ONE small index (names, prices, wallets) plus one key per product holding its
// big code. Orders only read the small index, which keeps every request fast on the free plan.
// Cloudflare's free plan allows only 1,000 KV list() calls a day, so this server NEVER uses list().
// Instead it keeps two tiny index lists (recent order ids, customer emails).
async function pushIndex(env, key, val, max) {
  const arr = (await env.ORDERS.get(key, 'json')) || [];
  if (arr.indexOf(val) < 0) arr.push(val);
  await env.ORDERS.put(key, JSON.stringify(arr.slice(-max)));
}
const getCatalog = env => env.ORDERS.get('idx', 'json');
const saveOrder = (env, o, ttl) => env.ORDERS.put('order:' + o.id, JSON.stringify(o), ttl ? { expirationTtl: ttl } : undefined);
const fmtAmount = (coin, a) => coin === 'btc' ? (a / 1e8).toFixed(8) : (a / 1e6).toFixed(3);
function tooMany(map, key, max, windowMs) {
  const now = Date.now(), hits = (map.get(key) || []).filter(t => now - t < windowMs);
  hits.push(now); map.set(key, hits);
  if (map.size > 800) map.clear();
  return hits.length > max;
}
function walletFor(env, cat, coin) {
  const w = (cat && cat.wallets && cat.wallets[coin]) || (coin === 'btc' ? env.WALLET_BTC : env.WALLET) || '';
  return String(w).trim();
}

/* ---------------- orders: shape helpers ---------------- */
// Orders made before carts existed have `item` instead of `items`; treat them the same.
function itemsOf(o) {
  if (Array.isArray(o.items) && o.items.length) return o.items;
  return [{ id: o.item, title: o.title, mode: 'all', type: o.item === 'ALL' ? 'all' : 'code' }];
}
const orderTitle = o => itemsOf(o).map(i => i.title).join(', ');
function orderCoin(o) { return o.coin || 'usdt_trc20'; }
function publicOrder(env, o, apiBase) {
  const coin = orderCoin(o), c = COINS[coin];
  return {
    id: o.id, status: o.status, title: orderTitle(o), items: itemsOf(o).map(i => ({ title: i.title, price: i.price, mode: i.mode, styles: i.styles })),
    usd: o.usd, coin, coinName: c.name, amount: fmtAmount(coin, o.amount), wallet: o.wallet || env.WALLET || '',
    network: c.network, expiresAt: o.expiresAt, createdAt: o.createdAt, paidAt: o.paidAt || null, txid: o.txid || null,
    deliveryUrl: o.status === 'paid' ? apiBase + '/api/delivery/' + o.id + '?k=' + o.key : null
  };
}

/* ---------------- pricing (the server decides every price) ---------------- */
function stylePriceOf(p) { const s = Number(p.stylePrice); return s > 0 ? s : Math.max(1, Math.ceil(Number(p.price) / 2)); }
function priceCart(cat, raw) {
  const byProd = {}; let hasAll = false;
  for (const it of raw.slice(0, 30)) {
    const id = String((it && it.id) || '');
    if (id === 'ALL') {
      if (!cat.allAccess || !cat.allAccess.enabled) return { error: 'All-Access is not available' };
      hasAll = true; continue;
    }
    const p = cat.products && cat.products[id];
    if (!p || p.published === false) return { error: 'One of the items is not available any more' };
    const g = byProd[id] || (byProd[id] = { p, all: false, styles: new Set() });
    if (p.type === 'digital') { g.all = true; continue; }
    if (it.v === undefined || it.v === null || it.v === 'all') g.all = true;
    else {
      const n = Number(it.v);
      if (!Number.isInteger(n) || n < 0 || n >= (p.variants || []).length) return { error: 'Unknown style' };
      g.styles.add(n);
    }
  }
  const lines = [];
  if (hasAll) lines.push({ id: 'ALL', title: cat.allAccess.title || 'All-Access Pass', type: 'all', mode: 'all', price: Number(cat.allAccess.price) });
  for (const id of Object.keys(byProd)) {
    const g = byProd[id], p = g.p;
    if (p.type === 'digital') { lines.push({ id, title: p.title, type: 'digital', mode: 'all', price: Number(p.price) }); continue; }
    if (hasAll) continue;                                  // already included in All-Access
    const n = (p.variants || []).length, sp = stylePriceOf(p);
    if (n < 2 || g.all || g.styles.size >= n || g.styles.size * sp >= p.price) lines.push({ id, title: p.title, type: 'code', mode: 'all', price: Number(p.price) });
    else {
      const styles = [...g.styles].sort((a, b) => a - b);
      lines.push({ id, title: p.title + ' — ' + styles.map(i => p.variants[i]).join(', '), type: 'code', mode: 'styles', styles, price: round2(styles.length * sp) });
    }
  }
  if (!lines.length) return { error: 'Your cart is empty' };
  const usd = round2(lines.reduce((a, l) => a + l.price, 0));
  if (!(usd > 0)) return { error: 'This order has no price' };
  return { lines, usd };
}

async function btcRate() {
  if (Date.now() - rateCache.t < 60000 && rateCache.v) return rateCache.v;
  const tries = [
    ['https://mempool.space/api/v1/prices', j => j.USD],
    ['https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd', j => j.bitcoin && j.bitcoin.usd]
  ];
  for (const [u, pick] of tries) {
    try { const r = await fetch(u); if (r.ok) { const v = Number(pick(await r.json())); if (v > 0) { rateCache = { t: Date.now(), v }; return v; } } } catch (e) { /* try next */ }
  }
  return 0;
}

/* ---------------- customer accounts ---------------- */
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function pbkdf2(pw, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/../g), h => parseInt(h, 16));
  return b64u(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
async function sign(env, data) {
  const secret = env.SESSION_SECRET || env.ADMIN_TOKEN;
  if (!secret) throw new Error('no secret');
  const key = await crypto.subtle.importKey('raw', enc.encode('geostore-session:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
async function makeToken(env, acct) {
  const body = b64u(enc.encode(JSON.stringify({ e: acct.email, exp: Date.now() + 30 * 86400000, v: acct.hash.slice(0, 8) })));
  return 'c.' + body + '.' + await sign(env, body);
}
async function authCustomer(req, env) {
  const h = req.headers.get('authorization') || '';
  if (!h.startsWith('Bearer c.')) return null;
  const [, body, sig] = h.slice(7).split('.');
  if (!body || !sig || !safeEqual(sig, await sign(env, body))) return null;
  let p; try { p = JSON.parse(new TextDecoder().decode(unb64u(body))); } catch (e) { return null; }
  if (!p || p.exp < Date.now()) return null;
  const acct = await env.ORDERS.get('acct:' + p.e, 'json');
  return acct && !acct.disabled && acct.hash.slice(0, 8) === p.v ? acct : null;
}
const profileOf = a => ({ email: a.email, name: a.name || '', phone: a.phone || '', country: a.country || '', createdAt: a.createdAt, orders: (a.orders || []).length });

async function accountRoutes(req, env, path, apiBase) {
  const ip = req.headers.get('cf-connecting-ip') || 'x';
  const body = req.method === 'POST' ? (await req.json().catch(() => null) || {}) : {};
  if (path === '/api/account/register' && req.method === 'POST') {
    if (tooMany(authHits, 'reg|' + ip, 5, 10 * 60000)) return fail(env, 'Too many attempts. Please wait a few minutes.', 429);
    const email = String(body.email || '').trim().toLowerCase(), pw = String(body.password || '');
    if (!validEmail(email)) return fail(env, 'Please enter a valid email address');
    if (pw.length < 8 || pw.length > 200) return fail(env, 'Password must be at least 8 characters');
    if (await env.ORDERS.get('acct:' + email)) return fail(env, 'An account with this email already exists. Please sign in.', 409);
    const salt = hex(16), acct = { email, name: String(body.name || '').trim().slice(0, 80), phone: '', country: '', salt, iter: PBKDF2_ITER, hash: await pbkdf2(pw, salt, PBKDF2_ITER), createdAt: Date.now(), orders: [] };
    await env.ORDERS.put('acct:' + email, JSON.stringify(acct));
    await pushIndex(env, 'cidx', email, 2000);
    return json(env, { token: await makeToken(env, acct), profile: profileOf(acct) });
  }
  if (path === '/api/account/login' && req.method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase();
    if (tooMany(authHits, 'log|' + ip + '|' + email, 8, 10 * 60000)) return fail(env, 'Too many attempts. Please wait a few minutes.', 429);
    const acct = validEmail(email) ? await env.ORDERS.get('acct:' + email, 'json') : null;
    const h = acct ? await pbkdf2(String(body.password || ''), acct.salt, acct.iter || PBKDF2_ITER) : '';
    if (!acct || !safeEqual(h, acct.hash)) return fail(env, 'Wrong email or password', 401);
    if (acct.disabled) return fail(env, 'This account has been disabled. Please contact us.', 403);
    return json(env, { token: await makeToken(env, acct), profile: profileOf(acct) });
  }
  const acct = await authCustomer(req, env);
  if (!acct) return fail(env, 'Please sign in again', 401);
  if (path === '/api/account/me' && req.method === 'GET') {
    const ids = (acct.orders || []).slice(-50).reverse();
    let found = (await Promise.all(ids.map(id => env.ORDERS.get('order:' + id, 'json')))).filter(Boolean);
    found = await Promise.all(found.map((o, i) => o.status === 'pending' && i < 5 ? checkOrder(env, o) : o));   // detect payments when the customer comes back
    const orders = found.map(o => publicOrder(env, o, apiBase));
    const spent = round2(orders.filter(o => o.status === 'paid').reduce((a, o) => a + (Number(o.usd) || 0), 0));
    return json(env, { profile: profileOf(acct), orders, spent });
  }
  if (path === '/api/account/update' && req.method === 'POST') {
    acct.name = String(body.name || '').trim().slice(0, 80); acct.phone = String(body.phone || '').trim().slice(0, 40); acct.country = String(body.country || '').trim().slice(0, 60);
    await env.ORDERS.put('acct:' + acct.email, JSON.stringify(acct));
    return json(env, { profile: profileOf(acct) });
  }
  if (path === '/api/account/password' && req.method === 'POST') {
    if (tooMany(authHits, 'pw|' + ip, 8, 10 * 60000)) return fail(env, 'Too many attempts. Please wait a few minutes.', 429);
    const np = String(body.newPassword || '');
    if (!safeEqual(await pbkdf2(String(body.oldPassword || ''), acct.salt, acct.iter || PBKDF2_ITER), acct.hash)) return fail(env, 'Your current password is wrong', 401);
    if (np.length < 8 || np.length > 200) return fail(env, 'New password must be at least 8 characters');
    acct.salt = hex(16); acct.iter = PBKDF2_ITER; acct.hash = await pbkdf2(np, acct.salt, PBKDF2_ITER);
    await env.ORDERS.put('acct:' + acct.email, JSON.stringify(acct));
    return json(env, { token: await makeToken(env, acct), profile: profileOf(acct) });
  }
  return fail(env, 'Not found', 404);
}

/* ---------------- create order ---------------- */
async function createOrder(req, env, apiBase) {
  if (tooMany(ipHits, req.headers.get('cf-connecting-ip') || 'x', 6, 10 * 60000)) return fail(env, 'Too many orders from your connection. Please wait a few minutes.', 429);
  const b = await req.json().catch(() => null) || {};
  const cat = await getCatalog(env);
  if (!cat) return fail(env, 'The store has not been synced yet', 503);

  const acct = await authCustomer(req, env);                  // optional: logged-in customers get the order saved to their account
  const email = acct ? acct.email : String(b.email || '').trim().toLowerCase();
  if (!validEmail(email)) return fail(env, 'Please enter a valid email address');

  const coin = COINS[b.coin] ? b.coin : 'usdt_trc20', C = COINS[coin];
  const wallet = walletFor(env, cat, coin);
  if (!wallet) return fail(env, C.name + ' payments are not set up yet. Please choose another coin.', 503);

  const raw = Array.isArray(b.items) ? b.items : (b.item ? [{ id: b.item, v: 'all' }] : []);
  const priced = priceCart(cat, raw);
  if (priced.error) return fail(env, priced.error);
  for (const l of priced.lines) {                              // digital items: refuse when stock is gone
    if (l.type !== 'digital') continue;
    const p = cat.products[l.id], used = Number(await env.ORDERS.get('used:' + l.id)) || 0;
    if (used >= (p.stockN || 0)) return fail(env, 'Sorry, "' + p.title + '" is out of stock right now.', 409);
  }

  // amount in the coin's smallest unit, plus a tiny unique offset so every open order is identifiable on-chain
  let base;
  if (coin === 'btc') {
    const rate = await btcRate();
    if (!rate) return fail(env, 'Could not get the Bitcoin price right now. Please try USDT or try again in a minute.', 503);
    base = Math.round(priced.usd / rate * 1e8);
  } else base = Math.round(priced.usd * 1e6);
  let amount = null, amtKey = null;
  for (let i = 0; i < 40 && amount === null; i++) {
    const cand = coin === 'btc' ? base + 1 + randInt(99) : base + (1 + randInt(99)) * 1000, key = 'amt:' + coin + ':' + cand;
    if (!(await env.ORDERS.get(key))) { amount = cand; amtKey = key; }
  }
  if (amount === null) return fail(env, 'Too many open orders, please try again in a minute', 503);

  const now = Date.now();
  const o = { id: hex(16), key: hex(16), email, items: priced.lines, usd: priced.usd, coin, amount, amtKey, wallet, status: 'pending', createdAt: now, expiresAt: now + C.minutes * 60000, account: acct ? acct.email : null };
  await saveOrder(env, o, 7 * 86400);
  // the "amt:" key both reserves the amount AND is the list of open orders the cron job checks
  await env.ORDERS.put(amtKey, o.id, { expirationTtl: (C.minutes + C.graceMs / 60000 + 5) * 60 });
  await pushIndex(env, 'oidx', o.id, 400);
  if (acct) { acct.orders = (acct.orders || []).concat(o.id).slice(-200); await env.ORDERS.put('acct:' + acct.email, JSON.stringify(acct)); }
  return json(env, publicOrder(env, o, apiBase));
}

/* ---------------- check the blockchain ---------------- */
async function markPaid(env, o, txid) {
  o.status = 'paid'; o.paidAt = Date.now(); o.txid = txid || 'manual';
  const dig = itemsOf(o).filter(i => i.type === 'digital');
  if (dig.length) {
    // digital items (gift cards, keys...): hand out the next unused code from your stock
    const cat = await getCatalog(env); o.codes = {};
    for (const l of dig) {
      const p = cat && cat.products && cat.products[l.id]; if (!p) continue;
      const stock = await env.ORDERS.get('stock:' + l.id, 'json') || [];
      const used = Number(await env.ORDERS.get('used:' + l.id)) || 0, code = stock[used];
      if (code) { o.codes[l.id] = code; await env.ORDERS.put('used:' + l.id, String(used + 1)); }
    }
  }
  await saveOrder(env, o);
  if (txid) await env.ORDERS.put('tx:' + txid, o.id);
  await env.ORDERS.delete(o.amtKey || ('amt:' + o.amount));
}
async function findPayment(env, o) {
  const coin = orderCoin(o), until = o.expiresAt + COINS[coin].graceMs;
  if (coin === 'btc') {
    const res = await fetch('https://mempool.space/api/address/' + o.wallet + '/txs');
    if (!res.ok) return null;
    for (const t of await res.json()) {
      if (!t.status || !t.status.confirmed) continue;
      const bt = t.status.block_time * 1000;
      if (bt < o.createdAt - 120000 || bt > until) continue;
      if (t.vout.some(v => v.scriptpubkey_address === o.wallet && v.value === o.amount) && !(await env.ORDERS.get('tx:' + t.txid))) return t.txid;
    }
    return null;
  }
  const url = 'https://api.trongrid.io/v1/accounts/' + o.wallet + '/transactions/trc20' +
    '?only_confirmed=true&only_to=true&limit=200&contract_address=' + USDT_CONTRACT + '&min_timestamp=' + o.createdAt;
  const res = await fetch(url, { headers: env.TRONGRID_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_KEY } : {} });
  if (!res.ok) return null;
  for (const t of (await res.json()).data || []) {
    const ok = t.to === o.wallet && t.type === 'Transfer' && t.token_info && t.token_info.address === USDT_CONTRACT &&
      String(t.value) === String(o.amount) && t.block_timestamp >= o.createdAt && t.block_timestamp <= o.expiresAt;
    if (ok && !(await env.ORDERS.get('tx:' + t.transaction_id))) return t.transaction_id;
  }
  return null;
}
async function checkOrder(env, o) {
  if (o.status !== 'pending') return o;
  const coin = orderCoin(o), C = COINS[coin], now = Date.now();
  if (now > o.expiresAt + C.graceMs) {
    o.status = 'expired'; await saveOrder(env, o);
    await env.ORDERS.delete(o.amtKey || ('amt:' + o.amount));
    return o;
  }
  if (now - (lastLook.get(o.id) || 0) < C.throttle) return o;   // memory only: no storage write
  lastLook.set(o.id, now);
  if (lastLook.size > 1000) lastLook.clear();
  let txid = null;
  try { txid = await findPayment(env, o); } catch (e) { /* network hiccup: try again next time */ }
  if (txid) await markPaid(env, o, txid);
  return o;                                                    // still waiting: nothing to save
}

/* ---------------- delivery page ---------------- */
// The server sends a tiny page plus the data as JSON; the customer's browser draws the previews and code.
// (This keeps the server fast even when someone buys every product.)
const J = JSON.stringify;
async function deliveryData(env, o, cat) {
  const prods = cat.products || {}, parts = [], jobs = [];
  const head = (id, p) => '{"id":' + J(id) + ',"title":' + J(p.title) + ',"tagline":' + J(p.tagline || '') + ',';
  async function code(id, styles) {
    const p = prods[id]; if (!p) return null;
    const txt = await env.ORDERS.get('prod:' + id, 'text'); if (!txt) return null;
    if (!styles) return head(id, p) + txt.slice(1);              // whole product: no parsing needed
    const d = JSON.parse(txt); d.variants = styles.map(i => d.variants[i]).filter(Boolean);
    return d.variants.length ? head(id, p) + J(d).slice(1) : null;
  }
  for (const l of itemsOf(o)) {
    if (l.id === 'ALL') { Object.keys(prods).forEach(id => { const p = prods[id]; if (p.type !== 'digital' && (p.variants || []).length) jobs.push(code(id)); }); continue; }
    const p = prods[l.id]; if (!p) continue;
    if (p.type === 'digital') {
      const c = o.codes && !Array.isArray(o.codes) ? o.codes[l.id] : (Array.isArray(o.codes) ? o.codes[0] : '');
      jobs.push(Promise.resolve(head(l.id, p) + '"code":' + J(c || '') + '}'));
    } else jobs.push(code(l.id, l.mode === 'styles' && Array.isArray(l.styles) ? l.styles : null));
  }
  (await Promise.all(jobs)).forEach(x => { if (x) parts.push(x); });
  return '{"order":' + J({ id: o.id.slice(0, 8), email: o.email }) + ',"store":' + J(cat.storeName || '') + ',"sections":[' + parts.join(',') + ']}';
}
const SHELL_CORE = String.raw`
function guardFn(){var t;function note(m){var n=document.getElementById("__dm");if(!n){n=document.createElement("div");n.id="__dm";n.style.cssText="position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;background:#111;color:#fff;border:1px solid #c5f442;padding:10px 16px;border-radius:99px;font:600 13px system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:92vw;text-align:center;opacity:0;transition:opacity .2s;pointer-events:none";document.body.appendChild(n)}n.textContent=m;n.style.opacity=1;clearTimeout(t);t=setTimeout(function(){n.style.opacity=0},2800)}
document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");if(!a)return;var h=a.getAttribute("href")||"";if(h.length>1&&h.charAt(0)==="#"){e.preventDefault();var el=document.getElementById(h.slice(1));if(el)el.scrollIntoView({behavior:"smooth"});else note("Demo: this link has no page in the preview");return}e.preventDefault();note(h==="#"||h===""?"Demo link — in your real site this goes to your own page":"Demo: this link goes to another page ("+h.slice(0,40)+") that you add in your real site")},true);
document.addEventListener("submit",function(e){if(!e.defaultPrevented){e.preventDefault();note("Demo form — connect it to your email or server in your real site")}});
window.open=function(u){note("Demo: this would open "+String(u||"a new page").slice(0,50)+" in your real site");return null}}
function guard(html){html=String(html||"");var g="<script>("+guardFn.toString()+")()<\/script>",i=html.lastIndexOf("</body>");return i<0?html+g:html.slice(0,i)+g+html.slice(i)}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function cp(btn,text,label){btn.onclick=function(){function d(){btn.textContent="Copied!";setTimeout(function(){btn.textContent=label},1500)}if(navigator.clipboard){navigator.clipboard.writeText(text).then(d,d)}else{d()}}}
window.__render=function(d,app){
  app.innerHTML="";
  var h=el("h1");h.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="34" height="34" style="vertical-align:middle;margin-right:10px"><rect width="32" height="32" rx="9" fill="#c5f442"/><path d="M16 6.2l8.6 4.9-8.6 4.9-8.6-4.9z" fill="#0a1000"/><path d="M7.4 12.9l8.6 4.9v8.6l-8.6-4.9z" fill="#0a1000" fill-opacity=".72"/><path d="M24.6 12.9l-8.6 4.9v8.6l8.6-4.9z" fill="#0a1000" fill-opacity=".42"/></svg>';
  h.appendChild(document.createTextNode("Thank you! 🎉"));app.appendChild(h);
  app.appendChild(el("p","d","Order "+d.order.id+" · "+d.order.email+". Every code has a live preview and a Copy button. Use the button below to keep a copy of everything on your computer."));
  var dl=el("button","",window.__standalone?"This page is your saved copy":"⬇ Download all my codes as one file");dl.style.marginTop="8px";
  if(window.__standalone)dl.disabled=true;else dl.onclick=function(){window.__download(d)};app.appendChild(dl);
  var n=0;
  d.sections.forEach(function(s){
    var sec=el("section");sec.appendChild(el("h2","",s.title));sec.appendChild(el("p","d",s.tagline||""));
    if(s.code!==undefined){
      var i=n++,bar=el("div","bar");bar.appendChild(el("b","",s.code?"Your code":"Your code is being prepared — please contact us with your order ID "+d.order.id));
      if(s.code){var b=el("button","","Copy");cp(b,s.code,"Copy");bar.appendChild(b);var pre=el("pre","",s.code);pre.style.fontSize="1.05rem";sec.appendChild(bar);sec.appendChild(pre)}else sec.appendChild(bar);
    }else{
      if(s.guide){var det=el("details","gd");det.open=true;det.appendChild(el("summary","","How to use & connect your data"));var gb=el("div","gb");gb.innerHTML=s.guide;det.appendChild(gb);sec.appendChild(det)}
      (s.variants||[]).forEach(function(v){
        var h3=el("h3","",v.name);h3.style.cssText="margin:22px 0 4px;font-size:1.05rem";sec.appendChild(h3);
        var f=document.createElement("iframe");f.setAttribute("sandbox","allow-scripts allow-forms");f.title="Preview";f.srcdoc=guard(v.full);sec.appendChild(f);
        var bar=el("div","bar");bar.appendChild(el("b","","Full code"));var b=el("button","","Copy code");cp(b,v.full,"Copy code");bar.appendChild(b);sec.appendChild(bar);sec.appendChild(el("pre","",v.full));
      });
    }
    app.appendChild(sec);
  });
  app.appendChild(el("p","d","Licence: use these codes in your own and your clients' projects. Do not resell or share the code files themselves.")).style.marginTop="40px";
};
window.__download=function(d){
  var css=document.getElementById("css").textContent,core=document.getElementById("core").textContent;
  var html='<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My codes</title><style id="css">'+css+'</style></head><body><div class="w" id="app"></div><script id="core" type="text/plain">'+core.replace(/<\/script/g,"<\\/script")+'<\/script><script>window.__standalone=true;var DATA='+JSON.stringify(d).replace(/</g,"\\u003c")+';new Function(document.getElementById("core").textContent)();window.__render(DATA,document.getElementById("app"))<\/script></body></html>';
  var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([html],{type:"text/html"}));a.download="my-codes.html";document.body.appendChild(a);a.click();a.remove();
};
`;
const SHELL_CSS = 'body{margin:0;font-family:system-ui,sans-serif;background:#0b0f1a;color:#f8fafc;line-height:1.6}.w{max-width:960px;margin:auto;padding:30px 18px 80px}h1{margin-bottom:4px}.d{color:#94a3b8}' +
  'section{margin-top:36px;padding:22px;border:1px solid #243049;border-radius:16px;background:#111827}iframe{width:100%;height:380px;border:1px solid #243049;border-radius:12px;background:#0b0f1a;margin:10px 0}' +
  '.bar{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:8px 0}button{background:#c5f442;color:#0a1000;border:0;padding:9px 18px;border-radius:10px;font-weight:600;cursor:pointer}button:disabled{opacity:.5}' +
  'pre{max-height:360px;overflow:auto;background:#070a12;border:1px solid #243049;border-radius:12px;padding:14px;font-size:.78rem;color:#c7d2fe}' +
  '.gd{margin:14px 0;border:1px solid #2f3b55;border-radius:12px;background:#0d1424}.gd summary{cursor:pointer;padding:12px 16px;font-weight:700;color:#c5f442}.gb{padding:4px 18px 16px;color:#cbd5e1;font-size:.93rem}.gb h4{margin:16px 0 4px;color:#f8fafc}.gb code{background:#1b2640;padding:1px 6px;border-radius:5px;font-size:.85em}.gb ul,.gb ol{margin:6px 0 6px 20px}';
function shellPage(storeName) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your codes — ' + esc(storeName) + '</title><style id="css">' + SHELL_CSS + '</style></head><body><div class="w" id="app"><p class="d">Loading your codes…</p></div>' +
    '<script id="core" type="text/plain">' + SHELL_CORE.replace(/<\/script/g, '<\\/script') + '<\/script>' +
    '<script>fetch(location.pathname+"/data"+location.search).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){new Function(document.getElementById("core").textContent)();window.__render(d,document.getElementById("app"))}).catch(function(){document.getElementById("app").textContent="Could not load your codes. Please refresh the page or contact us with your order ID."})<\/script></body></html>';
}
async function delivery(env, id, url, wantData) {
  const o = await env.ORDERS.get('order:' + id, 'json');
  const k = url.searchParams.get('k') || '';
  if (!o || !safeEqual(k, o.key)) return new Response('Not found', { status: 404 });
  if (o.status !== 'paid') return new Response('This order has not been paid yet.', { status: 402 });
  const cat = await getCatalog(env) || { products: {} };
  if (wantData) return new Response(await deliveryData(env, o, cat), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  return new Response(shellPage(cat.storeName || ''), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

/* ---------------- admin ---------------- */
// The dashboard uploads each product on its own (small requests), then the small index.
async function adminProduct(req, env) {
  const p = await req.json().catch(() => null);
  if (!p || !p.id) return fail(env, 'Bad data');
  const id = String(p.id);
  const variants = (Array.isArray(p.variants) ? p.variants : []).map(v => ({ name: String(v.name || ''), full: String(v.full || '') })).filter(v => v.full);
  await env.ORDERS.put('prod:' + id, J({ guide: String(p.guide || '').slice(0, 30000), variants }));
  if (p.type === 'digital') await env.ORDERS.put('stock:' + id, J((Array.isArray(p.stock) ? p.stock : []).map(String).filter(Boolean)));
  return json(env, { ok: true, id });
}
async function adminIndex(req, env) {
  const b = await req.json().catch(() => null);
  if (!b || !Array.isArray(b.products)) return fail(env, 'Bad data');
  const products = {};
  b.products.forEach(p => {
    if (!p || !p.id) return;
    products[String(p.id)] = {
      title: String(p.title || ''), tagline: String(p.tagline || ''), price: Number(p.price) || 0, stylePrice: Number(p.stylePrice) || 0,
      type: p.type === 'digital' ? 'digital' : 'code', variants: (Array.isArray(p.variants) ? p.variants : []).map(String),
      stockN: Number(p.stockN) || 0, published: p.published !== false
    };
  });
  for (const id of (Array.isArray(b.remove) ? b.remove : []).slice(0, 100)) { await env.ORDERS.delete('prod:' + id); await env.ORDERS.delete('stock:' + id); }
  const aa = b.allAccess || {}, w = b.wallets || {};
  await env.ORDERS.put('idx', J({
    storeName: String(b.storeName || ''), products,
    wallets: { usdt_trc20: String(w.usdt_trc20 || '').trim().slice(0, 120), btc: String(w.btc || '').trim().slice(0, 120) },
    allAccess: { enabled: !!aa.enabled, title: String(aa.title || 'All-Access Pass'), price: Number(aa.price) || 0 }
  }));
  return json(env, { ok: true, products: Object.keys(products).length });
}
async function adminOrders(env) {
  const ids = ((await env.ORDERS.get('oidx', 'json')) || []).slice(-100).reverse();
  let list = (await Promise.all(ids.map(id => env.ORDERS.get('order:' + id, 'json')))).filter(Boolean);
  list = await Promise.all(list.map((o, i) => o.status === 'pending' && i < 8 ? checkOrder(env, o) : o));   // refresh waiting orders
  const orders = list.map(o => ({ id: o.id, email: o.email, title: orderTitle(o), item: o.item || '', amount: fmtAmount(orderCoin(o), o.amount), coin: COINS[orderCoin(o)].short, usd: o.usd || null, status: o.status, createdAt: o.createdAt, paidAt: o.paidAt || null, txid: o.txid || null, key: o.key, account: o.account || null }));
  return json(env, { orders });
}
async function adminCustomers(env, url) {
  const all = ((await env.ORDERS.get('cidx', 'json')) || []).slice().reverse();
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const customers = (await Promise.all(all.slice(offset, offset + 100).map(e => env.ORDERS.get('acct:' + e, 'json')))).filter(Boolean)
    .map(a => ({ email: a.email, name: a.name || '', phone: a.phone || '', country: a.country || '', createdAt: a.createdAt, orders: (a.orders || []).length, disabled: !!a.disabled }));
  return json(env, { customers, total: all.length, next: offset + 100 < all.length ? offset + 100 : null });
}
async function adminCustomer(req, env, url, apiBase) {
  const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
  const acct = email && await env.ORDERS.get('acct:' + email, 'json');
  if (!acct) return fail(env, 'Customer not found', 404);
  let found = (await Promise.all((acct.orders || []).slice(-100).reverse().map(id => env.ORDERS.get('order:' + id, 'json')))).filter(Boolean);
  found = await Promise.all(found.map((o, i) => o.status === 'pending' && i < 5 ? checkOrder(env, o) : o));
  const orders = found.map(o => publicOrder(env, o, apiBase));
  return json(env, { profile: Object.assign(profileOf(acct), { disabled: !!acct.disabled, note: acct.note || '' }), orders, spent: round2(orders.filter(o => o.status === 'paid').reduce((a, o) => a + (Number(o.usd) || 0), 0)) });
}
// one endpoint for everything you can do to a customer account
async function adminCustomerAct(req, env) {
  const b = await req.json().catch(() => ({}));
  const email = String(b.email || '').trim().toLowerCase(), key = 'acct:' + email;
  const acct = email && await env.ORDERS.get(key, 'json');
  if (!acct) return fail(env, 'Customer not found', 404);
  const act = String(b.action || '');
  if (act === 'disable' || act === 'enable') { acct.disabled = act === 'disable'; await env.ORDERS.put(key, J(acct)); }
  else if (act === 'profile') {
    acct.name = String(b.name || '').trim().slice(0, 80); acct.phone = String(b.phone || '').trim().slice(0, 40);
    acct.country = String(b.country || '').trim().slice(0, 60); acct.note = String(b.note || '').slice(0, 1000);
    await env.ORDERS.put(key, J(acct));
  } else if (act === 'setpassword') {
    const pw = String(b.password || '');
    if (pw.length < 8 || pw.length > 200) return fail(env, 'Password must be at least 8 characters');
    acct.salt = hex(16); acct.iter = PBKDF2_ITER; acct.hash = await pbkdf2(pw, acct.salt, PBKDF2_ITER);   // old sessions stop working
    await env.ORDERS.put(key, J(acct));
  } else if (act === 'delete') {
    await env.ORDERS.delete(key);
    const idx = ((await env.ORDERS.get('cidx', 'json')) || []).filter(e => e !== email);
    await env.ORDERS.put('cidx', J(idx));
  } else return fail(env, 'Unknown action');
  return json(env, { ok: true });
}

/* ---------------- router ---------------- */
async function route(req, env) {
  const url = new URL(req.url);
  const apiBase = url.origin;
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (path === '/api/health') {
      let wallet = !!(env.WALLET || env.WALLET_BTC);
      if (env.ORDERS && !wallet) { try { const c = await getCatalog(env); wallet = !!(c && c.wallets && (c.wallets.usdt_trc20 || c.wallets.btc)); } catch (e) { /* ignore */ } }
      return json(env, { ok: true, wallet, admin: !!env.ADMIN_TOKEN, kv: !!env.ORDERS, version: 5 });
    }
    if (!env.ORDERS) return fail(env, 'Storage (KV binding named ORDERS) is not connected', 503);
    if (path === '/api/config' && req.method === 'GET') {
      const cat = await getCatalog(env);
      return json(env, { storeName: cat ? cat.storeName : '', accounts: !!(env.ADMIN_TOKEN || env.SESSION_SECRET),
        coins: Object.keys(COINS).filter(c => walletFor(env, cat, c)).map(c => ({ id: c, name: COINS[c].name, network: COINS[c].network })) });
    }
    if (path === '/api/order' && req.method === 'POST') return await createOrder(req, env, apiBase);
    let m = path.match(/^\/api\/order\/([a-f0-9]{32})$/);
    if (m && req.method === 'GET') {
      let o = await env.ORDERS.get('order:' + m[1], 'json');
      if (!o) return fail(env, 'Order not found', 404);
      o = await checkOrder(env, o);
      return json(env, publicOrder(env, o, apiBase));
    }
    m = path.match(/^\/api\/delivery\/([a-f0-9]{32})(\/data)?$/);
    if (m && req.method === 'GET') return await delivery(env, m[1], url, !!m[2]);
    if (path.startsWith('/api/account/')) return await accountRoutes(req, env, path, apiBase);
    if (path.startsWith('/api/admin/')) {
      if (!isAdmin(req, env)) return fail(env, 'Wrong or missing admin token', 401);
      if (path === '/api/admin/product' && req.method === 'POST') return await adminProduct(req, env);
      if (path === '/api/admin/index' && req.method === 'POST') return await adminIndex(req, env);
      if (path === '/api/admin/ping') return json(env, { ok: true });
      if (path === '/api/admin/orders' && req.method === 'GET') return await adminOrders(env);
      if (path === '/api/admin/customers' && req.method === 'GET') return await adminCustomers(env, url);
      if (path === '/api/admin/customer' && req.method === 'GET') return await adminCustomer(req, env, url, apiBase);
      if (path === '/api/admin/customer' && req.method === 'POST') return await adminCustomerAct(req, env);
      if (path === '/api/admin/markpaid' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const o = await env.ORDERS.get('order:' + String(b.id || ''), 'json');
        if (!o) return fail(env, 'Order not found', 404);
        if (o.status !== 'paid') await markPaid(env, o, null);
        return json(env, { ok: true });
      }
    }
    return fail(env, 'Not found', 404);
  } catch (e) {
    // admin calls get the real reason (only you can reach them); customers get a short message
    const msg = String((e && e.message) || e);
    if (/limit exceeded|too many requests|429/i.test(msg)) return fail(env, path.startsWith('/api/admin/') ? 'Server error: ' + msg : 'The shop is very busy right now. Please try again in a little while.', 503);
    return fail(env, path.startsWith('/api/admin/') ? 'Server error: ' + msg : 'Server error', 500);
  }
}

export default {
  async fetch(req, env) {
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env, path) });
    const res = await route(req, env);
    const h = new Headers(res.headers);
    const c = corsHeaders(env, path);
    Object.keys(c).forEach(k => h.set(k, c[k]));
    return new Response(res.body, { status: res.status, headers: h });
  },
  // A Cron Trigger is NOT needed any more (it only wasted free daily limits). If you still have one in Cloudflare,
  // this does nothing and costs nothing. Payments are detected when the customer's page, their account or your
  // Orders screen looks at the order.
  async scheduled() { /* intentionally empty */ }
};
