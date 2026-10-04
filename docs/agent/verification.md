# Verification status

## What is verified

Build and tests: compiles (`tsc --strict`), the full test suite passes (`npm test` is the source of
truth for the current count — **449** at the last run; it also passes on the Windows development host,
and on a WSL host with `libnss3`/`libnspr4`/`libasound2t64` installed so the Electron test host
launches), packages to a VSIX, API usage matches `node_modules/@types/vscode` plus the local
structural types for the proposed fields, and the runtime `LanguageModelThinkingPart` class exists on the stable test host
despite the proposed-API warning. The P10 usage-reporting and P11/P12 session-id and per-turn cost
behavior were verified against the installed VS Code Copilot bundle (see [Provider internals](provider.md)) plus a
stubbed-`vscode` Node harness for the stream loop.

**Live pilot, closed 2026-10-04** — Windows checkout, installed VSIX plus an `F5` dev host with a real
key. Evidence was the request dump and the account API, deliberately not the extension's own numbers:

- **Context-usage ring (P10 display)** shows `used / max tokens`, non-zero, agreeing with its
  percentage (the figure is essentially the 86 tool definitions).
- **Session spend (P12)** — one collapsible entry per chat, one route row per provider/model, a
  tool-using turn's total covering all of its rounds (455 calls inside a single entry), per-route
  cache rates distinct from the session blend, no window-wide total, no cost text in the transcript,
  and entries surviving a window reload.
- **Session continuity (P11)** — one `session_id` spanning a reload (39 → 44 dump lines), no orphan
  or bare-UUID line, and a new chat as its own session.
- **Reasoning echo (P1)** — the echo count tracks the request's own `reasoning` field across 59
  requests with 100% correlation, and tool-bearing turns carrying a prior trace never 400.
- **Thinking trace** renders as a collapsible reasoning part.
- **Anthropic `cache_control` (P6)** — top-level `{"type":"ephemeral"}` on all 8 bodies of one
  Anthropic chat, **0** nested markers, and the route honored it: Amazon Bedrock reported
  `cached 583017 / 679570 = 85.8%`.
- **Image input** — an attached image reaches the wire as a structured `image_url` part (and an image
  tool result as a following user message) while the P17 guardrail strips only prompt text; the model
  answered the image.
- **Status bar + dashboard** — the credit balance and the usage dashboard render, and the figures were
  cross-checked against the account's `GET /api/v1/keys`: the All-time OpenRouter cell matched the
  server's per-key `usage` exactly, and the key reports no `limit`, matching the panel's
  "Local-set limit" mode.

### Accepted residual gaps

Recorded so nobody re-opens them as unknowns; none is worth another pilot round:

- A full VS Code **restart** was not exercised (a window reload was) — same storage path and code.
- The **`Unattributed (no chat id)`** entry needs an agent-host/SDK session before it can appear.
- A **WSL-host run** was not part of this pilot; the Windows host was, and the code is
  platform-agnostic with the suite as the check.
- Live **429/backoff** and **mid-stream cancellation** were never observed by hand — both are covered
  by the canned-SSE suite.
- OpenRouter's weekly figure being **trailing** 7 days while monthly is the **calendar** month means
  Weekly can legitimately exceed Monthly early in a month; that is upstream semantics, not an
  arithmetic error in `logic.ts`.
