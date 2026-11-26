# Petitio

Work in progress for Hacksgiving 2026.

Your flight was cancelled and the airline owes you money. This agent runs on a
[Fly.io Sprite](https://docs.fly.io/sprites/) and takes the claim from start to payment: it
drafts the claim, fills the airline's form with your approval, answers false excuses with
public evidence such as the official airport weather report, and prepares the complaint for
the consumer agency if the airline does not pay.

## Where things are

```
agent/                 the agent
  knowledge/eu261/     EU Regulation 261/2004: official text, airports, compensation rules
server/                HTTP service the Sprite runs
```

Amounts and legal quotes come from `agent/knowledge/`, never from the language model. A test
checks every quote word for word against the official text.

## Run locally

Needs Node.js 24 and pnpm 11.

```bash
pnpm install
pnpm dev
curl http://localhost:8080/health
```

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

## License

MIT
