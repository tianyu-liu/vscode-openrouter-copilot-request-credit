# Verification status

## What is verified

**0.5.0-test.3:** strict compilation and **562 integration tests** pass on the Linux client
(VS Code 1.145.2, rerun 2026-11-10), after removal of the custom proxy allowance implementation and its tests.
The current candidate also packages successfully; its VSIX contains the credential guard and excludes
removed allowance modules, source/tests, preview scripts, and scratch data. Installed activation of
this exact candidate has not been checked. See the [next harness handoff](next-harness-handoff.md) for
the current priorities and reproducible entry points.

Regression coverage includes migration/rotation/deletion failure recovery, connection routing and
accounting, stale handles/caches, captured retry bodies, conservative legacy metadata, unknown costs,
native JSONC edits, and panel message/draft isolation. The unified editor covers combined metadata/key
saves, separate key clearing, blank-key retention, native rename rollback, credential-write recovery,
endpoint/key isolation, type conversion, keyless saves, masked hints, and preserving edits through key
clearing. The editor offers only Direct OpenRouter and OpenRouter proxy, with explicit legacy conversion.
Proxy discovery remains authoritative without fallback; keyless discovery/inference omit Authorization
and never borrow a direct connection's key. Credential guards cover saves, retained-key conversions,
legacy setters, and stored/cached provider credentials before network use. Tests stub fetch and secrets.

The final two-mode editor was browser-reviewed at 1000px and 380px widths, including the proxy usage tab.
Earlier native Chromium checks covered exactly two choices, editable proxy/fixed direct URLs,
OpenRouter-key rejection, proxy-token/keyless acceptance, and validity after tab switching. Custom
allowance controls, calls, and schema support are removed; preview checks confirm they are absent for
both modes. Proxy usage is local token and returned-cost tracking only. Regression tests verify obsolete
saved flags are stripped without changing IDs, revisions, keys, or scoped data. Independent source review
found no actionable issues. Generated outputs for deleted modules/tests were removed before the suite ran.
An extension refresh/panel harness verifies zero HTTP or direct preset reads across 18 proxy cases,
including old flags and missing credentials. Its direct positive control still reads OpenRouter key and
credit data. Disabling the nondirect guard makes the zero-fetch regression fail as expected.
Earlier Windows/WSL runs cover the prior baseline, not the new connection implementation.

An earlier packaged VSIX also activated as an installed extension in an isolated client profile. Its Manage
command, provider/icons, and initial keyless registry passed against that earlier package. A separate helper
injected in-memory SecretStorage before activation; no extension fetches or real keychain operations
occurred, and scheduled refresh callbacks were suppressed.

A normal isolated VS Code 1.143.1 host also exercised the production manifest and copied compiled
modules using fake SecretStorage and fetch responses: Settings/named tabs, scoped key/template saves,
native group rename, restart persistence, duplicate upstream models, and generic streaming through a
real `vscode.lm` handle. The captured generic request used its intended URL/key/template and original
upstream model ID, without automatic OpenRouter fields. The panel was also browser-reviewed, including
a narrow viewport. See [native grouping evidence](native-model-groups.md) for the initial prototype and
remaining picker/menu checks.

Earlier read-only live access verified management authentication, strict-TLS proxy health/discovery,
and unauthenticated refusal without inference or deployment changes. Custom allowance checks also
occurred in that earlier implementation; the feature has since been removed and those results do not
establish any current proxy API requirement.

Bounded live checks on 2026-10-28 exercised the compiled production registry/router in an isolated
VS Code host with in-memory credentials: gateway streamed tool call, tool-result continuation, and a
direct connection using the same `mistralai/mistral-nemo` model. Three inference calls were capped at
128 output tokens each. Bearer/origin isolation, redirect refusal, metadata, streamed usage, separate
connection accounting passed in that earlier implementation. Total reported cost was
$0.00000343440; no deployment, key, or budget settings changed.

TLS certificate and hostname verification stayed enabled. On this client, the default Electron-backed
extension-host fetch ignored `NODE_EXTRA_CA_CERTS`. The disposable profile used `http.electronFetch=false`
and `http.fetchAdditionalSupport=false` so Node fetch honored the supplied public CA. No trust bypass
was used. This is a client trust requirement, not a gateway health or billing guarantee.

API usage matches the installed types plus local structural fields; the runtime
`LanguageModelThinkingPart` class exists despite the proposed-API warning.
Earlier P10 usage-reporting and P11/P12 session/cost behavior was checked against the installed Copilot
bundle (see [Provider internals](provider.md)) and a stubbed stream harness.

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
