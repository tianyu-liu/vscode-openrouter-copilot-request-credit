# Request pipeline

## Paste-apply semantics

- The pasted body's **`messages`/`prompt` fields are ignored** — Copilot supplies the live conversation and tools each turn; they are merged with the saved template.
- The template applies to every request until cleared/replaced. Default when nothing is pasted: no `provider` object — OpenRouter's own routing applies and nothing is assumed.
- A template `provider` object is sent **verbatim**: no default is merged in and none is added, so routing comes entirely from the pasted `provider`. No separate setting exists (the former P7 floor and its merge are gone).
- `reasoning.effort`/`reasoning.enabled` always come from the picker's Thinking Effort selector and are spread into the template's `reasoning` object — they overwrite only `effort`/`enabled`; other keys like `max_tokens`/`exclude` survive.
- Validate the pasted JSON before saving: bad input is rejected with a clear error, never partially applied.

## Reasoning passthrough (P1)

DeepSeek V4 has thinking mode **on by default**, so every reply carries `reasoning_content`
(OpenRouter treats it as an alias of `reasoning`). The echo rule is conditional: when a
request carries `tools` (Copilot agent mode always sends tools), all prior turns' reasoning
**must** be passed back or the API 400s; without `tools` the echo is ignored. Copilot
preserves only what we emit, so the round-trip is symmetric: report `LanguageModelThinkingPart`
from `delta.reasoning`, and collect prior thinking parts in `toOpenAI` into a `reasoning`
string on the outgoing assistant message. As a display fallback, when `delta.reasoning` is
absent, flatten `delta.reasoning_details` by type (`reasoning.*`/`summary`/`text`/`final` →
thinking; `response.*` → text). Raw `reasoning_details` blocks (e.g. Claude's encrypted ones)
cannot round-trip through Copilot's flattened ThinkingPart — string echo is the mechanism;
never accumulate raw blocks for echo. P6 (`cache_control` for Claude) is applied:
anthropic-family models (`anthropic/*`, incl. `~anthropic/*`) get a top-level
`cache_control: {type:"ephemeral"}` in `buildRequestBody` unless the template already sets
its own `cache_control` (a template value wins, incl. an opt-out via `null`). It is a
5-minute ephemeral breakpoint that advances with the conversation; a template can extend it
(e.g. `"ttl": "1h"`). Per-block markers for Qwen/Gemini stay deferred until a suitable entry
is piloted; OpenRouter outputs `cache_control` ↔ `prompt_cache_breakpoint` translation
blocks across families since ~Sept 2026, but this extension only emits the top-level Anthropic
form so far. The harness does not supplement it: the harness's own cache-breakpoint parts are vendor-gated to `{anthropic, gemini, openrouter}`, which excludes this extension's vendor id (`openrouter-copilot-request-credit`; the built-in `openrouter` *vendor* is in the set), so the P6 top-level marker is the only cache signal that ever leaves the extension.

## Enforced behaviors

These are not user-configurable; the escape hatch, where one exists, is the pasted template.
The panel's short, context-specific notes are the user-facing version of this list.

- `stream: true` on every request (the provider API is progress-callback based).
- `session_id` = `copilot-chat:<Copilot chat-session id>` so OpenRouter sticky routing and
the Sessions view follow the Copilot chat session, not the window (cache warmth + grouping;
no content). With no known parent (an internal/utility call before any chat turn, or one long after
the last) **no `session_id` is sent at all**, so no orphan OpenRouter session is ever created.
- `model`/`messages`/`tools` always come from Copilot; template copies are stripped.
- `tools` map 1:1 to Copilot's list, each function carrying `name`, `description`, and
  always a `parameters` object (an absent `tool.inputSchema` becomes
  `{type:"object",properties:{}}`; an empty `tools` array is omitted). Copilot's
  `toolMode` is honored: `Required` sends `tool_choice:"required"` unless the template
  sets its own `tool_choice`. **In practice this branch is inert for Copilot-driven
  turns** — the harness's endpoint class never puts a `toolMode` key in the
  `modelOptions` bag it forwards, so core's `toolMode: i.toolMode ?? 1` default always
  resolves to Auto; the mapping stays live only for another `vscode.lm` caller that
  sets the option explicitly.
- No default `provider` object is ever added; a template `provider` passes through verbatim
  in every case, so routing is decided by the pasted `provider`, never by a built-in default
  (the former P7 floor is gone).
- Reasoning effort/enabled from the picker, merged over the template's `reasoning`; a picker
  effort of `none` is sent as `reasoning.enabled: false`.
- Anthropic-family models (`anthropic/*`, `~anthropic/*`) get a top-level `cache_control`
  (5-min ephemeral, advancing) unless the template sets its own `cache_control` (P6).
- Attribution headers `HTTP-Referer`/`X-Title` hardcoded, and sent only on `/chat/completions` (not on `/models`).
- Endpoints are fixed to `https://openrouter.ai/api/v1`; there is no `baseUrl` setting.
- Key in SecretStorage only, never settings.json.
- Template applies to every request until cleared (the picker's model switch back to a
  Copilot model is the per-turn escape).
- Usage accounting needs no field: every Chat Completions stream ends with an automatic
  `usage` chunk (P5) — nothing to paste or request.
- That chunk is forwarded to Copilot as a `usage` data part on every completed turn (P10), which
  is what puts *used / max tokens* in the context-usage ring. The **Copilot response footer is not
  a supported cost surface** for an extension-contributed provider (see [the P10 correction](provider.md)), and
  cost is deliberately kept out of the chat transcript too — it is reported in the panel's
  **Session spend** section instead (P12), where the figure is OpenRouter's `cost`, or the upstream
  cost on a BYOK route where OpenRouter charges nothing.

## Canonical request templates

- Default: the empty template `{}` (paste nothing) — no default `provider` is added,
  so OpenRouter's own routing applies; any pin (`order`, `only`, a `quantizations` floor, …)
  is just a pasted `provider` object.
- Published example: the empty template `{}` — every feature is enforced or provided by the
  extension/OpenRouter itself; state the always-on behaviors (the P8 list) next to it so
  readers do not paste `stream`/`session_id`/`usage`.
- Power-user variants: `{ "provider": { "order": ["deepinfra"], "allow_fallbacks": false } }`
  (hard pin), or a `response_format` json_schema from the Request Builder, or an Anthropic
  cache TTL extension: `{ "cache_control": { "type": "ephemeral", "ttl": "1h" } }`.
- Preset: `{ "preset": "<slug>" }` — a slug from the account's own preset list (the panel's Presets dropdown saves this); the preset's routing then applies (no default `provider` is added), and model-pinned presets are also pickable as `@preset/<slug>` entries.
