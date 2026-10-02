# Automatic Payments — Setup Guide (no coding, all free)

> **Simplest instructions: `START-HERE.md`.**
>
> **Version 3/4 — what changed:** wallets (USDT *and* Bitcoin) are now set in your **dashboard → Settings** and sent to the server with **Sync to server** — you no longer need a `WALLET` variable in Cloudflare. Customers can build a **cart**, buy **one style** or all styles, pay in **USDT or Bitcoin**, and keep their orders in a **customer account**. After updating, paste the new `worker/worker.js` into Cloudflare, then open the dashboard → Settings → fill both wallets → Publish → **Sync to server**.

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
   | `ADMIN_TOKEN` | **Secret** | a long password you invent (20+ random characters). Write it down! |
   | `ALLOWED_ORIGIN` | Text | your shop address, e.g. `https://myshop.pages.dev` (add after Part E; no slash at the end) |
   | `TRONGRID_KEY` | Secret (optional) | free key from https://www.trongrid.io — only needed if you get many sales |
4. **No Cron Trigger is needed** (version 5). If you created one earlier, delete it — it only wasted your free daily limit.

## Part D — Connect your dashboard
1. Open `admin/admin.html` → **Settings**.
2. **Payment server URL** = the address from Part B. **Server admin token** = your `ADMIN_TOKEN`. Save.
3. **Publish** → **Test connection**. It must say ✅. If it lists something missing, fix that item in Part C.
4. **Publish** → **Sync to server**. (Repeat after every change to products, prices or the All-Access pass.)

## Part E — Put the shop online (free)
1. In the dashboard, check **Settings** has your **Payment server URL** saved. Then **Publish** → **Download data.js**.
2. On your computer, copy that downloaded `data.js` into the `site` folder, replacing the old `data.js`. The `site` folder must now contain: `index.html`, `shop.html` (a small redirect), `data.js`.
3. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** tab → **Upload assets** (Direct Upload).
4. Project name: for example `myshop` → **Create project**.
5. Drag the **`site` folder** (the folder itself, with the 3 files inside) onto the upload area → **Deploy site**.
6. Cloudflare gives you an address like `https://myshop.pages.dev`. Open `https://myshop.pages.dev` — your home page should appear with the products.
7. Go back to your Worker → **Settings** → **Variables and Secrets** → add `ALLOWED_ORIGIN` = `https://myshop.pages.dev` (no slash at the end) → Deploy.
8. **Never upload the `admin` folder.**
Whenever you change products or prices later: Download `data.js` again → replace it in `site` → in Pages open your project → **Create deployment** → upload the `site` folder again. (Also press **Sync to server**.)

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

## If "Test connection" says ❌ Failed to fetch
1. Open your server address followed by `/api/health` in a new browser tab, e.g. `https://geostore-api.YOURNAME.workers.dev/api/health`.
   - You should see `{"ok":true,"wallet":true,"admin":true,"kv":true}`.
   - Nothing loads / error page → the address is wrong, or the Worker is not deployed. Copy the address again from Cloudflare (Workers & Pages → your worker → the link at the top).
   - If it loads but a value is `false` → that setting is missing (see Part C): `wallet` = WALLET, `admin` = ADMIN_TOKEN, `kv` = the KV binding named exactly `ORDERS`.
2. If `/api/health` works but the dashboard still fails, you are running an old `worker.js`. Open `worker/worker.js` from the latest project, copy everything, paste it into Cloudflare (Edit code), and press **Deploy**.
3. The URL in dashboard Settings must start with `https://` and have no space or `/api` at the end.
4. Still stuck? Send me a screenshot of the `/api/health` tab and of your Settings page (hide the token).

## If Cloudflare says "KV requests are temporarily blocked"
That means the free daily storage limit (1,000 writes) was used up. The limit resets every day at 00:00 UTC, and everything works again after that, with no action needed. (Or upgrade to Workers Paid for $5/month.)
The current `worker.js` is built to stay far below the limit: it writes to storage only when an order is created, paid or expired, and the cron check runs every 5 minutes. If you ever see this message again, make sure you pasted the latest `worker.js` and that the Cron Trigger is `*/5 * * * *`.

## Paying with Bitcoin as well as USDT
- Put your Bitcoin address in **dashboard → Settings → Bitcoin wallet**, press Save, then **Sync to server**. The checkout then offers *Bitcoin (BTC)* next to *USDT (TRC20)*. (If you leave a wallet empty, that coin is simply not offered.)
- The server converts the price to BTC at the live rate when the order is created (rate from mempool.space, backup CoinGecko) and gives the customer an exact amount with a few extra satoshis to identify the order. The customer has 90 minutes to send it.
- Bitcoin needs **1 network confirmation** (usually 10–30 minutes) before the order turns green. The server checks mempool.space automatically.
- The customer must send the amount **exactly** (the wallet's network fee is paid on top by most wallets; from an exchange, add the withdrawal fee). If a payment arrives with a slightly different amount, check your wallet and use **Orders → Mark paid**.

## Customer accounts
Customers can create an account on your shop (name, email, password). They see all their orders, can reopen their codes, see their **payment history** with a link to the transaction, and edit their details. You see all accounts in **dashboard → Orders → Customer accounts**.
- Guests can still buy without an account; their orders stay in **Account → Orders placed on this device**.
- Accounts are stored in the same free Cloudflare storage (one write per sign-up and per order). Passwords are salted and hashed; sessions last 30 days.
- No email verification yet (it needs an email service). If a customer forgets a password, create a new account with another email or contact support.

## Sync, version 4 (fixes "server error")
"Sync to server" now uploads each product in its own small request and then one small index — instead of one huge request. Cloudflare's free plan gives each request only a few milliseconds of processing time, which a single 2 MB upload could exceed. Unchanged products are skipped, so later syncs are fast. If a sync fails, the message after the ❌ is the real reason from the server. A full first sync uses ~37 KV writes of the 1,000 free per day.

## Version 5: no more list() calls
The server never uses Cloudflare's `list()` operation any more (free limit: 1,000 per day). Orders and customers are kept in two tiny index lists, and payments are detected when the customer's page, their account, or your Orders screen looks at the order. A full first Sync costs ~37 writes, an order ~3 writes plus 2 when paid.
