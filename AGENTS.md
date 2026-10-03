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

- `src/extension.ts` — activation: registers the provider (`vscode.lm.registerLanguageModelChatProvider('openrouter-copilot-request-credit', …)`, vendor id must match `contributes.languageModelChatProviders[].vendor`), the status bar item (credit), the refresh lifecycle (single-flight `refresh`/abort-supersede `doRefresh`), the unified webview panel, the config-change listener and the auto-refresh timer. Commands: `openrouterCopilot.manage` and `openrouterCopilot.pasteTemplate` both open the panel; `openrouterCopilot.clearTemplate` clears the template. Exports for tests: `refresh`, `doRefresh`, `getStatusText`, `createPanelDeps`, `stopRefreshTimerForTesting`, and `readConfig`.
- `src/panel.ts` — the **single control panel** (webview): `renderPanelHtml`, `handlePanelMessage`, `PanelDeps`, `readConfig`. Four tabs: **Key Info** (key save, credit usage and credit settings), **Session Spend** (per-chat spend), **Request** (preset dropdown and custom request JSON; selecting a preset replaces the saved request, selecting the default clears it), and **Context** (window budget, long-context pricing and per-model caps). Every contributed user setting has an editable control in this panel, even when no API key/account details are available; all configuration updates use application/global scope. The active tab is retained in VS Code webview state across rerenders. Short explanatory notes are placed with the controls they describe. Presets are fetched with the panel render; the dropdown re-syncs whenever the template is saved or cleared (the sync adds a `<slug> (not in list)` option when the saved slug is absent from the rendered list). `readConfig` reads global scope only and validates/clamps numeric, boolean and reset-period settings. Message handling and rendering are unit-testable (no live webview needed).
- `src/provider.ts` — the `LanguageModelChatProvider`:
  - `provideLanguageModelChatInformation` — fetches `GET /models` with the user's key (via `fetchWithRetry`; a non-OK catalog response now surfaces a mapped error instead of `[]`, and a 200 with a non-JSON body surfaces a mapped error too), maps to `LanguageModelChatInformation` (family = slug prefix, version = slug, token caps from `context_length`), attaches a `detail`/`tooltip` rendered by `modelInfo.ts` (price info in the model picker), and a `configurationSchema` so reasoning models expose **VS Code's native Thinking Effort selector** in the picker (proposed `chatProvider` API, `enabledApiProposals` in `package.json`, vendored types in `typings/`). It also fetches presets (`GET /presets`, then `GET /presets/{slug}` for the designated `designated_version.config.model`, capped at 25 lookups, fetched with bounded concurrency after the active-status filter — inactive presets never consume the lookup budget, and the full active list stays visible in the panel dropdown regardless of the cap) and appends a picker entry `@preset/<slug>` (family `preset`) for each **model-pinned** preset within the lookup cap, with caps/capabilities/pricing resolved from the underlying catalog entry (assumed defaults when the model is absent from it); model-less presets get no picker entry. The presets sweep is **single-flight and background**: the picker gets the models immediately, and the sweep (shared by `getPresets()` via one in-flight promise) attaches `@preset/*` entries when it resolves, firing `onDidChangeLanguageModelChatInformation`; a warm preset cache from a panel render is reused, not re-fetched. A failed sweep leaves the preset cache **cold** (never cached as an empty list) so a later render or query retries it. The presets fetch is **best-effort**: any failure degrades to the models-only catalog. `getPresets()` fetches on first use (also on panel render) and caches; `getPresetConfig(slug)` resolves and caches the full designated config (shared with the list fetch) so the panel can prefill the textarea with the resolved preset configuration as full-line `//` comments above the JSON when a preset is selected. A pinned model that is not in the catalog under its exact slug (e.g. datestamped `z-ai/glm-5.3-flash-20260826`) resolves against the catalog by stripping a trailing datestamp (`-YYYYMMDD`, then a plausible `-MMDD`) so reasoning schema, caps, and pricing still load; truly unknown models get assumed defaults and no reasoning selector. `setTemplate` strips full-line `//` comments before validating, so commented text saves cleanly. Changing `openrouterCopilot.baseUrl` calls `resetCatalogCache()` so the picker re-fetches from the new host.
  - `provideLanguageModelChatResponse(model, messages, options, progress, token)` — builds the body via `buildRequestBody` (saved template spread over the live model/messages/tools, `stream: true` — every forwarded tool carries a `parameters` object (`tool.inputSchema` ?? `{type:"object",properties:{}}`), an empty `tools` array and a legacy template `prompt` are dropped, and Copilot's `toolMode === Required` is mapped to `tool_choice:"required"` unless the template sets its own `tool_choice` — `session_id` = `sessionIdFor(options.modelOptions._conversationId)` — see "Session identity" — verbatim `provider` passthrough — no default `provider` is ever injected, preset reference or not, so preset routing survives; picker effort/enabled merged into the template's `reasoning`, with a picker effort of `none` sent as `reasoning.enabled: false` rather than `effort: "none"`; a preset-reference model id (`@preset/*` or combined `*@preset/*`) drops a template `preset` key so the picker entry is the only preset reference; `@preset/*` requests take the P6 `cache_control` decision from the preset's resolved underlying model), POSTs `/chat/completions` through `fetchWithRetry` (mid-stream and mid-read cancellation surfaces as `vscode.CancellationError`; retried responses have their bodies cancelled before backoff), parses SSE with a bounded line buffer, emits parts via `progress.report(...)`. Emits `LanguageModelThinkingPart` from `delta.reasoning` (fallback: flatten `delta.reasoning_details` via `flattenReasoningDetails`) plus text and tool-call parts. Throws mapped errors on HTTP statuses and mid-stream `data:{"error":…}` events (`mapResponseError`/`mapStreamedError`), appending the `X-Generation-Id` header. Tolerates and captures the automatic final `usage` chunk (`getLastStreamUsage`, reset per request). **Returns `Thenable<void>`; parts go through the progress callback, not a returned stream.**
  - `toOpenAI` — converts messages to OpenAI chat format. VS Code's `LanguageModelChatMessageRole` in the 1.134 type surface has no `System` value, but the **runtime** enum on VS Code 1.140 does (`System = 3`), and core's raw→public role rewrite does map a genuine system-role transcript message onto it; a defensive helper (`openAIRoleOf`, resolving the member through a cast) therefore sends `role:"system"` for it. Copilot-supplied prompt context still arrives in `user`-role messages, so user-role messages stay `user` regardless of position rather than guessing which text is scaffolding. Assistant text, prior `LanguageModelThinkingPart`s echoed back as a `reasoning` (string) field (DeepSeek thinking-mode echo rule; an assistant message with **no** thinking trace instead carries `reasoning_content: ""`, matching the native provider), tool calls/results as `tool_calls` / `role:"tool"`, images as `data:` URL `image_url`s, and a message `name` forwarded when Copilot sets one. Non-text tool results are decoded rather than JSON-stringified: `LanguageModelDataPart` text/JSON → text, an image → a following user `image_url` message (never a numeric-key blob), and `LanguageModelPromptTsxPart` → its `value` as JSON without the class wrapper.
  - **Per-turn usage report (P10)** — when the stream ends (`[DONE]`, or the read loop finishing), the captured usage chunk is reported back as `progress.report(new vscode.LanguageModelDataPart(bytes, 'usage'))` with `{ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: { cached_tokens, … }, completion_tokens_details?, copilot_usage? }`. `completion_tokens_details` is forwarded verbatim when present and object-shaped, because the harness reads `completion_tokens_details.reasoning_tokens` for its reasoning-token accounting and drops the number when the key is absent — while its decode step spreads the rest of the payload, so extra keys are tolerated. Copilot parses exactly this payload into its `APIUsage`, which is what feeds the **context-usage ring** numerator. `usage` capture happens **before** the `choices[0]` check, because OpenRouter's final chunk carries `choices: []`. `copilot_usage.total_nano_aiu` is set only when `cost > 0` (a zero charge must not render as a misleading `0.0 credits`). Only `buildUsagePart` decides the payload (pure, exported for tests) and it returns `undefined` (no part at all) unless the three token counters are numeric.
    **Correction (do not re-introduce):** an earlier version of this file claimed this payload also puts the turn's cost in the Copilot **response footer**. That is **false for a local chat session**. The local footer string is built in the copilot extension from `this._chatQuotaService.getCreditsForTurn(turn.id)`, and that map is populated *only* by the CAPI fetch path (`setLastCopilotUsage` on a `ChatMLSuccess` `usage.copilot_usage.total_nano_aiu`) — never by an extension-contributed provider's progress part — the endpoint class for extension-contributed models overrides `makeChatRequest2` and **never calls `super`**, so the CAPI fetcher (`fetchMany` → `setLastCopilotUsage`) is not on our request path at all, in any harness mode. `ExtensionContributedChatEndpoint` returns `response.usage`, which feeds the ring but not the footer. The `copilotCredits` → `cY()` → `Model • N credits` chain exists only on the **agent-host** path (`toResponseDetails`) plus session-cost and subagent hovers. Even if it existed, Copilot formats with one decimal (`Heu`: `toFixed(1)`), so a micro-dollar turn would render `0.0`.
    **But the footer is not the only Copilot-side consumer of our part (code-traced, not yet observed live):** the copilot extension's agent loop folds `K$e(be.usage.copilot_usage?.total_nano_aiu)` into `this._accumulatedCopilotCredits` and reports it on the chat progress participant (`ge.usage({copilotCredits: …})`), and the `runSubagent` tool accumulates that item and calls `response.setSubagentCopilotCredits(callId, …)`, which sums sub-agent credits into the parent request's usage. Because `K$e` divides by `1e9` and our `NANO_AIU_PER_CREDIT` multiplies by `1e9`, the figure Copilot shows equals OpenRouter's dollar cost, not a rescaled one. That is a genuinely working Copilot-side surface for this provider — unlike the response footer — and it exists only where Copilot itself renders accumulated credits (sub-agent and session-cost UI), never in the local chat footer.
  - **Session cost (P12)** — cost is surfaced by the extension itself, not Copilot, and lives in the **panel**, never in the chat transcript. `turnCostOf(usage, provider)` extracts a payable figure plus cache counts; `accumulateSessionCost(sessionId, usage, provider, model)` folds each model call into a session-keyed store (`getSessionCosts()`/`getSessionCost()`); the panel renders it via `renderSessionCosts` as one collapsible `<details>` per session (newest expanded) with a per-provider/model route row inside (`routeCostCells`, rendered as a `Cost | Provider | Model | Calls | Cached` table), and `onTurnCost` re-renders an open panel as turns finish. Each route row ends with its **own cache rate** (`cacheSharePercent`, a bare `82.3%` — the `Cached` header supplies the word — = `cachedTokens / promptTokens` over that route, one decimal), not a session-blended figure: a chat that **hopped models** has several routes whose cache behavior differs, so a single average would hide the good or bad one. The rate is omitted (never `0.0%`) on a route that reported no prompt tokens. The session-blended rate stays in the `<summary>` line (`cacheShareSuffix(session)`, which renders `82.3% cached`) — one helper, two scopes. **Why session-keyed rather than per-invocation:** Copilot drives a tool-using turn as **one `provideLanguageModelChatResponse` call per tool round** (the agent loop passes an `iterationNumber` through `makeChatRequest2`), so per-call state can never see the whole turn — a per-call accumulator was tried and removed. The store is bounded to `MAX_TRACKED_SESSIONS` (**10**), and **persisted to `globalState`** (`SESSION_COSTS_KEY`) so it survives a reload/restart; the provider constructor calls `hydrateSessionCosts`, which **merges** persisted entries rather than replacing memory (constructing a provider must never discard live state — a replace was tried and wiped totals when a second instance was constructed) and restores only real `copilot-chat:`-prefixed entries **plus the shared unattributed bucket** (an earlier revision stored unidentified calls under a bare per-window UUID; a bare UUID is still dropped, because such a call now belongs to the bucket — see P13). Persist writes are fire-and-forget.
Ordering uses a **monotonic `stamp()`**, not raw `Date.now()`: several sessions can land in the same millisecond, and equal stamps made the cap's sort fall back to insertion order, evicting the newest and keeping stale entries. `onTurnCost` remains as the change signal.    **Spend that has no chat (P12b):** a call that reached this provider **without going through the Copilot harness at all** has no chat to be charged to, so it is collected under the synthetic key `UNATTRIBUTED_SESSION_ID = 'unattributed'` and rendered by the panel as a single trailing entry labelled **`Unattributed (no chat id)`** (with a note explaining that an agent-host/SDK session talks to the provider through a client-BYOK bridge that carries no chat id). The sentinel is deliberately **not** `copilot-chat:`-prefixed so it can never be mistaken for a chat — `withSessionTitles` skips it (no title lookup), and it is **never used as an outgoing `session_id`** (the wire value is dropped for it, so no orphan OpenRouter session is minted). `trimToCap` **reserves the bucket's slot**: the chat entries share `MAX_TRACKED_SESSIONS − 1` slots while the bucket is present, so unidentified spend is never evicted by chat churn (and the bucket never simply *adds* an 11th entry).
    **Which session a call belongs to (P13):** `resolveCostSession(sessionId, hasConversationId, now, harnessOwned)` — a call carrying Copilot's conversation id *is* a chat turn and becomes the current session; a call **without** one that *did* come through the Copilot harness is internal (sub-agent or summarization) and is attributed to the most recently active chat rather than creating an entry of its own; a call that did **not** come through the harness at all is **never blamed on a chat** — it goes to the unattributed bucket (**P12b**) and sends no `session_id`. `resolveCostSession` therefore never returns `undefined`; the caller separately decides whether the returned key may be a wire `session_id` (it may not, for the sentinel). The conversation id can only be read off the **top-level** `conversationId` of `makeChatRequest2` — `ExtensionContributedChatEndpoint` (the harness class `Ok`) copies exactly that key into `modelOptions._conversationId`, and everything else the caller puts in `telemetryProperties` is unreachable (only `telemetryProperties.turnIndex` survives, collapsed to the numeric `_telemetryTurn`). Which driver supplies it therefore decides the mode's fidelity, and drivers split into two families: the **agent loop** passes it top-level (`conversationId: this.options.conversation.sessionId`), so the main chat turn, every tool round of it, inline chat's main turn, `summarizeConversationHistory`, and — importantly — a **generic `runSubagent` child agent loop** (core builds the child invocation from the *parent's* `sessionResource`) are exact, and a sub-agent's spend folds into its parent chat's entry; the **tool-style sub-agents and utility flows** implement their own `fetch` and pass the id *only* inside `telemetryProperties`, so harness `execution_subagent`/`search_subagent` (edit-agent and semantic search), the inline-chat intent loop, and title/progress/branch-name/NES calls have no id and fall to the most-recently-active heuristic, bounded by `PARENT_ATTRIBUTION_WINDOW_MS` (10 min) so a stale attribution is not blamed on a long-finished chat; past that window, and for any call that did not come through the harness at all (an **agent-host / SDK client-BYOK session**, §Harness boundary — which has no id *and* never enters the harness), the call is recorded in the **unattributed bucket** (**P12b**) instead of being dropped. Because the heuristic can only ever *reuse* a real `copilot-chat:`-prefixed id, a harness-owned internal call can never mint a bogus session key — nothing internal is ever stored under its own key, so the 10-entry cap cannot be polluted or evicted by one; the unattributed bucket holds one reserved slot of the 10 and is exempt from churn eviction.
The same rule drives `session_id`: it is sent only when the cost key is a real chat id — a chat's own id, or its known parent's — and **none is sent** whenever the call resolves to the unattributed bucket (harness-less, or a harness-owned internal call with no parent inside the window), so the cost panel and OpenRouter's Sessions view agree and no orphan session appears (P15). The parent is persisted to `globalState` (`parentSession`) so attribution survives a reload. The payable figure is `cost` when OpenRouter charges, otherwise `cost_details.upstream_inference_cost` — on a BYOK route OpenRouter reports `cost: 0` because the upstream provider bills the user (verified live: a Fireworks BYOK turn reported `cost: 0`, `is_byok: true`, `upstream_inference_cost: 1.342e-5`). `is_byok` is `true` either when the flag is set or when only an upstream figure exists. The serving provider name comes from the streamed chunk's `provider` field (reset per request; `getLastStreamProvider` is a test seam). Amounts are micro-dollars, so `formatUsdPrecise` scales decimals (and never prints `$0.00` for a real cost) and `roundSignificant` (default **15** significant digits = working precision) is applied to every accumulation and at the display boundary, so binary-float artifacts (`1e-5 + 2e-5 = 3.0000000000000004e-5`) cannot reach a total or a hover. **Do not lower that digit count to "hide" drift cheaply** — measured over 100k accumulated micro-dollar turns: plain float drift 5.8e-13 relative (invisible), whole-nano quantization 2.7e-5 relative bias, and 6-digit rounding a **5.3%** error. Rounding harder injects bias rather than removing noise; there is a regression test asserting this. Both helpers live in the pure `logic.ts`.    **How a harness-less call is recognized (P13b):** the presence of `_capturingTokenCorrelationId` in `modelOptions` ≡ "this call came through the Copilot harness", because the harness bag builder `Ok.makeChatRequest2` is the **only** construction site in the copilot bundle and always sets that key unconditionally (`_otelTraceContext` likewise). A bag lacking it therefore cannot have been produced by the harness — the agent-host BYOK bridge (`AgentHostByokLmHandler.chat`, in core's `sessions.desktop.main.js`) forwards the caller's `modelOptions` **verbatim** and passes `void 0` where a session-ish argument would go, so no identifier exists on that path *by construction* (there is no better id to discover — this is not a client-side fixable gap). `isHarnessOwnedModelOptions` implements exactly that test, and a harness-less call resolves to the unattributed bucket (**P12b**) instead of the parent heuristic. **Compat note:** the marker is a harness-internal key with no public constant, so read it defensively (existence only, never its value) — as with `_conversationId`.
    **Session label & last-update time (P14):** the panel labels a session with the **Copilot chat title** when it can get one, and always shows the session's **last-update time** beside the call count. Both are display-only enrichments — neither is persisted, so no chat content is written by the extension. The title is **not available through any API** and is never sent to a provider (`ExtensionContributedChatEndpoint` puts only `_capturingTokenCorrelationId`/`_otelTraceContext`/`_telemetryTurn` (a numeric turn index)/`_enableThinking`/`_conversationId` into `modelOptions`, and **omits** the `_conversationId` key rather than sending `undefined`; Copilot's `sessionTitle` exists only in VS Code core's OTel export/import path). It is instead read best-effort from VS Code's own chat-session store — `workspaceStorage/<hash>/chatSessions/<conversationId>.jsonl`, which sits beside the extension's `context.storageUri` (`chatSessionsDir` derives the dir; `SessionCost.title` is filled at panel-render time by `withSessionTitles`). Only the first 64 KB are read (`readSessionTitleFromDisk`), and and the pure `parseSessionTitle` (in `logic.ts`) understands **both** title shapes — the rename mutation `{"kind":1,"k":["customTitle"],"v":"…"}` (a later rename wins) and the **nested** `v.customTitle` on the `kind:0` initial-state record, which is the *only* carrier for a never-renamed session. The `kind:0` line embeds the whole transcript, so a long session outgrows the 64 KB head read and the line arrives **cut mid-object** (it no longer `JSON.parse`s at all — the shape that broke the `0ef97316…` session); `titleFromRawHead` then recovers the field from the raw text with an escape-aware scan, so the cap can stay bounded instead of growing with the session. A missing dir, missing file, malformed `HEAD`, a title cut off mid-string, or an absent/blank title all fall back to the truncated id. The chat title is generated by Copilot **after the first turn**, so the earliest render may still show the id. `updatedAt` is the monotonic `stamp()` (ms since epoch); the panel renders it via `formatReset` only when it is a plausible clock value (`>= 1e12`), so legacy/`1`-fixture stamps are omitted rather than shown as 1970.
  - `provideTokenCount` — rough `chars/4` estimate (must be async per the current API).
  - OpenRouter requests use the fixed `https://openrouter.ai/api/v1` API endpoint. Test seams: `setRetryDelayForTesting`, `getLastStreamUsage`, `buildUsagePart`, `sessionIdFor`.

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
read it defensively. Some internal calls do not pass it, and they fall in three families (see P13
for the mechanism): a **generic `runSubagent`/custom-agent child agent loop** runs the same agent loop
as a normal turn and is handed the **parent chat's** `sessionResource`, so it *does* carry the id and
its turns join the parent's OpenRouter session exactly; the harness's **tool-style sub-agents**
(`execution_subagent` for the edit agent, `search_subagent`) and Copilot's **utility flows** (title
generation, progress messages, the inline-chat intent pass, NES) pass the id only inside
`telemetryProperties` and therefore have none — those are attributed to the **last active chat**
instead (persisted to `globalState` under `parentSession` so it survives a reload, bounded by the
10-minute `PARENT_ATTRIBUTION_WINDOW_MS`); and an **agent-host / SDK client-BYOK session** (§Harness
boundary) never comes through the harness at all, so it is never attributed to a chat — its spend
appears in the panel's **Unattributed** entry (**P12b**) instead. For a call with no parent known
(harness-owned and past the window, or harness-less), **no `session_id` is sent at all** rather than a
per-window UUID (`WINDOW_SESSION_ID` survives only as `sessionIdFor`'s internal fallback), so an
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
section — four `openrouterCopilot.credit*` settings for the guardrail/usage dashboard and
three context/request-safety settings. API endpoints are fixed to OpenRouter. The request
template itself is pasted JSON stored via the provider's global state — it is
**not** exposed as a multi-field settings UI.

### Harness boundary — every Copilot mode reaches this provider through one funnel

Verified against the installed harness bundle (`github.copilot-chat` as the built-in `copilot`
extension, `dist/extension.js`). The full evidence, the mode inventory and the mode × function
matrix are in [`docs/copilot-harness-modes.md`](docs/copilot-harness-modes.md) (dev-only, excluded
from the VSIX). **There is exactly one funnel**, so no mode-specific handling is
needed or present: VS Code core's extHost builds the call at `$startChatRequest` and invokes
`provideLanguageModelChatResponse(info, messages, { ...options, modelOptions, modelConfiguration,
requestInitiator, toolMode: options.toolMode ?? 1, includeEncryptedThinking }, progress, token)`.
`modelOptions` is forwarded **verbatim** — core never injects `_conversationId` (it has no
`_conversationId` reference at all) — `requestInitiator` is `"core"` unless another extension called
through `vscode.lm`, and the progress parts are mapped back to Copilot's part types
(tool_use/text/data/thinking; an unknown part type is logged and dropped).

Modes that can reach us: VS Code chat (ask/agent/plan), the edit/notebook/terminal participants,
inline chat, NES, every agent-mode tool round, history compaction (`summarizeConversationHistory`),
sub-agents, Copilot's utility flows, the harness's own `agentLMServer` SSE endpoint, an agent-host
session's **client BYOK** bridge (gated on the host's `clientByokEnabled` policy; same catalog, same
request path, plus `includeEncryptedThinking: true` and `configuration.reasoningEffort`, which
`effortFromModelConfiguration` already reads), and any other extension or SDK client going through
`vscode.lm`. What differs between them is only content: messages/tools, which `modelOptions` keys are
present, `requestInitiator`, where the reply is routed, and who consumes the `usage` part — **not
`toolMode`**, which the harness's extension-contributed endpoint never sets (core's
`options.toolMode ?? 1` default therefore always yields Auto). The mode-dependent gaps that matter are
all **absent-`_conversationId`** cases (sub-agent, compaction, utility flows) plus the **agent-host
client-BYOK bridge** (§Harness boundary), which never enters the harness at all — exactly what
P13's parent/agent-host heuristic, P12b's unattributed bucket and P15's send-no-`session_id` rule
guard. Modes that **cannot** reach us: the
standalone CLI process and the GitHub cloud coding agent (both remote, with no path to a local
provider — the shipped CLI shim has zero `vscode.lm` references).

Three harness details worth knowing (none of them a defect in this extension):

- **`ExtensionContributedChatEndpoint.maxOutputTokens = 8192` is harness-internal only.** The
  endpoint class hardcodes that value for its own bookkeeping; the picker and the context budget are
  synthesized by core from **our** reported caps (`iTn`/`rTn` clamp and compute
  `contextWindow = maxInputTokens + maxOutputTokens`), so nothing truncates our replies and the
  P16 input budget is unaffected.
- **Our vendor id is what activates the BYOK utility-model path.** The harness computes
  `_hasByokModels = models.some(m => m.vendor !== "copilot")`, so *any* non-`copilot` vendor —
  including ours — makes Copilot report BYOK models as available, which is the precondition for the
  `chat.byokUtilityModelDefault: mainAgent` setting existing. The Copilot-utility-flows orphan-session
  risk described above is therefore a direct consequence of our vendor id, not an accident; the
  recommended `"copilot"` value is the avoidance.
- **The `copilotcli` vendor is not a route to us.** The harness registers a second
  `copilotcli` provider whose `languageModelChatProviders` entry is `"when": "false"` and whose
  `provideLanguageModelChatResponse` is an **empty no-op** (`provideLanguageModelChatInformation`
  returns `[]`, `provideTokenCount` returns `0`). The in-editor CLI / agent-host session model list
  comes from the Copilot CLI SDK catalog (`copilotCLISDK.getAvailableModels()`), not from
  `vscode.lm`, so this extension cannot be selected there — and no out-of-VS-Code harness can be
  handed a local extension provider in the first place.
- **Two host capabilities the 1.134 type surface does not describe are handled** (runtime-only,
  verified on 1.140): `LanguageModelChatMessageRole.System = 3` (resolved by cast, mapped to
  `role:"system"`) and `completion_tokens_details` on the streamed usage chunk (forwarded when
  present). Both were silent losses before; see `docs/copilot-harness-modes.md` §3e.

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
form so far. The harness does not supplement it: the harness's own cache-breakpoint parts are vendor-gated to `{anthropic, gemini, openrouter}`, which excludes this extension's vendor id (`openrouter-copilot-request-credit`; the built-in `openrouter` *vendor* is in the set), so the P6 top-level marker is the only cache signal that ever leaves the extension.

## Enforced behaviors

These are not user-configurable; the escape hatch, where one exists, is the pasted template.
The panel's short, context-specific notes are the user-facing version of this list.

- `stream: true` on every request (the provider API is progress-callback based).
- `session_id` = `copilot-chat:<Copilot chat-session id>` so OpenRouter sticky routing and
the Sessions view follow the Copilot chat session, not the window (cache warmth + grouping;
no content). With no known parent (an internal/utility call before any chat turn, or one long after
the last) **no `session_id` is sent at all**, so no orphan OpenRouter session is ever created.
- `model`/`messages`/`tools` always come from Copilot; template copies are stripped.
- `tools` map 1:1 to Copilot's list, each function carrying `name`, `description`, and
  always a `parameters` object (an absent `tool.inputSchema` becomes
  `{type:"object",properties:{}}`; an empty `tools` array is omitted). Copilot's
  `toolMode` is honored: `Required` sends `tool_choice:"required"` unless the template
  sets its own `tool_choice`. **In practice this branch is inert for Copilot-driven
  turns** — the harness's endpoint class never puts a `toolMode` key in the
  `modelOptions` bag it forwards, so core's `toolMode: i.toolMode ?? 1` default always
  resolves to Auto; the mapping stays live only for another `vscode.lm` caller that
  sets the option explicitly.
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

### Context window sizing (P16)

`maxInputTokens` is reported as the accurate input budget `context_length − max_output_tokens`
(never a percentage of it), so Copilot's own auto-compaction acts at the right point. OpenRouter's
`/models` publishes `pricing.overrides` — a stepped price above `min_prompt_tokens` (77/465 models,
notably OpenAI GPT above 272K) — and `longContextTier` (in `modelInfo.ts`, pure) detects it: a numeric
threshold below the window on a genuine surcharge; time-of-day overrides and discounts are ignored.
With `openrouterCopilot.contextWindowPolicy: auto` (default) the budget is capped at the
cheapest threshold; `full` ignores the cap.
`openrouterCopilot.contextSafetyMarginPercent` (0–50, default 0) rescales every saved numeric per-model
Custom cap in place, including models whose Custom selection is not currently active. The provider tracks the prior applied margin in global state and uses a ratio when adjusting values, so changing the margin back does not compound rounding/shrinkage. Auto and Full selections are unchanged. Per-model Auto/Full/custom overrides live in
`globalState.contextCaps`; saving one fires
`onDidChangeLanguageModelChatInformation`, and context setting changes refresh model information
without discarding the catalog. The picker tooltip shows base vs stepped `$/1M` and the cap, with a `· ≤262K`
marker on the detail line when capped.

#### Compaction field observation (2026-10-03; tentative)

During a long Copilot Chat debugging session, the conversation resumed with a generated summary of earlier
context; the user then reported increasing the limit and suspected compaction had occurred. This sequence is a
**likely symptom** of automatic compaction/summarization and is useful as a field-test lead, not a verified
extension compaction result. The inspected persisted transcript and debug log for session
`45e209a5-0b42-4753-819f-656f2aeca48d` contained no explicit compaction marker, token count, or configured
limit; the debug log only showed `session_start`. It is therefore unknown whether Copilot compacted because
the extension-reported input budget was reached, whether a separate host summarization occurred, or whether
the changed limit affected that event. For future debugging, record the model, effective `maxInputTokens`,
before/after user-visible evidence, and timestamps; classify summary handoffs alone as **likely, unconfirmed**.

### Base64 guardrail retry (P17)

Long base64-like runs in prompt TEXT (`[A-Za-z0-9+/=_-]{200,}`) are stripped before the POST when
`openrouterCopilot.sanitizeBase64Content` is on (default). Image `image_url` data URLs are never
touched. A 403 whose body matches `base64|prompt injection|request blocked` triggers one retry with
the sanitized body when the proactive pass had nothing to strip.

### Empty and reasoning-only turns (P18)

A turn that emits nothing reports a single space text part; a turn that emitted only reasoning while
the thinking-part class was missing or threw raises a fixed explanatory error instead of resolving
empty. The thinking-part constructor is probed through `probeThinkingPartCtor` (guarded `Reflect.get`),
so a host with a throwing getter degrades to "reasoning not displayed" rather than crashing at load.

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
(not `toolCallId`). `LanguageModelChatMessageRole` has **no `System` member** in the 1.134
type surface, so Copilot sends harness and other prompt context in `user`-role messages; the
extension preserves that role rather than inferring system provenance from position. The
**runtime** enum on VS Code 1.140 does define `System = 3` and core maps a genuine system-role
transcript message onto it, so the role is resolved defensively (a cast, never a direct member
access) and such a message is sent as `role:"system"` — see `openAIRoleOf`. Reasoning traces use the proposed
`LanguageModelThinkingPart`
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

Verified: compiles (`tsc --strict`), full test suite passes (**364 tests** in the latest full run; `npm test` is the source of truth for the current count — it also passes on the Windows development host, and on this
WSL host with `libnss3`/`libnspr4`/`libasound2t64` installed so the Electron test host
launches), packages to a VSIX, API usage matches the installed `@types/vscode` 1.134
(engine `^1.134.0`) plus the vendored proposal typings, and the runtime
`LanguageModelThinkingPart` class exists on the stable test host (VS Code 1.135) despite
the proposed-API warning. The P10 usage-reporting and P11/P12 session-id and per-turn
cost behavior were verified against the installed VS Code **1.140.0** copilot bundle
(`github.copilot-chat` 0.68.0; see the
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
8. Panel renders accurate notes alongside the relevant key, request and context controls (P8 proof).
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
    confirm the chat transcript itself carries **no** cost text. A chat driven from an **agent-host
    session** is expected to appear as an **Unattributed (no chat id)** entry rather than under its
    own chat (**P12b**) — the entry exists once such spend has occurred, even when the 10-entry
    cap is full, and it is the one entry that never looks up a chat title.
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
