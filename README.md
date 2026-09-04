# OpenRouter for Copilot with Custom Request & Credit Check

A VS Code extension that registers a **customizable OpenRouter provider** in Copilot Chat. Copilot's built-in OpenRouter provider cannot send OpenRouter's `provider` routing object or a `session_id` (microsoft/vscode#283201; microsoft/vscode-copilot-release#11420). This extension calls OpenRouter directly instead of through Copilot's CAPI proxy, so every Chat request can carry whatever request-body options you paste — and it tracks your key's credit usage while you work.

## What it does

- Adds an **"OpenRouter: RC"** group to the Copilot Chat model picker with the full OpenRouter catalog (nothing is model-restricted client-side).
- Lets you **paste a request body** from the [OpenRouter Request Builder](https://openrouter.ai/request-builder) into one panel; its settings — `provider` routing, sampling params, `response_format`, `plugins`, `transforms`, `cache_control`, etc. — apply verbatim to every request until you clear or replace it.
- **Presets**: pick a preset in the panel to send `"preset": "<slug>"` on every request; presets that pin a model also appear in the picker as `@preset/<slug>` entries (up to the first 25). Picker preset entries affect only turns on that entry.
- Reasoning models get VS Code's native **Thinking Effort** selector (or a simple on/off toggle); reasoning traces render in chat.
- Anthropic-family models (`anthropic/*`) automatically get a top-level `cache_control` (unless your pasted body sets its own).
- Model picker entries show estimated blended price per 1M tokens, context window, max output, and capabilities.
- Status bar shows **credit remaining**; the panel has a usage dashboard.

Always enforced (pasted copies are ignored): `model`, `messages`, and `tools` come from Copilot; `stream: true`; the extension's own per-session `session_id` (keeps the prompt cache warm).

## The panel

One webview, **"OpenRouter for Copilot"**, with four sections: **Settings** (save/clear the API key), **Usage** (credit dashboard), **Presets** (dropdown), and **Custom Request** (paste/save/clear). Open it from the status bar item (**OR …**) or the "OpenRouter: Manage provider" command.

## Install (from VSIX)

1. Build: `npm install && npm run package` → `openrouter-copilot-request-credit-<version>.vsix`.
2. VS Code → Extensions → "…" → **Install from VSIX…** → select the file.
3. Open the panel and paste your OpenRouter key (kept in your OS keychain).
4. In Chat, pick a model from the **OpenRouter: RC** group and use it like any Copilot model.

## Usage

1. Build a request at [openrouter.ai/request-builder](https://openrouter.ai/request-builder) and copy the JSON body.
2. Paste it into **Custom Request**, then **Save** (validated; errors are reported).
3. Every subsequent Copilot Chat request follows it until you clear or replace it.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `openrouterCopilot.baseUrl` | `https://openrouter.ai/api/v1` | API base URL used by the Chat provider (https-only). |
| `openrouterCopilot.creditLimit` | `0` | Local cap in USD (`0` disables it and shows the account-wide balance). |
| `openrouterCopilot.creditResetPeriod` | `daily` | Guardrail reset cadence: `daily` / `weekly` / `monthly` / `never`. |
| `openrouterCopilot.creditIncludeByok` | `true` | Count BYOK spend toward the guardrail. |
| `openrouterCopilot.creditRefreshIntervalMinutes` | `5` | Usage refresh interval (1–1440 minutes). |
| `openrouterCopilot.creditBaseUrl` | `https://openrouter.ai` | Base URL for the credit/usage check (advanced). |

All six are application-scoped: a workspace cannot redirect your key to another host or weaken the guardrail.

## Notes

- Chat and agent mode (tool calls) are supported; inline completions are not (same as BYOK).
- The key only leaves your machine in the Authorization header to OpenRouter.
- The local `limit` is a display helper; OpenRouter's server-side guardrail enforces the real cap.
