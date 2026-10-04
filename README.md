# OpenRouter for Copilot with Custom Request & Credit Check

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

A VS Code extension that registers a **customizable OpenRouter provider** in Copilot Chat. Copilot's built-in OpenRouter provider cannot send OpenRouter's `provider` routing object or a `session_id` (microsoft/vscode#283201; microsoft/vscode-copilot-release#11420). This extension calls OpenRouter directly instead of through Copilot's CAPI proxy, so every Chat request can carry whatever request-body options you paste — and it tracks your key's credit usage while you work.

## What it does

- **Model picker:** adds an "OpenRouter: RC" group to the Copilot Chat model picker with the OpenRouter catalog. By default it hides models your key cannot use (nothing else is model-restricted client-side).
- **Paste-apply request:** paste a request body from the [OpenRouter Request Builder](https://openrouter.ai/request-builder); its settings — `provider` routing, sampling params, `response_format`, `plugins`, `transforms`, `cache_control`, etc. — apply verbatim to every request until you clear or replace it.
- **Presets:** pick a preset from your OpenRouter account and its routing applies to every request; a preset that pins a model is also offered as an `@preset/<slug>` picker entry (only model-pinned presets get picker entries; configurations are resolved for up to 25 presets per picker query).
- **Hide models this key cannot use** (on by default): the model picker drops models the account cannot reach, using the account's own available-model list. Turn it off to show the whole catalog.
- **Thinking effort:** reasoning models get VS Code's native Thinking Effort selector (or a simple on/off toggle), and reasoning traces render in chat.
- **Anthropic caching:** Anthropic-family models (`anthropic/*`, incl. `~anthropic/*`) automatically get a top-level `cache_control` unless your pasted body sets its own.
- **Model cards:** picker entries show estimated blended price per 1M tokens, context window, max output, and capabilities — and, where OpenRouter charges more above a long-context threshold (e.g. OpenAI GPT above 272K tokens), the base vs stepped price.
- **Context size:** for models with a long-context price step, the picker's **Context size** menu lists the model's fixed sizes (one per step, plus the whole window) as **prompt budgets** — Copilot adds the output reserve on top. Small budgets carry a stop sign (`<64K`) or a warning (`≤128K`); an unchosen model defaults to the step closest to 256K (at or above a 196K floor). This is the only per-model context-size control — the panel has no Context tab (the global output-reserve settings still apply).
- **Used context size:** every turn forwards OpenRouter's own `usage` chunk (prompt/completion tokens, cache reads) to Copilot, so the context-usage ring shows *used / max tokens*.
- **Session spend:** the panel's Session spend section accumulates what each chat session has cost in this window, with a collapsible per-session breakdown by provider and model (see below). Nothing is added to the chat transcript.
- **One OpenRouter session per chat:** the `session_id` is the chat's own persisted id, so turns stay grouped in one OpenRouter session (sticky routing + the Logs → Sessions view) even after a window reload (a full restart is expected by design but was not exercised). A new chat is a new OpenRouter session. Background/internal calls (sub-agents, and Copilot's own utility flows) join the chat that triggered them; when there is no such chat, no `session_id` is sent, so no stray session is created.
- **Status bar:** shows credit remaining; the panel has a usage dashboard.

Host-managed fields are always replaced: `model`, `messages`, and `tools` come from Copilot, `stream` is always `true`, and `session_id` is the extension's own per-chat id (keeps the prompt cache warm); a pasted `prompt` is dropped. Every other pasted field applies. Thinking effort/enabled come from the picker and overwrite only `reasoning.effort` / `reasoning.enabled`.

## The panel

One webview, **"OpenRouter for Copilot"**, with three tabs: **Key Info**, **Session Spend**, and **Configurations**. Open it from the status bar item (**OR …**) or the "OpenRouter: Manage provider" command. Context size for long-context-priced models is set in the model picker's **Context size** menu, not the panel.

## Install (from VSIX)

This extension is distributed as a VSIX only: it uses proposed VS Code APIs (`chatProvider`, `languageModelThinkingPart`) and is not published to the Marketplace.

1. Build: `npm install && npm run package` → `openrouter-copilot-request-credit-<version>.vsix`.
2. VS Code → Extensions → "…" → **Install from VSIX…** → select the file.
3. Open the panel and paste your OpenRouter key (kept in your OS keychain).
4. In Chat, pick a model from the **OpenRouter: RC** group and use it like any Copilot model.

## Usage

1. Build a request at [openrouter.ai/request-builder](https://openrouter.ai/request-builder) and copy the JSON body.
2. Paste it into the **Custom Request** box, then select **Save request** (validated; errors are reported).
3. Every subsequent Copilot Chat request follows it until you clear or replace it.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `openrouterCopilot.creditLimit` | `0` | Local cap in USD (`0` disables it and shows the account-wide balance). |
| `openrouterCopilot.creditResetPeriod` | `daily` | Guardrail reset cadence: `daily` / `weekly` / `monthly` / `never`. |
| `openrouterCopilot.creditIncludeByok` | `true` | Count BYOK spend toward the guardrail. |
| `openrouterCopilot.creditRefreshIntervalMinutes` | `5` | Usage refresh interval (1–1440 minutes). |
| `openrouterCopilot.sanitizeBase64Content` | `true` | Strip long base64-like runs from request text (messages, reasoning, tool-call arguments; never image attachments) so an org guardrail does not block the request. |
| `openrouterCopilot.hideUnavailableModels` | `true` | Hide models this key cannot use from the model picker. Falls back to the full catalog when the availability query fails. |
| `openrouterCopilot.outputReservePercent` | `12.5` | Output reserve target as a share of the context window (%), used when OpenRouter publishes no real max-completion cap (1–50). |
| `openrouterCopilot.outputReserveMinTokens` | `16384` | Lower bound for the output reserve in tokens: tiny windows still hold back a sane reply budget. |
| `openrouterCopilot.outputReserveMaxTokens` | `262144` | Upper bound for the output reserve in tokens: a real published cap is capped here. Set both limits equal for a fixed reserve. |

All nine settings are application-scoped: workspace settings cannot change these provider or usage preferences. Provider and credit requests use the fixed OpenRouter API endpoint.

**Output reserve:** the reply budget held back from the context window. When OpenRouter publishes no real max-completion cap (or only a synthetic placeholder), the extension reserves `outputReservePercent` of the window, clamped between the lower and upper token limits; a real published cap is trusted and only capped at the upper limit. The rest of the window is reported to Copilot as the model's input budget.

## Session spend, in the panel

The panel's **Session spend** section shows what each Copilot chat session has cost (persisted across window reloads). Each session is one collapsible row; expanding it shows a `Cost | Provider | Model | Calls | Cached` row per provider/model route.

- **One entry per chat session** (its OpenRouter `session_id`): newest first, newest expanded. Click to collapse/expand — implemented with `<details>`, so it needs no script.
- **Named like Copilot names it:** a row is labelled with the Copilot chat title when VS Code has one (read locally from VS Code's own chat-session store — nothing is sent to OpenRouter), otherwise a short id; each row also shows the session's last-update time.
- **Up to 10 entries:** the most recent chats are kept; one slot is reserved for the Unattributed entry, so chats share nine slots and older chats drop as new ones appear.
- **Internal calls go to a nearby chat (a heuristic, not exact attribution):** a background call without a conversation id — a sub-agent or summarization call — is credited to the most recently active chat for up to 10 minutes; past that window, or when the call never went through Copilot's chat harness, its spend goes to Unattributed instead.
- **One row per provider/model route:** a single session can mix routes — e.g. most turns on a BYOK route plus one turn on an OpenRouter-hosted model. Routes are sorted by cost, highest first.
- **BYOK marker:** the route label marks `(BYOK)` when your own upstream key is billed; an OpenRouter-charged route carries no marker.
- **`Unattributed (no chat id)`:** spend from calls that reached the provider outside Copilot's chat harness (for example an agent-host/SDK client-BYOK session) collects in one trailing entry, because there is no chat to charge.
- **No window-wide total:** each session shows its own figure.

**Which figure is reported:** OpenRouter's `usage.cost` when OpenRouter charges you (a shared-pool route). On a **BYOK route OpenRouter reports `cost: 0`** because the upstream provider bills you instead, so the extension falls back to the upstream cost OpenRouter reports for that turn (`usage.cost_details.upstream_inference_cost`).

- **Cross-turn totals:** totals survive across the separate model calls of a tool-using turn (Copilot makes one call per tool round).
- **Persistence and precision:** totals are stored in your VS Code global state, so they survive a window reload (a full restart is expected by design but was not exercised); costs are micro-dollars in practice, so figures are printed at working precision and never collapse to `$0.00`.
- **Not in the transcript:** costs are deliberately not written into the chat transcript. Copilot's own response footer (`Model • N credits`) isn't reachable by an extension-provided model — it reads Copilot's CAPI usage — and putting a line in the response text would pollute the conversation (and get re-sent as context).

## Known limitations

- **Agents window / Copilot SDK under WSL and Dev Containers:** this provider does not appear in the agent-host model list there (microsoft/vscode#332085; it affects every BYOK/custom-endpoint provider). Regular Copilot Chat in the same window works, and a local Windows window works.
- **Gemini via OpenRouter:** prompt caching is broken (0% hits through the OpenAI→Gemini translation layer), and Gemini 3.1 agent mode can 400 on a stripped `thought_signature`. Avoid Gemini in agent mode.
- **Qwen:** prompt caching needs per-block cache markers this extension does not send, so budget full input price for a Qwen route.
- **Stream cancellation:** stops billing only on providers OpenRouter lists as supporting it (DeepSeek and DeepInfra do; Google/Bedrock/Groq and others do not).

## Notes

- **Compatibility:** chat and agent mode (tool calls) are supported; inline completions are not (same as BYOK).
- **Network:** the key only leaves your machine in the Authorization header to OpenRouter.
- **Local limit:** the local `limit` is a display helper; OpenRouter's server-side guardrail enforces the real cap.
