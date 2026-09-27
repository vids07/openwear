# TryOn

Real-time virtual try-on showcase. Static site in `public/`, API in a
Cloudflare Worker (`worker/index.js`), free-trial records in Cloudflare D1.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # then set SESSION_SECRET (and optional keys)
npm run dev                      # http://localhost:8787
```

## Deploy to Cloudflare (one-time setup)

```sh
npx wrangler login
npx wrangler d1 create tryon          # paste the printed database_id into wrangler.jsonc
npx wrangler secret put SESSION_SECRET
npx wrangler secret put DECART_API_KEY          # optional: live try-on
npx wrangler secret put GOOGLE_CLIENT_ID        # optional: Google sign-in
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run deploy
```

After that, `npm run deploy` builds, applies any new migrations, and deploys.

To serve on a custom domain, uncomment `routes` in `wrangler.jsonc`. For Google
sign-in, add `https://<your-domain>/auth/google/callback` as an authorized
redirect URI.
