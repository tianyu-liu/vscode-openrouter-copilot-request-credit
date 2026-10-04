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
the chat's turns in one session (see [Session identity](docs/agent/session-identity.md));
- **tools** (agent mode) and **image input** for vision models;
- **thinking traces** — `delta.reasoning` is reported as `LanguageModelThinkingPart` and
  prior turns' reasoning is echoed back on assistant messages (DeepSeek thinking-mode
  requirement; see [Reasoning passthrough](docs/agent/request-pipeline.md)).

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
  `openrouterCopilot.*`, config namespace `openrouterCopilot.*` (the four credit
  settings folded in as `openrouterCopilot.credit*`; nine `openrouterCopilot.*`
  settings in total). The key secret
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
npm run preview      # compile + serve the control panel at http://127.0.0.1:8765 for browser UI review
npm run preview:serve # serve only (pair with `npm run watch`); live-reloads on rebuild
npm run package      # vsce package → openrouter-copilot-request-credit-<ver>.vsix (no marketplace publish; install from VSIX)
```

No lint setup exists for this TypeScript project; `tsc --strict` is the gate.
Run `npm run compile` (and `npm test` when behavior changed) before committing.

**Panel preview (dev UI).** `scripts/panel-preview.mjs` (excluded from the VSIX) renders the panel
and the picker's model cards in a normal browser, so their markup/styles can be debugged, reviewed,
and iterated on **without installing the VSIX or reloading the VS Code extension host**. It stubs
the `vscode` module with a recursive proxy so `out/panel.js` can be `require`d in plain Node, strips
the webview CSP, injects a `--vscode-*` theme shim and an `acquireVsCodeApi` stub (so tabs and
controls work), and serves a fixed representative fixture set. `GET /` renders `renderPanelHtml`
(all three tabs); `GET /model-info` renders `buildModelInfo` for a representative catalog as the
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
this extension's id, one JSON object holding `sessionCosts` / `parentSession` / `requestTemplate` /
`contextCaps`. VS Code holds a lock on that database, so copy the file first and open the
copy read-only (Node's built-in `node:sqlite` `DatabaseSync` is enough).

## Architecture

- `src/extension.ts` — activation: registers the `openrouter-copilot-request-credit` provider, the credit status bar and refresh lifecycle, the unified webview panel, the config-change listener and the auto-refresh timer. Details: [architecture.md](docs/agent/architecture.md).
- `src/panel.ts` — the single webview control panel (Key Info / Session Spend / Configurations). Details: [architecture.md](docs/agent/architecture.md).
- `src/provider.ts` — the `LanguageModelChatProvider`: catalog/picker, request building and streaming, usage, session spend, attribution. Details: [Provider internals](docs/agent/provider.md).
- `src/modelInfo.ts` — pure model-card/tooltip rendering, reasoning and context-cap picker schemas, context-budget math. Details: [Context window sizing](docs/agent/context-window.md) and [architecture.md](docs/agent/architecture.md).
- `src/storage.ts` — the single shared key secret; `src/logic.ts` — pure credit/cost math; `src/test/` — mocha integration suite. Details: [architecture.md](docs/agent/architecture.md).

## Detailed docs

- [Provider internals](docs/agent/provider.md) — catalog/picker, request build and streaming, P10 usage, P12/P12b/P13/P13b/P14 spend, P15 `session_id`, P17/P18, API contract, test seams. Read before changing request/response behavior.
- [Session identity](docs/agent/session-identity.md) — P11 across reloads plus the utility flows. Read before touching `session_id` or attribution.
- [Context window sizing](docs/agent/context-window.md) — P16 reserve/budget math, the Context size picker menu, and compaction.
- [Request pipeline](docs/agent/request-pipeline.md) — paste-apply semantics, enforced behaviors, canonical templates.
- [Harness boundary](docs/agent/harness-boundary.md) — the single funnel and agent-host BYOK visibility; full evidence in [docs/copilot-harness-modes.md](docs/copilot-harness-modes.md).
- [Verification status](docs/agent/verification.md) — what is verified, the closed live pilot, residual gaps.
- [Upstream limitations](docs/agent/upstream-limitations.md) — no-client-side-fix issues for the README.

## Conventions

- **No redundant comments**; keep explanatory doc comments where they document
  non-obvious contracts (`logic.ts` keeps its ported comments).
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
- Before changing VS Code API usage, check `node_modules/@types/vscode/index.d.ts` and the API contract in [Provider internals](docs/agent/provider.md) (the running host is usually newer; runtime-only capabilities are probed defensively).
