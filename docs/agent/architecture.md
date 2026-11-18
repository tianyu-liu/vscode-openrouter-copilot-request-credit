# Architecture

Module map for everything outside the language-model provider.

Provider internals (catalog, request pipeline, usage, session spend) are in [provider.md](provider.md).

The status bar prefixes every state with a contributed OpenRouter glyph. The bundled color font
preserves the official Ink/Cloud colors; light/dark and high-contrast theme changes swap glyphs without
refreshing account data. `buildStatus` returns the balance text without branding; `extension.ts` adds
the icon and a plain-text accessibility label. See [asset provenance and usage terms](../../THIRD_PARTY_NOTICES.md)
and [font generator](../../scripts/build-status-icons.py).

- [extension.ts](../../src/extension.ts) — activation registers one `ConnectionChatProvider` under
  `openrouter-copilot-request-credit`, matching the contributed vendor. It owns panel selection,
  per-connection credit state and stale-refresh checks, shared settings/timer, status bar, and commands.
  `openrouterCopilot.manage` and `openrouterCopilot.pasteTemplate` open the panel;
  `openrouterCopilot.clearTemplate` clears the selected connection's request. The status bar opens the
  panel through runtime-only `openrouterCopilot.show`. It lists enabled and opted-in direct key budgets
  in registry order, with the connection names in the tooltip. Theme changes update the icon without
  another account fetch. Credit refresh is single-flight per connection; a superseding refresh aborts
  that connection's older run. Session spend updates are event-driven through connection-tagged `onTurnCost`.
- [connections.ts](../../src/connections.ts) — `ConnectionRegistry` stores named definitions in
  `connectionRegistry.v1`. IDs are permanent (`default-openrouter` for the migrated connection; UUIDs
  for new ones), independent of names. Definitions include kind, normalized base URL, enabled state,
  revision, connection settings, and legacy manual models. Names are
  nonempty and unique ignoring case; snapshots are cloned. Definitions and credential commits advance revisions and emit changes;
  scoped state updates do neither. Mutations use a serial queue that remains usable after rejection.
- [connectionProvider.ts](../../src/connectionProvider.ts) — the registered router resolves discovery
  only from the native group's `configuration.connectionId`. It maintains one child provider per current
  connection revision, rejects disabled/deleted/stale model handles, and wraps upstream IDs with stable
  connection identity. See [provider.md](provider.md).
- [nativeGroups.ts](../../src/nativeGroups.ts) — the initial default group uses
  `lm.addLanguageModelsProviderGroup`. An existing same-name group requires explicit reconciliation when
  the user opens management. Explicit panel add/rename/remove actions open the **active UI client's**
  `chatLanguageModels.json` using `workbench.action.openLanguageModelsJson`; remote extension-host paths
  are never guessed. JSONC edits retain unrelated entries, comments, native model preferences, and
  connection IDs. Dirty documents, duplicate properties/groups, concurrent document changes, failed
  edits, and failed saves produce an error. The contributed `managementCommand` opens the panel and
  the contribution requires `configuration.connectionId`. A failed native add removes its new registry
  connection. Renames update the native group before committing registry metadata and credentials;
  a failed registry save restores the old native name. A failed native rename leaves the registry and
  credentials untouched. Renaming can retire native model selections/pins, so the UI asks users to
  select the model again.
- [panel.ts](../../src/panel.ts) — one webview with **Settings** and one tab per named connection.
  Settings manages direct OpenRouter connection names, enabled state, deletion, and credentials,
  with one **Save connection** action for the group form. Blank key inputs retain the existing secret;
  **Clear key** is a separate immediate action. Saved masks appear as grey placeholders, never field
  values, and raw keys stay outside webview draft state. Keyless saves are allowed.
  Nonsecret connection edits survive key-clear refreshes when saved metadata is unchanged; Cancel or
  a changed saved definition discards those drafts.
  Settings also holds the shared refresh interval, status-bar budget display mode, prompt safeguard, and output reserve.
  A named OpenRouter tab shows key credit details, the status-bar visibility option, the model availability filter,
  session spend, presets, and custom request JSON. Output reserve uses a target percentage and
  lower/upper limits in decimal K (1 K = 1000 tokens). Per-model context-size choices remain in the
  model picker. Drafts and asynchronous panel messages are scoped by connection ID; stale renders are
  discarded. Selecting a panel tab changes the connection being edited. Copilot's model group
  controls inference routing. `renderPanelHtml`, `handlePanelMessage`, and injected `PanelDeps` remain
  testable without a live webview. `readConfig` reads/validates application/global settings only.

- [modelInfo.ts](../../src/modelInfo.ts) — pure model-card rendering for the picker tooltip (`buildModelInfo`): OpenRouter per-token pricing → per-1M display; a **plain GFM pricing table** (no heading), whose first column is `%` (the agentic-usage mix `3 uncached : 6 cache write : 85 cache read : 5 thinking : 1 output`, cache-write → input fallback), then `Type` (one row per component: uncached/cache write/cache read/thinking/output), then one column per pricing segment (`$Mtok` when flat, `≤ <bound>` / `> <bound>` when tiered), closed by a bold weighted `**Blended**` row (ratio `100`, per-column blended `~$X.XXX`); plain info lines
`Context window:` / `Effective prompt cap:` / `Effective completion cap:` / `Max completion:`, followed by one capability line each (`Tools: \u2713`, `Image: input \u2713 / output \u2717`, likewise video and audio — `architecture.output_modalities` included); and a reasoning line (`None/Low/**Medium**/High` with the default bolded, `(required)` appended when mandatory) — plus `buildReasoningSchema` (navigation-grouped Thinking Effort schema; it honors `default_enabled: false` by pre-selecting the off choice wherever one exists, and never offers `none` when `mandatory`), `effortFromModelConfiguration`, and the stepped-model **Context size** picker schema (`contextCapOptions`/`contextCapSelection`/`contextCapFromPicker`/`buildContextCapSchema`/`defaultContextCap`/`formatSize`/`sizeAdvisory`: one entry per step plus the whole window as **prompt budgets**, `sizeAdvisory` giving `<64K` a stop sign and `≤128K` a warning, `defaultContextCap` picking the step closest to 256K at or above a 196K floor; offered only for a model with a price step). Intentionally imports no `vscode`; unit-tested in `modelInfo.test.ts`.
- [storage.ts](../../src/storage.ts) — bounded legacy-compatible key helpers and test override resolution.
  Production inference and credit refresh read the registry's selected connection credential. The registry's
  SecretStorage facade maps the primary alias to its own slot and makes old-alias cleanup harmless.
- [logic.ts](../../src/logic.ts) — pure credit/usage derivation (`KeyInfo`, `coreView`, `buildDetail`, `buildStatus`, `maskKey`, reset math). Intentionally imports no `vscode`; unit-tested. Do not add `vscode`/network imports here.
- [src/test/](../../src/test/) — mocha (tdd) suite: `runTest.ts` (fresh temp `--user-data-dir`, `ELECTRON_RUN_AS_NODE` guard, 10-minute timeout), `suite/index.ts`, and per-module suites (`logic`, `config`, `modelInfo`, `panel`, `extension`, `provider`, `connections`,
`connectionProvider`, `nativeGroups`). The extension and provider suites stub `globalThis.fetch` so they never hit the network or the real OS keychain (Windows SecretStorage is OS-global, not isolated by `--user-data-dir`); `provider.test.ts` also injects a no-op retry delay (`setRetryDelayForTesting`) and exercises the stream loop end-to-end with canned SSE bodies (reasoning parts, streamed errors, retries, usage chunk — including a `choices: []` usage-only chunk — and the forwarded `usage` data part), plus unit cases for `buildUsagePart` and `sessionIdFor`.

## Storage and migration

Each connection owns state under `connections.<id>.*`, including `requestTemplate`, `contextCaps`,
`sessionCosts`, and `parentSession`. Rename leaves these keys intact. Deleted connection wrappers reject
writes and credential reads; state snapshots become empty so stale callbacks cannot revive removed data.

Credentials live only in SecretStorage. A rotation records a unique staging slot before storing the key,
then atomically commits its slot reference and revision in the registry record. The previous slot is
removed afterward. Interrupted staging/cleanup is tracked and retried; a failed pre-commit rotation
keeps the old active credential. Direct OpenRouter URLs are fixed to `https://openrouter.ai/api/v1`.
[connectionCredentials.ts](../../src/connectionCredentials.ts) rejects the case-insensitive `sk-or-`
prefix on every non-direct connection.
Both storage mutations and outgoing provider credential acquisition enforce it. Existing
blocked secrets remain readable for masking and explicit clearing, but cannot be sent to a proxy.
Proxy URLs require HTTPS except loopback HTTP (`localhost`, `127.0.0.1`, `::1`), reject embedded
credentials/query/fragments, and allow API paths such as `/v1`. API type is editable; converting to
Direct OpenRouter fixes the base URL; conversion to OpenRouter proxy drops inherited manual models.
Clear a saved credential before changing its endpoint, or explicitly replace it in the same save.

First initialization copies the existing primary `openrouterApiKey` (or old `openrouterCopilot.apiKey`)
and `requestTemplate`, `contextCaps`, `contextCapsBase`, `contextMarginPercent`, `sessionCosts`, and
`parentSession` into **OpenRouter: RC**, ID `default-openrouter`. It also copies the four old connection
settings. Secret read failures abort migration. Original data is preserved until the registry commit;
post-commit cleanup is retryable. The default exists even without a key, and an intentionally empty
registry never recreates it. New connections never inherit a legacy key, template, or history.
New connection names default to **OpenRouter: RC1**, **OpenRouter: RC2**, and so on, using the first
available name (case-insensitive). Users can edit these names before saving.

## Settings

The nine contributed application settings remain for compatibility. Five are shared:
`creditRefreshIntervalMinutes`, `sanitizeBase64Content`, `outputReservePercent` (default 12.5, range
1–50), `outputReserveMinTokens` (default 16384), and `outputReserveMaxTokens` (default 262144).
They have controls in **Settings**. The four former global connection settings (`creditLimit`,
`creditResetPeriod`, `creditIncludeByok`, `hideUnavailableModels`) are deprecated migration inputs;
after migration the panel edits their equivalents in the selected connection definition.

Request templates live in connection state and remain paste-apply JSON. The released extension exposes
only `openrouter` connections. The registry retains `gateway` and `openai-compatible` records and their
credentials, history, and obsolete fields. Production panel mutations, credit refreshes, native discovery,
and model requests accept direct connection IDs only. Internal tests still exercise the proxy transport.

Test seams remain in their modules: `refresh`, `doRefresh`, `getStatusText`, `createPanelDeps`,
`stopRefreshTimerForTesting`, and `readConfig` cover refresh/panel compatibility; fake Memento and
SecretStorage exercise registry failures without using the OS keychain. Native group tests inject a
`NativeGroupHost`; the executable grouping prototype is separate from the production registry.
