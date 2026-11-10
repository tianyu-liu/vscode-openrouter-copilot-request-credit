# AGENTS.md — instructions for AI assistants working on this extension

> This file is for AI coding assistants (Kilo, Claude Code, Cursor, Cline,
> Continue.dev, Aider, etc.) working in this repository. It is **not** for
> human readers; see `README.md` for that.
>
> This file is synced/shared, so it intentionally contains **no**
> organization-specific content.

## What this is

A small **VS Code extension** that registers the **"OpenRouter: RC"** provider vendor in
**Copilot Chat**, with a native model group for each named connection. The two supported modes are
**Direct OpenRouter** and **OpenRouter proxy**: direct access or a proxy managing OpenRouter access.
The package/vendor identifiers stay unchanged; connection names and permanent internal IDs are separate.

Direct OpenRouter requests bypass Copilot's CAPI proxy so the extension can send OpenRouter's
`provider` routing object, `session_id`, and other request-body options. Credit tracking from the retired
`tianyu-liu.openrouter-key-credit-check` extension remains fully merged and is scoped to each direct
OpenRouter connection.

**Core flow (paste-apply):** add a connection and an optional credential in **Settings**, then use the named connection
tab to paste request JSON, inspect usage, and configure its request. For OpenRouter, build the JSON at
the [OpenRouter Request Builder](https://openrouter.ai/request-builder). Shared Settings holds the
refresh interval, prompt safeguard, and output reserve. The selected panel connection controls editing
and the status bar; the model selected in Copilot determines request routing.

The shared transport supports tools, image input, SSE streaming, cancellation, and thinking traces.
Both supported modes send OpenRouter session, reasoning, and cache fields. Only direct connections
expose OpenRouter account credits and presets. Proxies use their authoritative server catalog, with
no manual model additions or unrestricted fallback. Proxy usage consists only of local token and
returned-cost tracking; no custom proxy balance, budget, or allowance API is called.
All non-direct connections reject OpenRouter key syntax (`/^sk-or-/i` after trimming) during form/save
validation and before network use; use a proxy token or no key. See [Request pipeline](docs/agent/request-pipeline.md).

**Model choice is intentionally open:** direct connections expose the full OpenRouter catalog with an
optional account-availability filter; proxies expose the server's permitted models. The extension
adds no model allowlist. Internal `gateway` identifies the proxy adapter. Older `openai-compatible`
records remain a migration detail: they retain their prior runtime behavior until explicitly saved
as a proxy, preserving ID, credentials, and state while removing manual models. They are not a third
supported mode.

## Repo naming and origin

- Repository (kept): `tianyu-liu/vscode-openrouter-copilot-request-credit` — the GitHub
  name may stay different from the extension id. Display names:
  **"OpenRouter for Copilot with Custom Request & Credit Check"** (extension) and
  **"OpenRouter: RC"** (model picker).
- Machine identifiers (renamed in the pre-pilot pass, no users yet): package name /
  provider vendor id `openrouter-copilot-request-credit`, command ids
  `openrouterCopilot.*`, config namespace `openrouterCopilot.*` (the four credit
  settings folded in as `openrouterCopilot.credit*`; nine `openrouterCopilot.*`
  settings retained). Four former global connection settings are now deprecated migration inputs;
  the panel edits their per-connection equivalents. Migration moves the old `openrouterApiKey` into
  an isolated SecretStorage slot.
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
npm run preview      # compile + serve the control panel at http://127.0.0.1:8765 for browser UI review
npm run preview:serve # serve only (pair with `npm run watch`); live-reloads on rebuild
npm run package      # vsce package → openrouter-copilot-request-credit-<ver>.vsix (no marketplace publish; install from VSIX)
```

No lint setup exists for this TypeScript project; `tsc --strict` is the gate.
Run `npm run compile` (and `npm test` when behavior changed) before committing.

VS Code compatibility is an open-ended minimum in `engines.vscode`, not a pin to the current client.
Keep API types on a compatible dependency range; the lockfile records the resolved build dependency.
The integration runner uses the latest stable VS Code by default. Describe runtime capabilities in
plans/docs and verify them on the installed client instead of assuming a particular release number.

**Panel preview (dev UI).** `scripts/panel-preview.mjs` (excluded from the VSIX) renders the panel
and the picker's model cards in a normal browser, so their markup/styles can be debugged, reviewed,
and iterated on **without installing the VSIX or reloading the VS Code extension host**. It stubs
the `vscode` module with a recursive proxy so `out/panel.js` can be `require`d in plain Node, strips
the webview CSP, injects a `--vscode-*` theme shim and an `acquireVsCodeApi` stub (so tabs and
controls work), and serves a fixed representative fixture set. `GET /` renders `renderPanelHtml`
(Settings and representative named connection tabs); `GET /model-info` renders `buildModelInfo` for a representative catalog as the
picker tooltip and detail line. The server re-reads `out/*.js` on every request and the page polls
`/__mtime`, so after `tsc` (or `npm run watch`) a browser refresh shows the new build. Override the
port with `PANEL_PREVIEW_PORT` or an argument, and edit `buildFixtures()` / `buildModelFixtures()`
in the script to change the sample data.

**Request-dump debug hook.** Setting `OPENROUTER_RC_DEBUG=1` makes `dumpRequestBody` append every
outgoing `/chat/completions` body as one JSONL line to `<workspaceFolder ?? cwd>/tmp/openrouter-requests.jsonl`
(the write is inside a swallowing `try/catch`, so a bad path never fails a turn). It runs on the real
request path, immediately before each POST and after the base64 safeguard pass, so the recorded body is
what goes on the wire; a guardrail retry attempt is dumped as its own line. The file holds verbatim
prompt and tool content — `tmp/` is gitignored, never commit it, and it works under `npm test` too
(cwd fallback), which is how the request-shape claims in this file can be re-verified on the wire rather
than by reading code.

Two things to know before concluding anything from a missing dump line: the variable is **window
scoped**, so a dev host started from a launch config that does not set it writes **nothing at all**
(ask which launch config/window the run used before suspecting the extension), and a line is written
**before** the POST, so a failed request still leaves one. When no dump is available, the same facts
can be read from the extension's persisted ledger — `globalStorage/state.vscdb`, `ItemTable`, key =
this extension's id, one JSON object holding `connectionRegistry.v1` and per-connection state under
`connections.<id>.*` (`sessionCosts`, `parentSession`, `requestTemplate`, `contextCaps`). The registry
contains credential slot references, never raw keys. VS Code holds a lock on that database, so copy
the file first and open the copy read-only (Node's built-in `node:sqlite` `DatabaseSync` is enough).

## Architecture

- [extension.ts](src/extension.ts) — activation, the registry/router registration, per-connection credit refresh, status bar,
  panel selection, native group lifecycle, commands, and shared-setting listeners.
- [connections.ts](src/connections.ts) — connection definitions, validation, isolated state/credentials, recoverable migration,
  and mutation revisions. Details: [architecture.md](docs/agent/architecture.md).
- [connectionCredentials.ts](src/connectionCredentials.ts) — shared OpenRouter-key syntax rejection for proxy form,
  storage, and request boundaries.
- [connectionProvider.ts](src/connectionProvider.ts) — the registered `LanguageModelChatProvider`; dispatches native groups by
  connection ID, scopes model IDs, and rejects stale model revisions.
- [nativeGroups.ts](src/nativeGroups.ts) — explicit native group add/rename/remove and initial migration through the active
  client's profile. Details: [architecture.md](docs/agent/architecture.md).
- [panel.ts](src/panel.ts) — the single webview with shared **Settings** and one tab per named connection.
- [provider.ts](src/provider.ts) — per-connection child provider: discovery, request building/streaming, caches,
  usage, spend ledger, and parent attribution. Details: [Provider internals](docs/agent/provider.md).
- [modelInfo.ts](src/modelInfo.ts) — pure model-card/tooltip rendering, reasoning and context-cap picker schemas, context-budget math. Details: [Context window sizing](docs/agent/context-window.md) and [architecture.md](docs/agent/architecture.md).
- [storage.ts](src/storage.ts) — bounded legacy-compatible key helpers; production uses the registry's isolated
  SecretStorage facade. [logic.ts](src/logic.ts) — pure credit/cost math; [src/test/](src/test/) — mocha integration suite.
  Details: [architecture.md](docs/agent/architecture.md).

## Detailed docs

- [Provider internals](docs/agent/provider.md) — catalog/picker, request build and streaming, P10 usage, P12/P12b/P13/P13b/P14 spend, P15 `session_id`, P17/P18, API contract, test seams. Read before changing request/response behavior.
- [Session identity](docs/agent/session-identity.md) — P11 across reloads plus the utility flows. Read before touching `session_id` or attribution.
- [Context window sizing](docs/agent/context-window.md) — P16 reserve/budget math, the Context size picker menu, and compaction.
- [Request pipeline](docs/agent/request-pipeline.md) — paste-apply semantics, enforced behaviors, canonical templates.
- [Harness boundary](docs/agent/harness-boundary.md) — the single funnel and agent-host BYOK visibility; full evidence in [docs/copilot-harness-modes.md](docs/copilot-harness-modes.md).
- [Verification status](docs/agent/verification.md) — what is verified, the closed live pilot, residual gaps.
- [Next harness handoff](docs/agent/next-harness-handoff.md) — current implementation, evidence boundaries, and prioritized probes.
- [Upstream limitations](docs/agent/upstream-limitations.md) — no-client-side-fix issues for the README.

## Conventions

- **No redundant comments**; keep explanatory doc comments where they document
  non-obvious contracts (`logic.ts` keeps its ported comments).
- TypeScript strict (`tsconfig.json`), PEP-8-style clarity, 120-char lines.
- Keep the human-facing `README.md` plain and short; it doubles as the hand-out
  ("install from VSIX, open the panel, paste key and template").
- Commit `package-lock.json`; never commit `node_modules/`, `out/`, `.vscode-test/`,
  or `*.vsix` (already gitignored).
- **Never commit secrets.** Keys live in VS Code SecretStorage, one isolated credential per connection;
  there is no key material in repository files or settings.
- Commit and push are the user's call in this repo.
- Tests must never hit the network or the real keychain (see `extension.test.ts`
  fetch stub). Keep `logic.ts` free of `vscode` imports.
- Before changing VS Code API usage, check `node_modules/@types/vscode/index.d.ts` and the API contract in [Provider internals](docs/agent/provider.md) (the running host is usually newer; runtime-only capabilities are probed defensively).
