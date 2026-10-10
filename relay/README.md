# Binance relay (only needed if the dashboard says “Binance blocks this server location”)

1. Create a free account at vercel.com (you can sign in with GitHub or email).
2. Add New → Project → import this repository, and set **Root Directory** to `relay`. Deploy.
3. Project → Settings → Environment Variables → add `RELAY_SECRET` = a long random password (letters and numbers). Redeploy.
4. Cloudflare → your Worker → Settings → Variables and Secrets:
   - Text variable `BINANCE_RELAY` = `https://YOUR-PROJECT.vercel.app/api/binance`
   - Secret `RELAY_SECRET` = the same password
   Deploy. Then Dashboard → Settings → Check Binance connection.

`vercel.json` runs the relay in Frankfurt (`fra1`). If Binance still refuses, change it to another region such as `arn1` (Stockholm) or `cdg1` (Paris) and redeploy.
