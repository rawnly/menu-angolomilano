# Contributing

Thanks for your interest in contributing.

## Development setup
1) Install dependencies

```bash
npm install
```

2) Set required secrets

```bash
npx wrangler secret put SLACK_SIGNING_SECRET
npx wrangler secret put SLACK_BOT_TOKEN
```

3) Run locally

```bash
npx wrangler dev
```

## Tests

```bash
npm test
```

## Code style
- Keep changes focused and small when possible.
- Follow existing formatting and Effect usage patterns.

## Reporting issues
Include steps to reproduce, expected behavior, and environment details.
