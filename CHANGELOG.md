# Changelog

## 0.4.0

Highlights since 0.3.x:

- **Presets in the model picker:** presets that pin a model appear as `@preset/<slug>` entries, and the panel's Presets dropdown applies an account preset to every request.
- **Context size menu:** models with a long-context price step get a native picker menu of fixed prompt budgets (one per price step plus the whole window), with small-size advisories and a default near 256K.
- **Hide models this key cannot use:** the picker intersects the catalog with the account's available-model list (on by default) and falls back to the full catalog when the query fails.
- **Output reserve settings:** a target percent plus lower and upper token limits control the reply budget held back when OpenRouter publishes no real max-completion cap.
- **Base64 prompt safeguard:** long base64-like runs in request text (messages, reasoning, tool-call arguments) are stripped before sending (image attachments are never touched), with one automatic retry if a guardrail blocks the request.
- **Session spend panel:** one collapsible entry per chat with a row per provider/model route and a cache-read rate per route, plus an `Unattributed (no chat id)` entry for spend that has no chat to charge.
- **Session labels:** panel entries show the Copilot chat title when VS Code has one and the session's last-update time.
- **Reasoning passthrough:** reasoning traces render in chat and prior turns' reasoning is echoed back on assistant messages, so thinking-mode requests that carry tools keep working.

### Fixes

- A turn that produced only a tool call no longer ends with a stray empty text part.
- Models priced at an explicit zero no longer report a misleading credit figure.
- The Thinking Effort selector now pre-selects the off choice for models whose catalog marks reasoning off by default.
- Image attachments now contribute to the token estimate (pixel-area based, with a bounded fallback) instead of counting as zero.
- Upgrading from the retired margin-based context setup restores the pre-margin saved caps and clears the old state; the removed `contextSafetyMarginPercent` and `contextWindowPolicy` settings no longer apply, and a stepped model without a saved Context size uses the default near 256K.
