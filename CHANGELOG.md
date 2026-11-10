# Changelog

## Unreleased

- Combine connection details, enabled state, and API key management in one group editor with a single
  **Save connection** action. Show saved keys as masked field hints, retain them on blank input, keep
  a separate **Clear key** action, and allow keyless saves. API type remains editable; OpenRouter fixes
  and disables its base URL.
- Reject OpenRouter key syntax on non-direct connections during saves and before authenticated network
  requests, including retained keys and legacy saved credentials. Proxy tokens and keyless saves remain allowed.
- Add named direct OpenRouter and OpenRouter proxy connections with isolated credentials, request settings,
  model identities, and session accounting; migrate the existing setup into one default connection.
- Regroup the panel into shared **Settings** and connection-name tabs. Settings manages connections,
  output reserve, refresh frequency, and text sanitization; each connection tab owns usage and requests.
- Offer exactly two connection modes: **Direct OpenRouter** and **OpenRouter proxy**. Proxies retain
  OpenRouter request fields and use the server catalog without manual additions or unrestricted fallback.
  Preserve older compatible connections until explicitly converted; retain unknown pricing and token-only usage.
- Block request redirects and stale connection selection; preserve captured request settings across retries.
- Remove custom proxy allowance APIs and configuration. Proxy usage uses locally tracked token counts
  and returned costs only; direct credit/preset APIs remain direct-only.
- Use conservative limits and capabilities for incomplete proxy metadata, and wrap session summaries
  on narrow panels.
- Use `0.5.0-test.3` for this development build.
- Replace the status bar's `OR` label with the official OpenRouter glyph, using Ink for light themes
  and Cloud for dark themes, including high-contrast variants and live theme changes.
- Remove the exact VS Code API-types pin, allow newer clients through an open-ended compatibility
  range, and make the multi-provider plan's grouping check depend on runtime capabilities.
- Include OpenRouter asset provenance and usage terms in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## 0.4.1

Localization release:

- **In-UI localization:** the panel, status bar, model picker cards, and error messages now use VS Code's `l10n` API, with `l10n/bundle.l10n.ja.json` and `l10n/bundle.l10n.zh-cn.json`; English remains the source language and the fallback.
- **Manifest localization:** display name, description, command titles, and setting descriptions are localized through `package.nls.json` plus `package.nls.ja.json` and `package.nls.zh-cn.json`.
- **Translated READMEs:** added [README.ja.md](README.ja.md) and [README.zh-CN.md](README.zh-CN.md), with a language switcher on every README.
- **Fix:** the panel's mode line ("No limit — …", "Local-set limit — …", "Key limit — …") is now translated; it stayed English even when a bundle was loaded.

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
