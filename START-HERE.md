# START HERE — the simple version

You have **3 parts**. Think of them like a shop:

| Part | What it is | Where it lives |
|---|---|---|
| 🏪 **The shop** | The website your customers see | the `site` folder → put online on **Netlify** |
| 🧠 **The server** | Makes the payment, detects the money, sends the code | **Cloudflare** (free) → file `worker/worker.js` |
| 🎛️ **Your dashboard** | Where YOU change products, prices, wallets | file `admin/admin.html` on **your computer** (never upload it) |

The dashboard talks to the server. The server talks to the shop. Customers only ever see the shop.

---

## One-time setup (do once)

### Step 1 — Put the new server code on Cloudflare
1. Open `worker/worker.js` → select all → copy.
2. Cloudflare → **Workers & Pages** → your worker → **Edit code** → select all → paste → **Deploy**.
3. Check: open `https://YOUR-WORKER-ADDRESS/api/health` in your browser. You should see `"ok":true` and `"kv":true` and `"version":4`.
   (If it says version 3 or lower, the new code was not pasted.)

*(Your earlier settings — the KV storage, `ADMIN_TOKEN`, the 5-minute cron — stay as they are.)*

### Step 2 — Fill your dashboard
1. Double-click `admin/admin.html`.
2. If you had an older dashboard with data: in the OLD one press **Publish → Backup everything**, then in the NEW one press **Publish → Restore backup**.
3. **Settings** tab:
   - **Payment server URL** = your Cloudflare worker address (starts with `https://`).
   - **Server admin token** = your `ADMIN_TOKEN` password.
   - **USDT wallet (TRC20)** = your TRON address (starts with `T`).
   - **Bitcoin wallet** = your Bitcoin address (starts with `bc1`, `1` or `3`).
   - Your email, store name, All-Access price → **Save settings**.
4. **Publish** tab → **Test connection** → you want ✅.

### Step 3 — Send your products to the server (“Sync”)
1. **Publish** tab → **Sync to server**.
2. Wait. You will see “Uploading 12 of 36…”. It sends the products **one by one** (this fixes the old “server error”).
3. At the end: ✅ *Synced … Everything is up to date.*
4. Next time you press Sync it only uploads what you changed.

> If you see a ❌ now, it shows the **real reason**. The most common one:
> **“KV … limit”** or **“429”** = Cloudflare's free daily storage limit was reached. It resets every day at **00:00 UTC**. Just press Sync again tomorrow (or after midnight UTC). A full first sync uses about 37 of your 1,000 free daily writes.

### Step 4 — Put the shop online
1. Dashboard → **Publish** → **Download data.js**.
2. Copy the downloaded file into the `site` folder (replace the old `data.js`).
3. The `site` folder must contain: `index.html`, `data.js`, `pack-1.js`, `pack-2.js`, `logo.svg` (and `shop.html`).
4. Netlify → your site → **Deploys** → drag the `site` folder onto the upload area.
5. Open your Netlify link. 🎉

### Step 5 — Test once with real money
1. In the dashboard set one product's price to `1`, save, press **Sync**, download `data.js`, upload the `site` folder again.
2. Buy it on your live shop (pay with USDT).
3. Within a minute or two the payment window turns green → **Open my codes**.
4. Set the real price back → Sync → download `data.js` → upload `site` again.

---

## Every time you change something later

| You changed… | Do this |
|---|---|
| a **price, name, description, a product's code** | Dashboard → **Sync to server** → **Download data.js** → put it in `site` → upload `site` to Netlify |
| only **wallets** | Settings → Save → **Sync to server** (no need to upload the site) |
| nothing in products, just want a **backup** | Publish → Backup everything |

*(Rule of thumb: **Sync** updates the server (payments + secret codes). **data.js + Netlify** updates what visitors see.)*

---

## What happens when someone buys

**Customer:** clicks **Add** → opens the cart → enters email → chooses USDT or Bitcoin → sends the exact amount shown → the window turns green → **Open my codes**. They can also create an account to see all orders and payments.

**You:** nothing. The server notices the payment and unlocks the code by itself. You can watch everything in the dashboard → **Orders**. If a customer paid a slightly wrong amount, check your wallet and press **Mark paid** on that order.

---

## If something goes wrong
- **Sync says ❌** → read the message after the ❌ (it is the real reason). Limit reached → wait until 00:00 UTC.
- **Test connection says “Failed to fetch”** → check the server address, then open `…/api/health` in a browser.
- **Test connection says “Wrong or missing admin token”** → paste the same `ADMIN_TOKEN` in Settings and press Save.
- **The shop does not show new products** → you did not upload the new `data.js` to Netlify (Step 4).
- **A payment window turned green but I got no code** → ask the customer to open **Account → Orders**, or send them the link from the dashboard → Orders → **Open codes**.
