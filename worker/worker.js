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
  usdt_bep20: { name: 'USDT (BEP20)', network: 'BNB Smart Chain (BEP20)', short: 'USDT', minutes: 60, graceMs: 15 * 60000, throttle: 8000, kind: 'bsc' },
  btc:        { name: 'Bitcoin (BTC)', network: 'Bitcoin', short: 'BTC',  minutes: 90, graceMs: 180 * 60000, throttle: 20000 },
  // Binance Pay cannot be watched automatically without handing over a Binance API key, so the customer presses
  // "I have paid" and you confirm it with Mark paid (delivery is automatic after that).
  binancepay: { name: 'Binance Pay', network: 'Binance Pay (inside the Binance app)', short: 'USDT', minutes: 120, graceMs: 24 * 3600000, throttle: 0, kind: 'manual' }
};
const BSC_USDT = '0x55d398326f99059ff775485246999027b3197955';          // USDT on BNB Smart Chain (18 decimals)
const BSC_RPCS = ['https://bsc-rpc.publicnode.com', 'https://bsc.drpc.org', 'https://1rpc.io/bnb', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.binance.org', 'https://bsc-dataseed.binance.org'];   // several free nodes: some refuse log searches or rate-limit
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
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
  // Always '*': customers sign in with a token header (no cookies), so a wrong ALLOWED_ORIGIN value
  // could only break sign-up ("Failed to fetch") without adding real protection.
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
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
// the visitor's address: when the shop forwards requests through its own web address (Netlify), the real address arrives in this header
const ipOf = req => req.headers.get('x-nf-client-connection-ip') || req.headers.get('cf-connecting-ip') || 'x';
let cfgMem = { t: 0, v: null };
const PUB_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=15', 'netlify-cdn-cache-control': 'public, max-age=30, stale-while-revalidate=120', 'access-control-allow-origin': '*' };
let catMem = { t: 0, v: null };                       // the catalogue can be large: keep it in memory for a few seconds instead of re-reading it for every request
const getCatalog = async env => { if (catMem.v && Date.now() - catMem.t < 8000) return catMem.v; const v = await env.ORDERS.get('idx', 'json'); catMem = { t: Date.now(), v }; return v; };
const saveOrder = (env, o, ttl) => env.ORDERS.put('order:' + o.id, JSON.stringify(o), ttl ? { expirationTtl: ttl } : undefined);
const fmtAmount = (coin, a) => coin === 'btc' ? (a / 1e8).toFixed(8) : (a % 10000 === 0 ? (a / 1e6).toFixed(2) : (a / 1e6).toFixed(3));  // new orders are whole cents so any wallet can type them
function tooMany(map, key, max, windowMs) {
  const now = Date.now(), hits = (map.get(key) || []).filter(t => now - t < windowMs);
  hits.push(now); map.set(key, hits);
  if (map.size > 800) map.clear();
  return hits.length > max;
}
function walletFor(env, cat, coin) {
  const w = (cat && cat.wallets && cat.wallets[coin]) || (coin === 'btc' ? env.WALLET_BTC : coin === 'usdt_trc20' ? env.WALLET : '') || '';
  return String(w).trim();
}

/* ---------------- orders: shape helpers ---------------- */
// Orders made before carts existed have `item` instead of `items`; treat them the same.
function itemsOf(o) {
  if (Array.isArray(o.items) && o.items.length) return o.items;
  return [{ id: o.item, title: o.title, mode: 'all', type: o.item === 'ALL' ? 'all' : 'code' }];
}
const qtyOf = i => Math.max(1, Math.min(10, Math.floor(Number(i && i.qty) || 1)));
const orderTitle = o => itemsOf(o).map(i => i.title + (qtyOf(i) > 1 ? ' ×' + qtyOf(i) : '')).join(', ');
function orderCoin(o) { return o.coin || 'usdt_trc20'; }
function publicOrder(env, o, apiBase) {
  const coin = orderCoin(o), c = COINS[coin];
  return {
    id: o.id, status: o.status, title: orderTitle(o), items: itemsOf(o).map(i => ({ title: i.title, price: i.price, qty: qtyOf(i), mode: i.mode, styles: i.styles })), fromBinance: !!o.fromBinance,
    usd: o.usd, coin, coinName: c.name, amount: fmtAmount(coin, o.amount), wallet: o.wallet || env.WALLET || '',
    network: c.network, kind: c.kind || (coin === 'btc' ? 'btc' : 'tron'), claimed: !!o.claimed, expiresAt: o.expiresAt, createdAt: o.createdAt, paidAt: o.paidAt || null, txid: o.txid || null,
    ptsUsed: o.ptsUsed || 0, ptsOff: o.ptsOff || 0, ptsEarned: o.ptsEarned || 0, fulfil: fulfilState(o), deliveryUrl: o.status === 'paid' ? apiBase + '/api/delivery/' + o.id + '?k=' + o.key : null
  };
}

/* ---------------- pricing (the server decides every price) ---------------- */
function stylePriceOf(p) { const s = Number(p.stylePrice); return s > 0 ? s : Math.max(1, Math.ceil(Number(p.price) / 2)); }
function priceCart(cat, raw, gp) {
  gp = gp || {};
  const byProd = {}; let hasAll = false;
  for (const it of raw.slice(0, 30)) {
    const id = String((it && it.id) || '');
    if (id === 'ALL') {
      if (!cat.allAccess || !cat.allAccess.enabled) return { error: 'All-Access is not available' };
      hasAll = true; continue;
    }
    const p = (cat.products && cat.products[id]) || gp[id];
    if (!p || p.published === false) return { error: 'One of the items is not available any more' };
    const g = byProd[id] || (byProd[id] = { p, all: false, styles: new Set() });
    if (p.type === 'digital') { g.all = true; g.q = p.topup ? 1 : Math.min(10, (g.q || 0) + Math.max(1, Math.min(10, Math.floor(Number(it.q) || 1)))); continue; }
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
    if (p.type === 'digital') { const q = g.q || 1; lines.push({ id, title: p.title, type: 'digital', mode: 'all', unit: Number(p.price), qty: q, price: round2(Number(p.price) * q), supplier: p.supplier || undefined, gift: p.gift || undefined, topup: p.topup || undefined, fields: p.fields || undefined }); continue; }
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
    try { const r = await fetch(u, { signal: AbortSignal.timeout(4000) }); if (r.ok) { const v = Number(pick(await r.json())); if (v > 0) { rateCache = { t: Date.now(), v }; return v; } } } catch (e) { /* try next */ }
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
const profileOf = a => ({ email: a.email, name: a.name || '', phone: a.phone || '', country: a.country || '', createdAt: a.createdAt, orders: (a.orders || []).length, points: Math.max(0, Math.floor(Number(a.pts) || 0)) });

/* ---------------- points wallet ----------------
   Settings live in KV "pts:cfg" (saved live from the dashboard, no Sync needed).
   perUsd: points earned per $1 · valueUsd: what 1 point is worth at checkout · minOrder/maxOrder: only orders of at least minOrder earn,
   and only the first maxOrder dollars of an order count · maxPct: biggest share of an order that points can pay for · minRedeem: smallest redeem. */
async function ptsCfg(env) {
  const c = await env.ORDERS.get('pts:cfg', 'json').catch(() => null) || {};
  const n = (v, d, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  return { on: !!c.on, perUsd: n(c.perUsd, 10, 0, 100000), valueUsd: n(c.valueUsd, 0.01, 0, 1000), minOrder: n(c.minOrder, 0, 0, 1e6), maxOrder: n(c.maxOrder, 0, 0, 1e6), maxPct: n(c.maxPct, 50, 0, 100), minRedeem: Math.floor(n(c.minRedeem, 100, 0, 1e9)) };
}
const ptsEarn = (cfg, usd) => { if (!cfg.on || !(usd > 0) || usd < cfg.minOrder) return 0; const base = cfg.maxOrder > 0 ? Math.min(usd, cfg.maxOrder) : usd; return Math.floor(base * cfg.perUsd); };
function ptsAdd(acct, d, why) {
  acct.pts = Math.max(0, Math.floor(Number(acct.pts) || 0) + d);
  acct.ptsLog = ((acct.ptsLog || []).concat({ t: Date.now(), d, why: String(why).slice(0, 80), bal: acct.pts })).slice(-40);
}
// bring points back when an unpaid order that used them expires (once)
async function ptsRefund(env, o) {
  if (!(o.ptsUsed > 0) || o.ptsRefunded || !o.account) return;
  const k = 'acct:' + o.account, a = await env.ORDERS.get(k, 'json'); if (!a) return;
  ptsAdd(a, o.ptsUsed, 'Order #' + o.id.slice(0, 8).toUpperCase() + ' expired — points returned'); o.ptsRefunded = true;
  await env.ORDERS.put(k, J(a));
}

async function accountRoutes(req, env, path, apiBase) {
  const ip = ipOf(req);
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
    notify(env, '👤 <b>New sign-up</b>\n' + esc(email) + (acct.name ? ' · ' + esc(acct.name) : ''));
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
    const ids = (acct.orders || []).slice(-25).reverse();
    let found = (await Promise.all(ids.map(id => env.ORDERS.get('order:' + id, 'json')))).filter(Boolean);
    found = await Promise.all(found.map((o, i) => o.status === 'pending' && i < 5 ? checkOrder(env, o) : (i < 5 ? ensureFulfilled(env, o) : o)));   // detect payments when the customer comes back
    const orders = found.filter(o => o.status !== 'expired').map(o => publicOrder(env, o, apiBase));   // expired orders are useless to the customer: not shown
    const spent = round2(orders.filter(o => o.status === 'paid').reduce((a, o) => a + (Number(o.usd) || 0), 0));
    return json(env, { profile: profileOf(acct), orders, spent, pts: await ptsCfg(env), ptsLog: (acct.ptsLog || []).slice(-15).reverse() });
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
/* ---------------- supplier: FazerCards gift cards (optional) ----------------
   Items that carry a "supplier" block are bought from FazerCards at the moment the customer's payment is confirmed.
   Needs the Cloudflare secret FAZER_KEY (your FazerCards API key, starts with fc_). */
const FZ_BASE = 'https://api.fzr.cards/api/v2';
const fzCache = new Map(), lastFul = new Map();
let fzBal = { t: 0, v: 0 };
async function fz(env, method, path, body, idem) {
  if (!env.FAZER_KEY) throw new Error('FAZER_KEY is not set in Cloudflare (Worker → Settings → Variables and Secrets)');
  const h = { 'X-API-Key': env.FAZER_KEY, accept: 'application/json' };
  if (body) h['content-type'] = 'application/json';
  if (idem) h['Idempotency-Key'] = idem;
  const r = await fetch(FZ_BASE + path, { method, headers: h, body: body ? J(body) : undefined, signal: AbortSignal.timeout(9000) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.ok === false) { const e = new Error((j && (j.error || j.code)) || ('FazerCards HTTP ' + r.status)); e.status = r.status; throw e; }
  return j;
}
async function fzOffers(env, cat) {
  const c = fzCache.get(cat); if (c && Date.now() - c.t < 20000) return c.v;
  const v = await fz(env, 'GET', '/giftcards/cards?category_id=' + encodeURIComponent(cat));
  fzCache.set(cat, { t: Date.now(), v }); if (fzCache.size > 200) fzCache.clear();
  return v;
}
const fzFind = (j, card) => ((j && j.offers) || []).find(o => String(o.card_id) === String(card));
async function fzBalance(env) {
  if (Date.now() - fzBal.t < 20000) return fzBal.v;
  const j = await fz(env, 'GET', '/balance'); fzBal = { t: Date.now(), v: Number(j.balance) || 0 };
  return fzBal.v;
}
// Before we take a customer's money: is the supplier item in stock, profitable, and is our balance enough?
async function checkSupplierLines(env, cat, lines) {
  let need = 0;
  for (const l of lines) {
    const p = cat.products[l.id] || (l.gift ? { title: l.title, supplier: l.supplier } : null); if (!p || !p.supplier) continue;
    if (p.supplier.topup) {
      let t; try { t = tpFind(await fzTopup(env, p.supplier.cat), p.supplier.card); } catch (e) { return 'This item is temporarily unavailable. Please try again later.'; }
      const tc = Number(t && t.price_usd);
      if (!t || !(tc > 0)) return '"' + p.title + '" is not available right now.';
      if (tc >= l.price) return 'This item is being repriced and cannot be ordered right now. Please try again later.';
      l.supplier = { cat: p.supplier.cat, card: p.supplier.card, topup: true, cost: tc }; need += tc; continue;
    }
    let offer;
    try { offer = fzFind(await fzOffers(env, p.supplier.cat), p.supplier.card); } catch (e) { return 'This item is temporarily unavailable. Please try again later.'; }
    const qty = qtyOf(l);
    if (!offer || (offer.stock != null && Number(offer.stock) < qty)) return offer && Number(offer.stock) > 0 ? 'Only ' + offer.stock + ' of "' + p.title + '" left right now.' : '"' + p.title + '" is out of stock right now.';
    const cost = Number(offer.price_usd);
    if (!(cost > 0) || Number(offer.min_order_quantity || 1) > qty || (Number(offer.max_order_quantity) > 0 && qty > Number(offer.max_order_quantity))) return 'This quantity is not available for "' + p.title + '". Please choose fewer.';
    if (cost >= (l.unit || l.price)) return 'This item is being repriced and cannot be ordered right now. Please try again later.';
    l.supplier = { cat: p.supplier.cat, card: p.supplier.card, cost };
    need += cost * qty;
  }
  if (need > 0) {
    let bal = 0;
    try { bal = await fzBalance(env); } catch (e) { return 'This item is temporarily unavailable. Please try again later.'; }
    if (bal < need) return 'This item is temporarily unavailable. Please try again later.';
  }
  return null;
}
/* ---- live gift-card catalog: the category list lives in idx.sup, prices are cost + your rule, computed fresh ---- */
const GIFT_ID = /^g:([A-Za-z0-9_-]{1,80}):([A-Za-z0-9_.-]{1,80})$/;
function giftPrice(rule, cost) {
  const v = Number(rule && rule.value) || 0, c = Number(cost);
  const raw = rule && rule.mode === 'fixed' ? c + v : c * (1 + v / 100);
  return Math.max(Math.ceil(raw * 100 - 1e-7) / 100, round2(c + 0.01));
}
// your own fixed price for one amount (set in the dashboard) beats the percent / fixed rule, but never goes below cost + 1 cent
function giftSell(sup, catId, card, cost) {
  const ov = Number(sup && sup.over && sup.over[catId + ':' + card]);
  return ov > 0 ? Math.max(round2(ov), round2(Number(cost) + 0.01)) : giftPrice(sup.rule, cost);
}
/* ---- game top-ups (FazerCards /topups): the customer gives a Player ID, FazerCards delivers to the game account ---- */
const TOPUP_ID = /^t:([A-Za-z0-9_-]{1,80}):([A-Za-z0-9_.-]{1,80})$/;
const tpCache = new Map();
async function fzTopup(env, catId) {
  const c = tpCache.get(catId); if (c && Date.now() - c.t < 20000) return c.v;
  const v = await fz(env, 'GET', '/topups/offers?category_id=' + encodeURIComponent(catId));
  tpCache.set(catId, { t: Date.now(), v }); if (tpCache.size > 100) tpCache.clear();
  return v;
}
const tpFind = (j, offer) => ((j && j.offers) || []).find(o => String(o.offer_id) === String(offer));
const optVal = o => typeof o === 'string' ? o : o && (o.value !== undefined ? o.value : o.id !== undefined ? o.id : o.key);
function topupFieldDefs(j) {
  return ((j && j.fields) || []).filter(f => f && /^[A-Za-z0-9_.-]{1,40}$/.test(String(f.key))).slice(0, 8).map(f => ({ key: String(f.key), label: String(f.label || f.key).slice(0, 60), type: f.type === 'select' ? 'select' : 'text', options: Array.isArray(f.options) ? f.options.map(o => ({ value: String(optVal(o)), label: String((o && o.label) || optVal(o)) })).filter(o => o.value && o.value !== 'undefined').slice(0, 80) : [] }));
}
// the customer's answers (Player ID, server...) checked against the fields FazerCards asks for
function cleanTopupFields(defs, given) {
  const out = {}; given = given && typeof given === 'object' ? given : {};
  for (const d of defs) {
    const v = String(given[d.key] == null ? '' : given[d.key]).trim();
    if (!v) return { error: 'Please fill in "' + d.label + '".' };
    if (v.length > 80 || /[\u0000-\u001f<>"'`\\]/.test(v)) return { error: '"' + d.label + '" has characters that are not allowed.' };
    if (d.type === 'select' && d.options.length && !d.options.some(o => o.value === v)) return { error: 'Please choose a valid "' + d.label + '".' };
    out[d.key] = v;
  }
  return { v: out };
}
async function topupOffers(env, cat, catId) {
  const sup = cat && cat.sup; if (!sup || !sup.tcats || !sup.tcats[catId]) return null;
  const j = await fzTopup(env, catId);
  return { name: sup.tcats[catId].n || j.name || catId, fields: topupFieldDefs(j), offers: (j.offers || []).filter(o => Number(o.price_usd) > 0).map(o => ({ offer: String(o.offer_id), name: String(o.name), cost: Number(o.price_usd) })) };
}
const topupSell = (sup, catId, offer, cost) => giftSell(sup, 'T-' + catId, offer, cost);
async function topupRoute(req, env, url) {
  if (tooMany(giftHits, ipOf(req), 90, 10 * 60000)) return fail(env, 'Too many requests. Please wait a moment.', 429);
  const catId = String(url.searchParams.get('cat') || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(catId)) return fail(env, 'Not found', 404);
  const cat = await getCatalog(env);
  let t; try { t = await topupOffers(env, cat, catId); } catch (e) { return fail(env, 'This item is temporarily unavailable. Please try again later.', 503); }
  if (!t) return fail(env, 'Not found', 404);
  const canCheck = !!(await validatorFor(env, catId, t.name).catch(() => null));
  return json(env, { ok: true, name: t.name, fields: t.fields, canCheck, offers: t.offers.map(o => ({ offer: o.offer, name: o.name, price: topupSell(cat.sup, catId, o.offer, o.cost) })) });
}
// which games FazerCards can check a Player ID for (the list is dynamic), matched by id or by name ("PUBG Mobile (Auto)" = "PUBG Mobile")
let tvList = { t: 0, v: [] };
const normName = x => String(x || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
async function validatorFor(env, catId, name) {
  if (Date.now() - tvList.t > 600000) {
    try { const j = await fz(env, 'GET', '/topups/validate-id'); tvList = { t: Date.now(), v: (j.items || []).map(i => ({ id: String(i.category_id), name: String(i.name || ''), fields: topupFieldDefs({ fields: i.fields }) })) }; }
    catch (e) { tvList = { t: Date.now() - 540000, v: tvList.v }; }          // retry in a minute; keep the old list meanwhile
  }
  return tvList.v.find(i => i.id === catId) || tvList.v.find(i => normName(i.name) && normName(i.name) === normName(name)) || null;
}
const tvHits = new Map();
async function topupValidate(req, env) {
  if (tooMany(tvHits, ipOf(req), 20, 10 * 60000)) return fail(env, 'Too many checks. Please wait a few minutes.', 429);
  const b = await req.json().catch(() => null) || {}, catId = String(b.cat || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(catId)) return fail(env, 'Not found', 404);
  const cat = await getCatalog(env);
  let t; try { t = await topupOffers(env, cat, catId); } catch (e) { return fail(env, 'Could not check right now. You can still continue.', 503); }
  if (!t) return fail(env, 'Not found', 404);
  const f = cleanTopupFields(t.fields, b.fields); if (f.error) return fail(env, f.error);
  const vd = await validatorFor(env, catId, t.name).catch(() => null);
  if (!vd) return json(env, { ok: true, valid: null, unsupported: true });
  const first = Object.keys(f.v).map(k => f.v[k])[0], vf = {};
  for (const d of vd.fields) vf[d.key] = f.v[d.key] !== undefined ? f.v[d.key] : first;
  try {
    const j = await fz(env, 'POST', '/topups/validate-id', { category_id: vd.id, fields: vf });
    return json(env, { ok: true, valid: j.valid !== false, player: String(j.player_name || '').slice(0, 60), region: String(j.region || '').slice(0, 30) });
  } catch (e) {
    if (e.status === 422) return json(env, { ok: true, valid: false });
    return json(env, { ok: true, valid: null });                // this game cannot be checked in advance
  }
}
async function giftOffers(env, cat, catId) {
  const sup = cat && cat.sup; if (!sup || !sup.cats || !sup.cats[catId]) return null;
  const j = await fzOffers(env, catId);
  return { name: sup.cats[catId].n || j.name || catId, offers: (j.offers || []).filter(o => Number(o.min_order_quantity || 1) <= 1 && Number(o.price_usd) > 0).map(o => ({ card: String(o.card_id), name: String(o.name), cost: Number(o.price_usd), stock: o.stock == null ? null : Number(o.stock), max: Math.min(10, Number(o.max_order_quantity) > 0 ? Number(o.max_order_quantity) : 10) })) };
}
const giftHits = new Map();
async function giftRoute(req, env, url) {
  if (tooMany(giftHits, ipOf(req), 90, 10 * 60000)) return fail(env, 'Too many requests. Please wait a moment.', 429);
  const catId = String(url.searchParams.get('cat') || '');
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(catId)) return fail(env, 'Not found', 404);
  const cat = await getCatalog(env);
  let g; try { g = await giftOffers(env, cat, catId); } catch (e) { return fail(env, 'This item is temporarily unavailable. Please try again later.', 503); }
  if (!g) return fail(env, 'Not found', 404);
  return json(env, { ok: true, name: g.name, offers: g.offers.map(o => ({ card: o.card, name: o.name, price: giftSell(cat.sup, catId, o.card, o.cost), inStock: o.stock == null || o.stock > 0, max: Math.max(1, Math.min(o.max, o.stock == null ? 10 : o.stock)) })) });
}
// Turn "g:<category>:<card>" cart ids into priced products (the server decides every price)
async function resolveGift(env, cat, raw) {
  const gp = {};
  if (new Set(raw.map(it => String((it && it.id) || '').split(':')[1]).filter(Boolean)).size > 8) return { error: 'Please order gift cards from at most 8 different brands at a time.' };
  for (const it of raw.slice(0, 30)) {
    const id = String((it && it.id) || ''), tm = id.match(TOPUP_ID);
    if (tm && !gp[id]) {
      let t; try { t = await topupOffers(env, cat, tm[1]); } catch (e) { return { error: 'This item is temporarily unavailable. Please try again later.' }; }
      const of = t && t.offers.find(o => o.offer === tm[2]);
      if (!of) return { error: 'One of the items is not available any more' };
      const fl = cleanTopupFields(t.fields, it.f); if (fl.error) return { error: fl.error };
      gp[id] = { title: t.name + ' — ' + of.name, price: topupSell(cat.sup, tm[1], of.offer, of.cost), type: 'digital', gift: true, topup: true, fields: fl.v, supplier: { cat: tm[1], card: tm[2], topup: true } };
      continue;
    }
    const m = id.match(GIFT_ID); if (!m || gp[id]) continue;
    let g; try { g = await giftOffers(env, cat, m[1]); } catch (e) { return { error: 'This item is temporarily unavailable. Please try again later.' }; }
    const of = g && g.offers.find(o => o.card === m[2]);
    if (!of) return { error: 'One of the items is not available any more' };
    const wantQ = Math.max(1, Math.min(10, Math.floor(Number((raw.find(x => x && x.id === id) || {}).q) || 1)));
    if (of.stock != null && of.stock < wantQ) return { error: of.stock > 0 ? 'Only ' + of.stock + ' of "' + g.name + ' ' + of.name + '" left right now.' : '"' + g.name + ' ' + of.name + '" is out of stock right now.' };
    gp[id] = { title: g.name + ' — ' + of.name, price: giftSell(cat.sup, m[1], of.card, of.cost), type: 'digital', gift: true, supplier: { cat: m[1], card: m[2] } };
  }
  return { gp };
}
const FZ_SKIP = /^(id|order_id|status|name|title|price|price_usd|total|card_id|category_id|offer_id|created_at|createdat|updated_at|updatedat|quantity|currency|kind|type|note|image|imageurl)$/i;
function fzCodeText(c) {
  if (c == null) return '';
  if (typeof c !== 'object') return String(c);
  const rows = [];
  for (const k of Object.keys(c)) {
    const v = c[k]; if (v == null || v === '' || typeof v === 'object' || FZ_SKIP.test(k)) continue;
    rows.push(/^(code|key|voucher)$/i.test(k) ? String(v) : k.replace(/[_-]+/g, ' ').replace(/^./, x => x.toUpperCase()) + ': ' + v);
  }
  return rows.join('\n');
}
function fzCards(order) {
  const arr = order && (order.cards || order.codes || order.keys || order.vouchers);
  if (!arr) return [];
  return (Array.isArray(arr) ? arr : [arr]).map(fzCodeText).filter(Boolean);
}
function fzCodes(order) {
  const arr = order && (order.cards || order.codes || order.keys || order.vouchers);
  if (!arr) return '';
  return (Array.isArray(arr) ? arr : [arr]).map(fzCodeText).filter(Boolean).join('\n\n');
}
function supplierLines(o) { return itemsOf(o).filter(l => l.supplier); }
const needsFulfil = o => o.status === 'paid' && supplierLines(o).some(l => !(o.fulfil && o.fulfil[l.id] && o.fulfil[l.id].state === 'done'));
// Buy every supplier item of a paid order. Safe to call again and again: FazerCards ignores repeated requests with the same Idempotency-Key.
async function fulfil(env, o, force) {
  o.fulfil = o.fulfil || {}; o.codes = o.codes && !Array.isArray(o.codes) ? o.codes : {};
  const lines = itemsOf(o); let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; if (!l.supplier) continue;
    const f = o.fulfil[l.id] || (o.fulfil[l.id] = { state: 'wait', tries: 0 });
    if (f.state === 'done') continue;
    if (f.state === 'stuck' && !force) continue;
    if (force) { f.tries = 0; f.state = 'wait'; }
    f.tries++; changed = true;
    try {
      let order;
      if (l.supplier.topup) {
        if (!f.sid) {
          const j = await fz(env, 'POST', '/topups/order', { category_id: l.supplier.cat, offer_id: l.supplier.card, fields: l.fields || {} }, 'tp-' + o.id + '-' + i);
          order = j.order; f.sid = order && (order.id || order.order_id || order.public_id) || null;
        } else order = (await fz(env, 'GET', '/orders/' + encodeURIComponent(f.sid))).order;
        const st = String((order && order.status) || '').toLowerCase(), who = Object.keys(l.fields || {}).map(k => l.fields[k]).join(' / ');
        if (/refund|cancel|fail|reject|error/.test(st)) { f.state = 'stuck'; f.error = 'FazerCards says: ' + st + ' — refund your customer or retry'; }
        else if (/complet|done|deliver|success/.test(st)) { o.codeList = o.codeList || {}; o.codeList[l.id] = ['✅ Top-up delivered to ' + who]; o.codes[l.id] = o.codeList[l.id][0]; f.state = 'done'; f.error = ''; f.doneAt = Date.now(); }
        else { f.state = 'wait'; f.error = ''; }
        if (f.state === 'wait' && f.tries >= 60) f.state = 'stuck';
        if (f.state === 'stuck' && !f.alerted) { f.alerted = true; notify(env, '⚠️ <b>Needs you</b> — top-up problem for order #' + o.id.slice(0, 8).toUpperCase() + ' (' + esc(who) + ')\n' + esc(f.error || '')); }
        continue;
      }
      if (!f.sid) {
        const j = await fz(env, 'POST', '/giftcards/order', { category_id: l.supplier.cat, card_id: l.supplier.card, quantity: qtyOf(l) }, 'gs-' + o.id + '-' + i);
        order = j.order; f.sid = order && (order.id || order.order_id || order.public_id) || null;
      } else order = (await fz(env, 'GET', '/orders/' + encodeURIComponent(f.sid))).order;
      const list = fzCards(order), codes = list.join('\n\n'), st = String((order && order.status) || '').toLowerCase();
      if (list.length >= qtyOf(l)) { o.codeList = o.codeList || {}; o.codeList[l.id] = list; o.codes[l.id] = codes; f.state = 'done'; f.error = ''; f.doneAt = Date.now(); }
      else if (list.length && /complet|done|deliver|success/.test(st)) { f.state = 'stuck'; f.error = 'FazerCards returned ' + list.length + ' of ' + qtyOf(l) + ' codes'; }
      else if (/refund|cancel|fail|reject|error/.test(st)) { f.state = 'stuck'; f.error = 'FazerCards says: ' + st; }
      else { f.state = 'wait'; f.error = ''; }
    } catch (e) { f.state = 'wait'; f.error = String((e && e.message) || e).slice(0, 200); }
    if (f.state === 'wait' && f.tries >= 30) f.state = 'stuck';
    if (f.state === 'stuck' && !f.alerted) { f.alerted = true; notify(env, '⚠️ <b>Needs you</b> — supplier delivery stuck for order #' + o.id.slice(0, 8).toUpperCase() + '\n' + esc(f.error || '')); }
  }
  if (changed && fulfilState(o) === 'ok') await dlRecord(env, o);
  return changed;
}
async function ensureFulfilled(env, o) {
  if (!needsFulfil(o)) return o;
  if (Date.now() - (lastFul.get(o.id) || 0) < 15000) return o;
  lastFul.set(o.id, Date.now()); if (lastFul.size > 500) lastFul.clear();
  if (await fulfil(env, o, false)) await saveOrder(env, o);
  return o;
}
function fulfilState(o) {
  const ls = supplierLines(o); if (!ls.length) return null;
  const fs = ls.map(l => (o.fulfil && o.fulfil[l.id]) || { state: 'wait' });
  return fs.every(f => f.state === 'done') ? 'ok' : fs.some(f => f.state === 'stuck') ? 'stuck' : 'wait';
}

/* ---------------- Telegram: alerts to you + live chat bridge ----------------
   Needs the Cloudflare secret TELEGRAM_BOT_TOKEN (from @BotFather). You connect it once from the dashboard (Settings → Telegram).
   Customer chat messages arrive in your Telegram; you answer by using Telegram's "Reply" on the message. */
const tgMem = { owner: null, t: 0 };
const bg = (env, p) => { const q = Promise.resolve(p).catch(() => {}); if (env.__ctx && env.__ctx.waitUntil) env.__ctx.waitUntil(q); };
async function tg(env, method, body) {
  const r = await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(8000) });
  const j = await r.json().catch(() => null);
  if (!j || !j.ok) throw new Error((j && j.description) || 'Telegram error');
  return j.result;
}
async function tgOwner(env) {
  if (env.TELEGRAM_CHAT_ID) return String(env.TELEGRAM_CHAT_ID);
  if (tgMem.owner && Date.now() - tgMem.t < 60000) return tgMem.owner;
  const v = await env.ORDERS.get('tg:owner', { cacheTtl: 30 }); tgMem.owner = v || ''; tgMem.t = Date.now(); return v || '';
}
function notify(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  bg(env, (async () => { const chat = await tgOwner(env); if (chat) await tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }); })());
}
// The connect code is derived from your secret + the current 15-minute window, so it needs no storage
// (storage updates can take a minute to appear in other locations, which made pairing fail when you pressed START quickly).
const pairCode = async (env, back) => (await sign(env, 'tg-pair:' + (Math.floor(Date.now() / 900000) - (back || 0)))).replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
const pairOk = async (env, c) => safeEqual(String(c), await pairCode(env, 0)) || safeEqual(String(c), await pairCode(env, 1));
const tgSecret = async env => (await sign(env, 'tg-webhook')).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
const chatHits = new Map(), pollHits = new Map();
const SID = /^[a-f0-9]{16,32}$/;
/* ---- live chat inbox: every visitor is one conversation ("ticket") with its own thread, unread counter and status ---- */
const TOPICS = { payment: 'Payment', order: 'My order', topup: 'Game top-up', other: 'Other' };
const ticketOf = sid => '#' + String(sid).slice(0, 4).toUpperCase();
const chatOn = env => !!(env.ADMIN_TOKEN || env.TELEGRAM_BOT_TOKEN);
async function convAdd(env, conv, from, text) {
  conv.msgs = (conv.msgs || []).concat({ t: Date.now(), f: from, x: text }).slice(-60); conv.last = Date.now();
  if (from === 'c') { conv.unread = (conv.unread || 0) + 1; conv.status = 'open'; } else conv.unread = 0;
  await env.ORDERS.put('conv:' + conv.sid, J(conv), { expirationTtl: 30 * 86400 });
}
async function convIndex(env, sid) {
  for (let i = 0; i < 3; i++) {                                        // several customers may write at once: make sure the id really is in the list
    await pushIndex(env, 'cvidx', sid, 300);
    if (((await env.ORDERS.get('cvidx', 'json')) || []).indexOf(sid) >= 0) return;
  }
}
async function chatSend(req, env) {
  if (!chatOn(env)) return fail(env, 'Live chat is offline right now. Please use WhatsApp or email.', 503);
  const ip = ipOf(req), b = await req.json().catch(() => ({}));
  const sid = String(b.sid || ''), text = String(b.text || '').trim().slice(0, 600);
  if (!SID.test(sid) || !text) return fail(env, 'Bad message');
  if (tooMany(chatHits, ip, 20, 10 * 60000) || tooMany(chatHits, 's|' + sid, 20, 10 * 60000)) return fail(env, 'You are sending messages too fast. Please wait a moment.', 429);
  const name = String(b.name || '').trim().slice(0, 40) || 'Visitor', order = /^[A-Za-z0-9-]{4,20}$/.test(String(b.order || '')) ? String(b.order) : '';
  const email = validEmail(String(b.email || '').trim().toLowerCase()) ? String(b.email).trim().toLowerCase() : '';
  let conv = await env.ORDERS.get('conv:' + sid, 'json'), fresh = !conv;
  if (!conv) conv = { sid, name, email, order, topic: TOPICS[b.topic] ? b.topic : 'other', status: 'open', createdAt: Date.now(), unread: 0, msgs: [] };
  else { if (name !== 'Visitor') conv.name = name; if (email) conv.email = email; if (order) conv.order = order; if (TOPICS[b.topic] && conv.msgs.length === 0) conv.topic = b.topic; }
  const reopened = !fresh && conv.status === 'done';
  await convAdd(env, conv, 'c', text);
  if (fresh) await convIndex(env, sid);
  const tag = ticketOf(sid);
  if (env.TELEGRAM_BOT_TOKEN) bg(env, (async () => { const chat = await tgOwner(env); if (chat) await tg(env, 'sendMessage', { chat_id: chat, parse_mode: 'HTML', disable_web_page_preview: true,
    text: (fresh ? '🆕 <b>New chat ' + tag + '</b> · ' + esc(TOPICS[conv.topic]) : reopened ? '🔁 <b>Chat ' + tag + ' reopened</b>' : '💬 <b>Chat ' + tag + '</b>') + '\n👤 ' + esc(conv.name) + (conv.email ? ' · ' + esc(conv.email) : '') + (conv.order ? ' · order #' + esc(conv.order) : '') + '\n' + esc(text) + '\n\n<i>↩ Reply to this message to answer · or use Dashboard → Messages</i>\n#sid:' + sid }); })());
  return json(env, { ok: true, ticket: tag });
}
async function chatPoll(req, env, url) {
  const sid = String(url.searchParams.get('sid') || ''), after = Number(url.searchParams.get('after')) || 0;
  if (!SID.test(sid)) return fail(env, 'Bad session');
  if (tooMany(pollHits, ipOf(req), 200, 10 * 60000)) return fail(env, 'Too many requests', 429);
  const conv = await env.ORDERS.get('conv:' + sid, 'json');
  return json(env, { ok: true, msgs: ((conv && conv.msgs) || []).filter(m => m.f === 'o' && m.t > after).map(m => ({ t: m.t, text: m.x })), status: conv ? conv.status : 'none', ticket: ticketOf(sid), online: chatOn(env) });
}
const convSummary = c => ({ sid: c.sid, ticket: ticketOf(c.sid), name: c.name, email: c.email || '', order: c.order || '', topic: TOPICS[c.topic] || 'Other', status: c.status, unread: c.unread || 0, last: c.last, createdAt: c.createdAt, count: (c.msgs || []).length,
  preview: String(((c.msgs || [])[(c.msgs || []).length - 1] || {}).x || '').slice(0, 90), lastFrom: ((c.msgs || [])[(c.msgs || []).length - 1] || {}).f || 'c' });
async function adminChats(env) {
  const ids = ((await env.ORDERS.get('cvidx', 'json')) || []).slice(-40).reverse();
  const list = (await Promise.all(ids.map(id => env.ORDERS.get('conv:' + id, 'json')))).filter(Boolean).map(convSummary).sort((a, b) => b.last - a.last);
  return json(env, { chats: list, unread: list.reduce((a, c) => a + c.unread, 0), open: list.filter(c => c.status === 'open').length });
}
async function adminChat(req, env, url) {
  const sid = String(url.searchParams.get('sid') || ''); if (!SID.test(sid)) return fail(env, 'Bad session');
  const conv = await env.ORDERS.get('conv:' + sid, 'json'); if (!conv) return fail(env, 'Conversation not found', 404);
  if (conv.unread) { conv.unread = 0; await env.ORDERS.put('conv:' + sid, J(conv), { expirationTtl: 30 * 86400 }); }
  let orders = [];
  if (conv.email) { const a = await env.ORDERS.get('acct:' + conv.email, 'json'); if (a) orders = (await Promise.all((a.orders || []).slice(-3).map(id => env.ORDERS.get('order:' + id, 'json')))).filter(Boolean).map(o => ({ id: o.id.slice(0, 8).toUpperCase(), title: orderTitle(o), usd: o.usd, status: o.status })); }
  return json(env, { chat: Object.assign(convSummary(conv), { msgs: conv.msgs, orders, points: undefined }) });
}
async function adminChatAct(req, env) {
  const b = await req.json().catch(() => ({})), sid = String(b.sid || ''); if (!SID.test(sid)) return fail(env, 'Bad session');
  const conv = await env.ORDERS.get('conv:' + sid, 'json'); if (!conv) return fail(env, 'Conversation not found', 404);
  if (b.action === 'reply') {
    const text = String(b.text || '').trim().slice(0, 1000); if (!text) return fail(env, 'Type a message first');
    await convAdd(env, conv, 'o', text);
  } else if (b.action === 'done' || b.action === 'open') { conv.status = b.action; await env.ORDERS.put('conv:' + sid, J(conv), { expirationTtl: 30 * 86400 }); }
  else if (b.action === 'delete') { await env.ORDERS.delete('conv:' + sid); await env.ORDERS.put('cvidx', J(((await env.ORDERS.get('cvidx', 'json')) || []).filter(x => x !== sid))); return json(env, { ok: true }); }
  else return fail(env, 'Unknown action');
  return json(env, { ok: true, chat: Object.assign(convSummary(conv), { msgs: conv.msgs }) });
}
async function telegramHook(req, env, secretInPath) {
  if (!env.TELEGRAM_BOT_TOKEN || !safeEqual(secretInPath, await tgSecret(env))) return fail(env, 'Not found', 404);
  const u = await req.json().catch(() => ({})), m = u && u.message; if (!m || !m.chat) return json(env, { ok: true });
  const chat = String(m.chat.id), text = String(m.text || '');
  const start = text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{6,40})/);
  if (start) {
    const cur = await tgOwner(env);
    if (await pairOk(env, start[1]) && cur && cur !== chat) await tg(env, 'sendMessage', { chat_id: chat, text: 'This shop is already connected to another Telegram account. Press “Disconnect” in the dashboard first, then connect again.' });
    else if (await pairOk(env, start[1])) {
      await env.ORDERS.put('tg:owner', chat); cfgMem = { t: 0, v: null }; tgMem.owner = chat; tgMem.t = Date.now();
      await tg(env, 'sendMessage', { chat_id: chat, text: '✅ Connected! You will now get an alert for every order and every chat message. To answer a customer, use Telegram’s “Reply” on their message.\n\n(The dashboard can take up to a minute to show “Connected”.)' });
    } else await tg(env, 'sendMessage', { chat_id: chat, text: 'That connect code is wrong or expired. Press “Connect Telegram” in your dashboard again, then use the new link.' });
    return json(env, { ok: true });
  }
  if (/^\/start(@\w+)?\s*$/.test(text) && !(await tgOwner(env))) { await tg(env, 'sendMessage', { chat_id: chat, text: 'Hi! To connect me to your shop, press “Connect Telegram” in your dashboard and open the link it gives you (it contains your connect code).\n\nYour Telegram chat ID is ' + chat + ' — only needed if you prefer to set it manually as the Cloudflare variable TELEGRAM_CHAT_ID.' }).catch(() => {}); return json(env, { ok: true }); }
  const owner = await tgOwner(env);
  if (!owner || chat !== owner) { await tg(env, 'sendMessage', { chat_id: chat, text: 'This is a private shop assistant bot.' }).catch(() => {}); return json(env, { ok: true }); }
  const rt = m.reply_to_message && String(m.reply_to_message.text || ''), sid = rt && (rt.match(/#sid:([a-f0-9]{16,32})/) || [])[1];
  if (sid && text) {
    let conv = await env.ORDERS.get('conv:' + sid, 'json');
    if (!conv) { conv = { sid, name: 'Visitor', topic: 'other', status: 'open', createdAt: Date.now(), unread: 0, msgs: [] }; await convIndex(env, sid); }
    await convAdd(env, conv, 'o', text.slice(0, 1000));
    await tg(env, 'sendMessage', { chat_id: chat, text: '✓ sent', reply_to_message_id: m.message_id }).catch(() => {});
  } else if (text && !text.startsWith('/')) await tg(env, 'sendMessage', { chat_id: chat, text: 'To answer a customer, long-press their message and choose “Reply”.' }).catch(() => {});
  return json(env, { ok: true });
}
async function createOrder(req, env, apiBase) {
  // each order costs 3 writes of the free daily allowance, so one visitor (and the whole shop) is capped
  if (tooMany(ipHits, ipOf(req), 4, 10 * 60000) || tooMany(ipHits, '*all*', 60, 10 * 60000)) return fail(env, 'Too many orders right now. Please wait a few minutes and try again.', 429);
  const b = await req.json().catch(() => null) || {};
  const rid = /^[a-f0-9]{8,40}$/.test(String(b.rid || '')) ? String(b.rid) : '';       // the shop may send the same click twice on a bad connection: answer with the first order
  if (rid) { const oid0 = await env.ORDERS.get('rid:' + rid, 'text'); const o0 = oid0 && await env.ORDERS.get('order:' + oid0, 'json'); if (o0) return json(env, publicOrder(env, o0, apiBase)); }
  const cat = await getCatalog(env);
  if (!cat) return fail(env, 'The store has not been synced yet', 503);

  const acct = await authCustomer(req, env);                  // optional: logged-in customers get the order saved to their account
  const email = acct ? acct.email : String(b.email || '').trim().toLowerCase();
  if (!validEmail(email)) return fail(env, 'Please enter a valid email address');

  const coin = COINS[b.coin] ? b.coin : 'usdt_trc20', C = COINS[coin];
  const wallet = walletFor(env, cat, coin);
  if (!wallet) return fail(env, C.name + ' payments are not set up yet. Please choose another coin.', 503);

  const raw = Array.isArray(b.items) ? b.items : (b.item ? [{ id: b.item, v: 'all' }] : []);
  const rg = await resolveGift(env, cat, raw);
  if (rg.error) return fail(env, rg.error, 409);
  const priced = priceCart(cat, raw, rg.gp);
  if (priced.error) return fail(env, priced.error);
  for (const l of priced.lines) {                              // digital items: refuse when stock is gone
    if (l.type !== 'digital') continue;
    const p = cat.products[l.id]; if (!p || p.supplier) continue;
    const used = Number(await env.ORDERS.get('used:' + l.id)) || 0, want = qtyOf(l);
    if (used + want > (p.stockN || 0)) return fail(env, (p.stockN || 0) - used > 0 ? 'Only ' + ((p.stockN || 0) - used) + ' left of "' + p.title + '".' : 'Sorry, "' + p.title + '" is out of stock right now.', 409);
  }

  const sup = await checkSupplierLines(env, cat, priced.lines);
  if (sup) return fail(env, sup, 409);

  // points: the customer may pay part of the order with points (needs an account)
  let ptsUsed = 0, ptsOff = 0;
  const wantPts = Math.floor(Number(b.usePoints) || 0);
  if (wantPts > 0) {
    const cfg = await ptsCfg(env);
    if (!cfg.on || !acct) return fail(env, 'Points can only be used when signed in', 400);
    if (wantPts < cfg.minRedeem) return fail(env, 'The smallest amount of points you can use is ' + cfg.minRedeem, 400);
    if (wantPts > Math.floor(Number(acct.pts) || 0)) return fail(env, 'You do not have that many points', 400);
    const cap = Math.floor(priced.usd * cfg.maxPct) / 100;                  // whole cents, never the full price
    ptsOff = Math.min(Math.round(wantPts * cfg.valueUsd * 100) / 100, cap);
    ptsUsed = cfg.valueUsd > 0 ? Math.min(wantPts, Math.ceil(ptsOff / cfg.valueUsd - 1e-9)) : 0;
    if (!(ptsOff > 0) || priced.usd - ptsOff < 0.5) return fail(env, 'Points cannot cover this order. Try fewer points.', 400);
    priced.full = priced.usd; priced.usd = Math.round((priced.usd - ptsOff) * 100) / 100;
  }

  // amount in the coin's smallest unit, plus a tiny unique offset so every open order is identifiable on-chain
  let base;
  if (coin === 'btc') {
    const rate = await btcRate();
    if (!rate) return fail(env, 'Could not get the Bitcoin price right now. Please try USDT or try again in a minute.', 503);
    base = Math.round(priced.usd / rate * 1e8);
  } else base = Math.ceil(Math.round(priced.usd * 1e6) / 10000) * 10000;   // whole cents
  let amount = null, amtKey = null;
  for (let round = 0; round < 12 && amount === null; round++) {            // look at several candidate amounts at the same time (faster than one by one)
    const cands = [...new Set(Array.from({ length: 3 }, () => coin === 'btc' ? base + 1 + randInt(99) : base + (1 + randInt(round < 6 ? 20 : 60)) * 10000))];
    const free = await Promise.all(cands.map(async cand => {
      if (await env.ORDERS.get('amt:' + coin + ':' + cand)) return false;
      if (coin !== 'btc') for (const oc of ['usdt_trc20', 'usdt_bep20', 'binancepay']) if (oc !== coin && await env.ORDERS.get('amt:' + oc + ':' + cand)) return false;   // one amount = one order across all USDT methods
      return true;
    }));
    const i = free.indexOf(true); if (i >= 0) { amount = cands[i]; amtKey = 'amt:' + coin + ':' + amount; }
  }
  if (amount === null) return fail(env, 'Too many open orders, please try again in a minute', 503);

  const now = Date.now();
  const fromBinance = !!b.fromBinance && !!(cat.binanceAddr && cat.binanceAddr[coin]);
  const o = { id: hex(16), key: hex(16), base: apiBase, fromBinance, email, items: priced.lines, usd: priced.usd, coin, amount, amtKey, wallet, status: 'pending', createdAt: now, expiresAt: now + (fromBinance ? Math.max(C.minutes, 180) : C.minutes) * 60000, account: acct ? acct.email : null, lang: b.lang === 'ar' ? 'ar' : 'en' };
  if (ptsUsed > 0) { o.ptsUsed = ptsUsed; o.ptsOff = ptsOff; o.usdFull = priced.full; }
  await saveOrder(env, o, 7 * 86400);
  // the "amt:" key both reserves the amount AND is the list of open orders the cron job checks
  await env.ORDERS.put(amtKey, o.id, { expirationTtl: ((fromBinance ? Math.max(C.minutes, 180) : C.minutes) + C.graceMs / 60000 + 5) * 60 });
  await pushIndex(env, 'oidx', o.id, 400);
  if (rid) await env.ORDERS.put('rid:' + rid, o.id, { expirationTtl: 900 });
  if (acct) { acct.orders = (acct.orders || []).concat(o.id).slice(-200); if (ptsUsed > 0) ptsAdd(acct, -ptsUsed, 'Used on order #' + o.id.slice(0, 8).toUpperCase()); await env.ORDERS.put('acct:' + acct.email, JSON.stringify(acct)); }
  notify(env, '🛒 <b>New order</b> #' + o.id.slice(0, 8).toUpperCase() + '\n$' + o.usd + ' · ' + esc(C.name) + (fromBinance ? ' · 🟡 paying from Binance' : '') + '\n' + esc(orderTitle(o)) + '\n' + esc(email) + '\n⏳ waiting for payment');
  return json(env, publicOrder(env, o, apiBase));
}

/* ---------------- check the blockchain ---------------- */
/* ---------------- email receipts (optional) ----------------
   Needs two Cloudflare settings: RESEND_KEY (secret, from resend.com) and MAIL_FROM (e.g.  Geostore <orders@yourdomain.com>).
   Optional: MAIL_REPLY (where customer replies go). Without them nothing is sent and everything else works as before. */
const mailOn = env => !!(env.RESEND_KEY && env.MAIL_FROM);
async function sendMail(env, to, subject, html) {
  const body = { from: String(env.MAIL_FROM), to: [to], subject, html };
  if (env.MAIL_REPLY) body.reply_to = String(env.MAIL_REPLY);
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_KEY, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(9000) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j && (j.message || j.error)) || ('Email service HTTP ' + r.status)); }
}
function receiptHTML(store, o, link) {
  const l = o.lang === 'ar' ? 'ar' : 'en', rtl = l === 'ar', coin = orderCoin(o), c = COINS[coin], tx = o.txid && o.txid !== 'manual' ? o.txid : '';
  const txUrl = !tx || /^(bp|bn):/.test(tx) ? '' : coin === 'btc' ? 'https://mempool.space/tx/' + tx : coin === 'usdt_bep20' ? 'https://bscscan.com/tx/' + tx : 'https://tronscan.org/#/transaction/' + tx;
  const row = (a, b) => '<tr><td style="padding:9px 0;border-bottom:1px solid #e6ece4;color:#51604b">' + a + '</td><td style="padding:9px 0;border-bottom:1px solid #e6ece4;text-align:' + (rtl ? 'left' : 'right') + ';font-weight:600">' + b + '</td></tr>';
  const items = itemsOf(o).map(i => row(esc(i.title) + (qtyOf(i) > 1 ? ' × ' + qtyOf(i) : ''), '$' + round2(i.price))).join('');
  return '<div dir="' + (rtl ? 'rtl' : 'ltr') + '" style="background:#f3f7ef;padding:24px 12px;font-family:Arial,Helvetica,sans-serif"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #dfe8da;text-align:' + (rtl ? 'right' : 'left') + '">' +
    '<div style="background:#3d9a0e;color:#fff;padding:22px 26px"><div style="font-size:13px;opacity:.9">' + esc(store || 'Geostore') + '</div><div style="font-size:24px;font-weight:800;margin-top:4px">' + mt(l, 'recH') + '</div></div>' +
    '<div style="padding:22px 26px;color:#0e1a0b;font-size:15px"><p style="margin:0 0 14px">' + mt(l, 'recP') + '</p>' +
    '<p style="margin:0 0 20px"><a href="' + esc(link) + '" style="display:inline-block;background:#3d9a0e;color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:999px">' + esc(mt(l, 'recBtn')) + '</a></p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' + items +
    (o.ptsOff > 0 ? row('⭐ ' + (rtl ? 'خصم النقاط' : 'Points discount'), '−$' + round2(o.ptsOff)) : '') +
    row(mt(l, 'total'), '<b>$' + round2(o.usd) + '</b>') + row(mt(l, 'paidWith'), esc(c.name) + ' — ' + esc(fmtAmount(coin, o.amount)) + ' ' + esc(c.short)) +
    row(mt(l, 'orderNo'), '#' + esc(o.id.slice(0, 8).toUpperCase())) + (tx ? row(mt(l, 'txn'), txUrl ? '<a href="' + esc(txUrl) + '" style="color:#2f7d09">' + mt(l, 'txView') + '</a>' : mt(l, 'binTx')) : '') +
    (o.ptsEarned > 0 ? row('⭐ ' + mt(l, 'pts'), '+' + o.ptsEarned) : '') + '</table>' +
    '<p style="margin:18px 0 0;font-size:12.5px;color:#6a7864">' + mt(l, 'recFoot') + '</p></div></div></div>';
}
async function markPaid(env, o, txid) {
  o.status = 'paid'; o.paidAt = Date.now(); o.txid = txid || 'manual';
  const dig = itemsOf(o).filter(i => i.type === 'digital' && !i.supplier);
  if (dig.length) {
    // digital items (gift cards, keys...): hand out the next unused code from your stock
    const cat = await getCatalog(env); o.codes = {};
    for (const l of dig) {
      const p = cat && cat.products && cat.products[l.id]; if (!p) continue;
      const stock = await env.ORDERS.get('stock:' + l.id, 'json') || [];
      const used = Number(await env.ORDERS.get('used:' + l.id)) || 0, take = stock.slice(used, used + qtyOf(l));
      if (take.length) { o.codeList = o.codeList || {}; o.codeList[l.id] = take; o.codes[l.id] = take.join('\n\n'); await env.ORDERS.put('used:' + l.id, String(used + take.length)); }
    }
  }
  if (supplierLines(o).length) { try { await fulfil(env, o, false); lastFul.set(o.id, Date.now()); } catch (e) { /* the payment is recorded either way; retried later */ } } else await dlRecord(env, o);
  const wantMail = mailOn(env) && !o.emailed && !!o.email; if (wantMail) o.emailed = true;
  if (o.email) { try { if (await env.ORDERS.get('cart:' + o.email, 'text')) await env.ORDERS.delete('cart:' + o.email); } catch (e) { /* only a reminder */ } }   // paid: no reminder needed
  if (o.account && !o.ptsDone) {                           // points: earn once; a late payment on an order whose points were returned takes them again
    o.ptsDone = true;
    try {
      const ak = 'acct:' + o.account, a = await env.ORDERS.get(ak, 'json');
      if (a) {
        if (o.ptsRefunded && o.ptsUsed > 0) { ptsAdd(a, -o.ptsUsed, 'Late payment on order #' + o.id.slice(0, 8).toUpperCase()); o.ptsRefunded = false; }
        const g = ptsEarn(await ptsCfg(env), Number(o.usd) || 0);
        if (g > 0) { ptsAdd(a, g, 'Earned on order #' + o.id.slice(0, 8).toUpperCase()); o.ptsEarned = g; }
        await env.ORDERS.put(ak, J(a));
      }
    } catch (e) { /* points are a bonus: never block a paid order */ }
  }
  await saveOrder(env, o);
  if (txid) await env.ORDERS.put('tx:' + txid, o.id);
  await env.ORDERS.delete(o.amtKey || ('amt:' + o.amount));
  if (wantMail) {                                          // one receipt per order; failures only raise a Telegram note
    const cat0 = await getCatalog(env).catch(() => null), link = (o.base || env.__base || '') + '/api/delivery/' + o.id + '?k=' + o.key;
    bg(env, sendMail(env, o.email, mt(o.lang === 'ar' ? 'ar' : 'en', 'recSub') + o.id.slice(0, 8).toUpperCase(), receiptHTML(cat0 && cat0.storeName, o, link))
      .catch(e => { notify(env, '⚠️ Receipt email to ' + esc(o.email) + ' failed: ' + esc(String((e && e.message) || e).slice(0, 160))); }));
  }
  const fs = fulfilState(o);
  notify(env, '✅ <b>Paid</b> #' + o.id.slice(0, 8).toUpperCase() + '\n$' + o.usd + ' · ' + esc(orderTitle(o)) + '\n' + esc(o.email) + (o.fromBinance ? '\n🟡 from Binance' : '') + (fs === 'ok' ? '\n🎁 delivered automatically' : fs === 'wait' ? '\n⏳ buying from supplier…' : fs === 'stuck' ? '\n⚠️ needs you (supplier)' : '\n📦 delivered'));
}
async function bscRpc(method, params) {
  let last = null;
  for (const u of BSC_RPCS) {
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(7000) });
      const j = await r.json();
      if (j && j.result !== undefined && !j.error) return j.result;
      last = j && j.error;
    } catch (e) { last = e; }
  }
  throw new Error('BSC node unavailable' + (last && last.message ? ': ' + last.message : ''));
}
// Incoming USDT (BEP20) transfers to the order's wallet. Returns [{hash, value (18-decimal BigInt), exact, block, conf}] and fills notes.
async function bscIn(o, notes) {
  const head = parseInt(await bscRpc('eth_blockNumber', []), 16);
  const topicTo = '0x' + '0'.repeat(24) + o.wallet.toLowerCase().replace(/^0x/, '');
  const age = (Date.now() - o.createdAt) / 1000 + 180, chunk = 2000;
  const chunks = Math.min(8, Math.max(1, Math.ceil(age / 0.4 / chunk)));           // BSC now makes a block roughly every 0.45 s (older: up to 3 s)
  const out = [];
  for (let c = 0; c < chunks; c++) {
    const to = head - c * chunk, from = Math.max(0, to - chunk + 1);
    let logs;
    try { logs = await bscRpc('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), address: BSC_USDT, topics: [TRANSFER_TOPIC, null, topicTo] }]); }
    catch (e) { if (notes) notes.push('BSC log search failed: ' + (e && e.message)); continue; }
    for (const l of logs) out.push({ hash: l.transactionHash, value: BigInt(l.data), exact: BigInt(l.data) === BigInt(o.amount) * 1000000000000n, block: parseInt(l.blockNumber, 16), conf: head - parseInt(l.blockNumber, 16) });
  }
  if (notes) notes.push('BSC checked ' + chunks + ' block range(s) up to block ' + head + ', found ' + out.length + ' incoming USDT transfer(s)');
  return out;
}
async function findBsc(env, o) {
  for (const t of await bscIn(o, null)) {
    if (!t.exact || t.conf < 10) continue;                       // wait for a few confirmations
    if (!(await env.ORDERS.get('tx:' + t.hash))) return t.hash;
  }
  return null;
}
/* ---------------- Binance account detection (optional) ----------------
   With a READ-ONLY Binance API key (Cloudflare secrets BINANCE_KEY + BINANCE_SECRET) the server also sees money that never touches
   the blockchain: Binance Pay transfers and Binance-to-Binance (internal) deposits to your Binance deposit address. */
const binanceOn = env => !!(env.BINANCE_KEY && env.BINANCE_SECRET);
const BN_HOSTS = ['https://api-gcp.binance.com', 'https://api.binance.com', 'https://api1.binance.com', 'https://api2.binance.com', 'https://api3.binance.com', 'https://api4.binance.com'];
const bnCache = new Map();
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function binanceGet(env, path, params) {
  const ck = path + '|' + J(params), c = bnCache.get(ck);
  if (c && Date.now() - c.t < 5000) return c.v;                        // many open orders share one lookup
  const q = new URLSearchParams(Object.assign({}, params, { timestamp: String(Date.now()), recvWindow: '10000' })).toString();
  const url = path + '?' + q + '&signature=' + await hmacHex(env.BINANCE_SECRET, q);
  let last = 'Binance did not answer';
  // Optional relay (env.BINANCE_RELAY + RELAY_SECRET): a tiny forwarder you host in a country Binance accepts, used when Cloudflare's location is blocked
  const targets = (env.BINANCE_RELAY ? [{ relay: true }] : []).concat(BN_HOSTS.map(h => ({ h })));
  for (const t of targets) {
    try {
      const r = t.relay
        ? await fetch(String(env.BINANCE_RELAY).replace(/\/+$/, '') + '?p=' + encodeURIComponent(url), { headers: { 'X-MBX-APIKEY': env.BINANCE_KEY, 'x-relay-secret': String(env.RELAY_SECRET || '') }, signal: AbortSignal.timeout(9000) })
        : await fetch(t.h + url, { headers: { 'X-MBX-APIKEY': env.BINANCE_KEY }, signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => null);
      if (r.status === 451 || r.status === 403) { last = (t.relay ? 'The relay or Binance refused the request' : 'Binance blocks this server location') + ' (HTTP ' + r.status + ')'; continue; }
      if (!r.ok || (j && j.code && String(j.code) !== '000000' && Number(j.code) < 0)) { last = (j && (j.msg || j.message)) || ('Binance HTTP ' + r.status); if (r.status >= 500) continue; throw new Error(last); }
      bnCache.set(ck, { t: Date.now(), v: j }); if (bnCache.size > 50) bnCache.clear();
      return j;
    } catch (e) { last = String((e && e.message) || e); if (/Invalid|signature|permission|IP|key/i.test(last)) throw new Error(last); }
  }
  throw new Error(last);
}
const micro = x => Math.round(Number(x) * 1e6);
async function bnPayList(env, o) { const j = await binanceGet(env, '/sapi/v1/pay/transactions', { startTimestamp: String(o.createdAt - 120000), endTimestamp: String(Date.now() + 60000), limit: '100' }); return Array.isArray(j && j.data) ? j.data : []; }
async function bnDepositList(env, o) { const j = await binanceGet(env, '/sapi/v1/capital/deposit/hisrec', { coin: 'USDT', startTime: String(o.createdAt - 120000), limit: '1000' }); return Array.isArray(j) ? j : []; }
async function findBinancePay(env, o) {
  for (const t of await bnPayList(env, o)) {
    const cur = String(t.currency || (t.fundsDetail && t.fundsDetail[0] && t.fundsDetail[0].currency) || ''), amt = Number(t.amount !== undefined ? t.amount : (t.fundsDetail && t.fundsDetail[0] && t.fundsDetail[0].amount));
    if (cur !== 'USDT' || !(amt > 0) || micro(amt) !== o.amount) continue;
    const ts = Number(t.transactionTime) || 0; if (ts && ts < o.createdAt - 60000) continue;
    const id = 'bp:' + (t.transactionId || t.orderId || ts);
    if (!(await env.ORDERS.get('tx:' + id))) return id;
  }
  try {                                                                    // second way: a plain Binance-to-Binance transfer shows up in the deposit history
    for (const t of await bnDepositList(env, o)) {
      if (micro(t.amount) !== o.amount || ![1, 6].includes(Number(t.status)) || Number(t.transferType) !== 1) continue;
      if (Number(t.insertTime) && Number(t.insertTime) < o.createdAt - 60000) continue;
      const id = 'bn:' + t.id; if (!(await env.ORDERS.get('tx:' + id))) return id;
    }
  } catch (e) { /* the Pay history already answered */ }
  return null;
}
const BN_NET = { usdt_trc20: 'TRX', usdt_bep20: 'BSC' };
async function findBinanceDeposit(env, o) {
  const coin = orderCoin(o);
  for (const t of await bnDepositList(env, o)) {
    if (micro(t.amount) !== o.amount || ![1, 6].includes(Number(t.status))) continue;
    const internal = Number(t.transferType) === 1;
    if (!internal && String(t.network || '') !== BN_NET[coin]) continue;                 // on-chain: must be this network
    if (t.address && !internal && String(t.address) !== o.wallet) continue;
    if (Number(t.insertTime) && Number(t.insertTime) < o.createdAt - 60000) continue;
    const id = internal || !t.txId ? 'bn:' + t.id : String(t.txId);
    if (!(await env.ORDERS.get('tx:' + id))) return id;
  }
  return null;
}
async function findOnChain(env, o) {
  const coin = orderCoin(o), until = o.expiresAt + COINS[coin].graceMs;
  if (COINS[coin].kind === 'manual') return null;
  if (COINS[coin].kind === 'bsc') return await findBsc(env, o);
  if (coin === 'btc') {
    for (const t of await btcIn(o, null)) {
      if (!t.confirmed || t.value !== o.amount) continue;
      if (t.bt < o.createdAt - 120000 || t.bt > until) continue;
      if (!(await env.ORDERS.get('tx:' + t.txid))) return t.txid;
    }
    return null;
  }
  const list = await trc20In(env, o, false);
  for (const t of list) {
    if (String(t.value) === String(o.amount) && t.ts >= o.createdAt - 60000 && t.ts <= until && !(await env.ORDERS.get('tx:' + t.txid))) return t.txid;
  }
  return null;
}
// Incoming Bitcoin payments to the order's wallet: mempool.space first, blockstream.info as a second source (same data format).
// Returns [{txid, value (sats), confirmed, bt (ms)}] for every output paying the wallet.
async function btcIn(o, notes) {
  const out = [];
  for (const base of ['https://mempool.space/api', 'https://blockstream.info/api']) {
    try {
      const res = await fetch(base + '/address/' + o.wallet + '/txs', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { if (notes) notes.push(base.split('/')[2] + ' answered HTTP ' + res.status); continue; }
      const d = await res.json();
      if (notes) notes.push(base.split('/')[2] + ' ok, ' + d.length + ' recent transaction(s)');
      for (const t of d) for (const v of t.vout || []) if (v.scriptpubkey_address === o.wallet) out.push({ txid: t.txid, value: v.value, confirmed: !!(t.status && t.status.confirmed), bt: t.status && t.status.block_time ? t.status.block_time * 1000 : 0 });
      return out;
    } catch (e) { if (notes) notes.push(base.split('/')[2] + ' failed: ' + (e && e.message)); }
  }
  return out;
}
// Incoming USDT transfers to the order's wallet from TronGrid, with TronScan as a second source (TronGrid's free tier is often rate-limited).
// Returns [{txid, value, ts}]. With dbg=true returns {list, notes} so the dashboard can explain what happened.
async function trc20In(env, o, dbg) {
  const notes = [], out = [], seen = new Set();
  const add = (txid, value, ts) => { if (txid && !seen.has(txid)) { seen.add(txid); out.push({ txid, value: String(value), ts }); } };
  try {
    const res = await fetch('https://api.trongrid.io/v1/accounts/' + o.wallet + '/transactions/trc20' +
      '?only_confirmed=true&only_to=true&limit=200&contract_address=' + USDT_CONTRACT + '&min_timestamp=' + (o.createdAt - 60000),
      { headers: env.TRONGRID_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_KEY } : {}, signal: AbortSignal.timeout(8000) });
    if (!res.ok) notes.push('TronGrid answered HTTP ' + res.status + (res.status === 429 ? ' (rate-limited: add a free TRONGRID_KEY secret)' : ''));
    else {
      const d = (await res.json()).data || [];
      notes.push('TronGrid ok, ' + d.length + ' incoming USDT transfer(s) since the order was created');
      for (const t of d) if (t.to === o.wallet && t.type === 'Transfer' && t.token_info && t.token_info.address === USDT_CONTRACT) add(t.transaction_id, t.value, t.block_timestamp);
    }
  } catch (e) { notes.push('TronGrid failed: ' + (e && e.message)); }
  if (!out.length || dbg) {
    try {
      const res = await fetch('https://apilist.tronscanapp.com/api/token_trc20/transfers?limit=50&start=0&confirm=true&contract_address=' + USDT_CONTRACT +
        '&toAddress=' + o.wallet + '&start_timestamp=' + (o.createdAt - 60000), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) notes.push('TronScan answered HTTP ' + res.status);
      else {
        const d = (await res.json()).token_transfers || [];
        notes.push('TronScan ok, ' + d.length + ' incoming USDT transfer(s)');
        for (const t of d) if (t.to_address === o.wallet && (t.contract_address || USDT_CONTRACT) === USDT_CONTRACT && (t.finalResult || t.contractRet || 'SUCCESS') === 'SUCCESS') add(t.transaction_id, t.quant, t.block_ts);
      }
    } catch (e) { notes.push('TronScan failed: ' + (e && e.message)); }
  }
  return dbg ? { list: out, notes } : out;
}
async function findPayment(env, o) {
  const coin = orderCoin(o), C = COINS[coin];
  if (C.kind === 'manual') return binanceOn(env) ? await findBinancePay(env, o) : null;
  let tx = null, err = null;
  try { tx = await findOnChain(env, o); } catch (e) { err = e; }
  if (tx) return tx;
  if (binanceOn(env)) {
    const cat = await getCatalog(env);
    if (cat && cat.binanceAddr && cat.binanceAddr[coin]) { try { tx = await findBinanceDeposit(env, o); } catch (e) { err = err || e; } if (tx) return tx; }
  }
  if (err) throw err;
  return null;
}
async function checkOrder(env, o) {
  if (o.status !== 'pending') return o;
  const coin = orderCoin(o), C = COINS[coin], now = Date.now();
  if (now > o.expiresAt + C.graceMs) {
    o.status = 'expired'; await ptsRefund(env, o); await saveOrder(env, o);
    await env.ORDERS.delete(o.amtKey || ('amt:' + o.amount));
    return o;
  }
  if (now - (lastLook.get(o.id) || 0) < (C.throttle || (binanceOn(env) ? 6000 : 0))) return o;   // memory only: no storage write
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
// Full-version preview (view only). The shop shows it inside a locked-down frame; the code is scrambled in transit.
// This is a deterrent, not a vault: anything a browser can display can in theory be extracted, so previews are
// rate-limited per visitor and never include the download/copy tools.
const prevHits = new Map();
// Tiled diagonal watermark baked into the preview HTML itself, so anyone who copies the markup copies the watermark too (and a tiny script restores it if it is deleted)
function watermarkHTML(name) {
  const t = String(name || 'Geostore').replace(/[<>&"'\\]/g, '').slice(0, 36) + ' · preview only';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="340" height="190"><text x="170" y="95" text-anchor="middle" transform="rotate(-24 170 95)" font-family="Arial,sans-serif" font-size="21" font-weight="700" fill="#7a7a7a">' + t + '</text></svg>';
  const bg = 'url(&quot;data:image/svg+xml,' + encodeURIComponent(svg).replace(/'/g, '%27') + '&quot;)';
  const div = '<div id="__wm" style="position:fixed;inset:0;z-index:2147483647;pointer-events:none;opacity:.22;background:' + bg + ' repeat"></div>';
  return div + '<script>(function(){var h=' + J(div) + ';setInterval(function(){if(!document.getElementById("__wm"))document.documentElement.insertAdjacentHTML("beforeend",h)},700)})()<\/script>';
}
async function fullPreview(req, env, id, vi) {
  const ip = ipOf(req);
  if (tooMany(prevHits, ip, 40, 10 * 60000)) return fail(env, 'Too many previews. Please wait a few minutes.', 429);
  const cat = await getCatalog(env), p = cat && cat.products && cat.products[id];
  if (!p || p.type === 'digital' || p.hidden) return fail(env, 'Not found', 404);
  const txt = await env.ORDERS.get('prod:' + id, 'text'); if (!txt) return fail(env, 'Not found', 404);
  const v = (JSON.parse(txt).variants || [])[vi]; if (!v || !v.full) return fail(env, 'Not found', 404);
  let html = String(v.full);
  if (p.wm !== false) { const w = watermarkHTML(cat.storeName), i = html.search(/<\/body>/i); html = i >= 0 ? html.slice(0, i) + w + html.slice(i) : html + w; }
  const key = hex(16), kb = new TextEncoder().encode(key), data = new TextEncoder().encode(html);
  for (let i = 0; i < data.length; i++) data[i] ^= kb[i % kb.length];
  let bin = ''; for (let i = 0; i < data.length; i += 8192) bin += String.fromCharCode.apply(null, data.subarray(i, i + 8192));
  return json(env, { k: key, d: btoa(bin) });
}

async function deliveryData(env, o, cat) {
  const prods = cat.products || {}, parts = [], jobs = [];
  const head = (id, p) => '{"id":' + J(id) + ',"title":' + J(p.title) + ',"tagline":' + J(p.tagline || '') + ',"files":' + J((p.files || []).map(f => ({ id: f.id, name: f.name, size: f.size, url: f.url || undefined }))) + ',';
  async function code(id, styles) {
    const p = prods[id]; if (!p) return null;
    const txt = await env.ORDERS.get('prod:' + id, 'text'); if (!txt) return null;
    if (!styles) return head(id, p) + txt.slice(1);              // whole product: no parsing needed
    const d = JSON.parse(txt); d.variants = styles.map(i => d.variants[i]).filter(Boolean);
    return d.variants.length ? head(id, p) + J(d).slice(1) : null;
  }
  for (const l of itemsOf(o)) {
    if (l.id === 'ALL') { Object.keys(prods).forEach(id => { const p = prods[id]; if (p.type !== 'digital' && (p.variants || []).length) jobs.push(code(id)); }); continue; }
    const p = prods[l.id] || (l.gift ? { title: l.title, tagline: '', type: 'digital' } : null); if (!p) continue;
    if (p.type === 'digital') {
      const c = o.codes && !Array.isArray(o.codes) ? o.codes[l.id] : (Array.isArray(o.codes) ? o.codes[0] : '');
      const list = (o.codeList && o.codeList[l.id]) || (c ? [c] : []);
      jobs.push(Promise.resolve(head(l.id, p) + '"code":' + J(list.join('\n\n')) + ',"codes":' + J(list) + ',"qty":' + qtyOf(l) + '}'));
    } else jobs.push(code(l.id, l.mode === 'styles' && Array.isArray(l.styles) ? l.styles : null));
  }
  (await Promise.all(jobs)).forEach(x => { if (x) parts.push(x); });
  const coin = orderCoin(o), inv = { no: 'INV-' + o.id.slice(0, 8).toUpperCase(), createdAt: o.createdAt, paidAt: o.paidAt || null, items: itemsOf(o).map(i => ({ title: i.title, price: i.price, qty: qtyOf(i), unit: i.unit || null })), total: o.usd, coin: COINS[coin].name, network: COINS[coin].network, amount: fmtAmount(coin, o.amount), txid: o.txid && o.txid !== 'manual' ? o.txid : '' };
  inv.txUrl = !inv.txid || /^(bp|bn):/.test(inv.txid) ? '' : coin === 'btc' ? 'https://mempool.space/tx/' + inv.txid : coin === 'usdt_bep20' ? 'https://bscscan.com/tx/' + inv.txid : 'https://tronscan.org/#/transaction/' + inv.txid;
  const rvd = (await featCfg(env)).reviews ? !!(await env.ORDERS.get('rev:' + o.id, 'text')) : true;
  return '{"order":' + J({ id: o.id.slice(0, 8), email: o.email, invoice: inv, reviewed: rvd }) + ',"lang":' + J(o.lang === 'ar' ? 'ar' : 'en') + ',"store":' + J(cat.storeName || '') + ',"logo":' + J(LOGO_DATA) + ',"sections":[' + parts.join(',') + ']}';
}
const LOGO_DATA = 'data:image/png;base64,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';
const SHELL_CORE = String.raw`
function guardFn(){var t;function note(m){var n=document.getElementById("__dm");if(!n){n=document.createElement("div");n.id="__dm";n.style.cssText="position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;background:#111;color:#fff;border:1px solid #8cf04d;padding:10px 16px;border-radius:99px;font:600 13px system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);max-width:92vw;text-align:center;opacity:0;transition:opacity .2s;pointer-events:none";document.body.appendChild(n)}n.textContent=m;n.style.opacity=1;clearTimeout(t);t=setTimeout(function(){n.style.opacity=0},2800)}
document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");if(!a)return;var h=a.getAttribute("href")||"";if(h.length>1&&h.charAt(0)==="#"){e.preventDefault();var el=document.getElementById(h.slice(1));if(el)el.scrollIntoView({behavior:"smooth"});else note("Demo: this link has no page in the preview");return}e.preventDefault();note(h==="#"||h===""?"Demo link — in your real site this goes to your own page":"Demo: this link goes to another page ("+h.slice(0,40)+") that you add in your real site")},true);
document.addEventListener("submit",function(e){if(!e.defaultPrevented){e.preventDefault();note("Demo form — connect it to your email or server in your real site")}});
window.open=function(u){note("Demo: this would open "+String(u||"a new page").slice(0,50)+" in your real site");return null}}
function guard(html){html=String(html||"");var g="<script>("+guardFn.toString()+")()<\/script>",i=html.lastIndexOf("</body>");return i<0?html+g:html.slice(0,i)+g+html.slice(i)}
function fsize(n){return n>1048576?(n/1048576).toFixed(1)+" MB":Math.max(1,Math.round(n/1024))+" KB"}
var AR={"Scratch the silver area (or press Reveal). Keep your codes private — whoever has them can use them.":"اخدش المنطقة الفضية (أو اضغط «اكشف الرمز»). احتفظ برموزك سرّية — فمن يملكها يستطيع استخدامها.","Light or dark mode": "الوضع الفاتح أو الداكن", "Almost there…": "اقتربنا…", "Order complete": "اكتمل الطلب", "Your payment is confirmed. We are preparing your code — this page updates by itself.": "تم تأكيد دفعتك. نجهّز رمزك الآن — تتحدّث هذه الصفحة تلقائياً.", "Thank you! Your items are below, with your invoice at the bottom.": "شكراً لك! مشترياتك أدناه، وفاتورتك في الأسفل.", "This is your saved copy": "هذه نسختك المحفوظة", "⬇ Save everything as one file": "⬇ احفظ كل شيء في ملف واحد", "🧾 Print / save invoice": "🧾 اطبع / احفظ الفاتورة", "Project files": "ملفات المشروع", "How to use & connect your data": "طريقة الاستخدام وربط بياناتك", "Full code": "الكود الكامل", "Copy code": "انسخ الكود", "Copied ✓": "تم النسخ ✓", "Invoice": "الفاتورة", "Total (USD)": "المجموع (دولار)", "Billed to": "فاتورة إلى", "Paid with": "طريقة الدفع", "Amount sent": "المبلغ المرسل", "Network": "الشبكة", "Transaction": "المعاملة", "Licence: use website code in your own and your clients' projects. Do not resell or share the code files themselves. Gift cards and codes are digital goods and cannot be returned once revealed.": "الترخيص: استخدم أكواد المواقع في مشاريعك ومشاريع عملائك. لا تعد بيع ملفات الأكواد ولا تشاركها. بطاقات الهدايا والأكواد سلع رقمية ولا يمكن إرجاعها بعد كشفها.", "YOUR CODE": "رمزك", "Reveal code": "اكشف الرمز", "✦ SCRATCH HERE TO REVEAL ✦": "✦ اخدش هنا للكشف ✦", "How was your order?": "كيف كان طلبك؟", "Your honest review helps other customers. Thank you!": "رأيك الصادق يساعد العملاء الآخرين. شكراً لك!", "Your name (optional)": "اسمك (اختياري)", "Tell us what you think (optional)": "أخبرنا برأيك (اختياري)", "Send review": "أرسل التقييم", "Please tap the stars first.": "اضغط على النجوم أولاً.", "Thank you! ❤️": "شكراً لك! ❤️", "Your review was sent. It appears on the shop after we check it.": "تم إرسال تقييمك. سيظهر في المتجر بعد مراجعته.", "You already reviewed this order. Thank you!": "لقد قيّمت هذا الطلب مسبقاً. شكراً لك!", "Open your order page online to download this file.": "افتح صفحة طلبك عبر الإنترنت لتنزيل هذا الملف."},LANG="en";
function T(s){if(LANG!=="ar")return s;if(AR[s])return AR[s];var m;if(m=/^Code (\d+) of (\d+)$/.exec(s))return "الرمز "+m[1]+" من "+m[2];if(m=/^Preparing your code[\s\S]*contact us with (.+)\.$/.exec(s))return "نجهّز رمزك… يستغرق ذلك بضع ثوانٍ. إذا لم يظهر خلال بضع دقائق، تواصل معنا مع ذكر "+m[1]+".";return s}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=T(x);return e}
function money(n){n=Math.round(n*100)/100;return "$"+(n%1===0?String(n):n.toFixed(2))}
function fdate(ms){return ms?new Date(ms).toLocaleString([],{dateStyle:"medium",timeStyle:"short"}):""}
function cp(btn,text,label){btn.onclick=function(){function d(){btn.textContent="Copied ✓";setTimeout(function(){btn.textContent=label},1500)}if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(d,d)}else{try{var a=document.createElement("textarea");a.value=text;document.body.appendChild(a);a.select();document.execCommand("copy");a.remove()}catch(e){}d()}}}
function revKey(k){return "geo_rev_"+k}
function wasRevealed(k){try{return localStorage.getItem(revKey(k))==="1"}catch(e){return false}}
function markRevealed(k){try{localStorage.setItem(revKey(k),"1")}catch(e){}}
/* scratch card: scratch the silver layer with a finger or the mouse (or press Reveal) */
function scratchCard(title,code,key){
  var box=el("div","sc"),under=el("div","sc-under");
  under.appendChild(el("small","","YOUR CODE"));
  var cd=el("div","sc-code",code);under.appendChild(cd);
  var acts=el("div","sc-acts"),cb=el("button","btn","Copy code");cp(cb,code,"Copy code");acts.appendChild(cb);under.appendChild(acts);
  box.appendChild(under);
  if(wasRevealed(key)){box.className+=" open";return box}
  var cv=document.createElement("canvas");cv.className="sc-cv";cv.setAttribute("aria-hidden","true");box.appendChild(cv);
  var rb=el("button","sc-rev","Reveal code");box.appendChild(rb);
  var done=false;
  function open(){if(done)return;done=true;markRevealed(key);cv.className+=" gone";rb.remove();box.className+=" open";setTimeout(function(){cv.remove()},600)}
  rb.onclick=open;
  function paint(){
    var w=box.clientWidth,h=box.clientHeight;if(!w||!h){setTimeout(paint,80);return}
    cv.width=w;cv.height=h;var c=cv.getContext("2d");
    var g=c.createLinearGradient(0,0,w,h);g.addColorStop(0,"#c9d1c4");g.addColorStop(.5,"#e9eee5");g.addColorStop(1,"#aab4a4");c.fillStyle=g;c.fillRect(0,0,w,h);
    c.globalAlpha=.35;c.strokeStyle="#8d9988";c.lineWidth=2;for(var x=-h;x<w+h;x+=14){c.beginPath();c.moveTo(x,0);c.lineTo(x+h,h);c.stroke()}c.globalAlpha=1;
    c.fillStyle="#5d6958";c.font="700 "+Math.max(14,Math.min(20,w/18))+"px system-ui,sans-serif";c.textAlign="center";c.textBaseline="middle";c.fillText(T("✦ SCRATCH HERE TO REVEAL ✦"),w/2,h/2);
    var down=false,lx=0,ly=0,n=0;
    function pos(e){var r=cv.getBoundingClientRect();return[e.clientX-r.left,e.clientY-r.top]}
    function line(a,b){c.globalCompositeOperation="destination-out";c.lineCap="round";c.lineJoin="round";c.lineWidth=Math.max(36,w/9);c.beginPath();c.moveTo(a[0],a[1]);c.lineTo(b[0],b[1]);c.stroke();c.globalCompositeOperation="source-over"}
    function coverage(){var d=c.getImageData(0,0,w,h).data,t=0,k=0;for(var y=0;y<h;y+=9){for(var x=0;x<w;x+=9){t++;if(d[(y*w+x)*4+3]<100)k++}}return k/t}
    cv.addEventListener("pointerdown",function(e){down=true;cv.setPointerCapture&&cv.setPointerCapture(e.pointerId);var p=pos(e);lx=p[0];ly=p[1];line([lx,ly],[lx+.1,ly+.1]);e.preventDefault()});
    cv.addEventListener("pointermove",function(e){if(!down)return;var p=pos(e);line([lx,ly],p);lx=p[0];ly=p[1];if(++n%6===0&&coverage()>.42)open();e.preventDefault()});
    function up(){down=false;if(!done&&coverage()>.42)open()}
    cv.addEventListener("pointerup",up);cv.addEventListener("pointercancel",up);
  }
  setTimeout(paint,30);return box;
}
var ICONS={sun:'<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',moon:'<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/></svg>'};
function themeBtn(){
  var b=el("button","tbtn");b.type="button";b.setAttribute("aria-label",T("Light or dark mode"));
  function paint(){b.innerHTML=document.documentElement.getAttribute("data-theme")==="dark"?ICONS.sun:ICONS.moon}
  b.onclick=function(){var n=document.documentElement.getAttribute("data-theme")==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",n);try{localStorage.setItem("geo_theme",n)}catch(e){}paint()};
  paint();return b;
}
function reviewCard(){
  var oid=(location.pathname.match(/\/api\/delivery\/([a-f0-9]{32})/)||[])[1];if(!oid)return null;
  var k=new URLSearchParams(location.search).get("k")||"";
  var c=el("section","card"),hd=el("div","ch");hd.appendChild(el("h2","","How was your order?"));hd.appendChild(el("p","d","Your honest review helps other customers. Thank you!"));c.appendChild(hd);
  var rate=0,stars=el("div","stars"),bs=[];
  for(var i=1;i<=5;i++)(function(i){var b=el("button","star","★");b.type="button";b.setAttribute("aria-label",i+" / 5");b.onclick=function(){rate=i;bs.forEach(function(x,j){x.className="star"+(j<i?" on":"")})};bs.push(b);stars.appendChild(b)})(i);
  c.appendChild(stars);
  var nm=el("input","rin");nm.placeholder=T("Your name (optional)");nm.maxLength=40;
  var tx=el("textarea","rin");tx.placeholder=T("Tell us what you think (optional)");tx.maxLength=600;tx.rows=3;
  var go=el("button","btn","Send review"),msg=el("p","d tiny","");
  go.onclick=function(){if(!rate){msg.textContent=T("Please tap the stars first.");return}go.disabled=true;
    fetch(location.origin+"/api/review",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:oid,k:k,rating:rate,text:tx.value,name:nm.value})}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||"Error");return j})}).then(function(){c.innerHTML="";c.appendChild(el("h2","","Thank you! ❤️"));c.appendChild(el("p","d","Your review was sent. It appears on the shop after we check it."))}).catch(function(e){go.disabled=false;msg.textContent=T(e.message)})};
  c.appendChild(nm);c.appendChild(tx);c.appendChild(go);c.appendChild(msg);return c;
}
window.__render=function(d,app){
  app.innerHTML="";var inv=d.order.invoice||{};
  LANG=d.lang==="ar"?"ar":"en";if(LANG==="ar"){document.documentElement.dir="rtl";document.documentElement.lang="ar"}
  var top=el("div","tb"),br=el("div","bn");
  if(d.logo){var im=document.createElement("img");im.src=d.logo;im.alt="";im.width=36;im.height=36;br.appendChild(im)}
  br.appendChild(el("span","",d.store||"Your order"));top.appendChild(br);top.appendChild(themeBtn());app.appendChild(top);
  var pending=d.sections.some(function(s){return s.code===""});
  var hero=el("div","hero2");
  var ck=el("div","ck",pending?"…":"✓");hero.appendChild(ck);
  hero.appendChild(el("h1","",pending?"Almost there…":"Order complete"));
  hero.appendChild(el("p","d",pending?"Your payment is confirmed. We are preparing your code — this page updates by itself.":"Thank you! Your items are below, with your invoice at the bottom."));
  var meta=el("div","meta");meta.appendChild(el("span","",inv.no||("Order "+d.order.id)));if(inv.paidAt)meta.appendChild(el("span","",fdate(inv.paidAt)));meta.appendChild(el("span","",d.order.email));hero.appendChild(meta);
  var row=el("div","hrow");
  var dl=el("button","btn ghost",window.__standalone?"This is your saved copy":"⬇ Save everything as one file");if(window.__standalone)dl.disabled=true;else dl.onclick=function(){window.__download(d)};row.appendChild(dl);
  var pr=el("button","btn ghost","🧾 Print / save invoice");pr.onclick=function(){document.body.classList.add("pinv");setTimeout(function(){window.print();setTimeout(function(){document.body.classList.remove("pinv")},500)},50)};row.appendChild(pr);
  hero.appendChild(row);app.appendChild(hero);
  var n=0;
  d.sections.forEach(function(s,idx){
    var sec=el("section","card");var hd=el("div","ch");hd.appendChild(el("h2","",s.title));if(s.tagline)hd.appendChild(el("p","d",s.tagline));sec.appendChild(hd);
    if(s.code!==undefined){
      var list=(s.codes&&s.codes.length)?s.codes:(s.code?[s.code]:[]);
      if(list.length){list.forEach(function(c,ci){if(list.length>1){var lb=el("p","d","Code "+(ci+1)+" of "+list.length);lb.style.cssText="margin:14px 0 0;font-weight:700";sec.appendChild(lb)}sec.appendChild(scratchCard(s.title,c,d.order.id+"_"+idx+"_"+ci))});sec.appendChild(el("p","d tiny","Scratch the silver area (or press Reveal). Keep your codes private — whoever has them can use them."))}
      else{var w=el("div","wait");w.appendChild(el("span","spin"));w.appendChild(el("span","","Preparing your code… this takes a few seconds. If it does not appear within a few minutes, contact us with "+(inv.no||d.order.id)+"."));sec.appendChild(w)}
    }else{
      if(s.files&&s.files.length){var fb=el("div","files");fb.appendChild(el("b","","Project files"));
        var oid=(location.pathname.match(/\/api\/delivery\/([a-f0-9]{32})/)||[])[1];
        s.files.forEach(function(f){var a=el("a","btn fbtn","⬇ "+f.name+(f.size?" ("+fsize(f.size)+")":""));
          if(f.url){a.href=f.url;a.target="_blank";a.rel="noopener noreferrer"}
          else if(oid&&!window.__standalone){a.href=location.origin+"/api/download/"+oid+"/"+encodeURIComponent(s.id)+"/"+f.id+location.search}
          else{a.href="#";a.onclick=function(e){e.preventDefault();alert(T("Open your order page online to download this file."))}}
          fb.appendChild(a)});sec.appendChild(fb)}
      if(s.guide){var det=el("details","gd");det.open=true;det.appendChild(el("summary","","How to use & connect your data"));var gb=el("div","gb");gb.innerHTML=s.guide;det.appendChild(gb);sec.appendChild(det)}
      (s.variants||[]).forEach(function(v){
        var h3=el("h3","vh",v.name);sec.appendChild(h3);
        var f=document.createElement("iframe");f.setAttribute("sandbox","allow-scripts allow-forms");f.title="Preview";f.srcdoc=guard(v.full);sec.appendChild(f);
        var bar=el("div","bar");bar.appendChild(el("b","","Full code"));var b=el("button","btn","Copy code");cp(b,v.full,"Copy code");bar.appendChild(b);sec.appendChild(bar);sec.appendChild(el("pre","",v.full));
      });
    }
    app.appendChild(sec);
  });
  /* invoice */
  var iv=el("section","card invoice"),ih=el("div","ch");ih.appendChild(el("h2","","Invoice"));ih.appendChild(el("p","d",(inv.no||"")+" · "+fdate(inv.paidAt||inv.createdAt)));iv.appendChild(ih);
  var t=el("table","it"),tb=el("tbody");
  (inv.items||[]).forEach(function(i){var tr=el("tr");tr.appendChild(el("td","",i.title));tr.appendChild(el("td","r",money(i.price)));tb.appendChild(tr)});
  var tt=el("tr","tot");tt.appendChild(el("td","","Total (USD)"));tt.appendChild(el("td","r",money(inv.total||0)));tb.appendChild(tt);t.appendChild(tb);iv.appendChild(t);
  var dtl=el("dl","pd");
  function kv(k,v,link){dtl.appendChild(el("dt","",k));var dd=el("dd");if(link){var a=el("a","",v);a.href=link;a.target="_blank";a.rel="noopener";dd.appendChild(a)}else dd.textContent=v;dtl.appendChild(dd)}
  kv("Billed to",d.order.email);kv("Paid with",inv.coin||"");kv("Amount sent",(inv.amount||"")+" "+((inv.coin||"").split(" ")[0]));kv("Network",inv.network||"");
  if(inv.txid)kv("Transaction",inv.txid.slice(0,14)+"…"+inv.txid.slice(-6),inv.txUrl||null);
  iv.appendChild(dtl);app.appendChild(iv);
  if(!pending&&!d.order.reviewed&&!window.__standalone){var rc=reviewCard();if(rc)app.appendChild(rc)}
  app.appendChild(el("p","d tiny","Licence: use website code in your own and your clients' projects. Do not resell or share the code files themselves. Gift cards and codes are digital goods and cannot be returned once revealed."));
  if(pending&&!window.__standalone&&!window.__poll){var tries=0;window.__poll=setInterval(function(){if(++tries>24){clearInterval(window.__poll);return}fetch(location.pathname+"/data"+location.search).then(function(r){return r.json()}).then(function(nd){if(!nd.sections.some(function(s){return s.code===""})){clearInterval(window.__poll);window.__poll=null;window.__render(nd,app)}}).catch(function(){})},6000)}
};
window.__download=function(d){
  var css=document.getElementById("css").textContent,core=document.getElementById("core").textContent;
  var html='<!DOCTYPE html><html lang="en" data-theme="'+(document.documentElement.getAttribute("data-theme")||"light")+'"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My order</title><style id="css">'+css+'</style></head><body><div class="w" id="app"></div><script id="core">'+core+'<\/script><script>window.__standalone=true;var DATA='+JSON.stringify(d).replace(/</g,"\\u003c")+';window.__render(DATA,document.getElementById("app"))<\/script></body></html>';
  var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([html],{type:"text/html"}));a.download="my-order.html";document.body.appendChild(a);a.click();a.remove();
};
`;
const SHELL_CSS = ':root{--bg:#f3f7ef;--surface:#fff;--s2:#f0f5ec;--bd:#dbe5d4;--bd2:#c6d4bd;--tx:#0e1a0b;--mu:#586651;--ac:#3d9a0e;--ac2:#2f7d09;--on:#fff;--soft:rgba(61,154,14,.11);color-scheme:light}' +
  '[data-theme=dark]{--bg:#060d08;--surface:#0e1a12;--s2:#13241a;--bd:rgba(255,255,255,.09);--bd2:rgba(255,255,255,.16);--tx:#eef6e9;--mu:#8fa188;--ac:#8cf04d;--ac2:#a6f873;--on:#0b1a00;--soft:rgba(140,240,77,.12);color-scheme:dark}' +
  '*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--tx);line-height:1.55;-webkit-font-smoothing:antialiased}' +
  '.w{max-width:860px;margin:auto;padding:16px 16px 70px}.d{color:var(--mu);margin:6px 0}.tiny{font-size:.8rem}' +
  '.tb{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.bn{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.1rem}.bn img{border-radius:10px}' +
  '.tbtn{width:40px;height:40px;border-radius:50%;border:1px solid var(--bd2);background:var(--surface);color:var(--tx);display:grid;place-items:center;cursor:pointer}' +
  '.hero2{text-align:center;padding:22px 16px;margin:8px 0 18px;border:1px solid var(--bd);border-radius:22px;background:linear-gradient(160deg,var(--soft),transparent 70%),var(--surface)}' +
  '.ck{width:68px;height:68px;margin:0 auto 10px;border-radius:50%;background:var(--ac);color:var(--on);display:grid;place-items:center;font-size:2rem;font-weight:800}' +
  '.hero2 h1{margin:0;font-size:1.7rem;letter-spacing:-.03em}.meta{display:flex;gap:8px 16px;flex-wrap:wrap;justify-content:center;font-size:.82rem;color:var(--mu);margin:10px 0 14px}' +
  '.meta span:first-child{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:700;color:var(--tx)}.hrow{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}' +
  '.btn{background:var(--ac);color:var(--on);border:0;padding:0 18px;min-height:42px;border-radius:999px;font:inherit;font-weight:700;font-size:.9rem;cursor:pointer}.btn.ghost{background:var(--surface);color:var(--tx);border:1px solid var(--bd2)}.btn:disabled{opacity:.55;cursor:default}' +
  '.card{margin-top:16px;padding:18px;border:1px solid var(--bd);border-radius:20px;background:var(--surface);box-shadow:0 1px 2px rgba(14,26,11,.05),0 10px 28px -16px rgba(14,26,11,.2)}' +
  '.ch h2{margin:0;font-size:1.15rem;letter-spacing:-.02em}.vh{margin:20px 0 6px;font-size:1rem}' +
  'iframe{width:100%;height:380px;border:1px solid var(--bd);border-radius:14px;background:#fff;margin:8px 0}' +
  '.bar{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:8px 0}' +
  'pre{max-height:320px;overflow:auto;background:var(--s2);border:1px solid var(--bd);border-radius:14px;padding:14px;font-size:.78rem;color:var(--tx);white-space:pre-wrap;word-break:break-word}' +
  '.gd{margin:12px 0;border:1px solid var(--bd);border-radius:14px;background:var(--s2)}.gd summary{cursor:pointer;padding:12px 16px;font-weight:700;color:var(--ac2)}.gb{padding:4px 18px 16px;font-size:.93rem}.gb h4{margin:16px 0 4px}.gb code{background:var(--soft);padding:1px 6px;border-radius:5px;font-size:.85em}.gb ul,.gb ol{margin:6px 0 6px 20px}.gb a{color:var(--ac2)}' +
  '.sc{position:relative;margin-top:14px;border-radius:18px;overflow:hidden;min-height:132px;border:2px dashed var(--bd2);background:var(--s2)}' +
  '.sc-under{padding:22px 18px 18px;text-align:center}.sc-under small{display:block;font-size:.7rem;letter-spacing:.14em;font-weight:800;color:var(--mu)}' +
  '.sc-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:clamp(1.15rem,4.6vw,1.6rem);font-weight:800;letter-spacing:.04em;margin:8px 0 12px;white-space:pre-wrap;word-break:break-all;user-select:all}' +
  '.sc.open{border-style:solid;border-color:var(--ac)}.sc-cv{position:absolute;inset:0;width:100%;height:100%;touch-action:none;cursor:crosshair;transition:opacity .5s}.sc-cv.gone{opacity:0;pointer-events:none}' +
  '.sc-rev{position:absolute;right:10px;bottom:10px;background:rgba(14,26,11,.85);color:#fff;border:0;border-radius:999px;padding:7px 14px;font:inherit;font-size:.76rem;font-weight:700;cursor:pointer}' +
  '.wait{display:flex;gap:12px;align-items:center;margin-top:12px;padding:14px 16px;border-radius:14px;background:var(--soft);font-weight:600;font-size:.92rem}.spin{width:20px;height:20px;border-radius:50%;border:3px solid var(--bd2);border-top-color:var(--ac);animation:sp 1s linear infinite;flex:none}@keyframes sp{to{transform:rotate(360deg)}}' +
  '.it{width:100%;border-collapse:collapse;margin:8px 0 12px}.it td{padding:10px 4px;border-bottom:1px solid var(--bd)}.it .r{text-align:right;white-space:nowrap}.it .tot td{font-weight:800;font-size:1.05rem;border-bottom:0}' +
  '.pd{display:grid;grid-template-columns:auto 1fr;gap:6px 18px;margin:0;font-size:.88rem}.pd dt{color:var(--mu)}.pd dd{margin:0;word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.82rem}.pd a{color:var(--ac2)}' +
  '.files{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:14px 0 4px}.files b{width:100%;font-size:.95rem}.fbtn{text-decoration:none;word-break:break-all}' +
  '.stars{display:flex;gap:6px;margin:12px 0}.star{background:none;border:0;font-size:2.1rem;color:var(--bd2);cursor:pointer;padding:0 2px;line-height:1}.star.on{color:#f5a623}.rin{display:block;width:100%;font:inherit;padding:10px 12px;border:1px solid var(--bd2);border-radius:12px;background:var(--s2);color:var(--tx);margin:8px 0}' +
  '[dir=rtl] .sc-rev{right:auto;left:10px}[dir=rtl] .it .r{text-align:left}[dir=rtl] .pd dd,[dir=rtl] pre,[dir=rtl] .sc-code{direction:ltr;text-align:left}' +
  '@media print{body{background:#fff;color:#000}.tb,.hero2,.btn,.tbtn{display:none!important}body.pinv .card:not(.invoice){display:none}.card{box-shadow:none;border:0}}' +
  '@media(max-width:560px){.w{padding:12px 12px 60px}.hero2 h1{font-size:1.45rem}.card{padding:14px;border-radius:18px}.pd{grid-template-columns:1fr}.pd dd{margin-bottom:6px}}';
function shellPage(storeName) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Your order — ' + esc(storeName) + '</title>' +
    '<script>try{var t=localStorage.getItem("geo_theme");document.documentElement.setAttribute("data-theme",t==="dark"?"dark":"light")}catch(e){document.documentElement.setAttribute("data-theme","light")}<\/script>' +
    '<style id="css">' + SHELL_CSS + '</style></head><body><div class="w" id="app"><p class="d">Loading your order…</p></div>' +
    '<script id="core">' + SHELL_CORE.replace(/<\/script/g, '<\\/script') + '<\/script>' +
    '<script>fetch(location.pathname+"/data"+location.search).then(function(r){if(!r.ok)throw 0;return r.json()}).then(function(d){window.__render(d,document.getElementById("app"))}).catch(function(){document.getElementById("app").textContent="Could not load your order. Please refresh the page or contact us with your order ID."})<\/script></body></html>';
}
async function delivery(env, id, url, wantData) {
  const o = await env.ORDERS.get('order:' + id, 'json');
  const k = url.searchParams.get('k') || '';
  if (!o || !safeEqual(k, o.key)) return new Response('Not found', { status: 404 });
  if (o.status !== 'paid') return new Response('This order has not been paid yet.', { status: 402 });
  if (wantData) await ensureFulfilled(env, o);
  const cat = await getCatalog(env) || { products: {} };
  if (wantData) return new Response(await deliveryData(env, o, cat), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  return new Response(shellPage(cat.storeName || ''), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src 'self' https:; frame-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
}

/* ---------------- admin ---------------- */
// The dashboard uploads each product on its own (small requests), then the small index.
/* ---- project files: ZIPs (or any file) delivered after payment; stored privately in KV (max 20 MB each) or given as a private link ---- */
const FILE_ID = /^[a-f0-9]{8,32}$/, MAX_FILE = 20 * 1024 * 1024;
function cleanFiles(list) {
  return (Array.isArray(list) ? list : []).slice(0, 8).map(f => {
    if (!f || !FILE_ID.test(String(f.id || ''))) return null;
    const out = { id: String(f.id), name: String(f.name || 'file').replace(/[\u0000-\u001f\\\/"<>|:*?]/g, '_').slice(0, 120) || 'file', size: Math.max(0, Number(f.size) || 0) };
    if (f.url) { const u = String(f.url); if (!/^https:\/\/[^\s"'<>]{4,600}$/.test(u)) return null; out.url = u; }
    return out;
  }).filter(Boolean);
}
async function adminFile(req, env, url) {
  const pid = String(url.searchParams.get('pid') || ''), fid = String(url.searchParams.get('fid') || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(pid) || !FILE_ID.test(fid)) return fail(env, 'Bad file id');
  if (req.method === 'DELETE') { await env.ORDERS.delete('file:' + pid + ':' + fid); return json(env, { ok: true }); }
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return fail(env, 'The file is empty');
  if (buf.byteLength > MAX_FILE) return fail(env, 'This file is bigger than 20 MB. Use “Add a download link” for big files (Google Drive, Mega, Dropbox).');
  await env.ORDERS.put('file:' + pid + ':' + fid, buf);
  return json(env, { ok: true, size: buf.byteLength });
}
const dlHits = new Map();
async function downloadFile(req, env, m, url) {
  if (tooMany(dlHits, ipOf(req), 40, 10 * 60000)) return fail(env, 'Too many downloads. Please wait a few minutes.', 429);
  const [, oid, pid, fid] = m, o = await env.ORDERS.get('order:' + oid, 'json');
  if (!o || !safeEqual(url.searchParams.get('k') || '', o.key) || o.status !== 'paid') return new Response('Not found', { status: 404 });
  const items = itemsOf(o), has = items.some(i => i.id === pid || i.id === 'ALL');
  const cat = await getCatalog(env), meta = cat && cat.products && cat.products[pid], f = meta && (meta.files || []).find(x => x.id === fid && !x.url);
  if (!has || !f) return new Response('Not found', { status: 404 });
  const buf = await env.ORDERS.get('file:' + pid + ':' + fid, 'arrayBuffer');
  if (!buf) return new Response('This file is not available. Please contact us with your order number.', { status: 404 });
  return new Response(buf, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="' + f.name.replace(/"/g, '') + '"', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
async function adminProduct(req, env) {
  const p = await req.json().catch(() => null);
  if (!p || !p.id) return fail(env, 'Bad data');
  const id = String(p.id);
  const variants = (Array.isArray(p.variants) ? p.variants : []).map(v => ({ name: String(v.name || ''), full: String(v.full || '') })).filter(v => v.full);
  await env.ORDERS.put('prod:' + id, J({ guide: String(p.guide || '').slice(0, 30000), variants, fileIds: cleanFiles(p.files).map(f => ({ id: f.id })) }));
  if (p.type === 'digital') {
    const stock = (Array.isArray(p.stock) ? p.stock : []).map(String).filter(Boolean);
    await env.ORDERS.put('stock:' + id, J(stock)); extraMem.v = null; cfgMem = { t: 0, v: null };
    if (stock.length > (Number(await env.ORDERS.get('used:' + id)) || 0)) bg(env, restock(env, id));   // tell the people who were waiting
  }
  return json(env, { ok: true, id });
}
function cleanSup(x) {
  if (!x || typeof x !== 'object') return undefined;
  const r = x.rule || {}, mode = r.mode === 'fixed' ? 'fixed' : 'percent', value = Math.min(Math.max(Number(r.value) || 0, 0), mode === 'fixed' ? 1000 : 500), cats = {};
  Object.keys(x.cats || {}).slice(0, 4000).forEach(id => { if (/^[A-Za-z0-9_-]{1,80}$/.test(id)) cats[id] = { n: String((x.cats[id] && x.cats[id].n) || '').slice(0, 80) }; });
  const tcats = {};
  Object.keys(x.tcats || {}).slice(0, 500).forEach(id => { if (/^[A-Za-z0-9_-]{1,80}$/.test(id)) tcats[id] = { n: String((x.tcats[id] && x.tcats[id].n) || '').slice(0, 80) }; });
  const over = {};
  Object.keys(x.over || {}).slice(0, 4000).forEach(k => { const v = Number(x.over[k]); if (/^[A-Za-z0-9_-]{1,80}:[A-Za-z0-9_.-]{1,80}$/.test(k) && v > 0 && v < 100000) over[k] = round2(v); });
  return { rule: { mode, value }, cats, tcats, over };
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
      stockN: Number(p.stockN) || 0, published: p.published !== false, wm: p.wm !== false, files: cleanFiles(p.files),
      supplier: p.supplier && p.supplier.cat && p.supplier.card ? { kind: 'giftcard', cat: String(p.supplier.cat).slice(0, 120), card: String(p.supplier.card).slice(0, 120) } : undefined
    };
  });
  for (const id of (Array.isArray(b.remove) ? b.remove : []).slice(0, 100)) { const pd = await env.ORDERS.get('prod:' + id, 'json').catch(() => null); for (const f of (pd && pd.fileIds) || []) if (FILE_ID.test(String(f.id))) await env.ORDERS.delete('file:' + id + ':' + f.id); await env.ORDERS.delete('prod:' + id); await env.ORDERS.delete('stock:' + id); }
  const aa = b.allAccess || {}, w = b.wallets || {};
  catMem = { t: 0, v: null }; cfgMem = { t: 0, v: null };
  await env.ORDERS.put('idx', J({
    storeName: String(b.storeName || ''), site: siteOk(b.site), products,
    wallets: { usdt_trc20: String(w.usdt_trc20 || '').trim().slice(0, 120), usdt_bep20: String(w.usdt_bep20 || '').trim().slice(0, 120), btc: String(w.btc || '').trim().slice(0, 120), binancepay: String(w.binancepay || '').trim().slice(0, 160) },
    sup: cleanSup(b.sup),
    binanceAddr: { usdt_trc20: !!(b.binanceAddr && b.binanceAddr.usdt_trc20), usdt_bep20: !!(b.binanceAddr && b.binanceAddr.usdt_bep20) },
    allAccess: { enabled: !!aa.enabled, title: String(aa.title || 'All-Access Pass'), price: Number(aa.price) || 0 }
  }));
  return json(env, { ok: true, products: Object.keys(products).length });
}
// Everything the server can see about money for this order, from every source, so you can find a payment that did not match
async function diagnoseOrder(env, o) {
  const coin = orderCoin(o), C = COINS[coin], notes = [], seen = [], refs = new Set();
  const info = { status: o.status, coin, expects: fmtAmount(coin, o.amount), wallet: o.wallet, notes, seen };
  const iso = t => t ? new Date(Number(t)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
  const add = (display, mic, ref, when) => { if (!ref || refs.has(ref)) return; refs.add(ref); seen.push({ amount: display, micro: mic, ref, when, match: mic === o.amount }); };
  if (binanceOn(env) && C.kind !== 'btc') {
    try { const l = await bnPayList(env, o); notes.push('Binance Pay history: OK (' + l.length + ' record(s))'); l.forEach(t => { const a = Number(t.amount), cur = String(t.currency || ''); if (a > 0) add(a + ' ' + cur + ' · Binance Pay', cur === 'USDT' ? micro(a) : null, 'bp:' + (t.transactionId || t.orderId || t.transactionTime), iso(t.transactionTime)); }); } catch (e) { notes.push('Binance Pay history: ' + String((e && e.message) || e)); }
    try { const l = await bnDepositList(env, o); notes.push('Binance deposit history: OK (' + l.length + ' record(s))'); l.forEach(t => { const internal = Number(t.transferType) === 1; add(t.amount + ' USDT · Binance ' + (internal ? 'internal transfer' : t.network), micro(t.amount), internal || !t.txId ? 'bn:' + t.id : String(t.txId), iso(t.insertTime)); }); } catch (e) { notes.push('Binance deposit history: ' + String((e && e.message) || e)); }
  } else if (C.kind === 'manual') notes.push('Binance Pay orders are confirmed by hand until the Binance API key is added.');
  if (coin === 'usdt_trc20') { const r = await trc20In(env, o, true); r.notes.forEach(n => notes.push(n)); r.list.forEach(t => add((Number(t.value) / 1e6) + ' USDT · blockchain', Number(t.value), t.txid, iso(t.ts))); }
  else if (C.kind === 'bsc') { try { const l = await bscIn(o, notes); l.forEach(t => add(Number(t.value / 1000000000000n) / 1e6 + ' USDT · blockchain', Number(t.value / 1000000000000n), t.hash, t.conf + ' blocks ago')); } catch (e) { notes.push('Could not reach any BNB Chain node: ' + String((e && e.message) || e)); } }
  else if (coin === 'btc') { const l = await btcIn(o, notes); l.forEach(t => add((t.value / 1e8).toFixed(8) + ' BTC · ' + (t.confirmed ? 'confirmed' : 'waiting for 1 confirmation'), t.value, t.txid, '')); }
  for (const x of seen) { x.used = !!(await env.ORDERS.get('tx:' + x.ref)); x.near = !x.match && !x.used && coin !== 'btc' && x.micro != null && Math.abs(x.micro - o.amount) <= 500000; }
  if (!seen.length) notes.push('No incoming payment found yet. Check the wallet address in Settings is the one that received the money.');
  else if (seen.some(x => x.match && !x.used)) notes.push('A matching payment is visible — the order should confirm within a minute.');
  else if (seen.some(x => x.near)) notes.push('A payment close to the expected amount arrived (see the list). If the customer says it is theirs, accept it.');
  else notes.push('Money arrived, but none of it is the exact amount ' + info.expects + '.');
  return info;
}
// Safety net, run by a Cloudflare Cron Trigger every few minutes: confirms payments even when the customer closed the page,
// and tells you on Telegram about Binance money that matches no order.
async function sweep(env) {
  const ids = ((await env.ORDERS.get('oidx', 'json')) || []).slice(-40).reverse();
  const orders = (await Promise.all(ids.map(id => env.ORDERS.get('order:' + id, 'json')))).filter(Boolean);
  let n = 0;
  for (const o of orders) { if (o.status === 'pending' && n < 10) { n++; try { await checkOrder(env, o); } catch (e) { /* next time */ } } else if (o.status === 'paid' && n < 10) { try { const before = o.fulfil && Object.values(o.fulfil).some(f => f.state === 'wait'); if (before) { n++; await ensureFulfilled(env, o); } } catch (e) { /* next time */ } } }
  await sweepCarts(env).catch(() => {});
  if (!binanceOn(env)) return;
  const probe = { createdAt: Date.now() - 2 * 3600000 }, found = [];
  try { for (const t of await bnPayList(env, probe)) { const a = Number(t.amount), cur = String(t.currency || ''); if (a > 0 && cur === 'USDT') found.push({ ref: 'bp:' + (t.transactionId || t.orderId || t.transactionTime), amt: a, kind: 'Binance Pay' }); } } catch (e) { /* diagnostics show it */ }
  try { for (const t of await bnDepositList(env, probe)) if ([1, 6].includes(Number(t.status))) found.push({ ref: Number(t.transferType) === 1 || !t.txId ? 'bn:' + t.id : String(t.txId), amt: Number(t.amount), kind: Number(t.transferType) === 1 ? 'Binance transfer' : 'Binance deposit (' + t.network + ')' }); } catch (e) { /* diagnostics show it */ }
  let alerts = 0;
  for (const f of found) {
    if (alerts >= 3 || !(f.amt >= 0.5)) continue;
    if (await env.ORDERS.get('tx:' + f.ref) || await env.ORDERS.get('unm:' + f.ref)) continue;
    await env.ORDERS.put('unm:' + f.ref, '1', { expirationTtl: 7 * 86400 }); alerts++;
    notify(env, '💰 <b>Binance payment not matched to any order</b>\n' + f.amt + ' USDT · ' + esc(f.kind) + '\nIf a customer says it is theirs: Orders → find their order → <b>Why not paid?</b> → accept it.');
  }
}
async function adminOrders(env) {
  const ids = ((await env.ORDERS.get('oidx', 'json')) || []).slice(-100).reverse();
  let list = (await Promise.all(ids.map(id => env.ORDERS.get('order:' + id, 'json')))).filter(Boolean);
  list = await Promise.all(list.map((o, i) => o.status === 'pending' && i < 8 ? checkOrder(env, o) : (i < 8 ? ensureFulfilled(env, o) : o)));   // refresh waiting orders
  const expiredN = list.filter(o => o.status === 'expired').length;
  const orders = list.map(o => ({ id: o.id, email: o.email, title: orderTitle(o), item: o.item || '', amount: fmtAmount(orderCoin(o), o.amount), coin: COINS[orderCoin(o)].short, coinName: COINS[orderCoin(o)].name, usd: o.usd || null, status: o.status, createdAt: o.createdAt, paidAt: o.paidAt || null, txid: o.txid || null, key: o.key, account: o.account || null, claimed: o.claimed || null,
    fulfil: fulfilState(o), fulfilErr: Object.values(o.fulfil || {}).map(f => f.error).filter(Boolean)[0] || '', cost: round2(supplierLines(o).reduce((a, l) => a + (Number(l.supplier.cost) || 0) * qtyOf(l), 0)) || null, fromBinance: !!o.fromBinance }));
  return json(env, { orders, expiredN });
}
// Delete orders that expired without being paid (frees storage; they are of no use to you or the customer)
async function purgeExpired(env) {
  const ids = (await env.ORDERS.get('oidx', 'json')) || [], keep = [], dead = [];
  const orders = await Promise.all(ids.map(id => env.ORDERS.get('order:' + id, 'json')));
  const now = Date.now();
  ids.forEach((id, i) => {
    const o = orders[i];
    if (!o) { dead.push(null); return; }                                  // already gone: just drop from the index
    const coin = orderCoin(o), gone = o.status === 'expired' || (o.status === 'pending' && now > o.expiresAt + COINS[coin].graceMs + 3600000);
    if (gone && dead.filter(Boolean).length < 80) dead.push(o); else keep.push(id);
  });
  for (const o of dead) if (o) { await env.ORDERS.delete('order:' + o.id); await env.ORDERS.delete(o.amtKey || ('amt:' + o.amount)).catch(() => {}); }
  if (dead.length) await env.ORDERS.put('oidx', JSON.stringify(keep));
  return json(env, { ok: true, deleted: dead.filter(Boolean).length, more: dead.filter(Boolean).length >= 80 });
}
async function adminCustomers(env, url) {
  const all = ((await env.ORDERS.get('cidx', 'json')) || []).slice().reverse();
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const customers = (await Promise.all(all.slice(offset, offset + 100).map(e => env.ORDERS.get('acct:' + e, 'json')))).filter(Boolean)
    .map(a => ({ email: a.email, name: a.name || '', phone: a.phone || '', country: a.country || '', createdAt: a.createdAt, orders: (a.orders || []).length, points: Math.max(0, Math.floor(Number(a.pts) || 0)), disabled: !!a.disabled }));
  return json(env, { customers, total: all.length, next: offset + 100 < all.length ? offset + 100 : null });
}
async function adminCustomer(req, env, url, apiBase) {
  const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
  const acct = email && await env.ORDERS.get('acct:' + email, 'json');
  if (!acct) return fail(env, 'Customer not found', 404);
  let found = (await Promise.all((acct.orders || []).slice(-100).reverse().map(id => env.ORDERS.get('order:' + id, 'json')))).filter(Boolean);
  found = await Promise.all(found.map((o, i) => o.status === 'pending' && i < 5 ? checkOrder(env, o) : o));
  const orders = found.map(o => publicOrder(env, o, apiBase));
  return json(env, { ptsLog: (acct.ptsLog || []).slice(-30).reverse(), profile: Object.assign(profileOf(acct), { disabled: !!acct.disabled, note: acct.note || '' }), orders, spent: round2(orders.filter(o => o.status === 'paid').reduce((a, o) => a + (Number(o.usd) || 0), 0)) });
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
  } else if (act === 'points') {                          // set an exact balance, or add/remove with delta
    const reason = String(b.reason || '').trim().slice(0, 60) || 'Edited by the shop';
    if (b.set !== undefined && b.set !== null && b.set !== '') { const v = Math.floor(Number(b.set)); if (!(v >= 0 && v <= 1e9)) return fail(env, 'Enter a number of points (0 or more)'); ptsAdd(acct, v - Math.floor(Number(acct.pts) || 0), reason); }
    else { const d = Math.floor(Number(b.delta)); if (!Number.isFinite(d) || d === 0 || Math.abs(d) > 1e9) return fail(env, 'Enter how many points to add or remove'); ptsAdd(acct, d, reason); }
    await env.ORDERS.put(key, J(acct));
    return json(env, { ok: true, points: acct.pts });
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

/* ---------------- shop extras: delivery-time stat, reviews, back-in-stock alerts, abandoned-cart email ---------------- */
async function featCfg(env) {
  const c = await env.ORDERS.get('feat:cfg', 'json').catch(() => null) || {};
  return { cart: c.cart !== false, reviews: c.reviews !== false, notify: c.notify !== false };
}
// real delivery time: seconds between "payment confirmed" and "everything delivered", kept for the last 50 orders
async function dlRecord(env, o) {
  if (o.dlRec || !o.paidAt) return; o.dlRec = true;
  const done = Object.values(o.fulfil || {}).reduce((m, f) => Math.max(m, f.doneAt || 0), 0);
  const sec = Math.min(3600, Math.max(0, Math.round(((done || Date.now()) - o.paidAt) / 1000)));
  try { const s = await env.ORDERS.get('stat:dl', 'json') || { r: [] }; s.r = (s.r || []).concat(sec).slice(-50); await env.ORDERS.put('stat:dl', J(s)); } catch (e) { /* a statistic: never block */ }
}
const extraMem = { t: 0, v: null };
async function shopExtras(env, cat) {
  if (extraMem.v && Date.now() - extraMem.t < 60000) return extraMem.v;
  const out = {};
  try {
    const s = await env.ORDERS.get('stat:dl', 'json'), r = ((s && s.r) || []).slice().sort((a, b) => a - b);
    if (r.length >= 5) out.dl = { sec: r[Math.floor(r.length / 2)], n: r.length };
  } catch (e) { /* none yet */ }
  const f = await featCfg(env);
  if (f.reviews) { try { const p = await env.ORDERS.get('rev:pub', 'json'); if (p && p.count) out.rv = { avg: p.avg, count: p.count }; } catch (e) { /* none yet */ } }
  if (f.notify) {
    const oos = [];
    for (const id of Object.keys((cat && cat.products) || {})) {
      const p = cat.products[id]; if (p.type !== 'digital' || p.supplier || p.published === false) continue;
      if ((p.stockN || 0) - (Number(await env.ORDERS.get('used:' + id)) || 0) <= 0) oos.push(id);
      if (oos.length >= 60) break;
    }
    if (oos.length) out.oos = oos;
  }
  out.cart = f.cart && mailOn(env);
  extraMem.t = Date.now(); extraMem.v = out;
  return out;
}

/* e-mails written in the customer's language (English or Arabic) */
const MT = {
  en: { cartSub: 'You left something in your cart', cartH: 'Still thinking it over?', cartP: 'Your cart is saved. Complete your order in a minute:', cartBtn: 'Back to my cart', total: 'Total', stop: 'Do not want these reminders?', stopLink: 'Unsubscribe',
    recSub: 'Payment received — order #', recH: 'Payment received ✓', recP: 'Thank you! Your payment is confirmed. Your order, codes and invoice are on your private order page:', recBtn: 'Open my order & codes', paidWith: 'Paid with', orderNo: 'Order number', txn: 'Transaction', txView: 'view on the blockchain', binTx: 'Binance transfer', recFoot: 'Keep this email private: anyone with the button link can open your codes. If a code does not work or something looks wrong, just reply to this email or contact us with your order number.', pts: 'Points earned on this order',
    stockSub: 'Back in stock', stockH: 'It is back!', stockP: 'You asked us to tell you when this item is available again:', stockBtn: 'Get it now', foot: 'You are receiving this because you asked for it on our shop.' },
  ar: { cartSub: 'لقد نسيت شيئاً في سلتك', cartH: 'هل ما زلت تفكر؟', cartP: 'سلتك محفوظة. أكمل طلبك خلال دقيقة:', cartBtn: 'العودة إلى سلتي', total: 'المجموع', stop: 'لا تريد هذه التذكيرات؟', stopLink: 'إلغاء الاشتراك',
    recSub: 'تم استلام الدفعة — الطلب #', recH: 'تم استلام الدفعة ✓', recP: 'شكراً لك! تم تأكيد دفعتك. طلبك وأكوادك وفاتورتك في صفحة طلبك الخاصة:', recBtn: 'افتح طلبي وأكوادي', paidWith: 'طريقة الدفع', orderNo: 'رقم الطلب', txn: 'المعاملة', txView: 'عرض على البلوكتشين', binTx: 'تحويل Binance', recFoot: 'احتفظ بهذه الرسالة بسرية: أي شخص يملك رابط الزر يستطيع فتح أكوادك. إذا لم يعمل أحد الأكواد أو بدا أن شيئاً غير صحيح فرُدّ على هذه الرسالة أو تواصل معنا مع رقم طلبك.', pts: 'النقاط المكتسبة من هذا الطلب',
    stockSub: 'عاد إلى المخزون', stockH: 'لقد عاد!', stockP: 'طلبت أن نخبرك عندما يتوفر هذا المنتج من جديد:', stockBtn: 'احصل عليه الآن', foot: 'تصلك هذه الرسالة لأنك طلبتها في متجرنا.' }
};
const mt = (l, k) => (MT[l] || MT.en)[k];
function mailShell(store, lang, head, body, btn, url, foot) {
  const rtl = lang === 'ar';
  return '<div dir="' + (rtl ? 'rtl' : 'ltr') + '" style="background:#f3f7ef;padding:24px 12px;font-family:Arial,Helvetica,sans-serif"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:18px;overflow:hidden;border:1px solid #dfe8da;text-align:' + (rtl ? 'right' : 'left') + '">' +
    '<div style="background:#3d9a0e;color:#fff;padding:22px 26px"><div style="font-size:13px;opacity:.9">' + esc(store || 'Geostore') + '</div><div style="font-size:24px;font-weight:800;margin-top:4px">' + esc(head) + '</div></div>' +
    '<div style="padding:22px 26px;color:#0e1a0b;font-size:15px">' + body + '<p style="margin:20px 0"><a href="' + esc(url) + '" style="display:inline-block;background:#3d9a0e;color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:999px">' + esc(btn) + '</a></p>' +
    '<p style="margin:18px 0 0;font-size:12.5px;color:#6a7864">' + foot + '</p></div></div></div>';
}
const siteOk = s => /^https:\/\/[A-Za-z0-9.-]{3,100}(:\d{2,5})?$/.test(String(s || '')) ? String(s) : '';
const langOf = l => l === 'ar' ? 'ar' : 'en';
const mailSecret = env => String(env.SESSION_SECRET || env.ADMIN_TOKEN || '');

/* reviews */
async function rebuildReviews(env) {
  const ids = ((await env.ORDERS.get('ridx', 'json')) || []).slice(-100).reverse();
  const all = (await Promise.all(ids.map(id => env.ORDERS.get('rev:' + id, 'json')))).filter(r => r && r.st === 'ok');
  const count = all.length, avg = count ? Math.round(all.reduce((a, r) => a + r.r, 0) / count * 10) / 10 : 0;
  await env.ORDERS.put('rev:pub', J({ avg, count, list: all.slice(0, 30).map(r => ({ n: r.name, r: r.r, x: r.text, t: r.t, i: r.item })) }));
  extraMem.v = null; cfgMem = { t: 0, v: null };
}
async function submitReview(req, env) {
  if (tooMany(ipHits, 'rv|' + (ipOf(req)), 6, 10 * 60000)) return fail(env, 'Too many attempts. Please wait a few minutes.', 429);
  const b = await req.json().catch(() => null) || {};
  if (!(await featCfg(env)).reviews) return fail(env, 'Reviews are switched off', 403);
  const id = String(b.id || ''); if (!/^[a-f0-9]{32}$/.test(id)) return fail(env, 'Order not found', 404);
  const o = await env.ORDERS.get('order:' + id, 'json');
  if (!o || !safeEqual(String(b.k || ''), o.key) || o.status !== 'paid') return fail(env, 'Order not found', 404);
  const rating = Math.round(Number(b.rating)); if (!(rating >= 1 && rating <= 5)) return fail(env, 'Please choose 1 to 5 stars');
  if (await env.ORDERS.get('rev:' + id, 'text')) return fail(env, 'You already reviewed this order. Thank you!', 409);
  const rv = { id, r: rating, text: String(b.text || '').trim().slice(0, 600), name: String(b.name || '').trim().slice(0, 40) || 'Customer', t: Date.now(), st: 'new', item: orderTitle(o).slice(0, 80) };
  await env.ORDERS.put('rev:' + id, J(rv)); await pushIndex(env, 'ridx', id, 500);
  notify(env, '⭐ <b>New review</b> (' + '★'.repeat(rating) + ')\n' + esc(rv.name) + ': ' + esc(rv.text.slice(0, 200)) + '\nApprove it in the dashboard → Customers → Reviews.');
  return json(env, { ok: true });
}
async function adminReviews(env) {
  const ids = ((await env.ORDERS.get('ridx', 'json')) || []).slice(-100).reverse();
  return json(env, { reviews: (await Promise.all(ids.map(id => env.ORDERS.get('rev:' + id, 'json')))).filter(Boolean) });
}
async function adminReviewAct(req, env) {
  const b = await req.json().catch(() => ({})), id = String(b.id || ''), k = 'rev:' + id;
  const rv = /^[a-f0-9]{32}$/.test(id) && await env.ORDERS.get(k, 'json'); if (!rv) return fail(env, 'Review not found', 404);
  if (b.action === 'approve' || b.action === 'hide') { rv.st = b.action === 'approve' ? 'ok' : 'hidden'; await env.ORDERS.put(k, J(rv)); }
  else if (b.action === 'delete') { await env.ORDERS.delete(k); await env.ORDERS.put('ridx', J(((await env.ORDERS.get('ridx', 'json')) || []).filter(x => x !== id))); }
  else return fail(env, 'Unknown action');
  await rebuildReviews(env);
  return json(env, { ok: true });
}

/* "notify me" when a sold-out item is back */
async function notifyMe(req, env) {
  if (tooMany(ipHits, 'nm|' + (ipOf(req)), 8, 10 * 60000)) return fail(env, 'Too many attempts. Please wait a few minutes.', 429);
  const b = await req.json().catch(() => null) || {}, pid = String(b.pid || ''), email = String(b.email || '').trim().toLowerCase();
  if (!validEmail(email)) return fail(env, 'Please enter a valid email address');
  const cat = await getCatalog(env), p = cat && cat.products && cat.products[pid];
  if (!p || p.type !== 'digital' || p.supplier) return fail(env, 'This item cannot be watched', 400);
  const k = 'nm:' + pid, list = await env.ORDERS.get(k, 'json') || [];
  if (!list.some(x => x.e === email)) { list.push({ e: email, s: siteOk(b.site), l: langOf(b.lang) }); await env.ORDERS.put(k, J(list.slice(-300))); }
  return json(env, { ok: true });
}
async function restock(env, pid) {
  if (!mailOn(env) || !(await featCfg(env)).notify) return;
  const k = 'nm:' + pid, list = await env.ORDERS.get(k, 'json'); if (!list || !list.length) return;
  const cat = await getCatalog(env), p = cat && cat.products && cat.products[pid]; if (!p) return;
  const now = list.slice(0, 40), rest = list.slice(40);
  if (rest.length) await env.ORDERS.put(k, J(rest)); else await env.ORDERS.delete(k);
  for (const w of now) {
    if (!w.s) continue;
    try { await sendMail(env, w.e, mt(w.l, 'stockSub') + ' — ' + p.title, mailShell(cat.storeName, w.l, mt(w.l, 'stockH'), '<p style="margin:0 0 10px">' + mt(w.l, 'stockP') + '</p><p style="font-weight:700;font-size:17px;margin:0">' + esc(p.title) + '</p>', mt(w.l, 'stockBtn'), w.s + '/', mt(w.l, 'foot'))); } catch (e) { /* one bad address must not stop the rest */ }
  }
}

/* abandoned cart: one reminder per customer, only if they did not order, with a working unsubscribe link */
async function saveCart(req, env, apiBase) {
  const ip = ipOf(req);
  if (tooMany(ipHits, 'cart|' + ip, 10, 10 * 60000)) return fail(env, 'Too many attempts', 429);
  const b = await req.json().catch(() => null) || {}, email = String(b.email || '').trim().toLowerCase();
  if (!validEmail(email) || !mailOn(env) || !(await featCfg(env)).cart) return json(env, { ok: true, saved: false });
  const site = siteOk(b.site), cat = await getCatalog(env); if (!site || !cat) return json(env, { ok: true, saved: false });
  const items = [];
  for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, 8)) {
    const id = String((it && it.id) || ''), p = cat.products && cat.products[id];
    if (p) items.push({ t: String(p.title).slice(0, 70), p: Number(p.price) || 0 });
    else if (id === 'ALL' && cat.allAccess && cat.allAccess.enabled) items.push({ t: String(cat.allAccess.title).slice(0, 70), p: Number(cat.allAccess.price) || 0 });
    else if (/^(g|t):/.test(id) || /gift|topup/.test(id)) items.push({ t: String(it.title || 'Gift card').replace(/[<>]/g, '').slice(0, 60), p: Math.min(Number(it.price) || 0, 1000) });
  }
  if (!items.length) return json(env, { ok: true, saved: false });
  const k = 'cart:' + email, old = await env.ORDERS.get(k, 'json');
  if (await env.ORDERS.get('nocart:' + email, 'text')) return json(env, { ok: true, saved: false });
  const c = { t: Date.now(), items, usd: round2(items.reduce((a, i) => a + i.p, 0)), site, base: apiBase || new URL(req.url).origin, l: langOf(b.lang), sent: old ? !!old.sent : false };
  await env.ORDERS.put(k, J(c), { expirationTtl: 7 * 86400 });
  if (!old) await pushIndex(env, 'kidx', email, 300);
  return json(env, { ok: true, saved: true });
}
async function cartStop(env, url) {
  const e = String(url.searchParams.get('e') || '').toLowerCase(), s = String(url.searchParams.get('s') || '');
  if (!validEmail(e) || !mailSecret(env) || !safeEqual(s, (await hmacHex(mailSecret(env), 'cart|' + e)).slice(0, 24))) return new Response('Link not valid', { status: 400 });
  await env.ORDERS.put('nocart:' + e, '1', { expirationTtl: 365 * 86400 }); await env.ORDERS.delete('cart:' + e);
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:Arial;text-align:center;padding:60px 20px"><h2>✓ Done / تم</h2><p>No more reminders. / لن تصلك تذكيرات بعد الآن.</p></body>', { headers: { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' } });
}
async function sweepCarts(env) {
  if (!mailOn(env) || !mailSecret(env) || !(await featCfg(env)).cart) return;
  const cat = await getCatalog(env), emails = ((await env.ORDERS.get('kidx', 'json')) || []).slice(-25);
  let sent = 0;
  for (const e of emails) {
    if (sent >= 5) break;
    const c = await env.ORDERS.get('cart:' + e, 'json'); if (!c || c.sent) continue;
    const age = Date.now() - c.t; if (age < 3600000 || age > 48 * 3600000) continue;
    c.sent = true; await env.ORDERS.put('cart:' + e, J(c), { expirationTtl: 7 * 86400 }); sent++;
    const a = await env.ORDERS.get('acct:' + e, 'json');                     // ordered since? then stay quiet
    if (a) { const last = (await Promise.all((a.orders || []).slice(-3).map(id => env.ORDERS.get('order:' + id, 'json')))).filter(Boolean); if (last.some(o => o.createdAt > c.t)) continue; }
    const stop = (c.base || env.__base || '') + '/api/cart/stop?e=' + encodeURIComponent(e) + '&s=' + (await hmacHex(mailSecret(env), 'cart|' + e)).slice(0, 24);
    const rows = c.items.map(i => '<tr><td style="padding:7px 0;border-bottom:1px solid #e6ece4">' + esc(i.t) + '</td><td style="padding:7px 0;border-bottom:1px solid #e6ece4;text-align:' + (c.l === 'ar' ? 'left' : 'right') + ';font-weight:600">$' + round2(i.p) + '</td></tr>').join('');
    const body = '<p style="margin:0 0 12px">' + mt(c.l, 'cartP') + '</p><table style="width:100%;border-collapse:collapse;font-size:14px">' + rows + '<tr><td style="padding:9px 0;font-weight:800">' + mt(c.l, 'total') + '</td><td style="padding:9px 0;text-align:' + (c.l === 'ar' ? 'left' : 'right') + ';font-weight:800">$' + c.usd + '</td></tr></table>';
    try { await sendMail(env, e, mt(c.l, 'cartSub'), mailShell(cat && cat.storeName, c.l, mt(c.l, 'cartH'), body, mt(c.l, 'cartBtn'), c.site + '/', mt(c.l, 'foot') + ' ' + mt(c.l, 'stop') + ' <a href="' + esc(stop) + '" style="color:#2f7d09">' + mt(c.l, 'stopLink') + '</a>')); } catch (er) { /* once is enough */ }
  }
}

/* ---------------- router ---------------- */
async function route(req, env) {
  const url = new URL(req.url);
  let apiBase = url.origin;
  if (req.headers.get('x-nf-client-connection-ip')) { const c0 = await getCatalog(env).catch(() => null); if (c0 && c0.site) apiBase = c0.site; }   // came through the shop's own address: links in emails use it too
  const path = url.pathname.replace(/\/+$/, '');
  try {
    if (path === '/api/health') {
      let wallet = !!(env.WALLET || env.WALLET_BTC);
      if (env.ORDERS && !wallet) { try { const c = await getCatalog(env); wallet = !!(c && c.wallets && (c.wallets.usdt_trc20 || c.wallets.btc)); } catch (e) { /* ignore */ } }
      return json(env, { ok: true, wallet, admin: !!env.ADMIN_TOKEN, kv: !!env.ORDERS, supplier: !!env.FAZER_KEY, telegram: !!env.TELEGRAM_BOT_TOKEN, version: 22, mail: mailOn(env), binance: binanceOn(env), relay: !!env.BINANCE_RELAY });
    }
    if (!env.ORDERS) return fail(env, 'Storage (KV binding named ORDERS) is not connected', 503);
    if (req.method === 'POST' && !path.startsWith('/api/admin/') && Number(req.headers.get('content-length') || 0) > 65536) return fail(env, 'Request too large', 413);
    if (path === '/api/config' && req.method === 'GET') {
      // the same answer for every visitor: keep it for 20 seconds (memory) and let the shop's own address cache it too, so 1000 visitors cost only a few reads
      if (cfgMem.v && Date.now() - cfgMem.t < 20000) return new Response(cfgMem.v, { headers: PUB_HEADERS });
      const cat = await getCatalog(env);
      const prices = {}; if (cat && cat.products) Object.keys(cat.products).forEach(id => { const q = cat.products[id]; prices[id] = { price: q.price, stylePrice: q.stylePrice || 0 }; });
      const pc = await ptsCfg(env), ex = await shopExtras(env, cat);
      const body = JSON.stringify({ ex, pts: pc.on ? pc : { on: false }, storeName: cat ? cat.storeName : '', prices, allAccess: cat && cat.allAccess ? { price: cat.allAccess.price } : null, accounts: !!(env.ADMIN_TOKEN || env.SESSION_SECRET),
        coins: Object.keys(COINS).filter(c => walletFor(env, cat, c)).map(c => ({ id: c, name: COINS[c].name, network: COINS[c].network, kind: COINS[c].kind || (c === 'btc' ? 'btc' : 'tron'), minutes: COINS[c].minutes, binance: !!(cat && cat.binanceAddr && cat.binanceAddr[c]) })), binanceAuto: binanceOn(env), chat: chatOn(env) });

      cfgMem = { t: Date.now(), v: body };
      return new Response(body, { headers: PUB_HEADERS });
    }
    let pm = path.match(/^\/api\/preview\/([A-Za-z0-9_-]{1,64})\/(\d{1,2})$/);
    if (pm && req.method === 'GET') return await fullPreview(req, env, pm[1], +pm[2]);
    if (path === '/api/gift/offers' && req.method === 'GET') return await giftRoute(req, env, url);
    if (path === '/api/topup/offers' && req.method === 'GET') return await topupRoute(req, env, url);
    if (path === '/api/topup/validate' && req.method === 'POST') return await topupValidate(req, env);
    if (path === '/api/chat/send' && req.method === 'POST') return await chatSend(req, env);
    if (path === '/api/chat/poll' && req.method === 'GET') return await chatPoll(req, env, url);
    let tm = path.match(/^\/api\/telegram\/([A-Za-z0-9]{16,64})$/);
    if (tm && req.method === 'POST') return await telegramHook(req, env, tm[1]);
    if (path === '/api/reviews' && req.method === 'GET') { const p = await env.ORDERS.get('rev:pub', 'text'); return new Response(p || '{"avg":0,"count":0,"list":[]}', { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', 'netlify-cdn-cache-control': 'public, max-age=60, stale-while-revalidate=300', 'access-control-allow-origin': '*' } }); }
    if (path === '/api/review' && req.method === 'POST') return await submitReview(req, env);
    if (path === '/api/notify-me' && req.method === 'POST') return await notifyMe(req, env);
    if (path === '/api/cart' && req.method === 'POST') return await saveCart(req, env, apiBase);
    if (path === '/api/cart/stop' && req.method === 'GET') return await cartStop(env, url);
    if (path === '/api/order' && req.method === 'POST') return await createOrder(req, env, apiBase);
    let cm = path.match(/^\/api\/order\/([a-f0-9]{32})\/claim$/);
    if (cm && req.method === 'POST') {
      if (tooMany(ipHits, 'claim|' + (ipOf(req)), 20, 10 * 60000)) return fail(env, 'Too many attempts. Please wait a few minutes.', 429);
      const o = await env.ORDERS.get('order:' + cm[1], 'json'), b = await req.json().catch(() => ({}));
      if (!o) return fail(env, 'Order not found', 404);
      if (o.status === 'pending' && !o.claimed && COINS[orderCoin(o)].kind === 'manual') { o.claimed = { at: Date.now(), ref: String(b.ref || '').slice(0, 80) }; await saveOrder(env, o); notify(env, '🟡 <b>Binance Pay</b> — customer says they paid #' + o.id.slice(0, 8).toUpperCase() + '\n$' + o.usd + ' · ' + esc(o.email) + (o.claimed.ref ? '\nref: ' + esc(o.claimed.ref) : '') + '\nCheck Binance, then Orders → Mark paid.'); }
      return json(env, publicOrder(env, o, apiBase));
    }
    let m = path.match(/^\/api\/order\/([a-f0-9]{32})$/);
    if (m && req.method === 'GET') {
      let o = await env.ORDERS.get('order:' + m[1], 'json');
      if (!o) return fail(env, 'Order not found', 404);
      o = await ensureFulfilled(env, await checkOrder(env, o));
      return json(env, publicOrder(env, o, apiBase));
    }
    m = path.match(/^\/api\/delivery\/([a-f0-9]{32})(\/data)?$/);
    if (m && req.method === 'GET') return await delivery(env, m[1], url, !!m[2]);
    m = path.match(/^\/api\/download\/([a-f0-9]{32})\/([A-Za-z0-9_-]{1,64})\/([a-f0-9]{8,32})$/);
    if (m && req.method === 'GET') return await downloadFile(req, env, m, url);
    if (path.startsWith('/api/account/')) return await accountRoutes(req, env, path, apiBase);
    if (path.startsWith('/api/admin/')) {
      const aip = 'adm|' + (ipOf(req));
      if ((authHits.get(aip) || []).filter(t => Date.now() - t < 10 * 60000).length >= 12) return fail(env, 'Too many failed attempts. Please wait a few minutes.', 429);
      if (!isAdmin(req, env)) { tooMany(authHits, aip, 99, 10 * 60000); return fail(env, 'Wrong or missing admin token', 401); }
      if (path === '/api/admin/product' && req.method === 'POST') return await adminProduct(req, env);
      if (path === '/api/admin/file' && (req.method === 'PUT' || req.method === 'DELETE')) return await adminFile(req, env, url);
      if (path === '/api/admin/index' && req.method === 'POST') return await adminIndex(req, env);
      if (path === '/api/admin/ping') return json(env, { ok: true });
      if (path === '/api/admin/orders' && req.method === 'GET') return await adminOrders(env);
      if (path === '/api/admin/chats' && req.method === 'GET') return await adminChats(env);
      if (path === '/api/admin/chat' && req.method === 'GET') return await adminChat(req, env, url);
      if (path === '/api/admin/chat' && req.method === 'POST') return await adminChatAct(req, env);
      if (path === '/api/admin/reviews' && req.method === 'GET') return await adminReviews(env);
      if (path === '/api/admin/review' && req.method === 'POST') return await adminReviewAct(req, env);
      if (path === '/api/admin/features' && req.method === 'GET') return json(env, await featCfg(env));
      if (path === '/api/admin/features' && req.method === 'POST') { const b = await req.json().catch(() => ({})); await env.ORDERS.put('feat:cfg', J({ cart: b.cart !== false, reviews: b.reviews !== false, notify: b.notify !== false })); extraMem.v = null; cfgMem = { t: 0, v: null }; cfgMem = { t: 0, v: null }; return json(env, await featCfg(env)); }
      if (path === '/api/admin/points' && req.method === 'GET') return json(env, await ptsCfg(env));
      if (path === '/api/admin/points' && req.method === 'POST') {
        const b = await req.json().catch(() => ({})); await env.ORDERS.put('pts:cfg', J(Object.assign(await ptsCfg(env), b, { on: !!b.on }))); cfgMem = { t: 0, v: null };
        return json(env, await ptsCfg(env));
      }
      if (path === '/api/admin/customers' && req.method === 'GET') return await adminCustomers(env, url);
      if (path === '/api/admin/customer' && req.method === 'GET') return await adminCustomer(req, env, url, apiBase);
      if (path === '/api/admin/customer' && req.method === 'POST') return await adminCustomerAct(req, env);
      if (path === '/api/admin/supplier/status') {
        const [me, bal] = await Promise.all([fz(env, 'GET', '/me'), fz(env, 'GET', '/balance')]);
        return json(env, { ok: true, email: me.email || me.login || '', plan: me.plan || '', balance: bal.balance, currency: bal.currency || 'USD' });
      }
      if (path === '/api/admin/supplier/categories' && req.method === 'GET') {
        const q = new URLSearchParams({ limit: '500', include_ui: '1' }); const cur = url.searchParams.get('cursor'); if (cur) q.set('cursor', cur);
        const j = await fz(env, 'GET', '/giftcards?' + q);
        return json(env, { ok: true, items: j.items || [], meta: j.meta || {} });
      }
      if (path === '/api/admin/supplier/topups' && req.method === 'GET') {
        const items = []; let cursor = '';
        for (let i = 0; i < 6; i++) {
          const j = await fz(env, 'GET', '/topups?limit=500&include_ui=1' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
          (j.items || []).forEach(c => items.push({ category_id: String(c.category_id), name: String(c.name || ''), imageurl: c.imageurl || null, note: c.note || '' }));
          cursor = (j.meta && j.meta.next_cursor) || ''; if (!cursor) break;
        }
        return json(env, { ok: true, items });
      }
      if (path === '/api/admin/supplier/topup-offers' && req.method === 'GET') {
        const j = await fz(env, 'GET', '/topups/offers?include_ui=1&category_id=' + encodeURIComponent(url.searchParams.get('category_id') || ''));
        return json(env, { ok: true, name: j.name, imageurl: j.imageurl || null, note: j.note || '', offers: j.offers || [], fields: j.fields || [] });
      }
      if (path === '/api/admin/supplier/offers' && req.method === 'GET') {
        const j = await fz(env, 'GET', '/giftcards/cards?include_ui=1&category_id=' + encodeURIComponent(url.searchParams.get('category_id') || ''));
        return json(env, { ok: true, name: j.name, imageurl: j.imageurl || null, note: j.note || '', offers: j.offers || [] });
      }
      if (path === '/api/admin/supplier/costs' && req.method === 'POST') {
        const b = await req.json().catch(() => ({})), want = (Array.isArray(b.items) ? b.items : []).slice(0, 60), cats = [...new Set(want.map(x => String(x.cat)))].slice(0, 25), out = {};
        const got = await Promise.all(cats.map(c => fzOffers(env, c).then(j => [c, j], () => [c, null])));
        const map = new Map(got);
        want.forEach(x => { const j = map.get(String(x.cat)), of = j && fzFind(j, x.card); out[x.cat + '|' + x.card] = of ? { cost: Number(of.price_usd), stock: of.stock == null ? null : Number(of.stock) } : null; });
        return json(env, { ok: true, costs: out });
      }
      if (path === '/api/admin/retry' && req.method === 'POST') {
        const b = await req.json().catch(() => ({})), o = await env.ORDERS.get('order:' + String(b.id || ''), 'json');
        if (!o) return fail(env, 'Order not found', 404);
        if (o.status !== 'paid') return fail(env, 'This order is not paid');
        await fulfil(env, o, true); await saveOrder(env, o);
        return json(env, { ok: true, fulfil: fulfilState(o), error: Object.values(o.fulfil || {}).map(f => f.error).filter(Boolean)[0] || '' });
      }
      if (path === '/api/admin/telegram/status') {
        if (!env.TELEGRAM_BOT_TOKEN) return json(env, { ok: true, token: false });
        let bot = ''; try { bot = (await tg(env, 'getMe')).username; } catch (e) { return json(env, { ok: true, token: true, error: String(e.message || e) }); }
        let wh = null; try { const w = await tg(env, 'getWebhookInfo'); wh = { set: !!w.url, pending: w.pending_update_count || 0, error: w.last_error_message || '', errorAt: w.last_error_date ? w.last_error_date * 1000 : 0 }; } catch (e) { /* optional */ }
        return json(env, { ok: true, token: true, bot, connected: !!(await tgOwner(env)), webhook: wh });
      }
      if (path === '/api/admin/telegram/connect' && req.method === 'POST') {
        if (!env.TELEGRAM_BOT_TOKEN) return fail(env, 'TELEGRAM_BOT_TOKEN is not set in Cloudflare (Worker → Settings → Variables and Secrets)');
        const me = await tg(env, 'getMe'), code = await pairCode(env, 0);
        await tg(env, 'setWebhook', { url: apiBase + '/api/telegram/' + (await tgSecret(env)), allowed_updates: ['message'], drop_pending_updates: true });
        return json(env, { ok: true, bot: me.username, code, link: 'https://t.me/' + me.username + '?start=' + code });
      }
      if (path === '/api/admin/telegram/test' && req.method === 'POST') {
        if (!(await tgOwner(env))) return fail(env, 'Telegram is not connected yet');
        await tg(env, 'sendMessage', { chat_id: await tgOwner(env), text: '🔔 Test alert — it works!' });
        return json(env, { ok: true });
      }
      if (path === '/api/admin/telegram/disconnect' && req.method === 'POST') {
        await env.ORDERS.delete('tg:owner'); cfgMem = { t: 0, v: null }; tgMem.owner = ''; tgMem.t = Date.now();
        if (env.TELEGRAM_BOT_TOKEN) await tg(env, 'deleteWebhook', {}).catch(() => {});
        return json(env, { ok: true });
      }
      if (path === '/api/admin/diagnose' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const o = await env.ORDERS.get('order:' + String(b.id || ''), 'json');
        if (!o) return fail(env, 'Order not found', 404);
        const info = await diagnoseOrder(env, o);
        if (o.status === 'pending') { lastLook.delete(o.id); const r2 = await checkOrder(env, o); info.after = r2.status; }
        else if (o.status === 'expired' && Date.now() - o.expiresAt < 7 * 86400000) {   // a late payment: look again with a wide window
          try { const tx = await findPayment(env, Object.assign({}, o, { expiresAt: Date.now() })); if (tx) { await markPaid(env, o, tx); info.after = 'paid'; info.notes.push('A matching late payment was found, so the order is now paid.'); } } catch (e) { info.notes.push('Late-payment check: ' + String((e && e.message) || e)); }
        }
        return json(env, { ok: true, info });
      }
      if (path === '/api/admin/accept' && req.method === 'POST') {
        const b = await req.json().catch(() => ({})), ref = String(b.ref || '');
        const o = await env.ORDERS.get('order:' + String(b.id || ''), 'json');
        if (!o) return fail(env, 'Order not found', 404);
        if (o.status === 'paid') return json(env, { ok: true });
        if (!/^[A-Za-z0-9:_. -]{3,120}$/.test(ref)) return fail(env, 'Bad payment reference');
        if (await env.ORDERS.get('tx:' + ref)) return fail(env, 'That payment is already linked to another order');
        await markPaid(env, o, ref);
        return json(env, { ok: true });
      }
      if (path === '/api/admin/testmail' && req.method === 'POST') {
        const b = await req.json().catch(() => ({})), to = String(b.to || '').trim().toLowerCase();
        if (!mailOn(env)) return fail(env, 'Email is not set up yet. Add the RESEND_KEY secret and the MAIL_FROM setting in Cloudflare, then Deploy.');
        if (!validEmail(to)) return fail(env, 'Please type a valid email address');
        const cat0 = await getCatalog(env).catch(() => null);
        const demo = { id: 'abcd1234ef567890abcd1234ef567890', usd: 11.5, coin: 'usdt_trc20', amount: 11540000, txid: 'manual', items: [{ title: 'Sample — iTunes US USD 10', price: 11.5, qty: 1 }] };
        try { await sendMail(env, to, 'Test receipt — ' + ((cat0 && cat0.storeName) || 'your shop'), receiptHTML(cat0 && cat0.storeName, demo, (env.__base || '') + '/api/health')); }
        catch (e) { return fail(env, 'The email service said: ' + String((e && e.message) || e).slice(0, 200)); }
        return json(env, { ok: true });
      }
      if (path === '/api/admin/binance/test' && req.method === 'POST') {
        if (!binanceOn(env)) return fail(env, 'Binance is not connected. Add the BINANCE_KEY and BINANCE_SECRET secrets in Cloudflare, then Deploy.');
        const out = [], t0 = Date.now() - 3600000, probe = { createdAt: t0 };
        try { const l = await bnDepositList(env, probe); out.push('Deposit history: OK (' + l.length + ' record(s) in the last hour)'); } catch (e) { out.push('Deposit history: ' + String((e && e.message) || e)); }
        try { const l = await bnPayList(env, probe); out.push('Binance Pay history: OK (' + l.length + ' record(s) in the last hour)'); } catch (e) { out.push('Binance Pay history: ' + String((e && e.message) || e)); }
        return json(env, { ok: !out.some(x => !/OK/.test(x)), lines: out });
      }
      if (path === '/api/admin/state' && req.method === 'PUT') {          // a private copy of the dashboard, so any phone or computer can load it
        const txt = await req.text();
        if (txt.length < 20 || txt.length > 20 * 1024 * 1024) return fail(env, 'The dashboard copy is empty or bigger than 20 MB');
        let st; try { st = JSON.parse(txt); if (!st || !Array.isArray(st.products)) throw 0; } catch (e) { return fail(env, 'That does not look like dashboard data'); }
        const savedAt = Date.now();
        await env.ORDERS.put('adminstate', J({ savedAt, state: st }));
        return json(env, { ok: true, savedAt, bytes: txt.length });
      }
      if (path === '/api/admin/state' && req.method === 'GET') {
        const txt = await env.ORDERS.get('adminstate', 'text');
        if (!txt) return json(env, { ok: true, empty: true });
        return new Response(txt.replace(/^\{/, '{"ok":true,'), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      }
      if (path === '/api/admin/purge-expired' && req.method === 'POST') return await purgeExpired(env);
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
  async scheduled(event, env0, ctx) {
    const env = Object.assign(Object.create(env0), { __ctx: ctx, __base: '' });
    ctx.waitUntil(sweep(env).catch(e => { /* the next run tries again */ }));
  },
  async fetch(req, env0, ctx) {
    const env = Object.assign(Object.create(env0), { __ctx: ctx, __base: new URL(req.url).origin });         // lets alerts finish after the reply is sent
    const path = new URL(req.url).pathname.replace(/\/+$/, '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env, path) });
    const res = await route(req, env);
    const h = new Headers(res.headers);
    const c = corsHeaders(env, path);
    Object.keys(c).forEach(k => h.set(k, c[k]));
    h.set('x-content-type-options', 'nosniff'); h.set('referrer-policy', 'no-referrer'); h.set('x-frame-options', 'DENY'); h.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    return new Response(res.body, { status: res.status, headers: h });
  }
};
