# OpenRouter for Copilot with Custom Request & Credit Check

A VS Code extension that registers a **customizable OpenRouter provider** in Copilot Chat. Copilot's built-in OpenRouter provider cannot send OpenRouter's `provider` routing object or a `session_id` (microsoft/vscode#283201; microsoft/vscode-copilot-release#11420). This extension calls OpenRouter directly instead of through Copilot's CAPI proxy, so every Chat request can carry whatever request-body options you paste — and it tracks your key's credit usage while you work.

## What it does

- Adds an **"OpenRouter: RC"** group to the Copilot Chat model picker with the full OpenRouter catalog (nothing is model-restricted client-side).
- Lets you **paste a request body** from the [OpenRouter Request Builder](https://openrouter.ai/request-builder) into one panel; its settings — `provider` routing, sampling params, `response_format`, `plugins`, `transforms`, `cache_control`, etc. — apply verbatim to every request until you clear or replace it.
- **Presets**: pick a preset in the panel to send `"preset": "<slug>"` on every request; presets that pin a model also appear in the picker as `@preset/<slug>` entries (up to the first 25). Picker preset entries affect only turns on that entry.
- Reasoning models get VS Code's native **Thinking Effort** selector (or a simple on/off toggle); reasoning traces render in chat.
- Anthropic-family models (`anthropic/*`) automatically get a top-level `cache_control` (unless your pasted body sets its own).
- Model picker entries show estimated blended price per 1M tokens, context window, max output, and capabilities.
- **Used context size in Copilot Chat**: every turn forwards OpenRouter's own `usage` chunk (prompt/completion tokens, cache reads) to Copilot, so the context-usage ring shows *used / max tokens*.
- **Session spend in the panel**: a **Session spend** section accumulates what each chat session has cost in this window, with a collapsible per-session breakdown by provider and model (see below). Nothing is added to the chat transcript.
- **One OpenRouter session per Copilot chat session**: the `session_id` is the chat's own persisted id, so turns stay grouped in one OpenRouter session (sticky routing + the Logs → Sessions view) even after a window reload or a full VS Code restart. A new chat is a new OpenRouter session. Background/internal calls (sub-agents, and Copilot's own utility flows) join the chat that triggered them; when there is no such chat, no `session_id` is sent, so no stray session is created.
- Status bar shows **credit remaining**; the panel has a usage dashboard.

Always enforced (pasted copies are ignored): `model`, `messages`, and `tools` come from Copilot; `stream: true`; the extension's own per-session `session_id` (keeps the prompt cache warm).

## The panel

One webview, **"OpenRouter for Copilot"**, with five sections: **Settings** (save/clear the API key), **Usage** (credit dashboard), **Session spend** (per-session cost, collapsible), **Presets** (dropdown), and **Custom Request** (paste/save/clear). Open it from the status bar item (**OR …**) or the "OpenRouter: Manage provider" command.

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

## Session spend, in the panel

The panel's **Session spend** section shows what each Copilot chat session has cost (persisted across reloads and restarts):

```
▾ $0.001656  Confirm work transfer to Windows   4 call(s) · 85.7% cached   2026/09/22 01:30:05
      Cost        Provider          Model                           Calls  Cached
      $0.001627   Fireworks (BYOK)  deepseek/deepseek-v4.1-flash    3      92.0%
      $0.00002910 Morph             z-ai/glm-5.3-flash              1      66.8%
▸ $0.004200  bbbb9999…   1 call(s) · 99.2% cached   2026/09/22 00:58:12
```

- **One entry per chat session** (its OpenRouter `session_id`), newest first, newest expanded. Click to collapse/expand — implemented with `<details>`, so it needs no script.
- **Named like Copilot names it.** A row is labelled with the Copilot chat **title** when VS Code has one (read locally from VS Code's own chat-session store — nothing is sent to OpenRouter), otherwise a short id; each row also shows the session's **last-update time**.
- **The 10 most recent sessions** are kept; older ones are dropped as new ones appear.
- **Internal calls are folded into their chat.** A tool-using turn makes extra model calls for sub-agents and summarization; those are attributed to the chat that triggered them, so their cost lands on the right session instead of creating an entry of its own.
- **One row per provider/model route** inside a session, because a single session can mix hosts — e.g. most turns on a Fireworks BYOK route plus one turn on an OpenRouter-hosted model. Routes are sorted by cost, highest first.
- The route label marks `(BYOK)` when your own upstream key is billed (e.g. `Fireworks (BYOK)`); an OpenRouter-charged route carries no marker (e.g. `Morph`).
- No window-wide total: each session shows its own figure.

**Which figure is reported:** OpenRouter's `usage.cost` when OpenRouter charges you (a shared-pool route). On a **BYOK route OpenRouter reports `cost: 0`** because the upstream provider bills you instead, so the extension falls back to the upstream cost OpenRouter reports for that turn (`usage.cost_details.upstream_inference_cost`) — verified live on Fireworks.

Two properties worth knowing: totals survive across the separate model calls of a tool-using turn (Copilot makes one call per tool round), and they are **stored in your VS Code global state**, so they survive a window reload and a full restart. Costs are micro-dollars in practice, so figures are printed at working precision and never collapse to `$0.00`.

Costs are deliberately **not** written into the chat transcript. Copilot's own **response footer** (`Model • N credits`) isn't reachable by an extension-provided model — it reads Copilot's CAPI usage — and putting a line in the response text would pollute the conversation (and get re-sent as context).

## Notes

- Chat and agent mode (tool calls) are supported; inline completions are not (same as BYOK).
- The key only leaves your machine in the Authorization header to OpenRouter.
- The local `limit` is a display helper; OpenRouter's server-side guardrail enforces the real cap.
