# OpenRouter for Copilot with Custom Request & Credit Check

A VS Code extension that registers a **customizable OpenRouter provider** in Copilot Chat. Copilot's built-in OpenRouter provider cannot send OpenRouter's `provider` routing object or a `session_id` (microsoft/vscode#283201; microsoft/vscode-copilot-release#11420). This extension calls OpenRouter directly instead of through Copilot's CAPI proxy, so every Chat request can carry whatever request-body options you paste — and it tracks your key's credit usage while you work.

## What it does

- Adds an **"OpenRouter: RC"** group to the Copilot Chat model picker with the full OpenRouter catalog (nothing is model-restricted client-side).
- Lets you **paste a request body** from the [OpenRouter Request Builder](https://openrouter.ai/request-builder) into one panel; its settings — `provider` routing, sampling params, `response_format`, `plugins`, `transforms`, `cache_control`, etc. — apply verbatim to every request until you clear or replace it.
- **Presets**: pick a preset from your OpenRouter account in the panel and its routing applies to every request; a preset that pins a model is also offered as an `@preset/<slug>` picker entry.
- Reasoning models get VS Code's native **Thinking Effort** selector (or a simple on/off toggle); reasoning traces render in chat.
- Anthropic-family models (`anthropic/*`) automatically get a top-level `cache_control` (unless your pasted body sets its own).
- Model picker entries show estimated blended price per 1M tokens, context window, max output, and capabilities — and, where OpenRouter charges more above a long-context threshold (e.g. OpenAI GPT above 272K tokens), the base vs stepped price and the input cap that keeps you in the cheaper tier.
- **Context limits**: Auto caps tiered models at the surcharge threshold; Full uses the model input budget; per-model Custom caps can be set for any tiered model. The safety margin scales numeric Custom caps only, across all models.
- **Used context size in Copilot Chat**: every turn forwards OpenRouter's own `usage` chunk (prompt/completion tokens, cache reads) to Copilot, so the context-usage ring shows *used / max tokens*.
- **Session spend in the panel**: a **Session spend** section accumulates what each chat session has cost in this window, with a collapsible per-session breakdown by provider and model (see below). Nothing is added to the chat transcript.
- **One OpenRouter session per Copilot chat session**: the `session_id` is the chat's own persisted id, so turns stay grouped in one OpenRouter session (sticky routing + the Logs → Sessions view) even after a window reload or a full VS Code restart. A new chat is a new OpenRouter session. Background/internal calls (sub-agents, and Copilot's own utility flows) join the chat that triggered them; when there is no such chat, no `session_id` is sent, so no stray session is created.
- Status bar shows **credit remaining**; the panel has a usage dashboard.

Always enforced (pasted copies are ignored): `model`, `messages`, and `tools` come from Copilot; `stream: true`; the extension's own per-session `session_id` (keeps the prompt cache warm).

## The panel

One webview, **"OpenRouter for Copilot"**, with four tabs: **Key Info**, **Session Spend**, **Request**, and **Context**. Open it from the status bar item (**OR …**) or the "OpenRouter: Manage provider" command. The Context tab lists every model with a price step and an **Auto / Full / Custom** control; the safety margin applies only to numeric Custom caps.

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
| --- | --- | --- |
| `openrouterCopilot.creditLimit` | `0` | Local cap in USD (`0` disables it and shows the account-wide balance). |
| `openrouterCopilot.creditResetPeriod` | `daily` | Guardrail reset cadence: `daily` / `weekly` / `monthly` / `never`. |
| `openrouterCopilot.creditIncludeByok` | `true` | Count BYOK spend toward the guardrail. |
| `openrouterCopilot.creditRefreshIntervalMinutes` | `5` | Usage refresh interval (1–1440 minutes). |
| `openrouterCopilot.contextWindowPolicy` | `auto` | `auto` caps tiered models at the long-context surcharge threshold; `full` uses the entire model input budget. |
| `openrouterCopilot.contextSafetyMarginPercent` | `0` | Changing this percentage rescales every saved numeric Custom cap in place across all models (0–50%). Auto and Full selections are unchanged. |
| `openrouterCopilot.sanitizeBase64Content` | `true` | Strip long base64-like runs from prompt text (never image attachments) so an org guardrail does not block the request. |

All seven settings are application-scoped: workspace settings cannot change these provider, usage, or context preferences. Provider and credit requests use the fixed OpenRouter API endpoint.

## Session spend, in the panel

The panel's **Session spend** section shows what each Copilot chat session has cost (persisted across reloads and restarts). Each session is one collapsible row; expanding it shows a `Cost | Provider | Model | Calls | Cached` row per provider/model route.

- **One entry per chat session** (its OpenRouter `session_id`), newest first, newest expanded. Click to collapse/expand — implemented with `<details>`, so it needs no script.
- **Named like Copilot names it.** A row is labelled with the Copilot chat **title** when VS Code has one (read locally from VS Code's own chat-session store — nothing is sent to OpenRouter), otherwise a short id; each row also shows the session's **last-update time**.
- **The 10 most recent sessions** are kept; older ones are dropped as new ones appear.
- **Internal calls are folded into their chat.** A tool-using turn makes extra model calls for sub-agents and summarization; those are attributed to the chat that triggered them, so their cost lands on the right session instead of creating an entry of its own.
- **One row per provider/model route** inside a session, because a single session can mix routes — e.g. most turns on a BYOK route plus one turn on an OpenRouter-hosted model. Routes are sorted by cost, highest first.
- The route label marks `(BYOK)` when your own upstream key is billed; an OpenRouter-charged route carries no marker.
- No window-wide total: each session shows its own figure.

**Which figure is reported:** OpenRouter's `usage.cost` when OpenRouter charges you (a shared-pool route). On a **BYOK route OpenRouter reports `cost: 0`** because the upstream provider bills you instead, so the extension falls back to the upstream cost OpenRouter reports for that turn (`usage.cost_details.upstream_inference_cost`).

Two properties worth knowing: totals survive across the separate model calls of a tool-using turn (Copilot makes one call per tool round), and they are **stored in your VS Code global state**, so they survive a window reload and a full restart. Costs are micro-dollars in practice, so figures are printed at working precision and never collapse to `$0.00`.

Costs are deliberately **not** written into the chat transcript. Copilot's own **response footer** (`Model • N credits`) isn't reachable by an extension-provided model — it reads Copilot's CAPI usage — and putting a line in the response text would pollute the conversation (and get re-sent as context).

## Notes

- Chat and agent mode (tool calls) are supported; inline completions are not (same as BYOK).
- The key only leaves your machine in the Authorization header to OpenRouter.
- The local `limit` is a display helper; OpenRouter's server-side guardrail enforces the real cap.
