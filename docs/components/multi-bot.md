# Multi-bot orchestration

Multiple papercup bots can co-exist in one Discord server, each owned by a different operator, each on a different machine with its own credentials/model/budget. Discord becomes the message bus; humans can watch and steer the negotiation in real time.

This page documents what's shipped. The full design and unbuilt phases live in [`docs/design-notes/multi-bot-orchestration.md`](https://github.com/powder-nomad/papercup/blob/main/docs/design-notes/multi-bot-orchestration.md).

## What ships today

### Loop cap (Phase 1)

`BOT_BOT_MAX_TURNS` (default `3`). Per-channel counter of papercup's consecutive replies since the last human message. When the counter is at or above the cap and another bot speaks, papercup ignores the message. Any human message resets the counter to zero.

### Reactivity modes (Phase 1)

Per-session, set via `/reactivity mode:<strict|loose|chatty>`. Controls how the bot reacts to messages from *other* bots — human messages always follow the existing bound-channel / @-mention rules.

| Mode | Behavior |
| --- | --- |
| `strict` (default) | Ignore other bots unless directly @-mentioned |
| `loose` | Respond to other bots without @-mention |
| `chatty` | Reserved — same as loose today |

### Mention allowlist (Phase 1)

`BOT_ALLOWED_USERS` already gates slash commands; the same env var now also gates @-mentions in messages, including from other bots. Stops bad actors from token-drain attacks: bots not on the allowlist are ignored regardless of reactivity mode.

### Budget tracking (Phase 2)

Each bot tracks daily token + USD usage in `data/budget.json`:

```json
{
  "budgetUsd": 10.0,
  "usage": [
    { "date": "2026-05-12", "inputTokens": 12345, "outputTokens": 6789, "costUsd": 0.42 }
  ]
}
```

30-day rolling history. Pricing snapshot for common models (Claude Opus/Sonnet/Haiku 4.x, GPT-5/4o/o3, Gemini 2.5) ships in `agent/budget.ts`; unknown models record tokens only.

Hard cap behavior:
- Humans get an explicit "💸 budget spent" reply
- Other bots are silently ignored
- Cap resets at UTC midnight

Configure via `BOT_DAILY_BUDGET_USD` env or `/budget set_usd:<n>` at runtime.

### Rich-presence broadcast (Phase 2)

The bot's Discord activity status shows `46% of $10/day` (when a cap is set) or `12k tokens today` (no cap). Visible to humans on bot hover; other bots can read it via Discord API. Updates after every reply. No mention spam, no slash-command UI clutter.

### In-band roster (Phase 3)

Set `BOT_ROSTER_CHANNEL_ID` to a designated `#roster` channel. Each operator runs `/announce` once; their bot posts a structured introduction:

```
papercup-roster v1
bot_id: 1234567890
owner: <@123456789012345678>
workdir: /home/operator/workspaces/foo
reactivity: strict
budget: $10/day
fingerprint: DDvzs4P1am30KSRN
public_key: MCowBQYDK2VwAyEA...
```

On bot startup (and on `/refresh-roster`), papercup scrapes recent messages from that channel, parses any `papercup-roster v1` blocks, and builds the local roster. Each entry keyed by Discord bot-id.

**No out-of-band coordination required.** Operators just need to agree on which channel is the `#roster` channel.

### Workdir overlap check (Phase 3)

On boot, papercup compares its declared `BOT_WORKDIR` (defaults to `process.cwd()`) against every other roster entry's workdir. Logs a warning if:

- Exact match (`/foo` vs `/foo`)
- We're inside them (`/foo/bar` vs `/foo`)
- They're inside us (`/foo` vs `/foo/bar`)

**Log-only, doesn't fail boot** — single-bot operation would otherwise warn every time. Read startup logs when adding new operators.

### Cryptographic identity (Phase 4, partial)

Each bot generates a persistent Ed25519 keypair on first boot, saved to `data/bot-identity.json` (chmod 0600). The public key + fingerprint ship in `/announce`. Signing/verification handshake protocol is **deferred** — the public key is captured now so the protocol can be added later without bot-side migration.

```
fingerprint: DDvzs4P1am30KSRN   # SHA-256(public_key), base64url, first 16 chars
```

## What doesn't ship yet

Per [`design-notes/multi-bot-orchestration.md`](https://github.com/powder-nomad/papercup/blob/main/docs/design-notes/multi-bot-orchestration.md):

- **Phase 4 cryptographic handshake** — the actual sign-and-verify protocol. Foundation (keypair) is in place; deferred until an abuse pattern justifies the complexity.
- **Phase 5 live two-bot integration test** — operators meeting to run a supervised hour with two bots.
- **Tool-collision protocol** — design note concedes there's no perfect solution; current mitigation is workdir isolation + the overlap warning.
- **Per-channel Discord rate-limit queue** — verbose bot bursts can still trip Discord's throttle. Workaround today: lean reactivity to `strict`.

## Related

- [Slash commands → /reactivity, /budget, /announce, /refresh-roster](/components/slash-commands)
- [Config → Multi-bot orchestration](/config#multi-bot-orchestration)
- Design note: [`docs/design-notes/multi-bot-orchestration.md`](https://github.com/powder-nomad/papercup/blob/main/docs/design-notes/multi-bot-orchestration.md)
