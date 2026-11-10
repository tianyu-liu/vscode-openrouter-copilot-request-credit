# OpenRouter for Copilot with Custom Request & Credit Check

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

A VS Code extension for **OpenRouter in Copilot Chat**, through named direct connections or an OpenRouter proxy. Each connection has its own credential, request JSON, model group, and usage history. Direct connections also track credit and offer account presets.

## What it does

- **Model picker:** each connection appears as a named model group. The same upstream model can be selected independently through different connections. OpenRouter connections show the full catalog, hiding models the key cannot use by default.
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
- **Status bar:** shows direct OpenRouter credit or local usage tracking for the selected connection.

Host-managed fields are always replaced: `model`, `messages`, and `tools` come from Copilot, `stream` is always `true`, and a pasted `prompt` is dropped. Both modes manage OpenRouter `session_id`, caching, and the picker's reasoning options. Proxies use their server's model catalog without manual additions or unrestricted fallback.

## The panel

Open **OpenRouter for Copilot** from the status bar or the **OpenRouter: Manage provider** command.

- **Settings → Group management:** choose **Direct OpenRouter** or **OpenRouter proxy**, then edit its name, endpoint, key, and enabled state together,
  then select **Save connection**. The key field shows a grey masked hint; leave it blank to keep the
  saved key, or use **Clear key** to remove it. Connections can be saved without a key.
  OpenRouter keys (`sk-or-...`) are accepted only for direct OpenRouter connections; a proxy must use
  its own token or no key.
- **Settings → shared settings:** output reserve, text sanitization, and usage refresh interval apply to all connections.
- **Each named connection tab:** view usage and session spend, and paste request JSON. Direct OpenRouter tabs also offer budget/model visibility controls and account presets.

Panel selection controls editing and the status bar display. The model selected in Copilot determines which connection sends a request. Renaming a group may require selecting its model again.

## Install (from VSIX)

This extension is distributed as a VSIX only: it uses proposed VS Code APIs (`chatProvider`, `languageModelThinkingPart`) and is not published to the Marketplace.

1. Build: `npm install && npm run package` → `openrouter-copilot-request-credit-<version>.vsix`.
2. VS Code → Extensions → "…" → **Install from VSIX…** → select the file.
3. Open **Settings → Group management**, choose or add a connection, enter its key, and select **Save connection** (keys stay in VS Code SecretStorage).
4. In Chat, pick a model from that connection's named group.

Existing keys, request settings, context choices, and history migrate into one **OpenRouter: RC** connection.

## Usage

1. Build a request at [openrouter.ai/request-builder](https://openrouter.ai/request-builder) and copy the JSON body.
2. Open the intended connection's tab, paste it into **Custom request**, then select **Save request**.
3. Requests using that connection follow its saved settings until you clear or replace them.

Choose **Direct OpenRouter** for the fixed OpenRouter API URL and an OpenRouter key. Choose **OpenRouter proxy** for a configurable API base URL and the proxy's own token, or no key if authentication is not required. HTTPS is required except for loopback HTTP. Proxies must provide streaming Chat Completions and their authoritative model catalog; they never use direct OpenRouter credit or preset APIs.

Proxy usage is tracked locally from reported token counts and returned costs; missing cost remains unavailable. No proxy balance or budget API is assumed. Private-CA endpoints require the extension host to trust the public CA certificate. Older saved connections retain their behavior until explicitly saved as an OpenRouter proxy; that conversion removes manual model definitions while preserving connection identity and history.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `openrouterCopilot.creditRefreshIntervalMinutes` | `5` | Usage refresh interval (1–1440 minutes). |
| `openrouterCopilot.sanitizeBase64Content` | `true` | Strip long base64-like runs from request text (messages, reasoning, tool-call arguments; never image attachments) so an org guardrail does not block the request. |
| `openrouterCopilot.outputReservePercent` | `12.5` | Output reserve target as a share of the context window (%), used when OpenRouter publishes no real max-completion cap (1–50). |
| `openrouterCopilot.outputReserveMinTokens` | `16384` | Lower bound for the output reserve in tokens: tiny windows still hold back a sane reply budget. |
| `openrouterCopilot.outputReserveMaxTokens` | `262144` | Upper bound for the output reserve in tokens: a real published cap is capped here. Set both limits equal for a fixed reserve. |

These shared settings are application-scoped; workspace settings cannot change them. Credit limits, reset periods, BYOK inclusion, and model visibility are now saved per connection in the panel. Their old VS Code settings are imported during migration and deprecated afterward. Direct OpenRouter connections always use OpenRouter's API; proxies keep separate credentials.

**Output reserve:** the reply budget held back from the context window. When OpenRouter publishes no real max-completion cap (or only a synthetic placeholder), the extension reserves `outputReservePercent` of the window, clamped between the lower and upper token limits; a real published cap is trusted and only capped at the upper limit. The rest of the window is reported to Copilot as the model's input budget.

## Session spend, in the panel

Each connection's **Session spend** section has its own history, persisted across reloads. Expanding a session shows provider/model routes. Proxies also show reported input/output tokens; missing cost is labeled unavailable, and mixed known/unknown cost stays visibly incomplete.

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
- **Network:** each connection sends its credential only to its configured API origin, with redirect following disabled.
- **Local limit:** the local `limit` is a display helper; OpenRouter's server-side guardrail enforces the real cap.
