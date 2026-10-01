# Automatic Payments — Setup Guide (no coding, all free)

**How it works.** Your shop (the `site` folder) talks to a tiny free server (`worker/worker.js`) on **Cloudflare**.
1. A customer clicks **Buy** → the server makes an order with a *unique* amount, e.g. `12.037` USDT.
2. The customer sends exactly that amount to your wallet (USDT on the **TRON / TRC20** network).
3. The server watches your wallet through the public TronGrid blockchain API. When the exact amount arrives, the order becomes **paid** and the customer's page shows **Open my codes**.
4. Everything happens by itself — no gateway company, no ID check, the money goes straight to **your** wallet.

Why a unique amount? It is how the server knows *which* customer paid, without any middleman.

> I cannot test Cloudflare from your country. Cloudflare's free plan is generally available, but if sign-up or a step is blocked for you, tell me — I will adapt the server to another free host.

---

## Part A — Your wallet (5 minutes)
You need a normal **TRON address** (starts with `T`, 34 characters) that can receive **USDT (TRC20)**.
- A wallet app that supports the TRON network (for example Trust Wallet or TronLink), **or** the deposit address of an exchange account → choose coin **USDT**, network **TRC20**.
- **Best:** your own wallet app (you hold the keys). An exchange address also works for receiving.
- Send yourself a tiny test amount first. Never share your recovery phrase.

## Part B — Create the server on Cloudflare
1. Make a free account at https://dash.cloudflare.com/sign-up
2. Left menu → **Workers & Pages** → **Create** → **Create Worker** → name it `geostore-api` → **Deploy**.
3. Press **Edit code**. Delete everything in the editor, open `worker/worker.js` from this project, copy ALL of it, paste it into the editor, press **Deploy**.
4. Copy your server address (looks like `https://geostore-api.YOURNAME.workers.dev`). You need it in Part D.

## Part C — Connect storage + settings
1. Left menu → **Storage & Databases** → **KV** → **Create a namespace** → name it `geostore-orders`.
2. Go back to your Worker → **Settings** → **Bindings** → **Add** → **KV namespace** → variable name must be exactly `ORDERS` → choose `geostore-orders` → Save/Deploy.
3. Worker → **Settings** → **Variables and Secrets** → add:
   | Name | Type | Value |
   |---|---|---|
   | `WALLET` | Text | your TRON address (starts with T) |
   | `ADMIN_TOKEN` | **Secret** | a long password you invent (20+ random characters). Write it down! |
   | `ALLOWED_ORIGIN` | Text | your shop address, e.g. `https://myshop.pages.dev` (add after Part E; no slash at the end) |
   | `TRONGRID_KEY` | Secret (optional) | free key from https://www.trongrid.io — only needed if you get many sales |
4. Worker → **Settings** → **Triggers** → **Cron Triggers** → **Add** → `* * * * *` (every minute). This detects payments even when the customer closed the page.

## Part D — Connect your dashboard
1. Open `admin/admin.html` → **Settings**.
2. **Payment server URL** = the address from Part B. **Server admin token** = your `ADMIN_TOKEN`. Save.
3. **Publish** → **Test connection**. It must say ✅. If it lists something missing, fix that item in Part C.
4. **Publish** → **Sync to server**. (Repeat after every change to products, prices or the All-Access pass.)

## Part E — Put the shop online (free)
1. Dashboard → **Publish** → **Download data.js** → put it in the `site` folder (replace the old one).
2. Cloudflare → **Workers & Pages** → **Create** → **Pages** → **Upload assets** → drag the **`site`** folder → Deploy.
   (You can also use https://app.netlify.com/drop.)
3. Open `https://YOUR-SITE/shop.html`. Then put that site address into `ALLOWED_ORIGIN` (Part C) so only your shop can use your server.
4. **Never upload the `admin` folder.**

## Part F — Test it before you announce anything
1. Set one product price to `1` in the dashboard → Sync (and Download data.js + re-upload).
2. Buy it on your live shop with your own email, send the shown amount from another wallet.
3. Within about a minute the page should turn green: **Payment received → Open my codes**.
4. Set the real price again and Sync.

---

## Good to know
- **Exact amount rule.** If a customer pays a slightly different amount, the order is not detected automatically. In the dashboard → **Orders** → **Refresh**, check your wallet, and press **Mark paid** if the money really arrived.
- **Orders last 60 minutes.** After that a new order is needed.
- **Customers get their link on screen** and can reopen it any time from the same browser. There is no email sending yet (free email services need another account) — the **Orders** tab shows every customer's email and a delivery link you can send them if they lose theirs.
- **Your code stays private.** The full code lives only in your server storage and is shown only to a paid order's secret link.
- **Prices are decided by the server**, not the website, so nobody can change a price in their browser.
- **Free limits.** Cloudflare's free plan allows plenty for a new store; check their current limits.
- **Cloudflare screens change names sometimes.** If a button is not where this guide says, send me a screenshot.
