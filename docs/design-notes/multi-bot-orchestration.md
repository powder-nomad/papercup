# Multi-bot orchestration via Discord

> Status: **future work, low priority.** Capture-only. Do not start until
> backend pluralization (Track 1) is fully shipped. Sibling of
> `limits-and-usage.md` and `plan-mode-interactive.md`.

## Idea

Multiple papercup bots in one Discord server, each owned by a different
operator, each running on a different machine with its own credentials/model
backend, **talking to each other** via @-mention. Discord becomes the message
bus; the entire negotiation is human-watchable in real time.

Differentiator vs. in-process orchestrators (CrewAI / AutoGen / LangGraph):
the conversation is observable and steerable by humans without instrumenting
the orchestrator. Trade-off: looser coordination, real risk of loops, cost
explosions, and rate-limit collisions.

## Hard problems & current thinking

### 1. Loop prevention

**Risk:** Bot A → Bot B → Bot A → ∞.

**Plan:**
- Env `BOT_BOT_MAX_TURNS` (per bot; per-session override possible).
- Bot tracks `consecutive_bot_to_bot_turns` counter; resets on every human
  message.
- Cap hit → bot posts a short "deferring, max turns reached" message and
  refuses to respond to other bots until a human chimes in.

### 2. Quota / cost broadcasting — *who needs to know, how, without polluting*

**What the user vetoed:**
- Including budget in every message → confuses bots in each iteration.
- A slash command → clutters Discord's command-suggestion UI when many bots
  run in one server.

**Better candidates (pick one or combine):**

| Mechanism | Audience | Pros | Cons |
|---|---|---|---|
| **Discord rich presence** (bot's "Playing X" status) | humans (hover), other bots (via API) | invisible to bot text-parsing → no mention spam | only one short string; can't be rich |
| **Pinned status message** in channel | both | structured, multi-line; other bots can read it as a regular message | clutters channel pins; needs cleanup |
| **DM to owner only** | the bot's owner | private by default; respects others | only the owner sees it |
| **Bot-only side channel** `#bot-coordination` | all bots, opt-in humans | structured shared state, doesn't disturb the working channel | requires a dedicated channel convention |

**Default recommendation:** Discord rich presence (passive humans) + pinned
status message in a dedicated `#bot-status` channel (other bots + curious
humans). On-demand `/budget` slash command only for the bot's owner (ephemeral
reply).

### 3. Reactivity modes (anti-deprivation)

**Per-bot config** — three levels of reactivity:

- **`strict`** — only respond to direct @-mention from an allowlisted user-id.
  Anti-deprive: random Discord users can't drain your tokens.
- **`loose`** — same allowlist, but may also chime in unprompted if the bot
  judges intervention is necessary.
- **`chatty`** — listen to all conversation, intervene freely (high spend).

Plus a **mention allowlist** orthogonal to reactivity mode: only these
user-ids can @-mention this bot. Stops bad-faith token-drain.

### 4. Tool collision

**Concession:** there's no perfect solution. Locks don't help — file writes
happen instantly; lock acquisition is a race. Best mitigations:

- **Each bot pinned to its own filesystem root**, NEVER a subdirectory of
  another bot's root. Enforced at boot: bot refuses to start if its workdir
  overlaps with any other bot in the roster.
- System-prompt rule: "treat files outside your workdir as read-only unless
  instructed by a human."
- Discourage shared mutations entirely; if work needs to land in a shared
  repo, a human merges between bot turns.

### 5. Discord rate limits

**Risk:** rapid bursts in busy turns trip per-channel throttling.

**Plan:**
- Per-bot internal send queue with `MAX_MSGS_PER_MIN`.
- If queue > 5 deep: summarize-and-drop older messages.
- The tension between "advertise impactful jobs" and "noise" gets configured
  per-bot via `BOT_VERBOSITY` (low/medium/high).

### 6. Bot identity & ownership verification (avoiding out-of-band)

**Constraint:** the user prefers no out-of-band coordination (no git repo,
no shared config file). Everything should flow through Discord.

**In-band-only roster (recommended default):**

- Designated `#roster` channel chosen by server admin convention.
- Each bot has an operator-only `/announce` slash command. Running it posts
  a structured introduction message in `#roster`:

  ```
  papercup-roster v1
  bot_id: <discord-bot-user-id>
  owner: <@operator-discord-id>
  workdir: /opt/papercup-foo
  reactivity: strict
  budget: $10/day
  public_key: <ed25519 pub key, base64>
  ```

- On startup, each bot scrapes `#roster` for these messages and builds its
  local roster. Re-scrapes on `/refresh-roster`.
- Optional cryptographic handshake on first contact: bot A posts a nonce in
  channel; bot B replies with `sig = sign(nonce, B_priv)`; A verifies against
  `public_key` from the roster.

**Why this works**: zero out-of-band config. Operators just agree on the
channel name. The roster is auditable (it's in Discord), revocable (delete
the message), and signed (cryptographic handshake on demand).

## Acceptance criteria (when we eventually build this)

1. Two papercup bots, different backends, different operators, can run in
   one channel without loops, cost blow-ups, or file collisions for at
   least one supervised hour.
2. `BOT_BOT_MAX_TURNS` correctly caps a runaway dialog.
3. Bot ignores @-mentions from non-allowlisted user-ids.
4. Bot publishes its budget % to discoverable surface (rich presence +
   pinned status) on a configurable interval.
5. In-band roster discovery works without any out-of-band shared file.
6. Workdir collision blocks bot startup with a clear error.

## Phased build (when prioritized)

1. **Phase 1** — Loop cap, mention allowlist, reactivity modes (single bot,
   no inter-bot logic yet). Foundation for everything else.
2. **Phase 2** — Budget tracking + rich-presence broadcast.
3. **Phase 3** — In-band roster discovery + workdir-overlap check.
4. **Phase 4** — Cryptographic handshake (optional; ship without if no real
   abuse pattern emerges).
5. **Phase 5** — Live two-bot integration test. Operators meet, run for an
   hour, capture failure modes, iterate.

## Open questions

1. When a bot's budget hits 100%, should it post a final "I'm out" message
   or silently stop? Silent risks confusion; loud risks bot-talking-to-bot
   loop trying to acknowledge.
2. Should reactivity-mode `chatty` even exist as a default option? Easy
   foot-gun.
3. How does a bot decide *"is this conversation worth chiming in on"* without
   re-evaluating every message? Cheap classifier? Pre-filter via keywords?
4. Cryptographic handshake — is it worth the complexity? Probably not until
   there's an observed incident.
