# Flight claim agent

Work in progress for Hacksgiving 2026.

Your flight was cancelled or delayed and the airline owes you money. This agent runs on a
[Fly.io Sprite](https://docs.fly.io/sprites/) and takes the claim from start to payment: it
drafts the claim, fills the airline's form with your approval, answers false excuses with
public evidence such as the official airport weather report, and prepares the complaint for
the consumer agency if the airline does not pay.

## Run locally

Needs Node.js 24 and pnpm 11.

```bash
pnpm install
pnpm dev
curl http://localhost:8080/health
```

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm build
```

## License

MIT
