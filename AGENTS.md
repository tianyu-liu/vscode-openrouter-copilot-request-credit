# AGENTS.md — instructions for AI assistants working on this extension

> This file is for AI coding assistants (Kilo, Claude Code, Cursor, Cline,
> Continue.dev, Aider, etc.) working in this repository. It is **not** for
> human readers; see `README.md` for that.
>
> This file is synced/shared, so it intentionally contains **no**
> organization-specific content. Local-only context (repo origin, policy
> pointers, pilot notes) lives in the gitignored `AGENTS.lab.md`, imported
> below when present.

@AGENTS.lab.md

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

- a **per-session `session_id`** so OpenRouter keeps the prompt cache warm;
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
- `src/panel.ts` — the **single control panel** (webview): `renderPanelHtml`, `handlePanelMessage`, `PanelDeps`, `readConfig`, `apiBaseUrl`. Four sections: **Settings** (key save/clear), **Usage** (credit dashboard from `logic.ts`), **Presets** (preset dropdown with a "No preset loaded" default, fetched with the panel render; selecting a preset saves `{"preset":"<slug>"}` as the template, selecting the default clears it, and the dropdown re-syncs whenever the template is saved or cleared (the sync adds a `<slug> (not in list)` option when the saved slug is absent from the rendered list)), **Custom Request** (paste/save/clear). The Custom Request section renders an enforced-options footnote block (P8: `stream`, `session_id`, verbatim passthrough incl. `provider`, reasoning effort, messages/model/tools, usage chunk, key storage/base URL, P9 presets) as a numbered anchor list. `readConfig` reads global scope only and clamps/coerces every `openrouterCopilot.credit*` value. Message handling and rendering are unit-testable (no live webview needed).
- `src/provider.ts` — the `LanguageModelChatProvider`:
  - `provideLanguageModelChatInformation` — fetches `GET /models` with the user's key (via `fetchWithRetry`; a non-OK catalog response now surfaces a mapped error instead of `[]`, and a 200 with a non-JSON body surfaces a mapped error too), maps to `LanguageModelChatInformation` (family = slug prefix, version = slug, token caps from `context_length`), attaches a `detail`/`tooltip` rendered by `modelInfo.ts` (price info in the model picker), and a `configurationSchema` so reasoning models expose **VS Code's native Thinking Effort selector** in the picker (proposed `chatProvider` API, `enabledApiProposals` in `package.json`, vendored types in `typings/`). It also fetches presets (`GET /presets`, then `GET /presets/{slug}` for the designated `designated_version.config.model`, capped at 25 lookups, fetched with bounded concurrency after the active-status filter — inactive presets never consume the lookup budget, and the full active list stays visible in the panel dropdown regardless of the cap) and appends a picker entry `@preset/<slug>` (family `preset`) for each **model-pinned** preset within the lookup cap, with caps/capabilities/pricing resolved from the underlying catalog entry (assumed defaults when the model is absent from it); model-less presets get no picker entry. The presets sweep is **single-flight and background**: the picker gets the models immediately, and the sweep (shared by `getPresets()` via one in-flight promise) attaches `@preset/*` entries when it resolves, firing `onDidChangeLanguageModelChatInformation`; a warm preset cache from a panel render is reused, not re-fetched. A failed sweep leaves the preset cache **cold** (never cached as an empty list) so a later render or query retries it. The presets fetch is **best-effort**: any failure degrades to the models-only catalog. `getPresets()` fetches on first use (also on panel render) and caches; `getPresetConfig(slug)` resolves and caches the full designated config (shared with the list fetch) so the panel can prefill the textarea with the resolved preset configuration as full-line `//` comments above the JSON when a preset is selected. A pinned model that is not in the catalog under its exact slug (e.g. datestamped `z-ai/glm-5.3-flash-20260826`) resolves against the catalog by stripping a trailing datestamp (`-YYYYMMDD`, then a plausible `-MMDD`) so reasoning schema, caps, and pricing still load; truly unknown models get assumed defaults and no reasoning selector. `setTemplate` strips full-line `//` comments before validating, so commented text saves cleanly. Changing `openrouterCopilot.baseUrl` calls `resetCatalogCache()` so the picker re-fetches from the new host.
  - `provideLanguageModelChatResponse(model, messages, options, progress, token)` — builds the body via `buildRequestBody` (saved template spread over the live model/messages/tools, `stream: true`, per-window `session_id`, verbatim `provider` passthrough — no default `provider` is ever injected, preset reference or not, so preset routing survives; picker effort/enabled merged into the template's `reasoning`, with a picker effort of `none` sent as `reasoning.enabled: false` rather than `effort: "none"`; a preset-reference model id (`@preset/*` or combined `*@preset/*`) drops a template `preset` key so the picker entry is the only preset reference; `@preset/*` requests take the P6 `cache_control` decision from the preset's resolved underlying model), POSTs `/chat/completions` through `fetchWithRetry` (mid-stream and mid-read cancellation surfaces as `vscode.CancellationError`; retried responses have their bodies cancelled before backoff), parses SSE with a bounded line buffer, emits parts via `progress.report(...)`. Emits `LanguageModelThinkingPart` from `delta.reasoning` (fallback: flatten `delta.reasoning_details` via `flattenReasoningDetails`) plus text and tool-call parts. Throws mapped errors on HTTP statuses and mid-stream `data:{"error":…}` events (`mapResponseError`/`mapStreamedError`), appending the `X-Generation-Id` header. Tolerates and captures the automatic final `usage` chunk (`getLastStreamUsage`, reset per request). **Returns `Thenable<void>`; parts go through the progress callback, not a returned stream.**
  - `toOpenAI` — converts messages to OpenAI chat format and echoes prior `LanguageModelThinkingPart`s back as a `reasoning` (string) field on outgoing assistant messages (DeepSeek thinking-mode echo rule).
  - `provideTokenCount` — rough `chars/4` estimate (must be async per the current API).
  - `baseUrl()` — global-scope https-only (a workspace cannot redirect the key), strips a trailing `/chat/completions` and slashes, warns and falls back to the default otherwise (P4). Test seams: `setRetryDelayForTesting`, `getLastStreamUsage`.
- `src/modelInfo.ts` — pure model-card rendering for the picker tooltip (`buildModelInfo`): OpenRouter per-token pricing → per-1M display, blended $/M estimate from the agentic-usage equation (per answer token: 85 cache read · 6 cache write · 3 uncached · 5 thinking · 1 output; cache-write → input and ephemeral → cache-write → input fallbacks), context/max-output/capabilities/reasoning lines, plus `buildReasoningSchema` (navigation-grouped Thinking Effort schema) and `effortFromModelConfiguration`. Intentionally imports no `vscode`; unit-tested in `modelInfo.test.ts`.
- `src/storage.ts` — the **single shared key secret** (`openrouterApiKey`) with a 10 s bounded keychain read and one-time migration from the legacy `openrouterCopilot.apiKey` secret. Both the provider and the usage refresh read this one key.
- `src/logic.ts` — pure credit/usage derivation (`KeyInfo`, `coreView`, `buildDetail`, `buildStatus`, `maskKey`, reset math). Intentionally imports no `vscode`; unit-tested. Do not add `vscode`/network imports here.
- `src/test/` — mocha (tdd) suite: `runTest.ts` (fresh temp `--user-data-dir`, `ELECTRON_RUN_AS_NODE` guard, 10-minute timeout), `suite/index.ts`, and per-module suites (`logic`, `config`, `panel`, `extension`, `provider`). The extension and provider suites stub `globalThis.fetch` so they never hit the network or the real OS keychain (Windows SecretStorage is OS-global, not isolated by `--user-data-dir`); `provider.test.ts` also injects a no-op retry delay (`setRetryDelayForTesting`) and exercises the stream loop end-to-end with canned SSE bodies (reasoning parts, streamed errors, retries, usage chunk).

Settings (package.json `contributes.configuration`): one **"OpenRouter for Copilot"**
section — `openrouterCopilot.baseUrl` for the provider and the five
`openrouterCopilot.credit*` settings for the guardrail/usage dashboard. The request
template itself is pasted JSON stored via the provider's global state — it is
**not** exposed as a multi-field settings UI.

## Paste-apply semantics

- The pasted body's **`messages`/`prompt` fields are ignored** — Copilot supplies the live conversation and tools each turn; they are merged with the saved template (e.g. a pasted `system` message may be applied as a prefix).
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
- Per-window `session_id` (cache warmth + Activity grouping; no content).
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
- Attribution headers `HTTP-Referer`/`X-Title` hardcoded.
- https-only `baseUrl` (provider) and `creditBaseUrl`, both read from global scope only.
- Key in SecretStorage only, never settings.json.
- Template applies to every request until cleared (the picker's model switch back to a
  Copilot model is the per-turn escape).
- Usage accounting needs no field: every Chat Completions stream ends with an automatic
  `usage` chunk (P5) — nothing to paste or request.

## Canonical request templates (decided with the plan)

- Lab default: the empty template `{}` (paste nothing) — no default `provider` is added,
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

Verified: compiles (`tsc --strict`), full test suite passes (205 tests), packages to
a VSIX, API usage matches the installed `@types/vscode` 1.134 (engine `^1.134.0`) plus
the vendored proposal typings, and the runtime `LanguageModelThinkingPart` class exists
on the stable test host (VS Code 1.135) despite the proposed-API warning.

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
   template at all (P5: automatic chunk confirmed).
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

## Follow-ups (outside this repo)

- **Lab skill doc drift.** `lab-ai-service/references/provider-pinning.md` and
  `copilot-openrouter-notes.md` still describe this extension as `tsuda-lab-openrouter`
  with a "Tsuda Lab: Manage OpenRouter provider" command, an "OpenRouter (Tsuda Lab)"
  picker group, and a `tsudaLab.openrouter.providerOptions` setting — none of which match
  this repo. Sync the skill references to the actual identifiers (vendor
  `openrouter-copilot-request-credit`, display "OpenRouter: RC", command
  `openrouterCopilot.manage`, paste-apply template) before rollout, and point the skill's
  `vscode-extension/` folder at this repo so the two cannot diverge again.

## Scope boundary

- Organization-specific scope boundary (model/provider policy pointers, the
  lab-ai-service user guide) is local-only: see `AGENTS.lab.md` (gitignored)
  when present.
