# OpenRouter for Copilot with Custom Request & Credit Check

A small VS Code extension that registers a **customizable OpenRouter provider** in Copilot Chat. Copilot's built-in OpenRouter provider cannot send OpenRouter's `provider` routing object or a `session_id` (microsoft/vscode#283201; feature request microsoft/vscode-copilot-release#11420 still open). This extension makes its own HTTP calls to OpenRouter instead of going through Copilot's CAPI proxy, so every Copilot Chat request can carry whatever request-body options you want — and it tracks your key's credit usage while you work.

## What it does

- Adds a provider group **"OpenRouter: RC"** to the Copilot Chat model picker.
- Exposes **any OpenRouter model** (the full catalog) — nothing is model-restricted.
- Lets you **paste a request body** from the [OpenRouter Request Builder](https://openrouter.ai/request-builder) (or any Chat Completions JSON) into one control panel. The extension parses it and applies those settings — `provider` routing (including a quantization floor), `temperature`/`top_p`/other sampling params, `response_format`, `plugins`, `transforms`, `cache_control`, `session_id`, etc. — to every request to OpenRouter.
- Sends a stable per-session `session_id` so OpenRouter keeps the prompt cache warm;and Anthropic-family models (`anthropic/*`) automatically get a top-level `cache_control` so their explicit prompt caching engages (unless your pasted body sets its own `cache_control`).
- Shows **credit remaining** for the key in the status bar (auto / manual / unlimited modes), with a usage dashboard in the same panel.
- Shows **price info in the model picker**: selecting a model lists its estimated blended price per 1M tokens (primary, at the top, always 3 decimal digits) — computed from OpenRouter's live per-class pricing with the fixed token mix **85 cache read · 6 cache write · 3 uncached · 5 thinking · 1 output per answer token** — then the uncached/cache-write/cache-read/thinking/output breakdown (each 3 decimal digits), context window, max output, capabilities, and reasoning mode.
- Reasoning models get a **reasoning control in the model picker** (proposed `chatProvider` API via `--enable-proposed-api`): models that expose effort selection show VS Code's native **Thinking Effort** selector (`supported_efforts` verbatim, or the full None–Max set at OpenRouter's default `medium` when `supported_efforts` is `null`; `None` is dropped for mandatory reasoning); models without effort selection (e.g. `qwen/qwen3.8-flash`) show a simple **Reasoning on/off** toggle. The choice is forwarded to OpenRouter as `reasoning.effort` / `reasoning.enabled` on every request.
- Uses **your OpenRouter key**, stored in VS Code SecretStorage (OS keychain).

## The panel

One webview, **"OpenRouter for Copilot"**, covers all interaction:

- **Settings** — save/clear the API key.
- **Usage** — remaining credit, limit and reset period (daily/weekly/monthly/never), usage table (OpenRouter vs BYOK vs sum), refresh interval.
- **Custom Request** — paste the Request Builder JSON, save, clear.

Open it from the status bar item (click **OR …** in the bottom-right), or via **"OpenRouter: Manage provider"** / **"OpenRouter: Paste custom request"** in the Command Palette.

## Install (from VSIX)

1. Build: `npm install && npm run package` — produces `openrouter-copilot-request-credit-0.1.0.vsix`.
2. VS Code → Extensions → "…" → **Install from VSIX…** → select the file.
3. Open the panel and paste your OpenRouter key (kept in your OS keychain).
4. Open Chat, pick a model from the **OpenRouter: RC** group, and use it exactly like Copilot's built-in models.

## Usage

1. Build your request at [openrouter.ai/request-builder](https://openrouter.ai/request-builder) (select a model, set parameters and provider preferences).
2. Copy the generated JSON request body.
3. Open the panel and paste it into the **Custom Request** textarea, then **Save**. The extension validates it and reports any error.
4. Every subsequent Copilot Chat request to OpenRouter follows the pasted settings until you clear or replace the custom request.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `openrouterCopilot.baseUrl` | `https://openrouter.ai/api/v1` | OpenRouter API base URL used by the Chat provider. |
| `openrouterCopilot.creditLimit` | `0` | Local cap in USD for the guardrail (`0` disables it and shows the account-wide balance). |
| `openrouterCopilot.creditResetPeriod` | `daily` | Guardrail reset cadence: `daily` / `weekly` / `monthly` / `never`. |
| `openrouterCopilot.creditIncludeByok` | `true` | Count bring-your-own-key (BYOK) spend toward the guardrail. |
| `openrouterCopilot.creditRefreshIntervalMinutes` | `5` | Usage refresh interval (clamped to 1–1440 minutes). |
| `openrouterCopilot.creditBaseUrl` | `https://openrouter.ai` | OpenRouter base URL for the credit/usage check (advanced). |

The five `openrouterCopilot.credit*` settings are application-scoped: workspace `.vscode/settings.json` overrides are ignored, so a project cannot disable the guardrail, inflate it, or redirect the stored key.

## Notes

- Chat and agent mode (tool calls) are supported; inline completions are not (same as BYOK).
- The key never leaves your machine except in the Authorization header to OpenRouter, like any other BYOK provider.
- The local `limit` is a display/alert helper; OpenRouter's server-side guardrail still enforces the real spending cap.
