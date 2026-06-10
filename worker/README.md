# Raw Markdown Worker

A tiny Cloudflare Worker that stores one markdown object per conversation (and
per file) in R2 and serves it at a stable URL — so an AI can fetch the full
history directly. R2's strong read-after-write consistency keeps the append
(read-modify-write) correct.

See [`src/index.js`](src/index.js) for the API (`GET`/`PUT`/`POST /conv/{id}`).

## Deploy

Requires a Cloudflare account. From this `worker/` directory (first copy the
config template: `cp wrangler.toml.example wrangler.toml`):

1. **Create an R2 bucket** (the name must match `bucket_name` in `wrangler.toml`):
   ```sh
   npx wrangler r2 bucket create ai-chat-md
   ```

2. **Set the write token** (any strong random string — the extension uses the
   same value as its "Write Token"):
   ```sh
   npx wrangler secret put WRITE_TOKEN
   ```

3. **Deploy:**
   ```sh
   npx wrangler deploy
   ```
   Note the printed URL, e.g. `https://ai-chat-md.<you>.workers.dev`.

## Use from the extension

In the extension's settings page, enable the **Cloudflare (raw markdown)** sink
and fill in:
- **Worker URL**: the deployed URL above.
- **Write Token**: the same value you set for `WRITE_TOKEN`.

Each conversation is then readable at `<Worker URL>/conv/<conversation-id>`.

## Security

Reads are public (unlisted — anyone with the URL/id can read). Writes require the
bearer token. Anyone you give a `/conv/{id}` URL to (including an AI you ask to
read it) can see that conversation; don't put secrets in synced chats.
