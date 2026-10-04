# Harness boundary — every Copilot mode reaches this provider through one funnel

Verified against the installed harness bundle (`github.copilot-chat` as the built-in `copilot`
extension, `dist/extension.js`). The full evidence, the mode inventory and the mode × function
matrix are in [`../copilot-harness-modes.md`](../copilot-harness-modes.md) (dev-only, excluded
from the VSIX). **There is exactly one funnel**, so no mode-specific handling is
needed or present: VS Code core's extHost builds the call at `$startChatRequest` and invokes
`provideLanguageModelChatResponse(info, messages, { ...options, modelOptions, modelConfiguration,
requestInitiator, toolMode: options.toolMode ?? 1, includeEncryptedThinking }, progress, token)`.
`modelOptions` is forwarded **verbatim** — core never injects `_conversationId` (it has no
`_conversationId` reference at all) — `requestInitiator` is `"core"` unless another extension called
through `vscode.lm`, and the progress parts are mapped back to Copilot's part types
(tool_use/text/data/thinking; an unknown part type is logged and dropped).

Modes that can reach us: VS Code chat (ask/agent/plan), the edit/notebook/terminal participants,
inline chat, NES, every agent-mode tool round, history compaction (`summarizeConversationHistory`),
sub-agents, Copilot's utility flows, the harness's own `agentLMServer` SSE endpoint, an agent-host
session's **client BYOK** bridge (gated on the host's `clientByokEnabled` policy **and** on
`chat.agentHost.byokModels.enabled` reaching that host's own root config — see "Agent-host BYOK
visibility" below; same catalog, same request path, plus `includeEncryptedThinking: true` and
`configuration.reasoningEffort`, which `effortFromModelConfiguration` already reads), and any other
extension or SDK client going through `vscode.lm`. What differs between them is only content: messages/tools, which `modelOptions` keys are
present, `requestInitiator`, where the reply is routed, and who consumes the `usage` part — **not
`toolMode`**, which the harness's extension-contributed endpoint never sets (core's
`options.toolMode ?? 1` default therefore always yields Auto). The mode-dependent gaps that matter are
all **absent-`_conversationId`** cases (sub-agent, compaction, utility flows) plus the **agent-host
client-BYOK bridge** (§Harness boundary), which never enters the harness at all — exactly what
[P13](provider.md)'s parent/agent-host heuristic, [P12b](provider.md)'s unattributed bucket and [P15](session-identity.md)'s send-no-`session_id` rule
guard. Modes that **cannot** reach us: the
standalone CLI process and the GitHub cloud coding agent (both remote, with no path to a local
provider — the shipped CLI shim has zero `vscode.lm` references).

Three harness details worth knowing (none of them a defect in this extension):

- **`ExtensionContributedChatEndpoint.maxOutputTokens = 8192` is harness-internal only.** The
  endpoint class hardcodes that value for its own bookkeeping; the picker and the context budget are
  synthesized by core from **our** reported caps (`iTn`/`rTn` clamp and compute
  `contextWindow = maxInputTokens + maxOutputTokens`), so nothing truncates our replies and the
  P16 input budget is unaffected.
- **Our vendor id is what activates the BYOK utility-model path.** The harness computes
  `_hasByokModels = models.some(m => m.vendor !== "copilot")`, so *any* non-`copilot` vendor —
  including ours — makes Copilot report BYOK models as available, which is the precondition for the
  `chat.byokUtilityModelDefault: mainAgent` setting existing. The Copilot-utility-flows orphan-session
  risk described above is therefore a direct consequence of our vendor id, not an accident; the
  recommended `"copilot"` value is the avoidance.
- **The `copilotcli` vendor is not a route to us.** The harness registers a second
  `copilotcli` provider whose `languageModelChatProviders` entry is `"when": "false"` and whose
  `provideLanguageModelChatResponse` is an **empty no-op** (`provideLanguageModelChatInformation`
  returns `[]`, `provideTokenCount` returns `0`). The in-editor CLI / agent-host session model list
  comes from the Copilot CLI SDK catalog (`copilotCLISDK.getAvailableModels()`), not from
  `vscode.lm`, so this extension cannot be selected there — and no out-of-VS-Code harness can be
  handed a local extension provider in the first place.
- **Two host capabilities the published type surface does not describe are handled** (runtime-only,
  verified at runtime): `LanguageModelChatMessageRole.System = 3` (resolved by cast, mapped to
  `role:"system"`) and `completion_tokens_details` on the streamed usage chunk (forwarded when
  present). Both were silent losses before; see `../copilot-harness-modes.md` §3e.

## Agent-host BYOK visibility (Agents window / Copilot SDK) — local-only gate

Getting `OpenRouter: RC` into the agent-host / Agents-window / Copilot-SDK model list needs **two**
gates, and the second is unreachable from a remote workspace. Code-traced in the installed Copilot bundle; the
full evidence sits in [`../copilot-harness-modes.md`](../copilot-harness-modes.md) §3e item 6.

1. **Client permission** — `chat.clientByokEnabled` (§3e item 1 of the doc). Necessary, not
   sufficient.
2. **Agent-host root config** — the node side populates its BYOK model list only when `byokModelsEnabled`
   is **strictly `true`** (`function zw(r){let i=r===!0; …}`) in the agent host's **own** root config
   file (`globalStorage/agent-host-config.json`), never in `settings.json`. The declaration carries
   `agentHost:{key:'byokModelsEnabled',scope:'local'}` and is written by the Agent Host settings
   editor, which is hard-wired to the local identity
   (`agent-host-settings://local/settings.jsonc`, `workbench.action.chat.openAgentHostSettings`).
3. **The mirroring filter withholds `scope:'local'` from remote hosts** — `Uto(resource)` maps the
   local identity to kind `0`, any `vscode-remote://` resource to `1`; `ubr(scope, kind)` admits
   `local` only for `0`. A WSL / Dev Container / SSH agent host is kind `1`, so it never receives
   `byokModelsEnabled` (nor `defaultShell`, `runtimePath`, `skillCharBudget` — the four local-scope
   agent-host keys). Measured: remote `agent-host-config.json` = **53** keys, key absent; Windows =
   **57** keys, key `true`.
4. The node entry always asks for the renderer-backed bridge
   (`byok:{kind:'renderer',bridgeRegistry}`); an unsupported topology falls back to a stub whose
   `start()` rejects with `"BYOK is not supported in this agent host"`.

A **third** gate stacks on top even locally: the sessions/Agents window loads only extensions whose
manifest has **no code** (`canExecuteOnSessionsWindow`: `if (manifest.main || manifest.browser) return
false`) and whose contribution points are all in `SESSIONS_WINDOW_ALLOWED_CONTRIBUTION_POINTS`
(`themes`, `iconThemes`, `productIconThemes`, `colors`, `keybindings`, `jsonValidation`,
`jsonValidationRegistry`, `localizations`, `grammars`, `languages`) — bypassable via the user setting
`extensions.supportAgentsWindow`, or (with `extensions.experimental.enableAgentsWindowCapability`)
`capabilities.agentsWindow.supported` + the `agentsWindowActivation` proposal. This extension has
`main` and contributes `languageModelChatProviders`, so it is refused there. **Do not add either opt-in
unless the user asks** — it addresses only the local case and adds a proposed-API dependency.

**Upstream, not our defect:** microsoft/vscode#332085 (primary; OPEN, milestone Backlog), #339228
(closed as its duplicate), #325738, #329815, #333016 (also reproduces in a Dev Container). Peer
extension `mfenderov/opencode-copilot-sync` documents the same limitation and links #332085. It
affects **every** BYOK/custom-endpoint provider, because the bridge — not the provider — is what is
unavailable on the remote path.

**What still works:** regular Copilot Chat in a WSL window reaches this provider normally; the panel,
session spend and `session_id` behaviour are unaffected. Only the agent-host/SDK model list is short
of it. Working route today: a **local Windows** window, `chat.agentHost.byokModels.enabled` on, then a
full restart.

**Contrast (why assets look more consistent than models):** customization is handed to the agent host
as a **list** — `skillDirectories`, `skillReadRoots`, `selectedCapabilityRoots` keyed by
`environmentId` — so a WSL-window agent host is observed to see skills from **both** the WSL-side
and the Windows-side locations, while BYOK **models** hang off one per-host root-config boolean that
the local-scope filter withholds from a remote host. (Observation: the user's, on a test setup.
Mechanism: code-traced. Environment aggregation itself: not verified.)
