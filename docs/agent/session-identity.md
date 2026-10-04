# Session identity (P11) — what survives a window reload

VS Code persists a local chat session's data (its `sessionId`, the transcript, thinking parts and each
response's token/credit usage) in the workspace's chat-session storage, so a reload or restart restores
the same conversation **with the same id**. The Copilot extension threads that id to
extension-contributed models as `options.modelOptions._conversationId` (the agent/tool-calling loop
passes `conversation.sessionId` into `makeChatRequest2`, `ExtensionContributedChatEndpoint` puts it in
`modelOptions`, and the extension host forwards `modelOptions` verbatim to
`provideLanguageModelChatResponse`). The extension therefore sends `session_id` =
`copilot-chat:<conversation id>`: **one OpenRouter session per Copilot chat session**, so sticky
routing and the Logs → Sessions view follow the chat, not the window, and cache warmth carries across
a reload. `_conversationId` is an internal, underscore-prefixed key with no public constant — always
read it defensively. Some internal calls do not pass it, and they fall in three families (see [P13](provider.md)
for the mechanism): a **generic `runSubagent`/custom-agent child agent loop** runs the same agent loop
as a normal turn and is handed the **parent chat's** `sessionResource`, so it *does* carry the id and
its turns join the parent's OpenRouter session exactly; the harness's **tool-style sub-agents**
(`execution_subagent` for the edit agent, `search_subagent`) and Copilot's **utility flows** (title
generation, progress messages, the inline-chat intent pass, NES) pass the id only inside
`telemetryProperties` and therefore have none — those are attributed to the **last active chat**
instead (persisted to `globalState` under `parentSession` so it survives a reload, bounded by the
10-minute `PARENT_ATTRIBUTION_WINDOW_MS`); and an **agent-host / SDK client-BYOK session** ([§Harness
boundary](harness-boundary.md)) never comes through the harness at all, so it is never attributed to a chat — its spend
appears in the panel's **Unattributed** entry (**P12b**) instead. For a call with no parent known
(harness-owned and past the window, or harness-less), **no `session_id` is sent at all**
(`sessionIdFor` returns `undefined`), so an unowned call can never mint an orphan OpenRouter
session. The id is capped at OpenRouter's
256-character `session_id` limit. Nothing in the session id is user content.

## Copilot utility flows (the orphan-session source).

Copilot drives background utility calls —
progress messages ("Polishing your code"), title generation, intent detection, and similar — through
`getChatEndpoint("copilot-utility-small")`, which resolves to the **selected main model**. With an
OpenRouter model picked and `chat.byokUtilityModelDefault` set to `mainAgent`, those calls land on our
provider with no conversation id. That is the shape of the historical orphan sessions (a bare UUID,
`calls: 2`, one per cached scenario: `generate` and `edit`). Recommend `chat.byokUtilityModelDefault:
"copilot"` so utility flows use Copilot's own small models and never reach OpenRouter; the P15
no-`session_id` rule is the backstop when they do.
