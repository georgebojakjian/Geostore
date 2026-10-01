# Geostore Codes — Complete Guide (for beginners)

You sell **website code** (navbars, heroes, product grids, pricing tables, FAQs, footers…).
Customers see a live preview and a FREE sample. After they pay, you send the FULL code.

## What is in this folder

| Folder / file | What it is | Upload to the internet? |
|---|---|---|
| `site/shop.html` | Your public shop | YES |
| `site/index.html` | A landing-page template (also sellable) | YES |
| `site/data.js` | Your product list + free samples | YES |
| `admin/admin.html` | Your private dashboard | **NEVER** |
| `admin/private.js` | The paid FULL code | **NEVER** |

## Step 1 — Open your dashboard
Double-click `admin/admin.html`. It opens in your browser (works offline, free).
Tabs: **Dashboard · Products · Orders · Settings · Publish**.
Your data is saved inside that browser on that computer — use **Publish → Backup** regularly.

## Step 2 — Fill Settings
1. Store name, your email, tagline.
2. Wallets — one per line: `USDT (TRC20 network) | your-address`.
3. All-Access pass: turn it on and choose YOUR price (one payment → every code).
4. Press **Save settings**.

### Getting a wallet address (you live in Syria)
Many card/PayPal services do not work in Syria, so crypto is the practical choice.
- Create a free wallet in an app available to you (for example Trust Wallet or Exodus — check what is available where you are), or use an exchange account where you are allowed.
- Choose **USDT on TRC20** (low fees) and copy the address.
- Send a tiny test amount first. Wrong network = lost money.
- Never share your recovery phrase with anyone.
- Check the laws in your country and keep records of sales.

## Step 3 — Manage products (Products tab)
- **New product**: title, category, price, a one-line description.
- **Free sample code** = what everybody can see and copy (a basic version).
- **Full code** = the premium version (kept private).
- **Preview** buttons show exactly what you wrote.
- Untick "Show on the website" to hide a product.
- Six ready-made products are already included.

## Step 4 — Publish for free
1. Admin → **Publish** → **Download data.js**.
2. Put it inside the `site` folder (replace the old one).
3. Go to https://app.netlify.com/drop and drag the whole **`site`** folder onto the page.
4. You get a live link. Open `/shop.html` on it. Later you can connect a domain you buy.
Repeat steps 1–3 after every change.

## Step 5 — When someone buys
1. The customer clicks **Buy**, copies your wallet address, sends the crypto, and presses **I've paid** → an email with the order opens for them to send you.
2. You check your wallet. Money arrived?
3. Admin → **Orders** → add the order (email, item) → press **⬇ Deliver**. A file downloads with live previews and a copy button for every full code.
4. Press **✉ Email** and attach that file. The order becomes "Delivered".

Nobody can get the full code before you send it, because the full code is never on the website.
Delivery is manual (a person checks the wallet). Fully automatic delivery needs a server; ask me when you are ready and I will build it.

## Step 6 — Which codes may you sell?
Sell **your own** code (everything included here is yours to sell). You may also sell code under licences that allow reselling (MIT, CC0) — keep their licence text.
Do **not** copy paid templates from other people: it is illegal, gets you banned from every marketplace, and ends your business.

## Step 7 — Get customers
- Short screen-recordings of each preview (TikTok, Instagram Reels, YouTube Shorts, X).
- Post in communities: r/webdev, r/SideProject, Product Hunt, dev groups on Facebook/Telegram.
- Add one new code every week — "All-Access" gets more valuable each time.
- Answer messages fast; offer a 14-day refund.

## Legal basics
Add Privacy and Terms pages, keep sales records, and follow your local laws.
