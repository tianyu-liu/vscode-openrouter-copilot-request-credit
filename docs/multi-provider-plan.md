# Historical named connections plan

This document records the two-mode design at the **2026-11-10** development checkpoint
(`0.5.0-test.3`). The 0.5.0 release supports named direct OpenRouter connections.
Saved proxy records are preserved and inactive. See the [README](../README.md) for usage and
[verification status](agent/verification.md) for the release evidence.

## Development design at that checkpoint

Use named connections, each appearing as a separate Copilot model group. A connection's permanent ID
is independent of its name and owns its credential, request template, model preferences, session
identity, spend, and refresh state. Panel selection controls editing/status display; the model selected
in Copilot determines routing. Keep the existing package/vendor identifiers.

| Mode | Discovery and inference | Additional features |
| --- | --- | --- |
| Direct OpenRouter | Fixed OpenRouter API URL, catalog and streaming Chat Completions | Optional account-availability filter, account credits, presets, routing, session/reasoning/cache fields |
| OpenRouter proxy | Configurable API base URL, authoritative server catalog and streaming Chat Completions | OpenRouter request fields; local token/returned-cost tracking |

A proxy manages OpenRouter access rather than providing a general-purpose endpoint mode. Its catalog
is authoritative, including an empty list. Discovery errors never fall back to an unrestricted
catalog or manual model definitions. It never calls direct OpenRouter credit or preset APIs.
Missing model metadata uses conservative limits/capabilities and unknown pricing.

Proxy usage consists of locally tracked token counts and returned costs. Missing cost remains
unavailable. No custom proxy allowance/balance API or setup is supported. Direct OpenRouter credit and
preset APIs remain direct-only. Old custom allowance flags are ignored and removed from registry data.

## Connection lifecycle and editor

- Shared **Settings → Group management** offers only the two supported modes, with one form and
  **Save connection** action for name, type, URL, enabled state, and key.
- Direct mode fixes/disables the OpenRouter URL. Proxy mode restores its custom URL draft when toggled.
- A saved key appears only as a grey masked password-field placeholder. Blank input retains it;
  **Clear key** is a separate immediate action. A neutral keyless state and keyless saves are valid.
- All non-direct modes reject trimmed case-insensitive `sk-or-` credentials at form/save/network
  boundaries. Use the proxy's own token or no key. A changed endpoint requires clearing or explicitly
  replacing an existing key; metadata and credentials commit together.
- Nonsecret editor drafts survive Clear key refreshes only while saved metadata matches. Raw credentials
  never enter persisted webview drafts. Cancel discards editor drafts.
- Connection tabs own usage, session spend, request JSON, and supported direct account controls.
  Shared Settings holds output reserve, refresh frequency, and text sanitization.

Existing `openai-compatible` records are migration compatibility only. They keep their previous runtime
behavior until explicitly saved as an OpenRouter proxy. The editor still presents two choices and
explains the pending conversion. Saving as proxy retains the permanent ID, allowed credential, and
scoped state while removing manual model definitions. Do not silently reinterpret old requests on load
or present generic providers/manual models as a third supported product mode.

## Implemented foundations

Recoverable migration copies the existing key, template, context choices, and history into one default
OpenRouter connection. It is repeatable after interruption and never duplicates a key into another
connection. Registry mutations and isolated SecretStorage references are revisioned; staging slots and
post-commit cleanup are recoverable.

Model IDs encode connection ID plus upstream model ID; requests send the original upstream ID.
Duplicate models remain independently selectable. Connection-scoped IDs avoid shared-ID ambiguity;
native settings-menu writes still need runtime verification. Each operation
captures endpoint, credential, template, and model configuration. Retries keep that captured connection;
old refreshes cannot overwrite newer configuration. There is no silent credential/origin/budget switch.
TLS verification stays enabled and authenticated redirects are refused.

Named groups and the regrouped/localized panel are integrated. Fixtures in a normal isolated client
exercised key rotation, template saves, rename/restart persistence, and duplicate model routing. Earlier
compatible-endpoint fixture inference is historical compatibility evidence, not a generic-provider
product promise. Bounded live provider checks exercised proxy tools/continuation, a direct same-model
control and isolated accounting in the earlier implementation. A packaged test.3 VSIX also passed installed
activation using fake credentials. See [verification status](agent/verification.md) for evidence and limits.

The current source passes strict compilation and **562 integration tests** on VS Code 1.145.2
(2026-11-10). Packaging also succeeds and excludes removed allowance modules and development fixtures.
Latest-candidate installed activation and native UI acceptance are still pending. Use the
[next harness handoff](agent/next-harness-handoff.md) to probe this checkpoint before choosing more work.

## Remaining release gates

The main design risk is native group lifecycle integration. Runtime support must be checked on the
actual installed client rather than inferred from a release number. Native group names form part of
VS Code's internal model identifiers, so rename retires old handles. Permanent connection IDs preserve
extension-owned preferences, but saved native selection/pins must not be promised to survive rename.

Finish native Add/Delete confirmation in a normal isolated profile, saved chat selection/pins after
rename/reload, and native settings edits with the same upstream model on two connections. The prototype
and prior UI observations are recorded in [native grouping verification](agent/native-model-groups.md).

Direct OpenRouter credit behavior is retained per connection. Its effective inherited account-budget
presentation remains pending. Proxies display local usage and returned costs only.

The regression suite already covers migration/rotation/deletion failures, duplicate model IDs, stale
refreshes/handles, captured retries, missing metadata, credential syntax rejection, legacy compatibility,
explicit conversion, and connection-isolated accounting. Separate extension-harness checks cover zero
proxy balance/preset calls. Repeat relevant checks when code changes, rather than treating them all as
unstarted work.

Next, verify the packaged candidate and native lifecycle interactions in a normal isolated profile.
Probe production wiring, persistence, error recovery, and credential/request isolation through actual
UI actions and controlled server responses. Reassess the remaining design and release work from that
evidence. Scoped live tests require authorized credentials. Keep fixture versus live and installed-package
versus copied-module evidence distinct.
