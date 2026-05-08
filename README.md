# AngoloMilano Slack

Cloudflare Worker that scrapes the Angolo Milano menu and posts it to Slack.

## Features
- Scheduled broadcast of the menu to tracked Slack channels
- Slash command endpoint for on-demand menu retrieval
- Slack events handler for channel join/leave tracking
- KV caching and Cloudflare AI OCR for image text extraction

## Stack
- Cloudflare Workers (with `nodejs_compat`)
- Cloudflare KV
- Cloudflare Vectorize (configured binding)
- Cloudflare AI (vision OCR)
- Effect for orchestration

## Setup
1) Install dependencies

```bash
npm install
```

2) Configure Cloudflare and Slack secrets

```bash
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
```

3) Ensure bindings in `wrangler.jsonc` match your Cloudflare resources

## Development
Run locally with Wrangler:

```bash
npx wrangler dev
```

## Deploy

```bash
npx wrangler deploy
```

## Endpoints
- `POST /slack/commands` Slack slash command handler
- `POST /slack/events` Slack events handler

## Notes
- `.dev.vars` and `.env*` are intentionally gitignored.
- Use `npx wrangler types` after changing bindings.

## License
MIT
