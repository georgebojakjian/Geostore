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
3. **Server:** open `worker/worker.js` → copy everything → Cloudflare → your worker → **Edit code** → paste → **Deploy**. Open `https://YOUR-WORKER/api/health` → it must show `"version":9`.
4. **Dashboard:** open the NEW `admin/admin.html` → **Publish → Restore backup** → choose your backup file. Then **Settings** → check your wallets and press **Save**.
5. **Sync:** **Publish → Sync to server** (wait for ✅).
6. **Website:** **Publish → Download data.js** → put it in the new `site` folder (replace the one inside) → upload the **whole `site` folder** to Netlify (Deploys → drag the folder). The folder now contains: `index.html`, `style.css`, `app.js`, `bg.js`, `qr.js`, `data.js`, `pack-1.js`, `pack-2.js`, `logo.png`, `logo-96.png`, `logo-512.png`, `favicon.png`, `_headers`, `shop.html`.

> Always upload the **whole folder** — the shop is now several files.

---

## First-time setup (if you are starting fresh)

### 1 — Server (Cloudflare)
1. Cloudflare → Workers & Pages → create a Worker → paste `worker/worker.js` → Deploy.
2. Settings → **Variables and Secrets**: add a **Secret** named `ADMIN_TOKEN` (a long password only you know). Settings → **Bindings** → add a **KV namespace** named `ORDERS`.
3. Open `…/api/health` → you want `"ok":true`, `"kv":true`, `"version":9`.
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

**What you get:** a Telegram alert for every new order (“🛒 New order… waiting for payment”), every payment (“✅ Paid…”), Binance Pay claims and stuck deliveries, plus every chat message.

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
