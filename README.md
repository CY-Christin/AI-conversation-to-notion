# AI Chat → Notion Sync

A browser extension that archives your AI conversations to Notion — one
conversation per Notion page, incrementally and without losing history.

- **Verbatim**: captures both your prompts and the AI's replies, preserving
  markdown and code blocks.
- **Never miss a turn**: history backfill and cross-device continuation are
  handled by the same diff-based sync.
- **Pluggable platforms**: ships with Claude; ChatGPT and Gemini via adapters.

> Status: M1 — Claude capture pipeline working (no Notion writes yet).

## How it works (short version)

The extension treats the live response stream only as a *signal* that a turn
finished, then re-fetches the platform's canonical conversation object and
diffs it (by message id) against what's already in Notion. This single path
covers real-time chat, opening old conversations, and picking up messages sent
from another device.

## Security

Your Notion token is entered in the extension's settings and stored in
`chrome.storage` — it never lives in this repo or in a build artifact. The
`.env` / `.env.example` files exist only for local integration tests.

## License

[MIT](LICENSE).
