# Multi-provider endpoint update plan

Status: in progress for **0.5.0**. Current development build: **0.5.0-test.3**.

Implemented: recoverable connection migration, multiple OpenRouter connections, generic streaming
Chat Completions endpoints, connection-scoped model IDs/accounting, the regrouped panel,
explicit gateway allowance lanes, and conservative gateway discovery. The existing package/vendor
identifiers are retained. The isolated grouping prototype remains available as
`npm run test:groups`; see [native grouping verification](agent/native-model-groups.md).

A normal isolated host also exercised the production panel, native groups, key rotation, per-connection
template saves, rename, restart persistence, and generic inference through `vscode.lm`, with fake keys
and stubbed fetch responses. Subsequent read-only checks verified real management access and gateway
HTTPS health, discovery, and both allowance lanes. The gateway adapter now implements
[the located contract](agent/gateway-allowance.md), including independent unknown/stale lane states.
Bounded live provider checks passed for gateway tools/continuation, a direct same-model control,
allowance refresh, and connection-isolated accounting; see [verification status](agent/verification.md).
The packaged test.3 VSIX also passed installed activation in an isolated profile with fake credentials.

Use **named connections, each appearing as a separate Copilot model group**. Users can configure several
OpenRouter keys, custom OpenAI-compatible endpoints, or both—for example, “Personal OpenRouter,”
“Work OpenRouter,” “Local Server,” and “Lab Gateway.”

The handoff’s Cheap/Default/gateway setup becomes one supported configuration. Connection names, budgets,
and model restrictions stay user- or server-defined.

## 1. Verify native VS Code grouping first

Verify configured provider groups against the installed VS Code client's API and runtime behavior.
Start with a small prototype proving add, rename, remove, reload, and duplicate model IDs on that client;
do not infer support from a release number.

Keep the existing extension vendor ID and package identifiers. Give every connection a permanent internal
ID independent of its name. Verify how renaming affects VS Code’s saved model selection; preserve
extension-owned preferences by connection ID.

Prototype findings: configured groups work on the checked installed runtime. Native model identifiers
include the group name, so rename retires previously acquired model handles even when the provider model
ID stays constant. Native model-settings updates can select an existing same-vendor settings entry by
provider model ID before resolving its group. Expose connection-scoped model IDs and retain the upstream
ID separately. A normal isolated host verified preference durability across restart/rename, and its
management UI rendered separate groups and completed a native rename. Do not promise preservation of
native saved selection or pins across rename; verify those surfaces and the remaining menu actions in
an isolated UI before completing the grouping gate.

## 2. Introduce a connection registry and safe migration

Each connection owns its:

- Name, endpoint type, normalized API base URL, and enabled state.
- SecretStorage credential.
- Request template, presets, discovery caches, and model preferences.
- Allowance state and spend attribution.

Migrate the existing key, template, context choices, and history into one default OpenRouter connection.
Migration must be repeatable and recoverable after interruption. Never assign the old key to Cheap or
duplicate it across connections.

This replaces singleton assumptions in [storage.ts](../src/storage.ts) and
[provider.ts](../src/provider.ts).

## 3. Separate endpoint behavior through adapters

| Connection type | Discovery and inference | Additional features |
| --- | --- | --- |
| Direct OpenRouter | OpenRouter catalog and streaming Chat Completions | Presets, routing, session identity, key/credit APIs |
| OpenAI-compatible | `/models` and streaming `/chat/completions` | Endpoint-supported features; manual model configuration where needed |
| Gateway profile from the handoff | Filtered catalog and streaming Chat Completions | Separate allowance lanes through origin-relative `/lab/allowance` |

Shared code handles transport, streaming, cancellation, tools, and images. Adapters control reasoning
fields, usage requests, session fields, caching behavior, presets, and allowance APIs.

Start with **Chat Completions compatibility**. Responses-only endpoints and additional authentication
protocols can follow.

## 4. Make model identity and requests connection-aware

Identify models internally by connection ID plus upstream model ID. Identical models on different
connections remain independently selectable; requests send the original upstream ID.

Capture the connection, endpoint, credential, template, and model configuration at operation start.
Panel changes must not reroute an in-flight operation. Version caches so an old refresh cannot overwrite
newer configuration.

Preserve the existing OpenRouter request behavior. Generic endpoints receive only their supported
automatic additions; users retain the paste-apply JSON workflow.

Retry within the selected connection. Never silently switch credentials, origins, or budgets.

## 5. Handle incomplete custom-endpoint metadata honestly

Standard OpenAI model listings often omit context limits, pricing, tools, vision, and reasoning support.

Add manual model IDs and compact metadata overrides, with clearly marked conservative defaults where
necessary. Preserve OpenRouter metadata when gateways provide it.

Update [modelInfo.ts](../src/modelInfo.ts) so missing prices display as unknown and incomplete models do
not inherit the current assumed 1M context window or tool support.

## 6. Generalize allowance and session accounting

Keep local chat identity separate from endpoint-specific wire fields. Include the connection in
accounting routes and scope parent-attribution state to prevent cross-connection contamination.

- Direct OpenRouter: account for effective/inherited budgets.
- Gateway: show each allowance separately, including stale, partial, and unknown states.
- Generic endpoint: show reported token usage and cost where available; otherwise mark cost unavailable.

Never add daily and weekly allowances together, or treat direct and gateway access to the same upstream
keys as extra budget.

Refactor the global refresh state in [extension.ts](../src/extension.ts) and extend the pure accounting
logic in [logic.ts](../src/logic.ts).

## 7. Extend the existing management panel

The panel now has **Settings** and one tab per named connection.

- **Settings → Keys:** connection list, Add/Edit/Enable/Disable/Delete, API type/base URL, name, and key.
- **Settings → shared settings:** output reserve, usage refresh frequency, and text sanitization.
- **Connection tab:** key usage, session spend, local budget, model availability, presets/request JSON,
  and manual model metadata for compatible endpoints.

The selected connection controls its credentials, allowance display, and request configuration. Panel
selection affects editing; the model selected in Copilot determines routing.

Keep the current paste-apply editor. Hide unsupported preset/credit controls, label spend by connection,
and make the status bar identify which connection it displays. Update localization, preview fixtures,
and documentation.

## 8. Validate in staged milestones

Implement in this order:

1. Grouping prototype — implemented; saved picker selection/pins and full native menu checks remain.
2. Registry and migration — implemented with failure-injection coverage.
3. Multiple OpenRouter connections — implemented and exercised in the real client using fixtures.
4. Generic endpoint adapter — implemented for streaming Chat Completions and manual metadata.
5. Gateway allowance support — implemented with [contract validation](agent/gateway-allowance.md),
   per-connection refresh isolation, separate effective interval budgets, and no catalog fallback.
6. UI completion — shared/per-connection regrouping implemented, localized, and browser/client checked.

Direct OpenRouter credit behavior is retained per connection. Its effective inherited account budget
presentation remains pending. Gateway lanes are implemented and never summed into a combined limit.

Regression coverage should include migration failures, duplicate model IDs, concurrent requests,
credential rotation, stale refreshes, deletion, missing metadata, and connection-isolated accounting.
Gateway discovery must fail closed.

Run compile, integration tests, and packaging. Then verify native groups and packaged activation in an
isolated client profile. With authorized credentials, test streaming, tools, allowance displays, and
connection isolation against real endpoints. Preserve TLS verification and prevent authenticated
cross-origin redirects.

The main design risk is native group lifecycle integration. Resolve that before the broader refactor.
