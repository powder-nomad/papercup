# Plan mode — interactive question/answer loop

> Status: design note. Not implemented. Companion to `limits-and-usage.md`.

## Problem

Today, plan mode in papercup (`--permission-mode plan`) produces a plan as a single
text blob. The user "approves" by sending another Discord message. There is no
checkpoint, no structured option list, and no way for the model to interview the
user before producing the plan.

Claude Code's TUI does much better: in plan mode the model uses `AskUserQuestion`
to run a short interview (typically 2–4 questions, each with ~3 canned options
plus three exit ramps), and only then emits the final plan. The user clicks
buttons; the conversation feels guided rather than free-form.

We want that experience inside Discord.

## Reference UX (from Claude Code)

A single `AskUserQuestion` invocation renders roughly like this:

```
Question: <model's question text>

[Option A]              ← canned answer
[Option B]              ← canned answer
[Option C]              ← canned answer
[Other...]              ← modal: free-text answer to THIS question; interview continues
[Talk about it]         ← abort the interview loop, fall back to free chat
[Skip interview]        ← stop asking; produce the final plan now with what we have
```

The model may chain several `AskUserQuestion` calls in sequence — each click
resumes the model, which may ask again. The three exit ramps are the only ways
out of the loop other than answering through to the end.

`AskUserQuestion`'s schema permits 2–4 options per question; observed usage trends
toward 3.

## Current state in papercup

- `claude -p --output-format json` (single-shot) — no interactive checkpoint exists
  in the current invocation model. Reference: `backend-claude-code.ts:71-75`.
- `permissionMode` accepts `"plan"` and is passed through, but only by the
  claude-code backend (anthropic-api and codex silently ignore it). Reference:
  `backend.ts:52`, `backend-claude-code.ts:84`.
- No Discord components anywhere — zero `ButtonBuilder` / `ActionRowBuilder` /
  `ModalBuilder` / `StringSelectMenuBuilder` usages.
- No tool-call interception — papercup reads only the final assistant text from
  the JSON output; it does not see in-progress tool-use events.
- Sessions persist via the bot's own `session/store.ts`; claude-code session
  resume is available via `--resume <session-id>`.

## Proposal — building blocks

### 1. Custom MCP tool: `present_options`

Add a papercup-side MCP tool the model is told to call when it wants to ask the
user a question. The tool's job is to *not return a result yet*: papercup
intercepts the call, renders Discord UI, waits for the click, then resumes the
model session with the chosen text as the tool result.

Tool surface:

```ts
present_options({
  question: string,
  options: string[]   // 2–4 entries
}) → string           // the user's answer (canned text, custom text, or sentinel)
```

Possible return values:

- One of the canned `options[]` strings → user clicked that button
- Any other free-text string → user picked "Other..." and typed
- `"__USER_WANTS_TO_DISCUSS__"` → user picked "Talk about it"
- `"__SKIP_TO_PLAN__"` → user picked "Skip interview"

The system prompt for plan mode tells the model:

> When you are in plan mode and need information from the user before producing
> the plan, call `present_options` instead of writing prose options. Provide 2–4
> short options. If the tool returns `__USER_WANTS_TO_DISCUSS__`, exit the
> interview loop and treat the user's next message as conversational planning
> input. If it returns `__SKIP_TO_PLAN__`, do not ask further questions; produce
> the final plan now using whatever information you already have.

### 2. claude-code stream output

`claude -p --output-format json` returns only the final assistant message and
hides intermediate tool calls. To intercept `present_options` we need a streaming
mode: `--output-format stream-json` (verify exact flag in the installed CLI
version). Papercup parses each event; on `tool_use` for `present_options`, it
pauses processing, takes over.

Important: papercup *cannot* respond to a tool call mid-stream from the same
spawned process if `claude -p` is treated as single-shot. Two viable shapes:

- **MCP-server-blocking (preferred):** run `present_options` as an HTTP MCP tool
  that *blocks* until the user clicks. The MCP server holds the request open;
  once the click arrives it returns the result; the spawned `claude -p` process
  continues normally. This avoids needing session resume.
- **Resume-based (fallback):** let the spawn finish (the model ends its turn
  waiting on the tool); on click, spawn a new `claude --resume <session-id>`
  process with a synthetic message that delivers the tool result. Requires a
  convention for "user message that resolves a pending tool call" — verify
  whether claude-code supports this directly or needs a wrapper.

### 3. Discord rendering

- 1 button row of N (2–4) option buttons (`ButtonStyle.Primary`).
- 1 button row of three exit ramps (`ButtonStyle.Secondary`):
  `[Other...]` `[Talk about it]` `[Skip interview]`.
- `[Other...]` and `[Talk about it]` open a `ModalBuilder` text-input dialog.
  ("Talk about it" optionally takes an opening message; an empty submit just
  drops back to chat.)
- `[Skip interview]` returns the sentinel directly with no modal.
- Restrict `MessageComponentInteraction` handler to the session owner's user id
  (same pattern slash commands already use).

### 4. State machine + timeout

- One pending `present_options` per session at a time.
- Timeout: if no click within N minutes (suggested default 10), auto-resolve
  with `__USER_WANTS_TO_DISCUSS__` and post a "interview timed out, dropped to
  chat" message. Open question: should it be a configurable `PAPERCUP_PLAN_TIMEOUT_S`?
- If the user sends a regular Discord message while a question is pending, treat
  it as `[Other...]` with that text as the answer (or as `[Talk about it]`?
  needs UX decision).

### 5. Scope limitations

- **Backend:** claude-code only (the only one with native plan-mode semantics).
  anthropic-api and codex backends ignore plan mode entirely and would skip this
  flow.
- **Mode:** text mode only. Voice mode can't speak buttons. Open question:
  should voice mode in plan mode fall back to spoken numbered options + "say
  one, two, or three" voice input? Probably out of scope for v1.

## Caveats

- Discord component interactions have a 15-minute initial token timeout — exit
  ramps may need `interaction.deferUpdate()` plus follow-up patterns for
  long-held questions.
- Discord rate limits on component edits aren't punishing for normal use, but
  rapid back-to-back questions in a single planning loop should be tested.
- If the model emits an option whose label exceeds Discord's 80-character button
  limit, papercup must truncate (with the full text in the message body).
- Model adherence isn't guaranteed: if the model emits prose options instead of
  calling `present_options`, papercup falls back to current behavior. Worth a
  hook in the system prompt that re-prompts on the first violation.

## Acceptance criteria

- In plan mode (claude-code backend, text mode), a planning turn that previously
  produced prose now produces a Discord message with N+3 buttons.
- Clicking a canned option resumes the model and may produce another question or
  the final plan, all within the same logical "turn" from the user's view.
- "Other..." opens a modal and the typed text reaches the model as the tool
  result.
- "Talk about it" exits the interview loop and the next user message is treated
  as free-form planning input.
- "Skip interview" causes the model to produce the final plan immediately.
- Only the session owner can press the buttons.
- Voice mode is unaffected (no buttons, no behavior change).
- Anthropic-API and codex backends are unaffected (the `present_options` tool is
  not made available to them).

## Open questions

1. MCP-server-blocking vs `--resume`-based shape — which is more reliable in
   practice? Need a small spike on each.
2. What does `claude -p --output-format stream-json` look like exactly in the
   installed CLI version, and does it expose tool-use events for custom MCP
   tools? Need to verify before building.
3. Timeout default — 10 minutes feels right for chat-paced planning but is a
   guess. Make configurable.
4. UX for "user types a regular Discord message while a question is pending" —
   treat as Other, or as Talk-about-it, or surface a "you have a pending question
   — pick a button or click Talk about it to drop the question" hint?
