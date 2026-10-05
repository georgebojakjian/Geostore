# Geostore Codes — Complete Guide (for beginners)

> **New here? Read `START-HERE.md` first — it is the short, simple version and it is the up-to-date one.**

> **Want fully automatic payments and delivery?** Follow `DEPLOY-AUTOMATIC.md` first. This guide describes the simple manual mode and the business side.

You sell **website code** (navbars, heroes, product grids, pricing tables, FAQs, footers…).
Customers see a live preview and a FREE sample. After they pay, you send the FULL code.

## What is in this folder

| Folder / file | What it is | Upload to the internet? |
|---|---|---|
| `site/index.html` | Your home page and shop (all products) | YES |
| `site/data.js` | Your product list + free samples | YES |
| `site/pack-2.js` | 10 complete 3D websites (free previews + how-to guides) | YES |
| `site/pack-1.js` | 20 extra products, free samples only (3 styles each) | YES |
| `site/style.css`, `site/app.js`, `site/qr.js` | The shop's design and logic | YES |
| `site/logo*.png`, `site/favicon.png` | Your logo (site, browser tab, dashboard, order pages) | YES |
| `admin/admin.html` | Your private dashboard | **NEVER** |
| `admin/private.js` | The paid FULL code of the first 6 products | **NEVER** |
| `admin/private-pack-2.js` | The paid FULL code of the 10 complete websites | **NEVER** |
| `admin/private-pack-1.js` | The paid FULL code of the 20 extra products | **NEVER** |

## Step 1 — Open your dashboard
Double-click `admin/admin.html`. It opens in your browser (works offline, free).
Menu: **Home · Products · Gift cards · Orders · Customers · Settings · Publish**.
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
4. You get a live link. Open the home page on it. Later you can connect a domain you buy.
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

## Your logo
The logo files are `site/logo.png` (256px), `logo-96.png` (header), `logo-512.png` and `favicon.png`. To use a different logo, replace those files (keep the same names and square shapes), then upload the `site` folder again.

## Product packs: 20 products with 3 styles each
`site/pack-1.js` adds 20 products (portfolio bento grid, SaaS pricing, email template, glass login, 404 page, dashboard sidebar, countdown page, floating action button, mega menu, SVG hero backgrounds, link-in-bio, crypto ticker, restaurant site, checkout wizard, dark/light toggle, agency site, testimonial slider, course accordion, real-estate listings, cookie banner).
- **One price per product; the buyer gets all 3 styles.** Customers can preview every style and copy a free basic sample of each.
- The **full** versions (animations, JavaScript, mobile layout, extra sections) stay private in `admin/private-pack-1.js` and are only delivered after payment.
- A pack never overwrites a product you already have, so your own edits and prices are safe. Change prices and names in the dashboard → Products.
- Crypto ticker note: the live prices use CoinGecko's free public API, which has rate limits. Tell customers to add their own API key for heavy traffic.

## Digital items (gift cards, licence keys...) — prepared, switched off
- On the home page there is a **Digital items** section. While you have none, it shows a "Coming soon" card. You can hide the whole section: dashboard → Settings → untick "Show the Digital items section".
- To add one: dashboard → Products → New product → Type: **Digital item**. Set the title, price, an emoji icon, and paste your **stock, one code per line**.
- When a customer pays, the server gives them the **next unused code** on their private page. When stock runs out, the item shows "out of stock" and cannot be ordered.
- After you add or change stock: Publish → **Sync to server**. Always add new codes at the **end** of the list, and never delete or reorder codes that were already sold.
- Only sell codes you obtained legitimately and are allowed to resell. Gift cards are a favourite target for fraud and chargebacks, so be careful where your stock comes from.

## How to update an existing setup (do this in order)
1. **Backup first:** in your OLD dashboard open Publish → **Backup everything**. Keep that file.
2. Download the latest project from GitHub (branch `claude/geostore-website-template-bwou47`).
3. Open the NEW `admin/admin.html` → Publish → **Restore backup** and pick your backup file. Your products, prices, orders and settings return, and the 20 new products are added.
4. Cloudflare → your Worker → Edit code → paste the new `worker/worker.js` → Deploy.
5. Dashboard → Publish → **Sync to server** (this uploads the full code of all products).
6. Copy the new `site/index.html`, `site/pack-1.js` and the logo files into your `site` folder. Keep your own `data.js`. Upload the `site` folder to Netlify (Deploys tab).

## New in version 3

### Cart, and buying a single style
- Customers can **Add to cart** (several products at once) or **Buy now**. In every product window they choose **all styles** (the product price) or **only the style they are looking at** (the "one style" price).
- You set the one-style price per product in the dashboard (Products → "Price for ONE style only"). Empty = half of the product price. If someone adds every style one by one, they are never charged more than the all-styles price.
- A customer who buys one style receives **only that style** on their private page.

### Complete websites (10 included)
E-commerce, restaurant, pharmacy, clothing store, grocery, medical clinic, hotel, real estate, car dealership and gym — each in **3 colour styles**, all with 3D effects, a cart / booking / enquiry system, filters, search, reviews and a contact area.
- Each website has a **"How to use & connect your data"** guide: it is shown on the product page (so buyers know what they get) and again on their delivery page. It explains editing the file, adding products, **connecting a Google Sheet or JSON/API**, receiving orders by WhatsApp / email / form service, adding a payment link, and publishing for free.
- You can edit any website or its guide in the dashboard (Products). To make your own, create a product and choose **Shown in: Complete websites section**.

### Payments: USDT and Bitcoin
Set both wallets in dashboard → Settings. See `DEPLOY-AUTOMATIC.md` for details.

### Customer accounts
See `DEPLOY-AUTOMATIC.md`. The payment window no longer pops up when a page is refreshed — customers find unfinished orders under **Account → Continue payment**.

### Update steps for version 3 (in this order)
1. Dashboard (old) → Publish → **Backup everything**.
2. Download the latest project; open the new `admin/admin.html` → Publish → **Restore backup**. The 10 websites are added automatically.
3. Cloudflare → your Worker → paste the new `worker/worker.js` → Deploy.
4. Dashboard → Settings → check your **USDT and Bitcoin** wallets → Save → Publish → **Sync to server**.
5. Copy the new `site/index.html`, `site/pack-1.js`, `site/pack-2.js`, the logo files into your `site` folder (keep your own `data.js`) and upload to Netlify (Deploys tab).
