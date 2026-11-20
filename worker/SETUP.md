# Downloader on Cloudflare (free)

Live at **https://video-downloader.vdl-4gqjz4.workers.dev**. Only the email on the Cloudflare account can sign in
(a one-time code is emailed each time a sign-in expires, after 30 days).

## What's set up on the Cloudflare account
- Worker `video-downloader` (this folder), on the free `vdl-4gqjz4.workers.dev` address. Preview addresses are off.
- Zero Trust team `vdl-4gqjz4` with **Email code** sign-in.
- Access application `video-downloader` for that address, policy **Only me** (the account's email).
- Worker settings `ACCESS_TEAM` and `ACCESS_AUD` link the helper to that application. The helper checks every
  request's sign-in itself as well, so it refuses to work if the lock is ever removed.

## Let someone else in, or use a different email
Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → `video-downloader` → **Policies** → **Only me**
→ add the email under *Include*.

## Publish a new version
From this folder, with a Cloudflare API token that can edit Workers:

    CLOUDFLARE_ACCOUNT_ID=<account id> npx wrangler deploy

`keep_vars` keeps the two lock settings already stored on the Worker.

## Add a site
Add an adapter in `src/index.js` (see `isFolderPage` / `isTokenFilePage` / `scanGeneric`), then publish.
