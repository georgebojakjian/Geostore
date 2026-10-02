/**
 * Geostore payment + delivery server — runs free on Cloudflare Workers.
 *
 * What it does
 *  1. Creates an order with a UNIQUE USDT (TRC20) amount, e.g. 9.037 for a $9 product.
 *  2. Watches your wallet through the public TronGrid API.
 *  3. When that exact amount arrives, the order becomes "paid" and the customer
 *     gets a private delivery link with the full code.
 *
 * Needs (set in the Cloudflare dashboard — see DEPLOY-AUTOMATIC.md):
 *   KV binding   ORDERS          (storage)
 *   Variable     WALLET          (your TRON address that receives USDT, starts with T)
 *   Secret       ADMIN_TOKEN     (a long password only you know)
 *   Variable     ALLOWED_ORIGIN  (your shop address, e.g. https://myshop.pages.dev) — optional but recommended
 *   Variable     TRONGRID_KEY    (optional free key from trongrid.io, for higher limits)
 */

const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'; // USDT on TRON (TRC20)
const ORDER_MINUTES = 60;                 // customer has 60 minutes to pay
const GRACE_MS = 15 * 60 * 1000;          // keep checking 15 min after expiry
const THROTTLE_MS = 7000;                 // don't ask TronGrid more often than this per order
// Cloudflare's FREE plan allows only 1,000 KV writes and 1,000 KV list calls per day,
// so this server writes ONLY when something really changes (new order, paid, expired)
// and keeps "when did I last look" in memory instead of in storage.
const lastLook = new Map();               // orderId -> time of last blockchain check
const ipHits = new Map();                 // ip -> [timestamps] of recent order requests

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
const usd = micro => (micro / 1e6).toFixed(3);
const saveOrder = (env, o, ttl) => env.ORDERS.put('order:' + o.id, JSON.stringify(o), ttl ? { expirationTtl: ttl } : undefined);
const publicOrder = (env, o, apiBase) => ({
  id: o.id, status: o.status, title: o.title, amount: usd(o.amount), wallet: env.WALLET,
  network: 'TRON (TRC20)', coin: 'USDT', expiresAt: o.expiresAt,
  deliveryUrl: o.status === 'paid' ? apiBase + '/api/delivery/' + o.id + '?k=' + o.key : null
});

/* ---------------- create order ---------------- */
function tooMany(req) {
  const ip = req.headers.get('cf-connecting-ip') || 'x', now = Date.now();
  const hits = (ipHits.get(ip) || []).filter(t => now - t < 10 * 60000);
  hits.push(now); ipHits.set(ip, hits);
  if (ipHits.size > 500) ipHits.clear();
  return hits.length > 6;                 // at most 6 new orders per IP per 10 minutes
}
async function createOrder(req, env, apiBase) {
  if (!env.WALLET) return fail(env, 'Server wallet is not configured', 503);
  if (tooMany(req)) return fail(env, 'Too many orders from your connection. Please wait a few minutes.', 429);
  const b = await req.json().catch(() => null) || {};
  const email = String(b.email || '').trim().slice(0, 200);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(env, 'Please enter a valid email address');
  const cat = await env.ORDERS.get('catalog', 'json');
  if (!cat) return fail(env, 'The store has not been synced yet', 503);

  const itemId = String(b.item || '');
  let title, price;
  if (itemId === 'ALL') {
    if (!cat.allAccess || !cat.allAccess.enabled) return fail(env, 'Not available');
    title = cat.allAccess.title || 'All-Access Pass'; price = cat.allAccess.price;
  } else {
    const p = cat.products && cat.products[itemId];
    if (!p || p.published === false) return fail(env, 'Unknown product');
    if (p.type === 'digital') {
      const used = Number(await env.ORDERS.get('used:' + itemId)) || 0;
      if (used >= (p.stock || []).length) return fail(env, 'Sorry, this item is out of stock right now.', 409);
    }
    title = p.title; price = p.price;
  }
  const base = Math.round(Number(price) * 1e6);
  if (!(base > 0)) return fail(env, 'This item has no price');

  // unique amount: price + 0.001..0.099 USDT, so every open order is identifiable on-chain
  let micro = null;
  for (let i = 0; i < 40 && micro === null; i++) {
    const cand = base + (1 + randInt(99)) * 1000;
    if (!(await env.ORDERS.get('amt:' + cand))) micro = cand;
  }
  if (micro === null) return fail(env, 'Too many open orders, please try again in a minute', 503);

  const now = Date.now();
  const o = { id: hex(16), key: hex(16), email, item: itemId, title, amount: micro, status: 'pending', createdAt: now, expiresAt: now + ORDER_MINUTES * 60000, lastCheck: 0 };
  await saveOrder(env, o, 7 * 86400);
  // the "amt:" key both reserves the amount AND is the list of open orders the cron job checks
  await env.ORDERS.put('amt:' + micro, o.id, { expirationTtl: (ORDER_MINUTES + 20) * 60 });
  return json(env, publicOrder(env, o, apiBase));
}

/* ---------------- check the blockchain ---------------- */
async function markPaid(env, o, txid) {
  o.status = 'paid'; o.paidAt = Date.now(); o.txid = txid || 'manual';
  if (o.item !== 'ALL') {
    // digital items (gift cards, keys...): hand out the next unused code from your stock
    const cat = await env.ORDERS.get('catalog', 'json');
    const p = cat && cat.products && cat.products[o.item];
    if (p && p.type === 'digital') {
      const used = Number(await env.ORDERS.get('used:' + o.item)) || 0;
      o.codes = (p.stock || []).slice(used, used + 1);
      if (o.codes.length) await env.ORDERS.put('used:' + o.item, String(used + 1));
    }
  }
  await saveOrder(env, o);
  if (txid) await env.ORDERS.put('tx:' + txid, o.id);
  await env.ORDERS.delete('amt:' + o.amount);
}
async function checkOrder(env, o) {
  if (o.status !== 'pending') return o;
  const now = Date.now();
  if (now > o.expiresAt + GRACE_MS) {
    o.status = 'expired'; await saveOrder(env, o);
    await env.ORDERS.delete('amt:' + o.amount);
    return o;
  }
  if (now - (lastLook.get(o.id) || 0) < THROTTLE_MS) return o;   // memory only: no storage write
  lastLook.set(o.id, now);
  if (lastLook.size > 1000) lastLook.clear();
  const url = 'https://api.trongrid.io/v1/accounts/' + env.WALLET + '/transactions/trc20' +
    '?only_confirmed=true&only_to=true&limit=200&contract_address=' + USDT_CONTRACT + '&min_timestamp=' + o.createdAt;
  let list = null;
  try {
    const res = await fetch(url, { headers: env.TRONGRID_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_KEY } : {} });
    if (res.ok) list = (await res.json()).data || [];
  } catch (e) { /* network hiccup: try again next time */ }
  if (list) {
    for (const t of list) {
      const ok = t.to === env.WALLET && t.type === 'Transfer' && t.token_info && t.token_info.address === USDT_CONTRACT &&
        String(t.value) === String(o.amount) && t.block_timestamp >= o.createdAt && t.block_timestamp <= o.expiresAt;
      if (ok && !(await env.ORDERS.get('tx:' + t.transaction_id))) { await markPaid(env, o, t.transaction_id); return o; }
    }
  }
  return o;                                 // still waiting: nothing to save
}

/* ---------------- delivery page ---------------- */
function bundle(o, cat, list) {
  let n = 0;
  const items = list.map(p => {
    if (p.type === 'digital') {
      const codes = o.codes || [];
      return '<section><h2>' + esc(p.title) + '</h2><p class="d">' + esc(p.tagline || '') + '</p>' +
        (codes.length ? codes.map(c => '<div class="bar"><b>Your code</b><button onclick="cp(' + (n++) + ',this)">Copy</button></div><pre id="c' + (n - 1) + '" style="font-size:1.05rem">' + esc(c) + '</pre>').join('')
                      : '<p class="d">Your code is being prepared — please contact us with your order ID: ' + esc(o.id) + '</p>') + '</section>';
    }
    return '<section><h2>' + esc(p.title) + '</h2><p class="d">' + esc(p.tagline || '') + '</p>' +
      p.variants.map(v => {
        const i = n++;
        return '<h3 style="margin:22px 0 4px;font-size:1.05rem">' + esc(v.name) + '</h3><iframe sandbox="allow-scripts" srcdoc="' + esc(v.full) + '" title="Preview"></iframe>' +
          '<div class="bar"><b>Full code</b><button onclick="cp(' + i + ',this)">Copy code</button></div><pre id="c' + i + '">' + esc(v.full) + '</pre>';
      }).join('') + '</section>';
  }).join('');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Your codes — ' + esc(cat.storeName || '') + '</title><style>' +
    'body{margin:0;font-family:system-ui,sans-serif;background:#0b0f1a;color:#f8fafc;line-height:1.6}.w{max-width:960px;margin:auto;padding:30px 18px 80px}h1{margin-bottom:4px}.d{color:#94a3b8}' +
    'section{margin-top:36px;padding:22px;border:1px solid #243049;border-radius:16px;background:#111827}iframe{width:100%;height:380px;border:1px solid #243049;border-radius:12px;background:#0b0f1a;margin:10px 0}' +
    '.bar{display:flex;justify-content:space-between;align-items:center;margin:8px 0}button{background:#c5f442;color:#0a1000;border:0;padding:9px 18px;border-radius:10px;font-weight:600;cursor:pointer}' +
    'pre{max-height:360px;overflow:auto;background:#070a12;border:1px solid #243049;border-radius:12px;padding:14px;font-size:.78rem;color:#c7d2fe}</style></head><body><div class="w">' +
    '<h1><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="34" height="34" style="vertical-align:middle;margin-right:10px"><rect width="32" height="32" rx="9" fill="#c5f442"/><path d="M16 6.2l8.6 4.9-8.6 4.9-8.6-4.9z" fill="#0a1000"/><path d="M7.4 12.9l8.6 4.9v8.6l-8.6-4.9z" fill="#0a1000" fill-opacity=".72"/><path d="M24.6 12.9l-8.6 4.9v8.6l8.6-4.9z" fill="#0a1000" fill-opacity=".42"/></svg>Thank you! 🎉</h1><p class="d">Order ' + esc(o.id.slice(0, 8)) + ' · ' + esc(o.email) + '. Each code has a live preview and a copy button. Save this page (Ctrl+S) or bookmark this link — it is yours to come back to.</p>' + items +
    '<p class="d" style="margin-top:40px">Licence: use these codes in your own and your clients\' projects. Do not resell or share the code files themselves.</p></div>' +
    '<script>function cp(i,b){var t=document.getElementById("c"+i).textContent;function d(){b.textContent="Copied!";setTimeout(function(){b.textContent="Copy code"},1500)}if(navigator.clipboard){navigator.clipboard.writeText(t).then(d,d)}else{d()}}<\/script></body></html>';
}
async function delivery(env, id, url) {
  const o = await env.ORDERS.get('order:' + id, 'json');
  const k = url.searchParams.get('k') || '';
  if (!o || !safeEqual(k, o.key)) return new Response('Not found', { status: 404 });
  if (o.status !== 'paid') return new Response('This order has not been paid yet.', { status: 402 });
  const cat = await env.ORDERS.get('catalog', 'json') || { products: {} };
  const all = Object.keys(cat.products).map(i => Object.assign({ id: i }, cat.products[i]))
    .filter(p => p.type === 'digital' || (p.variants && p.variants.length));
  const list = o.item === 'ALL' ? all.filter(p => p.type !== 'digital') : all.filter(p => p.id === o.item);
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };
  if (url.searchParams.get('download')) headers['content-disposition'] = 'attachment; filename="codes-' + o.id.slice(0, 8) + '.html"';
  return new Response(bundle(o, cat, list), { headers });
}

/* ---------------- admin ---------------- */
async function adminSync(req, env) {
  const b = await req.json().catch(() => null);
  if (!b || !Array.isArray(b.products)) return fail(env, 'Bad data');
  const products = {};
  b.products.forEach(p => {
    if (!p || !p.id) return;
    const variants = (Array.isArray(p.variants) ? p.variants : (p.full ? [{ name: 'Standard', full: p.full }] : []))
      .map(v => ({ name: String(v.name || ''), full: String(v.full || '') })).filter(v => v.full);
    products[String(p.id)] = {
      title: String(p.title || ''), tagline: String(p.tagline || ''), price: Number(p.price) || 0,
      type: p.type === 'digital' ? 'digital' : 'code',
      variants, stock: Array.isArray(p.stock) ? p.stock.map(String).filter(Boolean) : [],
      published: p.published !== false
    };
  });
  const aa = b.allAccess || {};
  await env.ORDERS.put('catalog', JSON.stringify({
    storeName: String(b.storeName || ''), products,
    allAccess: { enabled: !!aa.enabled, title: String(aa.title || 'All-Access Pass'), price: Number(aa.price) || 0 }
  }));
  return json(env, { ok: true, products: Object.keys(products).length });
}
async function adminOrders(env) {
  const keys = (await env.ORDERS.list({ prefix: 'order:', limit: 200 })).keys;
  const orders = (await Promise.all(keys.map(k => env.ORDERS.get(k.name, 'json')))).filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(o => ({ id: o.id, email: o.email, title: o.title, item: o.item, amount: usd(o.amount), status: o.status, createdAt: o.createdAt, paidAt: o.paidAt || null, txid: o.txid || null, key: o.key }));
  return json(env, { orders });
}

/* ---------------- router ---------------- */
async function route(req, env) {
  const url = new URL(req.url);
  const apiBase = url.origin;
  const path = url.pathname.replace(/\/+$/, '');
    try {
      if (path === '/api/health') return json(env, { ok: true, wallet: !!env.WALLET, admin: !!env.ADMIN_TOKEN, kv: !!env.ORDERS });
      if (!env.ORDERS) return fail(env, 'Storage (KV binding named ORDERS) is not connected', 503);
      if (path === '/api/order' && req.method === 'POST') return await createOrder(req, env, apiBase);
      let m = path.match(/^\/api\/order\/([a-f0-9]{32})$/);
      if (m && req.method === 'GET') {
        let o = await env.ORDERS.get('order:' + m[1], 'json');
        if (!o) return fail(env, 'Order not found', 404);
        o = await checkOrder(env, o);
        return json(env, publicOrder(env, o, apiBase));
      }
      m = path.match(/^\/api\/delivery\/([a-f0-9]{32})$/);
      if (m && req.method === 'GET') return await delivery(env, m[1], url);
      if (path.startsWith('/api/admin/')) {
        if (!isAdmin(req, env)) return fail(env, 'Wrong or missing admin token', 401);
        if (path === '/api/admin/sync' && req.method === 'POST') return await adminSync(req, env);
        if (path === '/api/admin/orders' && req.method === 'GET') return await adminOrders(env);
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
      return fail(env, 'Server error', 500);
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
  // runs every 5 minutes (Cron Trigger) so payments are detected even if the customer closed the page
  async scheduled(event, env, ctx) {
    if (!env.ORDERS || !env.WALLET) return;
    const keys = (await env.ORDERS.list({ prefix: 'amt:', limit: 50 })).keys;
    for (const k of keys) {
      const id = await env.ORDERS.get(k.name);
      const o = id && await env.ORDERS.get('order:' + id, 'json');
      if (o) await checkOrder(env, o);
    }
  }
};
