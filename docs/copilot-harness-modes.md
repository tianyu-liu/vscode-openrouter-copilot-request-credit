# Do Copilot harness modes change this extension's behavior?

Investigation notes kept in the repo so a developer on **any** machine can pick them up. Every claim
here is grounded in the *installed* Copilot harness bundle and VS Code core read directly (not in
documentation), tested against the behavior list in [`AGENTS.md`](../AGENTS.md). The conclusions that
affect the extension's contract are folded into `AGENTS.md` → *Architecture* → **Harness boundary**;
this file keeps the evidence, the mode inventory and the mode × function matrix.

- **Question:** does the Copilot harness mode (VS Code chat, agent loop, sub-agent, utility flow,
  in-editor CLI / agent host, GitHub cloud agent, inline chat, NES, a third-party `vscode.lm`
  caller, …) change what this extension does?
- **Answer in one line:** **no mode changes request or response handling.** Every mode reaches the
  provider through one funnel; the only mode-dependent inputs are the message/tool content and which
  `modelOptions` keys exist — the only mode-dependent *gap* that matters is an absent
  `_conversationId`, which P13/P15 already guard. (`toolMode` is *not* a mode axis for this
  provider: no Copilot mode sets it, see §3a.)
- **Portability warning:** the minified symbol names and character offsets quoted below come from
  one build of the built-in Copilot extension and **will drift** on any VS Code update. Re-locate
  anything you need with the literal anchors and the snippet in
  [Re-verifying on another machine](#re-verifying-on-another-machine). Read the symbol names as
  labels for the inspected build, never as stable API.

## Evidence base

| Source (all local, all read-only) | What it proves |
| --- | --- |
| `<VS Code install root>/resources/app/extensions/copilot/dist/extension.js` — the bundled `github.copilot-chat` harness, ~20 MB of minified JS | The harness itself: both vendor registrations, the extension-contributed endpoint class, every `makeChatRequest2` call site, the usage/cost plumbing. |
| `<VS Code install root>/resources/app/extensions/copilot/package.json` | Which harnesses exist as *contributions*: `languageModelChatProviders` (incl. the `copilotcli` entry gated `"when": "false"`), `chatSessions`, `chatParticipants`, `languageModelTools`/`ToolSets`, `mcpServerDefinitionProviders`. |
| Same folder: `dist/copilotCLIShim.js` (~18 KB) | The in-VS-Code Copilot CLI launcher (child process + readline + NLS). Touches no `lm` surface. |
| VS Code core: `<VS Code install root>/resources/app/out/vs/workbench/api/node/extensionHostProcess.js` and `.../api/worker/extensionHostWorkerMain.js` | The **single** extHost funnel for every provider call, the `modelOptions` pass-through, the progress-part mapping, the public role enum, and the `System`-role rewrite (see §3e). |
| VS Code core: `.../out/vs/workbench/workbench.desktop.main.js` and `.../out/vs/sessions/sessions.desktop.main.js` | The desktop workbench services — including the agent-host BYOK language-model bridge that can hand our provider to an agent-host session (§2 row P). |
| `node_modules/@types/vscode/index.d.ts` | The public contract: `modelOptions?: { [name: string]: any }` is an open bag, so nothing in a mode can be "unsupported" by the API. |
| [`AGENTS.md`](../AGENTS.md) | The list of behaviors to test each mode against. |

**Provenance of the inspected build** (recorded so a later reader can tell whether a re-check is
against the same host): the stable VS Code build installed at audit time and its bundled Copilot
Chat. This repository's own engine pin and its vendored `@types/vscode` target an API surface that
lags the installed host, i.e. **the host inspected here is newer than the API surface the extension
compiles against** — which is exactly why §3e exists. The gap is structural (a released host is
normally ahead of the types a published extension pins), not a property of one particular version,
so it should be re-checked against whatever host is installed rather than assumed settled.

Built-in extensions live under a **version-hashed** install folder, so no path in this file is
quoted from one machine; see the snippet below to locate them locally.

### Re-verifying on another machine

```powershell
# 1. locate the built-in copilot extension (Windows default install layout)
$dist = (Get-ChildItem "$env:LOCALAPPDATA\Programs\Microsoft VS Code\*\resources\app\extensions\copilot\dist" -Directory).FullName
$bundle = Join-Path $dist 'extension.js'

# 2. count the anchors this doc leans on
$b = [IO.File]::ReadAllText($bundle)
$anchors = @(
  'registerLanguageModelChatProvider("copilot"',
  'registerLanguageModelChatProvider("copilotcli"',
  'is only available to VS Code core.',
  'setLastCopilotUsage',
  'getCreditsForTurn',
  'new Set(["anthropic","gemini","openrouter"])',
  '_capturingTokenCorrelationId',
  'copilotCLISDK',
  'vendor!=="copilot"',
  'o200k_base',
  'toolMode',
  'includeEncryptedThinking',
  'completion_tokens_details',
  'ChatRole.System'
)
foreach ($a in $anchors) { '{0,-52} => {1}' -f $a, ([regex]::Matches($b, [regex]::Escape($a))).Count }
```

For a bounded context dump around a match, read the whole file into `$b` (as above) and take
`$b.Substring($i - 400, 900) -replace '\s+', ' '` where `$i = $b.IndexOf($anchor)`.
`out/vs/workbench/api/**` is in the same install root, under `resources/app/out/`.

| Anchor (verified present in the inspected build) | Hits | Meaning |
| --- | --- | --- |
| `registerLanguageModelChatProvider("copilot"` | 1 | The first-party provider registration. |
| `registerLanguageModelChatProvider("copilotcli"` | 1 | The CLI provider registration (inert, see §2). |
| `is only available to VS Code core.` | 1 | The core-only gate thrown for a non-core opener. |
| `setLastCopilotUsage` | 3 | The CAPI usage capture that populates the footer's credit map. |
| `getCreditsForTurn` | 4 | The footer's credit lookup. |
| `new Set(["anthropic","gemini","openrouter"])` | 1 | The vendor gate for harness-emitted cache breakpoints. |
| `_capturingTokenCorrelationId` | 4 | A `modelOptions` key the harness's bag builder always sets — its presence is how `isHarnessOwnedModelOptions` tells a harness call apart from a foreign one (§3f). |
| `copilotCLISDK` | 10 | The CLI / agent-host model catalog source. |
| `vendor!=="copilot"` | 6 | The BYOK-model classification test. |
| `o200k_base` | 27 | The tokenizer string used by the token-count path. |
| `toolMode` | 2 | Both inside the harness's *own* CAPI body builder — none in the extension-provider path (see §3a). |
| `includeEncryptedThinking` | 1 | A single consumer, in that same CAPI path (see §3e). |
| `completion_tokens_details` | 37 | The reasoning-token carrier Copilot reads back out of our usage part (§3e). |
| `ChatRole.System` | 32 | The harness's own transcript role enum really does carry system messages (§3e). |

Counts are from one build; a **zero** for a string that used to be non-zero is the signal that a
finding has moved, not that the search failed. Anchors outside the Copilot bundle, in the VS Code
tree (`resources/app/out/…`):

| Bundle | Anchor | Hits | Meaning |
| --- | --- | --- | --- |
| `vs/workbench/api/node/extensionHostProcess.js` | `i.toolMode??1` | 1 | The default that makes §3a's `toolMode` row true. |
| `vs/workbench/api/node/extensionHostProcess.js` | `case 0:return 3` | 1 | The raw→public role rewrite (§3e). |
| `vs/workbench/api/node/extensionHostProcess.js` | `_conversationId` | **0** | Core never injects a conversation id; it forwards `modelOptions` verbatim. |
| `vs/workbench/api/node/extensionHostProcess.js` | `provideLanguageModelChatResponse` | 1 | The single funnel call site. |
| `vs/sessions/sessions.desktop.main.js` | `AgentHostByokLmHandler` | 1 | The non-`vscode.lm` route (§3e). |
| `vs/sessions/sessions.desktop.main.js` | `clientByokEnabled` | 18 | Its gate. |
| `vs/sessions/sessions.desktop.main.js` | `BYOK models are disabled by policy.` | 1 | The refusal when the gate is off. |
| `vs/sessions/sessions.desktop.main.js` | `sendChatRequest` | 13 | Its request path. |

## 1. The authority boundary — one funnel

VS Code core owns the provider call. For every mode, the extHost builds exactly one call:

```
$startChatRequest(requestId, ?, initiatingExtension?, messages, options, token)
  -> provider.provideLanguageModelChatResponse(
       info,
       messages.map(toLanguageModelChatMessage),
       { ...options,
         modelOptions: options.modelOptions ?? {},
         modelConfiguration: options.configuration,
         requestInitiator: initiatingExtension ? key(initiatingExtension) : "core",
         toolMode: options.toolMode ?? 1,
         includeEncryptedThinking },
       progress, token)
```

What that means for this extension:

- `modelOptions` is forwarded **verbatim**. Core never injects `_conversationId` — the core out
  bundle contains **zero** references to `_conversationId`; only the harness sets it.
- `requestInitiator` is `"core"` for Copilot's own flows and an extension key for a caller that went
  through `vscode.lm`. It is *not* a mode discriminator we can act on, and nothing in this extension
  reads it.
- `toolMode: options.toolMode ?? 1` — the default is applied **by core**, and no harness mode ever
  supplies the option, so our provider always sees `1` (Auto) for Copilot-driven turns. The
  `Required` → `tool_choice: "required"` mapping in this extension therefore only fires for a
  non-Copilot `vscode.lm` caller that sets it explicitly (§3a).
- Progress parts are mapped back into Copilot's part types (`tool_use`, `text`, `data`, `thinking`);
  an unrecognized part type is logged and dropped, and parts are coalesced through a small buffer.
  Our usage part rides the `data` path (P10).
- Messages are converted by core (`LanguageModelChatMessage` ⇄ internal form), so the provider sees
  the same shapes whatever produced them.
- The worker/web host runs the **identical** funnel: `extensionHostWorkerMain.js` carries the same
  two `toolMode` mentions, the same two `includeEncryptedThinking` mentions and the same
  raw→public role rewrite as `extensionHostProcess.js`. So a remote, web, or worker extension host
  cannot diverge from the desktop one on any of the behaviors in §3.

### Two registrations in the Copilot extension, not one

The harness registers **two** language-model vendors, plus its own BYOK vendors (which include a
separate, unrelated `openrouter` vendor — **not** this extension's vendor id):

- `"copilot"` — the CAPI/first-party provider. Gated to core callers: a non-core opener throws
  `Model <id> is only available to VS Code core.`
- `"copilotcli"` — declared `"when": "false"` in the manifest, and its
  `provideLanguageModelChatResponse` is an **empty no-op**; `provideLanguageModelChatInformation`
  returns `[]` (or a single synthetic entry behind an experiment flag) and `provideTokenCount`
  returns `0`. See §2.

This is why the mode question reduces to "who calls the extHost" — there is no second provider path
that a harness mode can take into this extension.

## 2. Inventory of harness modes

| # | Mode / surface | Reaches this provider? | How |
| --- | --- | --- | --- |
| A | VS Code chat — Ask | yes | Main chat driver → `makeChatRequest2` with a real `conversationId`. |
| B | VS Code chat — Agent | yes | Agent loop; **one provider call per tool round** (hence P12's session-keyed store). |
| C | VS Code chat — Plan / custom modes | yes | Same driver, different prompt/tools. |
| D | Edit / notebook / terminal participants | yes | Same driver. |
| E | Inline chat | yes | The inline chat **main turn** goes through the same id-passing agent-loop handler as chat; only the separate `InlineChat2Intent` pass (`location: 4`) has no `conversationId` on its call site. |
| F | NES (next-edit-suggestions) | yes | `nes.nextCursorPosition` call site. |
| G | Sub-agents (edit agent, search agent) | yes, in **two families** (see §3f) | A generic `runSubagent` child agent loop is threaded with the **parent's** chat id; the harness-direct `execution_subagent` / `search_subagent` drivers call the provider with no conversation id → P13 attributes those to the most recent chat, else to the **Unattributed** bucket. |
| H | History compaction / summarization | yes, with the **parent's** `_conversationId` | `summarizeConversationHistory` passes `conversationId: o.conversation?.sessionId` (location 7, `conversation-compaction`); its usage is deliberately skipped (`conversation-background`). |
| I | Utility flows (progress text, title generation, intent detection, tool-arg fetch, goal classifier, …) | yes, **without** `_conversationId` | `getChatEndpoint("copilot-utility-small")` resolves to the *selected main model*. |
| J | Harness's own local LMS server (`agentLMServer`) | yes | SSE writer (`event:`/`data:`), `stream:!1`, `location:7`, **no** `conversationId`. |
| K | Any other extension or SDK client via `vscode.lm` | yes | `requestInitiator` = that extension rather than `"core"`. |
| L | Heal / apply-patch / string-replace, code mapper, branch naming, speculative edits | yes | Further `makeChatRequest2` call sites, all through the same funnel. |
| M | In-editor Copilot CLI / agent-host session | **no**, *except* via row P | Its model list comes from the Copilot CLI SDK catalog (`copilotCLISDK.getAvailableModels()`), not `vscode.lm`; the `copilotcli` vendor entry is `"when": "false"` with a no-op response. That catalog is also BYOK-gated: it lists us only when the agent host's **own** root config carries `byokModelsEnabled`, which a remote host never receives (§3e item 6). |
| N | Standalone `copilot` CLI process | **no** | Separate process; never loads a VS Code extension. |
| O | GitHub cloud coding agent | **no** | Runs remotely; no path to a locally installed provider. |
| P | Agent-host **client BYOK** bridge (`AgentHostByokLmHandler` behind `AgentHostClientByokLmChannel`) | yes, when `clientByokEnabled` is on **and** the agent host's own `byokModelsEnabled` is `true` | The only non-`vscode.lm` route into this provider: it enumerates `vscode.lm` models and drives `sendChatRequest` on them. Its request bag carries no chat identifier at all, so it never sends a `session_id` and its spend is collected under **Unattributed** (§3e, §3f). **Availability:** the second gate is a `scope:"local"` agent-host root-config key, so a **remote** workspace (WSL, Dev Container, SSH) never gets it — see §3e item 6. |

## 3. Matrix — extension function × harness mode

Legend: **identical** = the code path and the wire behavior are the same for every reachable mode;
differences are noted per row.

### 3a. Identity, session, cost telemetry

| Function (where) | VS Code chat (A–D) | Agent rounds (B) | Inline chat (E) / NES (F) | Sub-agent, compaction, utility (G–I) | LMS server (J) | Third-party `vscode.lm` (K) |
| --- | --- | --- | --- | --- | --- | --- |
| `session_id` (`provider.ts` → `sessionIdFor`) | `copilot-chat:<conversationId>` | identical, **one OpenRouter session per chat** | no `_conversationId` → most recent chat within 10 min, else **none sent** | **three families (3f):** a generic `runSubagent` child loop carries the parent's id (**exact** parent session); tool-style sub-agents (`execution_subagent`, `search_subagent`) and utility flows carry it only in `telemetryProperties` → parent heuristic, else **none sent**; a call that did not arrive through the harness endpoint at all (agent-host BYOK, P) always sends **none** | same | same |
| Session cost bucket (`resolveCostSession`) | keyed by conversation id | identical — every tool round folds into the same bucket | falls back to the parent chat | generic `runSubagent` spend folds into the parent bucket **exactly**; tool-style sub-agents and utility flows fold in **within 10 min**, else the **Unattributed** bucket | same | same |
| Session label / last update (P14) | Copilot chat title read from the workspace's `chatSessions/<id>.jsonl`; last-update time from the session stamp | identical | same rule — the title is read only if that conversation has a chat-session file, else the truncated id | generic `runSubagent` and heuristic-attributed calls show the **parent chat's** title; unattributed spend is collected under a fixed **Unattributed (no chat id)** entry, which gets no title lookup (its key is not `copilot-chat:`-prefixed) | title unavailable → truncated id | title unavailable → truncated id |
| Usage part → context ring (P10) | yes | yes, one part per round | yes | yes (compaction's usage is skipped by the harness) | yes | yes |
| Response footer credits | **absent** — see 3b | absent | absent | absent | absent | absent |
| Thinking parts (P1) | yes | yes (required by DeepSeek when tools are present) | yes | yes | yes | yes |
| `toolMode` → `tool_choice` | always `1` (auto) — the harness never sets the option | same (`1`); the documented `Required` → `tool_choice:"required"` mapping is **inert for every Copilot mode** | same (`1`) | same (`1`) | same (`1`) | caller-controlled — the only place the mapping is live |

### 3b. Cost surfaces — why the footer is never a cost surface

| Surface | Status for this provider |
| --- | --- |
| Copilot response footer (`Model • N credits`) | **Unreachable.** The footer reads a per-turn map populated only by the CAPI fetch path. For an extension-contributed model the harness's endpoint class **overrides `makeChatRequest2` and never calls `super`**, so the CAPI fetcher — the only chat-side caller of `setLastCopilotUsage` — is not on our request path in *any* mode. |
| Context-usage ring (`used / max`) | Works, because it is fed by *our* forwarded `usage` data part (P10), not by CAPI. |
| Panel → Session spend (P12) | The only viable cost surface, for every mode. Spend that no chat can be blamed for — including everything the agent-host BYOK bridge (row P) sends, whose `sendChatRequest(i, void 0, n, a, t)` call carries no session identifier at all — is still visible here, in the single **Unattributed** entry. |
| Sub-agent tool UI credits (`setSubagentCopilotCredits`) | **Works, and it is fed by us.** The agent loop folds `be.usage.copilot_usage.total_nano_aiu` (our forwarded `copilot_usage`, P10) through `K$e(t) = t / 1e9` into `_accumulatedCopilotCredits` and reports it on the progress participant; the generic `runSubagent` tool accumulates the reported `copilotCredits` and calls `setSubagentCopilotCredits`, which sums sub-agent credits into the parent request's usage. Since `NANO_AIU_PER_CREDIT` is `1e9`, the displayed figure equals OpenRouter's dollar cost. Code-traced, not observed live; it appears only in sub-agent/session-cost UI, never in the local chat footer. |
| Chat transcript | Deliberately carries no cost text. |

Same reasoning for the ring's *token* numbers: they come from the usage part we emit, so the ring
behaves the same in every mode, including modes the harness marks as background.

### 3c. Request body (`buildRequestBody`)

| Element | Mode dependence |
| --- | --- |
| `stream: true` | none |
| `model` / `messages` / `tools` | content varies by mode; the code path is identical |
| `session_id` | varies only by `_conversationId` presence (3a) |
| `provider`, sampling params, `plugins`, `transforms`, `response_format`, `preset` | none — pasted template spread over the live request, verbatim |
| `reasoning.effort` / `enabled` | from the picker (Thinking Effort), merged over the template |
| `cache_control` (P6) | none for our vendor; see 3d |
| `tool_choice` | effectively never, for Copilot-driven turns: the harness's endpoint class builds its `modelOptions` bag without a `toolMode` key, so core's `toolMode: i.toolMode ?? 1` default always wins and the `Required` branch is unreachable except for a third-party `vscode.lm` caller (§3a) |
| Attribution headers | fixed; sent only on `/chat/completions` |

### 3d. Catalog, picker, presets, settings

| Function | Mode dependence |
| --- | --- |
| `provideLanguageModelChatInformation` (models + `@preset/*`) | none — one catalog for all modes |
| Picker context budget (P16) | none. The endpoint class's own `maxOutputTokens = 8192` is **harness-internal bookkeeping only**; the picker and the context budget are synthesized by core from **our** reported caps (`contextWindow = maxInputTokens + maxOutputTokens`, both clamped), so nothing truncates our replies and the P16 input budget stands. |
| Thinking Effort selector | none — driven by the `configurationSchema` we attach |
| Preset dropdown / template state | none — global state, not per-mode |
| BYOK classification | Our vendor makes `_hasByokModels = models.some(m => m.vendor !== "copilot")` true. That is the precondition for the `chat.byokUtilityModelDefault` setting to matter — i.e. the utility-flow orphan-session risk (§2 row I) follows directly from this extension existing. |
| Harness-emitted cache breakpoints | Not ours: the harness only emits them for vendors in a fixed set (`anthropic`, `gemini`, the built-in `openrouter`) — our vendor id is **not** in it. So the P6 top-level marker is the only cache signal that ever leaves this extension, in every mode. |

### 3e. Runtime capabilities of the host that the published type surface does not describe

Everything here was found by reading the installed Copilot bundle rather than the API types, and two of the four
items were **real gaps that this extension closed**. Recorded because a future host build could move
any of them.

**1. A harness mode that is not `vscode.lm`.**
`AgentHostByokLmHandler` (registered as the `agentHostByokLmHandler` workbench service, driven by
`AgentHostClientByokLmChannel` over `chat` / `models` messages) is the one route that reaches this
provider without going through core's extHost funnel. It is gated on
`chat.clientByokEnabled`; when on, it lists the `vscode.lm` models and calls `sendChatRequest` on the
selected one. That is only the *client-side* gate — the agent host must also have received
`byokModelsEnabled` in its own root config, which a remote workspace never does (item 6 below). Note
what it does *not* put on the request: any chat/session identifier (§3f, row P). What it puts on the request:

| Input | Value | Consequence for this extension |
| --- | --- | --- |
| `includeEncryptedThinking` | `true` | We ignore it (it is a CAPI-path concept). Harmless. |
| `configuration.reasoningEffort` | the session's effort | Already handled — `effortFromModelConfiguration` reads this shape (P16 path, `modelInfo.ts`). |
| session identifier | **none** — `chat(e)` builds `{modelOptions: e.modelOptions, includeEncryptedThinking: true, …}` and calls `sendChatRequest(i, void 0, n, a, t)` | There is no `_conversationId` (and no `_capturingTokenCorrelationId`) to forward, so this path never sends a `session_id` and its spend is bucketed as **Unattributed** (§3f, P12b/P13b). |
| `toolMode` | **never set** | Same `1`-default as §3a. |
| tools | normal tool array | Normal `tools` mapping. |
| decode of our parts | `usage` → `{prompt_tokens, completion_tokens, completion_tokens_details.reasoning_tokens}`; `stateful_marker` → `${modelId}\${responseId}` | The `usage` shape is compatible. We **never** emit a stateful marker, so the response id stays undefined and the channel simply omits the marker on the next turn — graceful, not an error. |

**2. `includeEncryptedThinking` is never set by chat.** The string occurs once in the whole harness —
as a *consumer* inside its own CAPI body builder. The only setter anywhere is the agent-host BYOK
handler above. So no chat mode can hand this provider that flag.

**3. Gap closed — `completion_tokens_details` was dropped.** The harness decodes our usage part by
`JSON.parse`-ing it and rebuilding the payload as `{...R, prompt_tokens, completion_tokens,
total_tokens, prompt_tokens_details: {...}}` — i.e. it **spreads whatever we send**, so extra keys
survive. It then builds its `APIUsage` and consumes `completion_tokens_details.reasoning_tokens`
**only when that key is present**. Our `buildUsagePart` emitted just the three counters plus
`prompt_tokens_details`, so reasoning-token accounting was lost on both ends (extHost and agent-host
BYOK). Fixed: `completion_tokens_details` is now forwarded when it is present and object-shaped, and
omitted otherwise.

**4. Gap closed — a genuine system-role message was downgraded to `user`.** The core runtime's
`LanguageModelChatMessageRole` has `System = 3` at runtime (the enum is exported as the public
`LanguageModelChatMessageRole`), while the published type surface this repo compiles against declares
only `User = 1` / `Assistant = 2` — hence the long-standing "no System member" note in this repo. The harness's own
transcript enum numbers roles completely differently (`System = 0`, `User = 1`, `Assistant = 2`,
`Tool = 3`), and core's raw→public rewrite maps raw `0 → 3` before the message reaches a provider. So
`role: "system"` messages are real in this host, and `toOpenAI` was folding them into `user` (its old
"everything non-assistant is user" rule). Fixed: a runtime-aware helper maps the `System` role to
`role: "system"`, resolving the member defensively through a cast so the code still compiles and runs
against a type surface where the member does not exist.

**5. The internal alias budget is now fully explained.** When the harness synthesizes an internal
alias entry it reports `maxInputTokens = modelMaxPromptTokens − baseCount − 3`. `baseCount` is a
per-model, per-extension-version cached token count of that model's base prompt (computed on first
use); `3` is a fixed reserve. This is harness-internal bookkeeping and does not change the caps
reported by this extension — it is recorded only so the §3d context-budget row has no unexplained
term.

**6. The agent-host BYOK route has a second gate, and that one is local-only.** `chat.clientByokEnabled`
(§3e item 1) is the *client's* permission. The agent host itself only populates its BYOK model list
when its **own** root config says so:

```js
function zw(r){let i=r===!0;return{enabled:i,trace:`enabled: ${i} (root config: ${r??"unset"})`}}
```

— a **strict** boolean `true`, read from the agent host's root config **file**, never from
`settings.json`. The declaration carries `agentHost:{key:"byokModelsEnabled",scope:"local"}`, and the
key is written by the Agent Host settings editor, which is hard-wired to the local identity:
`var dYe="agent-host-settings",qbo="local"; function $bo(){return f.from({scheme:dYe,authority:qbo,path:"/settings.jsonc"})}`
(`workbench.action.chat.openAgentHostSettings`, “Open Host Settings”).

The decisive part is the **mirroring filter**. Agent-host settings are mirrored to a host's root
config only when their declared scope admits that host's kind:

```js
function Uto(s){return s===YM?0:s.startsWith(`${X.vscodeRemote}://`)?1:2}
function ubr(s,o){switch(s??"all"){case"all":return!0;case"local":return o===0;case"ambient":return o===0||o===1}}
```

with `var YM=Symbol("localAgentHostResourceIdentity")`. So `scope:"local"` settings reach **only** kind
`0` — and a WSL / Dev Container / SSH agent host is a `vscode-remote://` resource, kind `1`. It
therefore never receives `byokModelsEnabled` (nor `defaultShell`, `runtimePath`, `skillCharBudget`,
the other three `scope:"local"` agent-host keys). Measured on a WSL-window machine: the remote
`~/.vscode-server/data/User/globalStorage/agent-host-config.json` holds **53** keys with
`byokModelsEnabled` **absent**, while the Windows
`%APPDATA%/Code/User/globalStorage/agent-host-config.json` holds **57** with it `"true"` — the
difference is exactly those four local-scope keys.

The node entry always asks for the renderer-backed bridge (`byok:{kind:"renderer",bridgeRegistry:R}`);
an unsupported topology falls back to a stub:

```js
r.set(BT,i.byok.kind==="renderer"?new De(Sh):new WT)
var WT=class{start(){return Promise.reject(new Error("BYOK is not supported in this agent host"))}dispose(){}}
```

**A third gate stacks on top even locally.** The sessions/Agents window refuses any extension that has
code: `canExecuteOnSessionsWindow` first consults the user setting
`extensions.supportAgentsWindow`, otherwise (with `extensions.experimental.enableAgentsWindowCapability`)
`capabilities.agentsWindow.supported` + the `agentsWindowActivation` proposal, and then applies the rule
*“In the sessions window only extensions that have no code are currently allowed to run”* —
`if (manifest.main || manifest.browser) return false` — followed by an allow-list check against
`SESSIONS_WINDOW_ALLOWED_CONTRIBUTION_POINTS` (`themes`, `iconThemes`, `productIconThemes`, `colors`,
`keybindings`, `jsonValidation`, `jsonValidationRegistry`, `localizations`, `grammars`, `languages`).
This extension has `main` **and** contributes `languageModelChatProviders`, so it is refused there
regardless of the model list. (Recorded, not acted on: opting in would only help the *local* case and
would add a proposed-API dependency.)

**This is an upstream limitation affecting every BYOK/custom-endpoint provider**, not a defect in this
extension: microsoft/vscode#332085 (“Agents window: BYOK custom-endpoint model not selectable for WSL
workspaces”, OPEN, labels `bug` + `model-byok`, milestone **Backlog**; vritant24: *“a remote path is
used to communicate with the agent host in WSL scenarios, and so currently that is not supported …
Support for WSL is added to the backlog.”*), #339228 (same symptom from a
`contributes.languageModelChatProviders` extension, closed as a duplicate of #332085), #325738
(roblourens: *“BYOK is not supported in remote AH yet”*), #329815 (closed with the same maintainer
statement), #333016 (also reproduces in a **Dev Container**). Related PRs: #338944
(merged — register late BYOK models on live sessions), #338229 (draft — refresh sessions when BYOK
models appear). The peer extension `mfenderov/opencode-copilot-sync` documents the identical
limitation under “Known limitation: Agents window under Remote-WSL” and links #332085.

**Contrast with extension assets (`_customizationRead`).** Skill/instruction customization is handed
to the agent host as a **list** — `skillDirectories`, `skillReadRoots`, `selectedCapabilityRoots` with
`location:{type:"environment",environmentId:"local"}` — assembled per environment, whereas the BYOK
model list hangs off one per-host root-config boolean that the local-scope filter withholds from a
remote host. That asymmetry is why a WSL-window agent host is observed to see skills from both the
WSL-side and the Windows-side locations while it still cannot see our models. (The observation is the
user's, on a test setup; the *mechanism* is code-traced, the environment aggregation itself is
not.)

### 3f. Session identity (P11) and spend attribution (P12/P13) per mode

Every row below is decided by the same three questions the extension already keys off:

1. **Did the call arrive through the Copilot harness endpoint at all?** `isHarnessOwnedModelOptions`
   tests the request bag for `_capturingTokenCorrelationId`, which the harness's bag builder
   (`Ok.makeChatRequest2`) always sets as an own key. A bag without it cannot have come from the
   harness — in practice the agent-host BYOK bridge (row P), whose handler forwards the caller's
   `modelOptions` untouched. Such a call always sends **no `session_id`** and can never inherit a
   chat's identity; its spend goes to the **Unattributed** bucket.
2. **Does this mode put a top-level `conversationId` on the `makeChatRequest2` call?** That is the
   only carrier the extension host forwards (as `modelOptions._conversationId`). A `conversationId`
   placed inside `telemetryProperties` is **never** forwarded — `Vja` only lifts a numeric
   `turnIndex` out of that bag, and no other key escapes.
3. **When it does not, is there a recently active chat to attribute to?** `resolveCostSession`
   returns the last active `copilot-chat:`-prefixed session if it was active within
   `PARENT_ATTRIBUTION_WINDOW_MS` (10 minutes), otherwise the `unattributed` **sentinel** — never
   `undefined`, so spend is never dropped. The sentinel is a *cost bucket only*: it is deliberately
   **not** `copilot-chat:`-prefixed, so the caller can tell it apart from a real chat and declines
   to put it on the wire as a `session_id`.

| Mode / entry point | Top-level `conversationId`? | `session_id` sent | Spend bucket | Notes |
| --- | --- | --- | --- | --- |
| Chat panel, editor, quick chat, agent mode (A–D) | yes — main agent loop (`conversationId: conversation.sessionId`) | own `copilot-chat:<id>` | own entry | Panel label is the chat title read from VS Code's chat-session store; the id itself is restored with the conversation, so OpenRouter Sessions stay continuous across a reload/restart. |
| Agent rounds inside one turn (B, repeated) | yes — the same loop runs once per tool round (`iterationNumber`) | same own id | same own entry | This is exactly why the store is session-keyed rather than per-invocation: one tool-using turn is many provider calls, and per-call state can never see the whole turn. |
| Inline chat (E, `location === 4`) | yes — the same agent-loop handler | own inline conversation id | own entry | The driver is shared with chat; only `location` differs. If no chat-session file exists for that conversation, the panel falls back to the truncated id. |
| Generic `runSubagent`, custom agents, edit agent driven through the tool (part of G) | yes — the child agent loop is the same handler, threaded with the **parent's** `sessionResource` / `sessionId` | **the parent's** id | **folds into the parent's entry** | Sub-agent spend is not a separate panel entry, which is correct — the parent chat caused it. Copilot additionally surfaces the sub-agent's own credit figure (3b). |
| Harness-direct sub-agent drivers — `execution_subagent`, `search_subagent` (G) | no — the parent id is only in `telemetryProperties` | the parent's id **if** within the 10-minute window, else none | the parent's entry **if** within the window, else **Unattributed** | These bypass the child-agent loop and call `makeChatRequest2` directly; they still go through the harness, so the heuristic (not the ownership test) decides. |
| Compaction / `summarizeConversationHistory` (`location: 7`) | yes — the parent's id | the parent's id | the parent's entry | Its usage report also carries `copilotCredits`. |
| Utility flows — progress messages, title generation, intent detection, NES, branch name, `healCommit`, framework queries (H, F) | no | the parent's id if within the window, else none | the parent's entry if within the window, else **Unattributed** | The historical orphan-session source; `chat.byokUtilityModelDefault: "copilot"` is the mitigation. |
| `vscode.lm` third-party callers, incl. the `copilotLanguageModelWrapper` path (K, J) | caller's choice — the wrapper forwards the caller's `_conversationId` | that id when supplied, else heuristic/none | that id's entry when supplied; otherwise the heuristic applies **only if the wrapper was the driver** (it goes through the harness), else **Unattributed** | The one mode where an outside caller can deliberately join a session. A caller driving `vscode.lm` directly is *not* harness-owned: core forwards the caller's `modelOptions` verbatim, with no marker. `toolMode` is still honored here (3a). |
| Agent-host client BYOK (`AgentHostByokLmHandler`, P) | no | **never** — no id exists to send | **always Unattributed** | Its request bag carries neither `_conversationId` nor `_capturingTokenCorrelationId` (§3e), so it never inherits a chat's identity. |
| CLI, cloud, other non-VS-Code hosts (L, M) | unreachable | — | — | No local-provider bridge exists. |

**What the absent-id case can never do.** `resolveCostSession` yields either a real
`copilot-chat:`-prefixed id or the `unattributed` sentinel, so an internal or sub-agent call can
never *create* a chat entry, and can therefore never *evict* one through `trimToCap`. The sentinel
is not a chat: it is not `copilot-chat:`-prefixed, it is rendered as **Unattributed (no chat id)**
and receives no title lookup, and `trimToCap` reserves its slot — so nine of the ten tracked entries
remain available to real chats and unattributed spend cannot push a chat out. `sessionIdFor`'s
per-window UUID fallback survives only so that function is total (and for tests): whenever no
conversation id was present, the caller declines to use it — so in production it is effectively
dead, and no orphan OpenRouter session can be minted.

**One value, two consumers, decoupled at the sentinel.** The provider computes one `costKey` and
feeds it to the session-cost store and to `buildRequestBody` — but the value put on the wire is
suppressed when that key is the sentinel. For every call that belongs to a chat, the panel's Session
spend key and OpenRouter's Sessions view still cannot disagree; for a call that belongs to none, the
panel shows it under **Unattributed** while the request is sent without a `session_id`, so no orphan
OpenRouter session is created on its behalf.

**Reload behavior.** The spend store is persisted to `globalState` and re-hydrated (merging, never
replacing), and the last-active parent is persisted too — so attribution and totals survive a window
reload and a full restart, for every mode that had a session to attribute to.

**A boundary case worth knowing:** a `search_subagent` (or utility) turn that starts **more than 10
minutes after** the last chat turn sends no `session_id` and its spend goes to the **Unattributed**
bucket. That is intentional — a bucket of its own is better than being blamed on a long-finished
chat, and better than being dropped — and it is the whole reason the window exists.

## 4. Practical implications

- **No mode-specific code is needed.** Nothing in the extension branches on mode, and the one
  axis that actually varies (`_conversationId` presence) is already the axis P13/P15 key off.
- **Keep guarding the absent-`_conversationId` case** (rows G, I, J, and the non-harness row P):
  those are the modes that can produce an unattributed call. P15's send-no-`session_id` rule, P13's
  10-minute parent window and P12b's **Unattributed** bucket together keep such spend visible
  instead of misattributed or dropped.
- **Do not try to surface cost in the chat transcript or the response footer** for any mode; the
  mechanism is unreachable by construction (3b). The panel is the designed surface.
- **Do not rely on harness-emitted cache breakpoints** for our vendor (3d).
- **The `chat.byokUtilityModelDefault` recommendation in `AGENTS.md` is explained**: with this
  extension installed the harness reports BYOK models as available, which is what makes that setting
  relevant; `"copilot"` keeps utility flows off OpenRouter.
- **Do not test a mode as if it were a new code path.** When validating a change, one chat turn and
  one agent turn cover the funnel; the other modes differ only in content.
- **Two host capabilities were worth closing gaps for, and are now closed** (3e): the runtime
  `System` role, and the decoding of our `usage` part. Both were silent losses — a message role
  silently downgraded, a token figure silently dropped — so they are the type of thing to re-check
  against a future host build rather than assume.
- **Sub-agent spend folding into the parent chat is by design (3f).** The generic `runSubagent`
  family carries the parent's id, so a sub-agent turn adds to the parent's panel entry instead of
  minting its own. Do not "fix" that by inventing a child key — a separate entry would misreport a
  cost the parent turn caused. The harness-direct `execution_subagent`/`search_subagent` drivers have
  no id to carry and fall back to the 10-minute heuristic.
- **Row P needs no mode-specific request code.** The agent-host BYOK bridge reuses the same catalog
  and the same request path; the only input it adds that we read is `configuration.reasoningEffort`,
  which is already handled. Its `stateful_marker` expectation is unmet by design (we never emit one)
  and degrades gracefully. What it *did* need was the attribution fix: because its bag carries no
  chat identifier, spend from this path used to be charged to whichever chat had been active in the
  previous 10 minutes. P12b/P13b now bucket it as **Unattributed** instead.

## 5. Remaining uncertainty

Everything that was genuinely open in the first pass has since been closed; the entries below record
what closed them, so a future read does not re-open a settled question.

- **Non-VS-Code hosts cannot receive a local provider — closed.** The shipped CLI shim
  (`dist/copilotCLIShim.js`) contains **zero** occurrences of `registerLanguageModelChatProvider`,
  `selectChatModels`, or `languageModels`. There is no bridge for a CLI or cloud process to reach a
  locally installed provider.
- **The internal alias-budget reserve is now exact — closed.** `maxInputTokens =
  modelMaxPromptTokens − baseCount − 3`, where `baseCount` is the per-model cached base-prompt token
  count and `3` is the fixed reserve (3e item 5).
- **Build provenance — closed.** The install inspected was a stable VS Code build newer than the
  type surface this repo targets — see 3e, which exists precisely because of that gap.

Genuinely residual (do not treat as settled):

- **How often the agent-host BYOK bridge is reached in a plain desktop chat session.** The path
  itself is no longer open: it has been **observed live** (an agent-host session selected this
  provider and drove it), and its request shape is read verbatim in §3e (`modelOptions:
  e.modelOptions`, `sendChatRequest(i, void 0, n, a, t)` — no identifier). It is **not** a
  client-side fixable gap: no session identifier exists on that path, so the correct handling is
  P15's send-no-`session_id` plus P12b's **Unattributed (no chat id)** bucket. Only the *frequency*
  of the path in other session types is unknown.
- **The Unattributed bucket's reserved slot has not been observed live.** `trimToCap` reserves one of
  the ten tracked entries for it so chat churn cannot evict it; the behavior is unit-tested, not yet
  seen in a persisted store.
- **Whether OpenRouter's streamed `usage` chunk actually carries `completion_tokens_details`.** The
  harness consumer exists and we now forward the field when present, but whether a given upstream
  route reports reasoning tokens is a pilot observation, not a code property.
- **The stateful-marker contract is unexercised.** We never emit one; the harness's graceful
  omission is inferred from the decoder, not observed live.
- **The sub-agent credit surface (`setSubagentCopilotCredits`) is code-traced, not observed.** The
  chain from our `copilot_usage.total_nano_aiu` → `K$e(t)/1e9` → `_accumulatedCopilotCredits` →
  `ge.usage({copilotCredits})` → the `runSubagent` accumulator → `setSubagentCopilotCredits` is
  complete in code and the units match (`NANO_AIU_PER_CREDIT === 1e9`), but no live sub-agent run has
  been checked against it. It is a Copilot-side UI surface only; the panel remains the authoritative
  cost surface in every mode.
- **The copied anchors are a snapshot of one host version.** A moved anchor (a zero hit count) means
  re-read the bundle, not that the finding is void — see "Re-verifying on another machine".
