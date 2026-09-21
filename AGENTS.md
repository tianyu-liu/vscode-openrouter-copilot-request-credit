# AGENTS.md — instructions for AI assistants working on this extension

> This file is for AI coding assistants (Kilo, Claude Code, Cursor, Cline,
> Continue.dev, Aider, etc.) working in this repository. It is **not** for
> human readers; see `README.md` for that.
>
> This file is synced/shared, so it intentionally contains **no**
> organization-specific content.

## What this is

A small **VS Code extension** that registers an OpenRouter provider in **Copilot Chat**
as **"OpenRouter: RC"**. It exists because Copilot's built-in OpenRouter
provider cannot send OpenRouter's `provider` routing object or a `session_id`
(microsoft/vscode#283201; feature request microsoft/vscode-copilot-release#11420
still open). The extension makes its own HTTP calls to OpenRouter instead of going
through Copilot's CAPI proxy, so it can apply **any request-body option** OpenRouter
accepts.

It also **tracks the same key's credit usage** (absorbed from the retired
`tianyu-liu.openrouter-key-credit-check` extension): a status-bar item and the
usage dashboard live in the same control panel.

**Core flow (paste-apply):** the user builds a request at the
[OpenRouter Request Builder](https://openrouter.ai/request-builder), copies the JSON
body, pastes it into the extension's **one panel**, and every Copilot Chat request to
OpenRouter then follows those settings (`provider` routing,
sampling params, `response_format`, `plugins`, `transforms`, `session_id`, …). The
extension provides **no complex parameter UI of its own** — it applies what is pasted.

The extension still sends:

- a **per-chat-session `session_id`** so OpenRouter keeps the prompt cache warm and groups
the chat's turns in one session (see "Session identity");
- **tools** (agent mode) and **image input** for vision models;
- **thinking traces** — `delta.reasoning` is reported as `LanguageModelThinkingPart` and
  prior turns' reasoning is echoed back on assistant messages (DeepSeek thinking-mode
  requirement; see "Reasoning passthrough").

**Model choice is intentionally open:** the full OpenRouter catalog is exposed. This
extension adds no provider or model restrictions; any org-side allowlist still
applies at the OpenRouter account level.

## Repo naming and origin

- Repository (kept): `tianyu-liu/vscode-openrouter-copilot-request-credit` — the GitHub
  name may stay different from the extension id. Display names:
  **"OpenRouter for Copilot with Custom Request & Credit Check"** (extension) and
  **"OpenRouter: RC"** (model picker).
- Machine identifiers (renamed in the pre-pilot pass, no users yet): package name /
  provider vendor id `openrouter-copilot-request-credit`, command ids
  `openrouterCopilot.*`, config namespace `openrouterCopilot.*` (the five credit
  settings folded in as `openrouterCopilot.credit*`). The key secret
  (`openrouterApiKey` in SecretStorage) is unaffected.
- This repository originated inside a private skill repository and later
  absorbed the standalone `openrouter-key-credit-check` extension (status bar +
  usage dashboard). The credit check is **fully merged** — do not split it back
  out; its `openrouterCreditCheck.*` namespace was folded into
  `openrouterCopilot.credit*`.
- Development workspace is on the **Windows side**; the extension has no
  platform-specific code and must stay platform-agnostic.

## Commands

```bash
npm install          # first time (commit package-lock.json)
npm run compile      # tsc build + typecheck (strict) → out/
npm run watch        # tsc --watch during development
npm test             # compile + launch the VS Code integration test runner (mocha)
npm run package      # vsce package → openrouter-copilot-request-credit-<ver>.vsix (no marketplace publish; install from VSIX)
```

No lint setup exists for this TypeScript project; `tsc --strict` is the gate.
Run `npm run compile` (and `npm test` when behavior changed) before committing.

## Architecture

- `src/extension.ts` — activation: registers the provider (`vscode.lm.registerLanguageModelChatProvider('openrouter-copilot-request-credit', …)`, vendor id must match `contributes.languageModelChatProviders[].vendor`), the status bar item (credit), the refresh lifecycle (single-flight `refresh`/abort-supersede `doRefresh`), the unified webview panel, the config-change listener and the auto-refresh timer. Commands: `openrouterCopilot.manage` and `openrouterCopilot.pasteTemplate` both open the panel; `openrouterCopilot.clearTemplate` clears the template. Exports for tests: `refresh`, `doRefresh`, `getStatusText`, `createPanelDeps`, `stopRefreshTimerForTesting` (and re-exports `apiBaseUrl`/`readConfig` from `panel.ts`).
- `src/panel.ts` — the **single control panel** (webview): `renderPanelHtml`, `handlePanelMessage`, `PanelDeps`, `readConfig`, `apiBaseUrl`. Five sections: **Settings** (key save/clear), **Usage** (credit dashboard from `logic.ts`), **Session spend** (collapsible per-session cost from `renderSessionCosts`), **Presets** (preset dropdown with a "No preset loaded" default, fetched with the panel render; selecting a preset saves `{"preset":"<slug>"}` as the template, selecting the default clears it, and the dropdown re-syncs whenever the template is saved or cleared (the sync adds a `<slug> (not in list)` option when the saved slug is absent from the rendered list)), **Custom Request** (paste/save/clear). The Custom Request section renders an enforced-options footnote block (P8: `stream`, `session_id`, verbatim passthrough incl. `provider`, reasoning effort, messages/model/tools, usage chunk, key storage/base URL, P9 presets, P10 per-turn tokens/cost) as a numbered anchor list. `readConfig` reads global scope only and validates/clamps the numeric, boolean and reset-period `openrouterCopilot.credit*` values (a string-typed numeric does not coerce to the number, so `creditLimit` falls back to 0 and the interval to its default); `creditBaseUrl` is handled by `apiBaseUrl`, which enforces the https-only global scope. Message handling and rendering are unit-testable (no live webview needed).
- `src/provider.ts` — the `LanguageModelChatProvider`:
  - `provideLanguageModelChatInformation` — fetches `GET /models` with the user's key (via `fetchWithRetry`; a non-OK catalog response now surfaces a mapped error instead of `[]`, and a 200 with a non-JSON body surfaces a mapped error too), maps to `LanguageModelChatInformation` (family = slug prefix, version = slug, token caps from `context_length`), attaches a `detail`/`tooltip` rendered by `modelInfo.ts` (price info in the model picker), and a `configurationSchema` so reasoning models expose **VS Code's native Thinking Effort selector** in the picker (proposed `chatProvider` API, `enabledApiProposals` in `package.json`, vendored types in `typings/`). It also fetches presets (`GET /presets`, then `GET /presets/{slug}` for the designated `designated_version.config.model`, capped at 25 lookups, fetched with bounded concurrency after the active-status filter — inactive presets never consume the lookup budget, and the full active list stays visible in the panel dropdown regardless of the cap) and appends a picker entry `@preset/<slug>` (family `preset`) for each **model-pinned** preset within the lookup cap, with caps/capabilities/pricing resolved from the underlying catalog entry (assumed defaults when the model is absent from it); model-less presets get no picker entry. The presets sweep is **single-flight and background**: the picker gets the models immediately, and the sweep (shared by `getPresets()` via one in-flight promise) attaches `@preset/*` entries when it resolves, firing `onDidChangeLanguageModelChatInformation`; a warm preset cache from a panel render is reused, not re-fetched. A failed sweep leaves the preset cache **cold** (never cached as an empty list) so a later render or query retries it. The presets fetch is **best-effort**: any failure degrades to the models-only catalog. `getPresets()` fetches on first use (also on panel render) and caches; `getPresetConfig(slug)` resolves and caches the full designated config (shared with the list fetch) so the panel can prefill the textarea with the resolved preset configuration as full-line `//` comments above the JSON when a preset is selected. A pinned model that is not in the catalog under its exact slug (e.g. datestamped `z-ai/glm-5.3-flash-20260826`) resolves against the catalog by stripping a trailing datestamp (`-YYYYMMDD`, then a plausible `-MMDD`) so reasoning schema, caps, and pricing still load; truly unknown models get assumed defaults and no reasoning selector. `setTemplate` strips full-line `//` comments before validating, so commented text saves cleanly. Changing `openrouterCopilot.baseUrl` calls `resetCatalogCache()` so the picker re-fetches from the new host.
  - `provideLanguageModelChatResponse(model, messages, options, progress, token)` — builds the body via `buildRequestBody` (saved template spread over the live model/messages/tools, `stream: true`, `session_id` = `sessionIdFor(options.modelOptions._conversationId)` — see "Session identity" — verbatim `provider` passthrough — no default `provider` is ever injected, preset reference or not, so preset routing survives; picker effort/enabled merged into the template's `reasoning`, with a picker effort of `none` sent as `reasoning.enabled: false` rather than `effort: "none"`; a preset-reference model id (`@preset/*` or combined `*@preset/*`) drops a template `preset` key so the picker entry is the only preset reference; `@preset/*` requests take the P6 `cache_control` decision from the preset's resolved underlying model), POSTs `/chat/completions` through `fetchWithRetry` (mid-stream and mid-read cancellation surfaces as `vscode.CancellationError`; retried responses have their bodies cancelled before backoff), parses SSE with a bounded line buffer, emits parts via `progress.report(...)`. Emits `LanguageModelThinkingPart` from `delta.reasoning` (fallback: flatten `delta.reasoning_details` via `flattenReasoningDetails`) plus text and tool-call parts. Throws mapped errors on HTTP statuses and mid-stream `data:{"error":…}` events (`mapResponseError`/`mapStreamedError`), appending the `X-Generation-Id` header. Tolerates and captures the automatic final `usage` chunk (`getLastStreamUsage`, reset per request). **Returns `Thenable<void>`; parts go through the progress callback, not a returned stream.**
  - `toOpenAI` — converts messages to OpenAI chat format and echoes prior `LanguageModelThinkingPart`s back as a `reasoning` (string) field on outgoing assistant messages (DeepSeek thinking-mode echo rule).
  - **Per-turn usage report (P10)** — when the stream ends (`[DONE]`, or the read loop finishing), the captured usage chunk is reported back as `progress.report(new vscode.LanguageModelDataPart(bytes, 'usage'))` with `{ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: { cached_tokens, … }, copilot_usage? }`. Copilot parses exactly this payload into its `APIUsage`, which is what feeds the **context-usage ring** numerator. `usage` capture happens **before** the `choices[0]` check, because OpenRouter's final chunk carries `choices: []`. `copilot_usage.total_nano_aiu` is set only when `cost > 0` (a zero charge must not render as a misleading `0.0 credits`). Only `buildUsagePart` decides the payload (pure, exported for tests) and it returns `undefined` (no part at all) unless the three token counters are numeric.
    **Correction (do not re-introduce):** an earlier version of this file claimed this payload also puts the turn's cost in the Copilot **response footer**. That is **false for a local chat session**. The local footer string is built in the copilot extension from `this._chatQuotaService.getCreditsForTurn(turn.id)`, and that map is populated *only* by the CAPI fetch path (`setLastCopilotUsage` on a `ChatMLSuccess` `usage.copilot_usage.total_nano_aiu`) — never by an extension-contributed provider's progress part. `ExtensionContributedChatEndpoint` returns `response.usage`, which feeds the ring but not the footer. The `copilotCredits` → `cY()` → `Model • N credits` chain exists only on the **agent-host** path (`toResponseDetails`) plus session-cost and subagent hovers. Even if it existed, Copilot formats with one decimal (`Heu`: `toFixed(1)`), so a micro-dollar turn would render `0.0`.
  - **Session cost (P12)** — cost is surfaced by the extension itself, not Copilot, and lives in the **panel**, never in the chat transcript. `turnCostOf(usage, provider)` extracts a payable figure plus cache counts; `accumulateSessionCost(sessionId, usage, provider, model)` folds each model call into a session-keyed store (`getSessionCosts()`/`getSessionCost()`); the panel renders it via `renderSessionCosts` as one collapsible `<details>` per session (newest expanded) with a per-provider/model route row inside (`routeCostCells`, rendered as a `Cost | Provider | Model | Calls | Cached` table), and `onTurnCost` re-renders an open panel as turns finish. Each route row ends with its **own cache rate** (`cacheSharePercent`, a bare `82.3%` — the `Cached` header supplies the word — = `cachedTokens / promptTokens` over that route, one decimal), not a session-blended figure: a chat that **hopped models** has several routes whose cache behavior differs, so a single average would hide the good or bad one. The rate is omitted (never `0.0%`) on a route that reported no prompt tokens. The session-blended rate stays in the `<summary>` line (`cacheShareSuffix(session)`, which renders `82.3% cached`) — one helper, two scopes. **Why session-keyed rather than per-invocation:** Copilot drives a tool-using turn as **one `provideLanguageModelChatResponse` call per tool round** (the agent loop passes an `iterationNumber` through `makeChatRequest2`), so per-call state can never see the whole turn — a per-call accumulator was tried and removed. The store is bounded to `MAX_TRACKED_SESSIONS` (**10**), and **persisted to `globalState`** (`SESSION_COSTS_KEY`) so it survives a reload/restart; the provider constructor calls `hydrateSessionCosts`, which **merges** persisted entries rather than replacing memory (constructing a provider must never discard live state — a replace was tried and wiped totals when a second instance was constructed) and **drops non-`copilot-chat:` entries** (an earlier revision stored unidentified calls under a bare per-window UUID; those are now attributed to a parent instead). Persist writes are fire-and-forget. Ordering uses a **monotonic `stamp()`**, not raw `Date.now()`: several sessions can land in the same millisecond, and equal stamps made the cap's sort fall back to insertion order, evicting the newest and keeping stale entries. `onTurnCost` remains as the change signal.
    **Which session a call belongs to (P13):** `resolveCostSession(sessionId, hasConversationId)` — a call carrying Copilot's conversation id *is* a chat turn and becomes the current session; a call **without** one is internal (sub-agent or summarization) and is attributed to the most recently active chat rather than creating an entry of its own. The parent cannot be read off the request: the copilot extension passes `conversationId` to sub-agent calls only inside `telemetryProperties`, which is never forwarded — `ExtensionContributedChatEndpoint` puts only the top-level `conversationId` into `modelOptions._conversationId`. Hence the most-recently-active heuristic, bounded by `PARENT_ATTRIBUTION_WINDOW_MS` (10 min) so a stale attribution is dropped instead of blamed on a long-finished chat; with no parent known the call is not tracked at all. The same rule drives `session_id`: a known parent's id is sent, and with no parent **none is sent**, so the cost panel and OpenRouter's Sessions view agree and no orphan session appears (P15). The parent is persisted to `globalState` (`parentSession`) so attribution survives a reload. The payable figure is `cost` when OpenRouter charges, otherwise `cost_details.upstream_inference_cost` — on a BYOK route OpenRouter reports `cost: 0` because the upstream provider bills the user (verified live: a Fireworks BYOK turn reported `cost: 0`, `is_byok: true`, `upstream_inference_cost: 1.342e-5`). `is_byok` is `true` either when the flag is set or when only an upstream figure exists. The serving provider name comes from the streamed chunk's `provider` field (reset per request; `getLastStreamProvider` is a test seam). Amounts are micro-dollars, so `formatUsdPrecise` scales decimals (and never prints `$0.00` for a real cost) and `roundSignificant` (default **15** significant digits = working precision) is applied to every accumulation and at the display boundary, so binary-float artifacts (`1e-5 + 2e-5 = 3.0000000000000004e-5`) cannot reach a total or a hover. **Do not lower that digit count to "hide" drift cheaply** — measured over 100k accumulated micro-dollar turns: plain float drift 5.8e-13 relative (invisible), whole-nano quantization 2.7e-5 relative bias, and 6-digit rounding a **5.3%** error. Rounding harder injects bias rather than removing noise; there is a regression test asserting this. Both helpers live in the pure `logic.ts`.
    **Session label & last-update time (P14):** the panel labels a session with the **Copilot chat title** when it can get one, and always shows the session's **last-update time** beside the call count. Both are display-only enrichments — neither is persisted, so no chat content is written by the extension. The title is **not available through any API** and is never sent to a provider (`ExtensionContributedChatEndpoint` puts only `_captureTokenCorrelationId`/`_otelTraceContext`/`_telemetryTurn`/`_enableThinking`/`_conversationId` into `modelOptions`; Copilot's `sessionTitle` exists only in VS Code core's OTel export/import path). It is instead read best-effort from VS Code's own chat-session store — `workspaceStorage/<hash>/chatSessions/<conversationId>.jsonl`, which sits beside the extension's `context.storageUri` (`chatSessionsDir` derives the dir; `SessionCost.title` is filled at panel-render time by `withSessionTitles`). Only the first 64 KB are read (`readSessionTitleFromDisk`), and and the pure `parseSessionTitle` (in `logic.ts`) understands **both** title shapes — the rename mutation `{"kind":1,"k":["customTitle"],"v":"…"}` (a later rename wins) and the **nested** `v.customTitle` on the `kind:0` initial-state record, which is the *only* carrier for a never-renamed session. The `kind:0` line embeds the whole transcript, so a long session outgrows the 64 KB head read and the line arrives **cut mid-object** (it no longer `JSON.parse`s at all — the shape that broke the `0ef97316…` session); `titleFromRawHead` then recovers the field from the raw text with an escape-aware scan, so the cap can stay bounded instead of growing with the session. A missing dir, missing file, malformed `HEAD`, a title cut off mid-string, or an absent/blank title all fall back to the truncated id. The chat title is generated by Copilot **after the first turn**, so the earliest render may still show the id. `updatedAt` is the monotonic `stamp()` (ms since epoch); the panel renders it via `formatReset` only when it is a plausible clock value (`>= 1e12`), so legacy/`1`-fixture stamps are omitted rather than shown as 1970.
  - `provideTokenCount` — rough `chars/4` estimate (must be async per the current API).
  - `baseUrl()` — global-scope https-only (a workspace cannot redirect the key), strips a trailing `/chat/completions` and slashes, warns and falls back to the default otherwise (P4). Test seams: `setRetryDelayForTesting`, `getLastStreamUsage`, `buildUsagePart`, `sessionIdFor`.

- `src/modelInfo.ts` — pure model-card rendering for the picker tooltip (`buildModelInfo`): OpenRouter per-token pricing → per-1M display, blended $/M estimate from the agentic-usage equation (per answer token: 85 cache read · 6 cache write · 3 uncached · 5 thinking · 1 output; cache-write → input fallback), context/max-output/capabilities/reasoning lines, plus `buildReasoningSchema` (navigation-grouped Thinking Effort schema) and `effortFromModelConfiguration`. Intentionally imports no `vscode`; unit-tested in `modelInfo.test.ts`.
- `src/storage.ts` — the **single shared key secret** (`openrouterApiKey`) with a 10 s bounded keychain read and one-time migration from the legacy `openrouterCopilot.apiKey` secret. Both the provider and the usage refresh read this one key.
- `src/logic.ts` — pure credit/usage derivation (`KeyInfo`, `coreView`, `buildDetail`, `buildStatus`, `maskKey`, reset math). Intentionally imports no `vscode`; unit-tested. Do not add `vscode`/network imports here.
- `src/test/` — mocha (tdd) suite: `runTest.ts` (fresh temp `--user-data-dir`, `ELECTRON_RUN_AS_NODE` guard, 10-minute timeout), `suite/index.ts`, and per-module suites (`logic`, `config`, `modelInfo`, `panel`, `extension`, `provider`). The extension and provider suites stub `globalThis.fetch` so they never hit the network or the real OS keychain (Windows SecretStorage is OS-global, not isolated by `--user-data-dir`); `provider.test.ts` also injects a no-op retry delay (`setRetryDelayForTesting`) and exercises the stream loop end-to-end with canned SSE bodies (reasoning parts, streamed errors, retries, usage chunk — including a `choices: []` usage-only chunk — and the forwarded `usage` data part), plus unit cases for `buildUsagePart` and `sessionIdFor`.

### Session identity (P11) — what survives a window reload

VS Code persists a local chat session's data (its `sessionId`, the transcript, thinking parts and each
response's token/credit usage) in the workspace's chat-session storage, so a reload or restart restores
the same conversation **with the same id**. The Copilot extension threads that id to
extension-contributed models as `options.modelOptions._conversationId` (the agent/tool-calling loop
passes `conversation.sessionId` into `makeChatRequest2`, `ExtensionContributedChatEndpoint` puts it in
`modelOptions`, and the extension host forwards `modelOptions` verbatim to
`provideLanguageModelChatResponse`). The extension therefore sends `session_id` =
`copilot-chat:<conversation id>`: **one OpenRouter session per Copilot chat session**, so sticky
routing and the Logs → Sessions view follow the chat, not the window, and cache warmth carries across
a reload. `_conversationId` is an internal, underscore-prefixed key with no public constant — always
read it defensively. When it is absent (some internal calls do not pass it — the edit-agent subagent,
and Copilot's own utility flows) the call is attributed to the **last active chat** instead (persisted
to `globalState` under `parentSession` so it survives a reload, bounded by the 10-minute
`PARENT_ATTRIBUTION_WINDOW_MS`); if no parent is known, **no `session_id` is sent at all** rather than
a per-window UUID (`WINDOW_SESSION_ID` survives only as `sessionIdFor`'s internal fallback), so an
unowned call can never mint an orphan OpenRouter session. The id is capped at OpenRouter's
256-character `session_id` limit. Nothing in the session id is user content.

**Copilot utility flows (the orphan-session source).** Copilot drives background utility calls —
progress messages ("Polishing your code"), title generation, intent detection, and similar — through
`getChatEndpoint("copilot-utility-small")`, which resolves to the **selected main model**. With an
OpenRouter model picked and `chat.byokUtilityModelDefault` set to `mainAgent`, those calls land on our
provider with no conversation id. That is the shape of the historical orphan sessions (a bare UUID,
`calls: 2`, one per cached scenario: `generate` and `edit`). Recommend `chat.byokUtilityModelDefault:
"copilot"` so utility flows use Copilot's own small models and never reach OpenRouter; the P15
no-`session_id` rule is the backstop when they do.

Settings (package.json `contributes.configuration`): one **"OpenRouter for Copilot"**
section — `openrouterCopilot.baseUrl` for the provider and the five
`openrouterCopilot.credit*` settings for the guardrail/usage dashboard. The request
template itself is pasted JSON stored via the provider's global state — it is
**not** exposed as a multi-field settings UI.

## Paste-apply semantics

- The pasted body's **`messages`/`prompt` fields are ignored** — Copilot supplies the live conversation and tools each turn; they are merged with the saved template.
- The template applies to every request until cleared/replaced. Default when nothing is pasted: no `provider` object — OpenRouter's own routing applies and nothing is assumed.
- A template `provider` object is sent **verbatim**: no default is merged in and none is added, so routing comes entirely from the preset (`preset` field or `@preset/<slug>` picker entry) or the pasted `provider`. A pasted `provider` overrides a preset's routing. No separate setting exists (the former P7 floor and its merge are gone).
- A model-picker `@preset/<slug>` entry lives only in the per-request model id — it writes nothing to the template or shared state, so with an empty custom request other (non-preset) models are completely unaffected. If the custom request sets a **different** `preset`, the picker entry wins for that turn: the template's `preset` key is dropped (two preset references in one body would be ambiguous server-side) and the template's other fields still apply on top (OpenRouter shallow-merges request fields over the preset's config, request fields taking priority). A template `preset` with a non-preset model is preserved (the panel-dropdown form).
- `reasoning.effort`/`reasoning.enabled` always come from the picker's Thinking Effort selector and are spread into the template's `reasoning` object — they overwrite only `effort`/`enabled`; other keys like `max_tokens`/`exclude` survive.
- Validate the pasted JSON before saving: bad input is rejected with a clear error, never partially applied.

## Reasoning passthrough (P1)

DeepSeek V4 has thinking mode **on by default**, so every reply carries `reasoning_content`
(OpenRouter treats it as an alias of `reasoning`). The echo rule is conditional: when a
request carries `tools` (Copilot agent mode always sends tools), all prior turns' reasoning
**must** be passed back or the API 400s; without `tools` the echo is ignored. Copilot
preserves only what we emit, so the round-trip is symmetric: report `LanguageModelThinkingPart`
from `delta.reasoning`, and collect prior thinking parts in `toOpenAI` into a `reasoning`
string on the outgoing assistant message. As a display fallback, when `delta.reasoning` is
absent, flatten `delta.reasoning_details` by type (`reasoning.*`/`summary`/`text`/`final` →
thinking; `response.*` → text). Raw `reasoning_details` blocks (e.g. Claude's encrypted ones)
cannot round-trip through Copilot's flattened ThinkingPart — string echo is the mechanism;
never accumulate raw blocks for echo. P6 (`cache_control` for Claude) is applied:
anthropic-family models (`anthropic/*`, incl. `~anthropic/*`) get a top-level
`cache_control: {type:"ephemeral"}` in `buildRequestBody` unless the template already sets
its own `cache_control` (a template value wins, incl. an opt-out via `null`). A
`@preset/<slug>` request takes the decision from the preset's resolved underlying model.
It is a
5-minute ephemeral breakpoint that advances with the conversation; a template can extend it
(e.g. `"ttl": "1h"`). Per-block markers for Qwen/Gemini stay deferred until a suitable entry
is piloted ( OpenRouter outputs `cache_control` ↔ `prompt_cache_breakpoint` translation
blocks across families since ~Sept 2026, but this extension only emits the top-level Anthropic
form so far.

## Enforced behaviors

These are not user-configurable; the escape hatch, where one exists, is the pasted template.
The panel's footnote block (P8) is the user-facing version of this list.

- `stream: true` on every request (the provider API is progress-callback based).
- `session_id` = `copilot-chat:<Copilot chat-session id>` so OpenRouter sticky routing and
the Sessions view follow the Copilot chat session, not the window (cache warmth + grouping;
no content). With no known parent (an internal/utility call before any chat turn, or one long after
the last) **no `session_id` is sent at all**, so no orphan OpenRouter session is ever created.
- `model`/`messages`/`tools` always come from Copilot; template copies are stripped.
- No default `provider` object is ever added; a template `provider` passes through verbatim
  in every case (preset reference or not), so routing is decided by the preset or the pasted
  `provider`, never by a built-in default (the former P7 floor is gone; P9's verbatim rule now
  applies to all requests).
- Reasoning effort/enabled from the picker, merged over the template's `reasoning`; a picker
  effort of `none` is sent as `reasoning.enabled: false`.
- Anthropic-family models (`anthropic/*`, `~anthropic/*`) get a top-level `cache_control`
  (5-min ephemeral, advancing) unless the template sets its own `cache_control` (P6); a
  `@preset/<slug>` request takes the decision from the preset's resolved underlying model.
- Attribution headers `HTTP-Referer`/`X-Title` hardcoded, and sent only on `/chat/completions` (not on `/models` or `/presets`).
- https-only `baseUrl` (provider) and `creditBaseUrl`, both read from global scope only.
- Key in SecretStorage only, never settings.json.
- Template applies to every request until cleared (the picker's model switch back to a
  Copilot model is the per-turn escape).
- Usage accounting needs no field: every Chat Completions stream ends with an automatic
  `usage` chunk (P5) — nothing to paste or request.
- That chunk is forwarded to Copilot as a `usage` data part on every completed turn (P10), which
  is what puts *used / max tokens* in the context-usage ring. The **Copilot response footer is not
  a supported cost surface** for an extension-contributed provider (see the P10 correction above), and
  cost is deliberately kept out of the chat transcript too — it is reported in the panel's
  **Session spend** section instead (P12), where the figure is OpenRouter's `cost`, or the upstream
  cost on a BYOK route where OpenRouter charges nothing.

## Canonical request templates (decided with the plan)

- Default: the empty template `{}` (paste nothing) — no default `provider` is added,
  so OpenRouter's own routing applies; any pin (`order`, `only`, a `quantizations` floor, …)
  is just a pasted `provider` object.
- Published example: the empty template `{}` — every feature is enforced or provided by the
  extension/OpenRouter itself; state the always-on behaviors (the P8 list) next to it so
  readers do not paste `stream`/`session_id`/`usage`.
- Power-user variants: `{ "provider": { "order": ["deepinfra"], "allow_fallbacks": false } }`
  (hard pin), or a `response_format` json_schema from the Request Builder, or an Anthropic
  cache TTL extension: `{ "cache_control": { "type": "ephemeral", "ttl": "1h" } }`.
- Preset: `{ "preset": "faster-glm-flash" }` — the panel's Presets dropdown saves
  exactly this; the preset's own routing then applies (no default `provider` is ever added),
  and model-pinned presets are also pickable directly as `@preset/<slug>` entries.

## API contract — read the types, don't guess

The `LanguageModelChatProvider` API changed shape after the original 2024 design:
`provideLanguageModelChatResponse` takes `(model, messages, options, progress, token)`,
emits via `progress.report(new vscode.LanguageModelTextPart(...))` /
`new vscode.LanguageModelToolCallPart(callId, name, input)`, and returns `Promise<void>`.
`LanguageModelChatInformation` requires `family`, `version`, `maxInputTokens`,
`maxOutputTokens`, `capabilities`. `LanguageModelError` is built via static
factories (`NoPermissions`, `Blocked`, `NotFound`). Tool parts use `callId`
(not `toolCallId`). Reasoning traces use the proposed `LanguageModelThinkingPart`
(`value: string | string[]`), vendored in `typings/` and enabled via the
`languageModelThinkingPart` proposal id — guard runtime access through
`thinkingPartCtor` in `provider.ts` (stable VS Code exposes the class but the type
contract is proposed). Before changing API usage, check
`node_modules/@types/vscode/index.d.ts` (installed 1.134.0; engine `^1.134.0`) — it
is the authoritative source.

## Conventions

- **No code comments** unless the user asks (exception: `src/logic.ts` keeps the
  comments it was ported with).
- TypeScript strict (`tsconfig.json`), PEP-8-style clarity, 120-char lines.
- Keep the human-facing `README.md` plain and short; it doubles as the hand-out
  ("install from VSIX, open the panel, paste key and template").
- Commit `package-lock.json`; never commit `node_modules/`, `out/`, `.vscode-test/`,
  or `*.vsix` (already gitignored).
- **Never commit secrets.** The key exists only at runtime in VS Code
  SecretStorage; there is no key material anywhere in the repo.
- Commit and push are the user's call in this repo.
- Tests must never hit the network or the real keychain (see `extension.test.ts`
  fetch stub). Keep `logic.ts` free of `vscode` imports.

## What is verified vs. still to pilot

Verified: compiles (`tsc --strict`), full test suite passes (**314 tests** in the latest full run, 2026-09-21; `npm test` is the source of truth for the current count — it also passes on the Windows development host, and on this
WSL host with `libnss3`/`libnspr4`/`libasound2t64` installed so the Electron test host
launches), packages to a VSIX, API usage matches the installed `@types/vscode` 1.134
(engine `^1.134.0`) plus the vendored proposal typings, and the runtime
`LanguageModelThinkingPart` class exists on the stable test host (VS Code 1.135) despite
the proposed-API warning. The P10 usage-reporting and P11/P12 session-id and per-turn
cost behavior were verified against the installed VS Code 1.138 copilot bundle (see the
provider bullets) plus a stubbed-`vscode` Node harness for the stream loop; the live
**display** sides (context-usage ring, Session spend panel section) still need the pilot run below.

Still to pilot end-to-end (required before rollout):

1. Install the VSIX, open the panel, paste a key.
2. Paste a Request Builder body and confirm the request to OpenRouter carries the
   pasted settings.
3. **Reasoning passthrough proof (P1):** an agent-mode (tool-calling) turn on
   `deepseek/deepseek-v4-flash` — the second agent turn must not 400 (DeepSeek only
   400s on missing `reasoning_content` when the request carries `tools`); a plain chat
   turn is a smoke test only (the echo is ignored there).
4. Thinking trace renders in Copilot Chat (collapsible reasoning part).
5. Kill the network mid-retry / 429 → backoff observed, cancellation stops immediately;
   a streamed error body (HTTP 200 + `data:{"error":…}`) surfaces as a mapped error
   instead of an empty reply (P3 proof).
6. A streamed turn's final data chunk (just before `[DONE]`) carries `usage` with no
   template at all (P5: automatic chunk confirmed), and that chunk is forwarded to
   Copilot as a `usage` data part (P10).
7. A request with no template sends no `provider` object (OpenRouter's default routing
   applies); a template `{ "provider": { "order": [...] } }` reaches OpenRouter verbatim
   with nothing merged in — the former P7 floor is gone (removal proof).
8. Panel renders the enforced-options footnote block; the markers resolve to it (P8 proof).
9. One chat turn with a pasted image on a vision model reaches OpenRouter as `image_url`;
   on a text-only model Copilot does not attempt the image turn (capability gating).
10. Confirm in OpenRouter Activity that the served provider is allowlisted; endpoint
    quantization is what the pasted `provider.quantizations` (if any) requested — no
    default filter is applied.
11. Confirm the status bar shows the key's credit balance and the usage dashboard
    renders in the panel.
12. Check WSL and Windows extension hosts both build and run.
13. `cached_tokens > 0` on a follow-up turn is **not** a pass/fail gate: most ZDR +
    no-training DeepSeek hosts report `supports_implicit_caching: false`, so zero cache
    is an expected outcome even when `session_id` is sent. Record the observed value.

14. Anthropic proof (P6):on an `anthropic/*` turn (chat mode, no template cache_control),the
    outgoing body carries `cache_control:{type:"ephemeral"}`; a follow-up turn on an Anthropic
    model shows `cached_tokens > 0` when the prompt exceeds the model's cache minimum,or the
    request errors if the host rejects the marker (record which host).

15. Preset proof (P9): a member key's `GET /presets` lists the org presets; selecting a preset
    in the panel sends `"preset":"<slug>"` and **no `provider` key**; a turn on a
    `@preset/<slug>` picker entry is served in Activity from the preset's pinned provider
    order (e.g. baseten → makora for `faster-glm-flash`), proving the extension did not add
    a default `provider` over the preset routing. Also confirm a model-less preset shows no picker entry and is still
    selectable in the dropdown as the template for any picked model.

16. **Context-usage ring proof (P10):** on a normal turn the context-usage ring shows
    `used / max tokens` (non-zero, agreeing with the ring's percentage). Note the Copilot
    response footer is **not** a cost surface for this provider — do not treat a missing
    footer figure as a failure.
17. **Session spend proof (P12):** open the panel → **Session spend**. The chat you have been
    using should appear as one collapsible entry with a total, and expanding it should list one
    route row per provider/model in the `Cost | Provider | Model | Calls | Cached` table (e.g.
    `$0.001627 | Fireworks (BYOK) | deepseek/deepseek-v4.1-flash | 3 | 92.0%`). Confirm: the total
    covers **all** model calls of a
    tool-using turn (not just the last round); a second chat appears as a **separate** entry; the
    entry **survives a window reload and a full restart**; and a chat with only costless turns does
    not appear. There is deliberately no window-wide total. On a **BYOK** turn
    (BYOK — e.g. Fireworks) the figure is the `cost_details.upstream_inference_cost` value,
    because OpenRouter reports `cost: 0` there; on a shared-pool turn the route reads `OpenRouter`
    and the figure is OpenRouter's `cost`. Cross-check one figure against the **upstream provider's**
    billing page on BYOK (OpenRouter's `cost` is 0 there by design — correct, not a bug). Also
    confirm the chat transcript itself carries **no** cost text.
18. **Session-continuity proof (P11):** in OpenRouter's Logs → Sessions view, one Copilot chat
    session appears as one session *after a window reload and after a full restart* — i.e. the
    turns following the reload carry the same `session_id` (`copilot-chat:<chat-session id>`) as
    the turns before it, and the transcript + thinking parts are still there. Distinguish it from a
    *new* Copilot chat, which must show up as a separate OpenRouter session.

## Known upstream limitations (no client-side fix; for the README when publishing)

- **Gemini via OpenRouter**: prompt caching is broken (0% hits through the OpenAI→Gemini
  translation layer, microsoft/vscode#332772), and Gemini 3.1 agent mode 400s on a stripped
  `thought_signature` (microsoft/vscode#296713). Avoid Gemini in agent mode via OpenRouter.
- **Qwen**: this extension only emits the top-level (Anthropic) `cache_control` form (P6),
  which OpenRouter honors for Anthropic/Vertex/Azure/Bedrock — not Alibaba;Qwen still needs
  per-block markers this extension doesn't send, so budget full input price for a Qwen route
  (or use a client that emits them: pi/omp/Kilo/OpenClaw.
- **Stream cancellation** stops billing only on providers OpenRouter lists as supporting it
  (DeepSeek and DeepInfra do; Google/Bedrock/Groq and others do not).
- WSL reports of "Request blocked by content filter" are an OpenRouter-side filter/rate-limit
  pattern (github/orgs/community#199784), not WSL-caused.

