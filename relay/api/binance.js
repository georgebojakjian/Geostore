// Tiny Binance relay for Vercel (free). It only forwards two READ-ONLY Binance history calls, and only for requests
// that carry your secret. Deploy it in a region Binance accepts (see relay/README.md), then give the Worker its address.
module.exports = async function handler(req, res) {
  if (!process.env.RELAY_SECRET || req.headers['x-relay-secret'] !== process.env.RELAY_SECRET) { res.statusCode = 401; return res.end('no'); }
  const p = String((req.query && req.query.p) || '');
  if (!/^\/sapi\/v1\/(pay\/transactions|capital\/deposit\/hisrec)\?[A-Za-z0-9=&%._-]+$/.test(p)) { res.statusCode = 400; return res.end('bad path'); }
  const key = String(req.headers['x-mbx-apikey'] || '');
  if (!/^[A-Za-z0-9]{20,100}$/.test(key)) { res.statusCode = 400; return res.end('bad key'); }
  let r;
  for (const host of ['https://api-gcp.binance.com', 'https://api.binance.com', 'https://api1.binance.com']) {
    try { r = await fetch(host + p, { headers: { 'X-MBX-APIKEY': key } }); if (r.status !== 403 && r.status !== 451) break; } catch (e) { /* try the next host */ }
  }
  if (!r) { res.statusCode = 502; return res.end('Binance did not answer'); }
  res.statusCode = r.status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
  return res.end(await r.text());
};
