# Verification status

## What is verified

**Direct-only 0.5.0, 2026-11-18:** strict compilation and **577 integration tests** passed on
Linux with VS Code Stable 1.146.0. The suite uses stubbed extension requests and credentials.
Coverage includes credential migration and recovery, named-connection routing, stale handles,
native group edits, panel isolation, and suppression of discovery and inference for saved proxy
connections. The retained adapters have separate internal test coverage.

The packaged privacy-hardened build passed a fresh-install smoke in a normal isolated Linux Stable
1.146.0 profile with synthetic credentials and intercepted requests. It made no OpenRouter requests
before a key was saved. The smoke checked model discovery and streaming, safe handling of an upstream
HTTP 418, suppression of authenticated preset lookups for disabled connections, and the absence of an
installed request-body dump.

A separate upgrade and restart smoke from 0.4.1 passed on Linux Stable 1.145.2 with an earlier 0.5.0
build. It used synthetic credentials and checked key, template, credit settings, context preferences,
and spend migration, native group adoption, and routing.

Windows/WSL upgrades, live OpenRouter inference on 0.5.0, and remote Copilot SDK behavior remain
unverified. See the [handoff](next-harness-handoff.md) for reproduction entry points.

## Historical evidence

**0.5.0-test.3, 2026-11-10:** 562 tests passed on Linux with VS Code 1.145.2 for the earlier
two-mode build. Proxy form validation, authoritative discovery, credential isolation, and removal
of custom allowance APIs were checked at that stage. Those checks describe the development build
and retained adapters. The 0.5.0 release keeps saved non-direct connections inactive.

An earlier normal isolated VS Code 1.143.1 host used the production manifest and copied compiled
modules with fake credentials and requests. It exercised native rename, restart persistence,
duplicate upstream model IDs, and generic streaming through a real `vscode.lm` handle. See
[native grouping evidence](native-model-groups.md) for the scope of those checks.

A bounded live test on 2026-10-28 used an earlier compiled registry/router in an isolated host
with in-memory credentials. It covered a proxy tool call and continuation, plus one direct
request to the same upstream model. The three requests were capped at 128 output tokens each.
TLS verification stayed active, using a public CA with Node fetch in that profile.
The test checked credential and origin isolation, streaming usage, and separate connection
accounting for that build.


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
