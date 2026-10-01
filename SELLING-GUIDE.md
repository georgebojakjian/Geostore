# Geostore — Step-by-Step Guide to Selling Online with Crypto

No coding knowledge needed. Follow the steps in order.

## Step 1 — Put in your own details (5 minutes)

1. Open `index.html` in any text editor (Notepad, VS Code).
2. Press **Ctrl+F** and search for `STORE SETTINGS`.
3. Replace:
   - `YOUR-EMAIL@example.com` → your real email (also search for it once more in the footer and replace it there).
   - `PASTE_YOUR_..._ADDRESS` → your own crypto wallet addresses (Step 2).
   - Delete a wallet line's address (`''`) to hide that coin.
4. Optional: change the brand name "Geostore", the prices, and the colours (`--accent`, `--accent-2` at the top).
5. Double-click `index.html` to preview it in your browser.

## Step 2 — Get a crypto wallet (to receive money)

- Easiest: create an account on **Binance**, **Coinbase** or **Bybit** → Wallet → Deposit → choose **USDT** and the **TRC20** network → copy the address.
- Safer long-term: a self-custody wallet such as **Trust Wallet** or **MetaMask**.
- **Always send a tiny test amount first.** The wrong network = lost money.
- Never share your seed phrase / recovery words with anyone, ever.

## Step 3 — Publish the website for free

Pick one (all free, all take ~2 minutes):
- **Netlify Drop** — go to https://app.netlify.com/drop and drag your `index.html` into the page. You get a live link instantly.
- **GitHub Pages** — repo → Settings → Pages → deploy from branch.
- **Cloudflare Pages / Vercel** — connect the repo.

Later, buy a domain (Namecheap, Porkbun ≈ $10/year) and connect it in the host's settings.

## Step 4 — How customers pay you

Two options, both built in:

**Option A — Manual (works right now, no signup).**
Customer clicks *Choose plan* → sees your wallet address → sends crypto → clicks *I've paid* → an email with their order opens, addressed to you. You check your wallet, then email them the product files.

**Option B — Automatic (recommended once you get sales).**
Create a free merchant account at **NOWPayments**, **Coinbase Commerce** or **Cryptomus**, make a payment link for each plan, and paste the three links into `paymentLinks` in the STORE block. Customers then pay on a hosted page and you get automatic confirmations.

## Step 5 — Deliver the product

- Keep your files (zip) in **Google Drive / Dropbox** and send a private download link after payment is confirmed.
- Or use **Gumroad / Lemon Squeezy** (they also accept card payments) for automatic delivery.

## Step 6 — What to sell (important, read this)

"Getting products for free" is only OK when the licence allows **reselling**. Selling other people's paid or copyrighted work is illegal, gets your accounts banned, and results in refund/chargeback trouble.

Safe sources of free material you may legally include or resell:
- **CC0 / public-domain** assets (check the licence says "CC0"): Pixabay, Pexels, Unsplash (read their licence: you can't resell the raw photos on their own), unDraw, Heroicons, Lucide, Google Fonts.
- **MIT / Apache** licensed code — keep the licence text file.
- **Your own work** — the best option. Geostore itself is yours to sell. Make more templates (portfolio, SaaS, agency) by copying `index.html` and changing the text and colours.

Also add a simple licence file to every download (what the buyer may and may not do).

## Step 7 — Get your first customers

- List it on **Gumroad**, **Etsy (digital downloads)**, **ThemeForest** and **Creative Market**, and link to your own site.
- Post screenshots / short screen recordings on X, Instagram Reels, TikTok, Reddit (r/webdev, r/SideProject), Product Hunt.
- Use keywords people search for: "dark landing page template", "SaaS website template".
- Offer a 14-day refund and reply to messages fast.

## Legal basics

- Keep records of every sale; crypto income is usually taxable in your country.
- Add Privacy Policy and Terms pages before taking real orders (free generators exist: Termly, iubenda).
