# START HERE — the simple version

You have **3 parts**. Think of them like a shop:

| Part | What it is | Where it lives |
|---|---|---|
| 🏪 **The shop** | The website your customers see | the `site` folder → put online on **Netlify** |
| 🧠 **The server** | Makes the payment, detects the money, buys gift cards, sends the code | **Cloudflare** (free) → file `worker/worker.js` |
| 🎛️ **Your dashboard** | Where YOU change products, prices, wallets, gift cards | file `admin/admin.html` on **your computer** (never upload it) |

The dashboard talks to the server. The server talks to the shop. Customers only ever see the shop.

The dashboard's **top bar always tells you what to do**: *“Server needs a Sync”* or *“Website needs updating”* — press the button next to it.

---

## Update to this version (do in this order)

1. **Back up first.** Open your OLD dashboard → **Publish → Backup everything**. Keep that file.
2. **Download the new project** (GitHub → branch `claude/geostore-website-template-bwou47` → Code → Download ZIP) and unzip it.
3. **Server:** open `worker/worker.js` → copy everything → Cloudflare → your worker → **Edit code** → paste → **Deploy**. Open `https://YOUR-WORKER/api/health` → it must show `"version":18`.
4. **Dashboard:** open the NEW `admin/admin.html` → **Publish → Restore backup** → choose your backup file. Then **Settings** → check your wallets and press **Save**.
5. **Sync:** **Publish → Sync to server** (wait for ✅).
6. **Website:** **Publish → Download data.js** → put it in the new `site` folder (replace the one inside) → upload the **whole `site` folder** to Netlify (Deploys → drag the folder). The folder now contains: `index.html`, `style.css`, `app.js`, `bg.js`, `qr.js`, `data.js`, `pack-1.js`, `pack-2.js`, `logo.png`, `logo-96.png`, `logo-512.png`, `favicon.png`, `_headers`, `shop.html`, `manifest.webmanifest`.

> Always upload the **whole folder** — the shop is now several files.

---

## First-time setup (if you are starting fresh)

### 1 — Server (Cloudflare)
1. Cloudflare → Workers & Pages → create a Worker → paste `worker/worker.js` → Deploy.
2. Settings → **Variables and Secrets**: add a **Secret** named `ADMIN_TOKEN` (a long password only you know). Settings → **Bindings** → add a **KV namespace** named `ORDERS`.
3. Open `…/api/health` → you want `"ok":true`, `"kv":true`, `"version":18`.
4. Do **not** add a Cron Trigger (the shop does not need one).

### 2 — Dashboard
1. Open `admin/admin.html`. **Settings**:
   - **Server connection:** your Worker address (`https://…workers.dev`) and your `ADMIN_TOKEN` → **Test connection** (you want ✅).
   - **Where customers pay you:** add the wallets you want to accept (see the box below).
   - Store name, email → **Save settings**.
2. **Publish → Sync to server**, then **Download data.js** and upload the `site` folder.

### Payment methods — which one to use
| Method | Detected automatically? | Notes |
|---|---|---|
| **USDT TRC20** (address starts with `T`) | ✅ yes | Cheapest for most people |
| **USDT BEP20** (address starts with `0x`) | ✅ yes | Fast; low fee on Binance |
| **Bitcoin** | ✅ yes (after 1 confirmation) | Slower, 10–30 min |
| **Binance Pay** (your Pay ID) | ❌ you confirm | Customer presses “I have paid”; the dashboard marks it **needs you**; you press **Mark paid**; delivery is automatic after that |

**Amounts:** every order gets a few extra **cents** (for example $5.00 becomes **5.12**) so the server can tell orders apart. They are whole cents, so every wallet can type them. The customer must send that exact amount.

**Important:** use an address from a wallet **you control** (TronLink, Trust Wallet…) for TRC20/BEP20. If you use a *Binance deposit address*, customers paying from Binance often pay **inside Binance** — it never appears on the blockchain, so the shop cannot see it. Binance Pay is the right option for those customers.
Minimum amounts: some wallets (like the one that blocked you) refuse deposits under a minimum, so test with a wallet that accepts small amounts.

---

## Gift cards from FazerCards (no stock needed)

You pick what to sell, set your profit **once** (percent or fixed dollars), and the shop shows live prices. When a customer pays, the server buys the code from FazerCards and shows it to the customer.

**One-time setup**
1. Create an account at https://reseller.fazercards.com → create an **API key** (starts with `fc_`). Keep it secret — never paste it into the dashboard or send it to anyone.
2. Put money into your FazerCards **balance** (every sale is paid from it).
3. Cloudflare → your Worker → **Settings → Variables and Secrets → Add** → **Secret**, name `FAZER_KEY`, value = your key → **Deploy**. `/api/health` should now show `"supplier":true`.
4. Dashboard → **🎁 Gift cards** → **Check connection & balance**.

**Choose what to sell (one time, then it is automatic)**
1. **Your profit:** choose **Percent** or **Fixed $** and a number. The example below the box shows what a $10 card sells for.
2. **Load catalog** → the brand, country and group of every category are detected automatically (you can fix any row).
3. Search (for example “itunes”) → **Select all shown**, or tick the ones you want → **Save selection**.
4. **Publish → Sync to server**, then **Download data.js** and upload the site folder.

Customers then see: **Gift cards → brand (iTunes) → country (flag) → amount → cart**. Prices are always live (cost + your profit), so you never re-price by hand when FazerCards changes costs.

**What protects you**
- Before a customer can pay, the server checks the card is in stock, your price is above the current cost, and your balance is enough. If not, it shows “temporarily unavailable” and nobody pays.
- If FazerCards is down right after a payment, the customer sees “your code is being prepared” and the server retries by itself. Dashboard → **Orders** shows it; **Retry delivery** if something needs you. Retrying can never buy twice.
- The brand logos come from FazerCards.

**Please test first:** buy ONE cheap gift card yourself with USDT and check the code works before announcing the shop.
Game top-ups (which need the player's ID) are the next step and are not in this version.


---

## Live chat, WhatsApp and Telegram alerts (free)

**What customers get:** a round chat button on the shop. It opens a small window with your **WhatsApp**, **Telegram** and **Email**, and a **live chat** box when you connect Telegram. Inside the payment window there are the same contact buttons, so anyone with a problem can reach you in one tap.

**What you get:** a Telegram alert for every new sign-up, every new order (“🛒 New order… waiting for payment”), every payment (“✅ Paid…”), Binance Pay claims and stuck deliveries, plus every chat message.

**Set it up (10 minutes, one time)**
1. In Telegram open **@BotFather** → send `/newbot` → choose a name → copy the **token** it gives you.
2. Cloudflare → your Worker → **Settings → Variables and Secrets → Add** → **Secret**, name `TELEGRAM_BOT_TOKEN`, value = the token → **Deploy**.
3. Dashboard → **Settings → Contact & alerts**: type your **WhatsApp number** (country code, digits only — e.g. `963912345678`) and, if you like, your Telegram username → **Save settings** → **Publish → Sync**, then **Download data.js** and upload the site folder.
4. Settings → **Connect Telegram** → press **Open Telegram and press START**. The bot answers **“✅ Connected!”** in Telegram. The dashboard checks by itself and can take **up to a minute** to show ✅ Connected (Cloudflare storage is slow to update between countries) — if Telegram already said Connected, it worked. Then press **Send test alert**.
   - If Telegram shows **no START button** (you used the bot before), send the bot the exact message the dashboard shows, like `/start AbCd123xyz`.
   - If the dashboard says *“Telegram could not reach your server”*, the Worker address is wrong or the Worker was not re-deployed with the newest `worker.js`.
   - To switch to another Telegram account: **Disconnect** first, then connect again.

**Answering a chat:** in Telegram, long-press the customer's message → **Reply**. Your answer appears in their chat window within seconds. (WhatsApp messages come to your normal WhatsApp.)

## Quantity (buy 3 iTunes cards in one order)
In the gift-card window every amount has a **− 1 +** stepper (limited by what FazerCards allows per order, up to 10). The cart also has steppers. One payment buys all cards; the order page shows each code on its own scratch card, and the invoice shows “×3”.

## Customers paying from Binance to your Binance address
In **Settings → Where customers pay you** tick **“This is a Binance deposit address”** under the TRC20/BEP20 address if it is a Binance address. At checkout customers then choose **Another wallet or exchange** or **Binance app**. If they pick the Binance app they see: *“a Binance→Binance transfer is internal and can take a while — if your order is not confirmed within 1 hour, contact us”* with WhatsApp / chat buttons. Those orders stay open for 3 hours, you get a Telegram alert immediately, and after 1 hour they show up as **needs you** in the dashboard so you can check Binance and press **Mark paid** (delivery is then automatic). Customers using any other wallet continue the normal way.

---

## Game top-ups (PUBG, Free Fire, Mobile Legends…)
1. Dashboard → **🎁 Gift cards** → step **4 · Game top-ups** → **Load game list** → tick the games you want → **Save games**.
2. **Publish → Sync to server**, then **Download data.js** and upload the `site` folder.
3. Customers open the game, type their **Player ID** (and server if asked), can press **Check my ID**, choose an amount and pay like normal. After payment the server asks FazerCards to top up that account.
4. A top-up is **not instant**: the order shows “being prepared” until FazerCards completes it. If FazerCards refunds or fails, you get a Telegram alert and the order shows **needs you** — refund your customer or press **Retry delivery**.
5. Prices use your profit rule (step 2). To change one amount, press **Prices** next to the game and type the new price.

> I have not been able to test a real top-up (it needs your FazerCards balance). Please buy ONE small top-up for your own game account first.

## Your own digital items (not from FazerCards)
Dashboard → **Products** → **+ New digital item (my own codes)**. Type the name, the price, and paste your codes (one per line). Each sale hands out the next unused code automatically and the item shows “out of stock” when the list is empty.

## Change one price only
- **Your own products:** Products → change the price in the table → **Sync to server**.
- **Gift cards / top-ups:** Gift cards → **Prices** next to a brand → type a new price on that row (**Reset** returns to your automatic profit) → **Sync to server**. Prices never go below cost + 1 cent.

## Social media icons and best sellers
Settings → **Social media & best sellers**. Paste your full links (https://…). Only the ones you fill appear as icons at the bottom of the shop. In the same box, type the brand names you want shown first (for example `itunes, pubg, roblox`). Then **Save settings → Sync → Download data.js → upload the site folder**.

## Install the shop like an app (hides the browser bars)
A website cannot hide the browser's own bottom bar. But when a customer (or you) installs the shop, it opens full screen with no browser bars at all:
- **iPhone (Safari):** Share button → **Add to Home Screen**.
- **Android (Chrome):** menu ⋮ → **Install app** / **Add to Home screen**.

## New in the dashboard and shop
- **Light glass look** is now the default (the moon button switches to dark). Screens switch faster.
- **Gift cards → “Live on your shop”** (top of the tab) always shows everything you have already added — brands with their countries, and games — with search and filters. Press a country to see its prices, ✕ to remove it.
- **Prices update live:** change a price and the profit % changes while you type; change the profit setting and any open price list updates instantly. No refresh needed.
- **Game top-ups:** Select all shown / Clear shown, plus All / Selected / Not selected filters.
- **Watermark:** every product preview shows a faint tiled watermark with your store name (turn it off per product in the editor with “Watermark the live preview”). The code the customer receives after paying is always clean. After updating, press **Sync to server**.
- **Shop main page** shows about 50 items, plus a **Show all products** button that opens the full catalogue with search, type filter, categories and sorting.

## Buying a domain and connecting it
- **Cloudflare Registrar (my recommendation):** Cloudflare dashboard → **Domain Registration → Register Domains** → search → buy (card or PayPal). Price is the wholesale cost with no markup, and privacy protection is free.
  1. In **Netlify** → your site → **Domain management → Add a domain** → type your domain.
  2. In **Cloudflare → your domain → DNS → Records**, add: type **CNAME**, name **@** , target `YOUR-SITE.netlify.app`, and set the cloud to **grey “DNS only”**. Add a second one with name **www** and the same target.
  3. Back in Netlify press **Verify DNS**. HTTPS turns on by itself after a few minutes.
- **Buying inside Netlify:** also works and is the simplest (it sets up DNS for you), but there are fewer choices and it can cost more. If you leave Netlify later you just move the domain. Either way the server (Cloudflare Worker) needs **no change**.
- Choose a name without brand words (iTunes, PUBG, Roblox…). Turn on two-step login at the registrar and keep the account in your own name and email.

## How to publish a change (cheat sheet)
| What changed | What to do |
|---|---|
| A price (own products, gift cards, top-ups) | Dashboard → **Sync to server** |
| Wallets, profit %, watermark switch | Settings → Save → **Sync to server** |
| New or removed product, brand or game, names, images, social links | **Sync to server** → **Download data.js** → put it in the `site` folder → upload the **whole `site` folder** to Netlify (Deploys → drag the folder) |
| Shop design or checkout fix from me | Download the new project → upload the whole `site` folder to Netlify |
| Server fix from me (`worker.js`) | Cloudflare → your Worker → **Edit code** → paste the whole file → **Deploy** → open `/api/health` and check the version number |
| Dashboard update from me (`admin.html`) | Open the new `admin.html` → **Publish → Restore backup** with your latest backup file |
Always make a **Backup everything** before replacing the dashboard file.

## Email receipts (free, about 10 minutes)
After every paid order the customer gets an email with the invoice and an **Open my order & codes** button (the codes themselves stay on the private page, not in the email). It is optional — nothing breaks if you skip it.

**You need a domain first** (see “Buying a domain”), because mail from a free address like Gmail is blocked as spam.
1. Create a free account at **resend.com** (free plan: 100 emails a day, 3,000 a month).
2. In Resend → **Domains → Add Domain** → type your domain. Resend shows a few DNS records. Copy them into **Cloudflare → your domain → DNS → Records** exactly as shown (DNS only / grey cloud), then press **Verify** in Resend (can take a few minutes).
3. Resend → **API Keys → Create** → copy the key (starts with `re_`).
4. Cloudflare → your Worker → **Settings → Variables and Secrets**:
   - add a **Secret** named `RESEND_KEY` with that key,
   - add a **Variable** (text) named `MAIL_FROM` with your sender, for example: `Geostore <orders@yourdomain.com>` (the part after @ must be your verified domain),
   - optional text variable `MAIL_REPLY` = the address where customer replies should go (your own email).
   Press **Deploy**. `/api/health` now shows `"mail":true`.
5. Dashboard → **Settings → Email receipts** → type your email → **Send a test email**.

If a receipt cannot be sent you get a Telegram note with the reason, and the order is still delivered normally. Each order sends one receipt only.

## Binance auto-detect (fully automatic Binance Pay and Binance → Binance payments)
**What it solves:** a customer who pays from **their Binance account to your Binance account** (Binance Pay, or your Binance deposit address on TRC20/BEP20) never touches the blockchain, so normal detection cannot see it. With a **read-only** Binance API key the server reads your Binance history and confirms those orders by itself. It also removes the need for a second wallet: Binance deposit addresses accept small amounts.

**Set it up (10 minutes)**
1. Binance → **Profile → API Management → Create API** → *System generated* → name it `geostore` → finish the security check.
2. On the new key keep **only “Enable Reading”** ticked. Do **not** tick trading, withdrawals or anything else. For IP access choose **Unrestricted** (Cloudflare has no fixed address) — this is safe only because the key can read, never move money.
3. Copy the **API key** and the **Secret key** (Binance shows the secret once).
4. Cloudflare → your Worker → **Settings → Variables and Secrets** → add two **Secrets**: `BINANCE_KEY` and `BINANCE_SECRET` → **Deploy**. `/api/health` should show `"binance":true`.
5. Dashboard → Settings → **Binance auto-detect** → **Check Binance connection**. You want two green lines (deposit history and Binance Pay history).
6. Get your Binance **deposit addresses** (Binance → Wallet → Deposit → USDT → network TRON (TRC20) / BNB Smart Chain (BEP20)) and put them in Settings → Where customers pay you, with the **“This is a Binance deposit address”** box ticked. Your Binance Pay ID goes in the Binance Pay box. Save → Sync.

**How it works:** every order has a unique amount (for example 5.14). When your Binance history shows an incoming USDT payment of exactly that amount, the order turns paid. Customers must send the **exact amount**.

**Good to know**
- **If the check says “Binance blocks this server location (HTTP 403)”** — Binance refuses some countries, and Cloudflare sometimes runs your server in one of them. Try these in order:
  1. **Smart Placement:** Cloudflare → your Worker → **Settings → Runtime → Placement → Smart** → save. Cloudflare then runs your server near the services it calls. Wait a minute and press **Check Binance connection** again.
  2. Press the check button two or three times — different Cloudflare locations answer different times.
  3. **Binance relay (always works if you pick an allowed country):** follow `relay/README.md` — about 10 minutes, free on Vercel, in Frankfurt. It only forwards your two read-only history calls.
  Meanwhile **Mark paid** keeps working for Binance orders.
- If Binance refuses requests from Cloudflare's location (an HTTP 451 or “restricted location” message), the server automatically tries Binance's other addresses; if all fail, **Why not paid?** shows the reason and **Mark paid** still works.
- Keep your Binance account safe (two-step login). Never create a key with withdrawal permission.
- I could not test this against the real Binance service from here, only against simulated answers. Test with one small real payment before announcing.

## Selling whole projects (website + dashboard, Android project…)
A product can now carry **project files** that the customer downloads after paying.
1. Zip each part (for example `website.zip` and `dashboard.zip`, or your Android project folder as one ZIP).
2. Dashboard → **Products** → open (or create) the product → **Project files**:
   - **⬆ Upload a file** (up to **20 MB** each, up to 8 files). Files are stored privately on your server — customers cannot reach them without a paid order.
   - **Add link**: for bigger files paste a private download link (Google Drive, Mega, Dropbox, OneDrive). The customer sees it as a button after payment.
3. If you also want a live demo on the shop, keep a sample page in the product (its public sample + full preview). The shop shows “📦 Project files” on the card and lists the file names; the files themselves are only given after payment.
4. **Save the product → Sync to server → Download data.js → upload the site folder.**
5. After payment the order page shows a **Project files** section with one download button per file.
Backups made from the dashboard do **not** include the uploaded ZIP files (they live on the server), so keep your original ZIPs on your computer.

## Deleting expired orders
Unpaid orders that expired are hidden from your customers and from your Orders list. Orders → **🗑 Delete expired orders** removes them for good (paid orders are never touched).

## Dashboard
The dashboard now has the dark glass look. **Home** shows revenue, paid orders, estimated profit and “needs you” for **Today / 7D / 30D / 1Y**, a performance chart, payment-method split and the latest orders. **Gift cards → Prices** shows what each amount **costs you** at FazerCards, what you sell it for and your profit. The sun/moon button switches to a light dashboard.

---

## What happens when someone buys

**Customer:** picks an item → cart → email → chooses a payment box → pays the exact amount (QR code and copy buttons are shown) → the window turns green → **Open my codes & invoice**. The order page shows the invoice, and gift-card codes sit under a **scratch area** the customer scratches with a finger. They can also create an account to see all orders and payments.

**You:** nothing, except orders marked **needs you** (Binance Pay claims, or a supplier problem). Dashboard → **Orders** → filter **Needs you**.

---

## Every time you change something later

| You changed… | Do this |
|---|---|
| a **price** (product, gift-card profit, All-Access) | **Sync to server** only — the shop shows new prices by itself |
| **wallets** | Settings → Save → **Sync to server** |
| product **names, descriptions, images, new/removed products, gift-card brands** | **Sync to server** → **Download data.js** → upload the `site` folder |
| nothing, just want a **backup** | Publish → Backup everything |

The two chips at the top of the dashboard show exactly what is still pending.

---

## If something goes wrong
- **Sync says ❌** → read the message after the ❌ (it is the real reason). “KV … limit exceeded” = Cloudflare's FREE daily limit; it resets by itself at 00:00 UTC (the dashboard shows the time in your own clock).
- **Test connection says “Failed to fetch”** → check the server address, then open `…/api/health` in a browser.
- **“Wrong or missing admin token”** → paste the same `ADMIN_TOKEN` in Settings and Save. (After 12 wrong tries from one connection the server locks that connection for 10 minutes.)
- **The shop does not show new products or brands** → upload the new `data.js` (Publish → step 2).
- **A payment window turned green but I got no code** → ask the customer to open **Account → Orders**, or open the order from the dashboard → Orders → **Open order**.
- **A payment is not detected** → Dashboard → **Orders** → press **Why not paid?** on that order. It asks the blockchain right now and tells you what it sees (the amount that arrived, or that nothing arrived, or that the free lookup service refused). If the money is there and matches, the order turns paid by itself.
- **Customer says they paid but the window stays waiting** → check your wallet; if the money is there, Orders → **Mark paid**.

---

## Will the Cloudflare limit error come back?
Only if you use more than the free daily allowance — and the shop uses very little:

| What happens | Cloudflare writes used (free = 1,000 per day) |
|---|---|
| First full Sync of 36 products | about 37 (only once) |
| Later Syncs (only changed products) | about 1–3 |
| A customer places an order | 3 |
| That customer's payment is detected | 2 (+1 delete) |
| Browsing, watching the payment window, reading the account | **0** |

Roughly **150–200 orders per day** fit in the free plan. The server also limits each visitor to 4 orders per 10 minutes (and the whole shop to 60) so nobody can use up your daily allowance. Beyond ~150 orders/day, Cloudflare's paid plan is $5 per month.

## Security notes (short)
- Your admin token and FazerCards key live only in Cloudflare secrets / your browser — never in the shop files.
- The shop only ever receives public data. Private code and supplier costs never leave the server until a customer has paid.
- Order pages use long secret links; only the first 8 characters of an order are shown to customers as the “order number”.
- Keep your backup files private — they contain your private code.
