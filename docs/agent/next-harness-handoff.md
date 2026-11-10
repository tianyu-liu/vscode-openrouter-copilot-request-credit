# Next agent harness handoff

Checkpoint: **2026-11-10**, development build **0.5.0-test.3**. This document accompanies the commit
that consolidates the group editor and removes custom proxy allowances. Record `git rev-parse HEAD`
and `git status --short` before probing; the version string alone does not identify a candidate.

The next task is independent probing and reassessment. The implementation is ready to inspect, but
native UI and packaged-runtime acceptance are incomplete. Read [AGENTS.md](../../AGENTS.md),
[the current plan](../multi-provider-plan.md), [verification status](verification.md), and the
[native grouping evidence](native-model-groups.md) before deciding what to change.

## Current behavior and product decisions

- Two visible connection modes: **Direct OpenRouter** and **OpenRouter proxy**. Direct mode fixes the
  official base URL and retains per-connection credit tracking, account presets, and model filtering.
  Proxy mode uses a configurable API URL, server model catalog, and streaming Chat Completions.
- **Save connection** saves name, mode, URL, enabled state, and replacement credential together.
  A grey masked placeholder represents the saved key; the actual input starts blank. Blank retains
  the key, **Clear key** removes it immediately, and saving with no key is always allowed. Whether
  a request needs authentication is determined by the endpoint; direct OpenRouter requests need a key.
- Changing an endpoint with a saved key requires clearing it first or supplying a replacement in
  the same save. All non-direct paths reject trimmed, case-insensitive `sk-or-` credentials before
  network use. Raw credentials never enter webview drafts or registry metadata.
- Panel selection controls editing and the status bar. The model selected in Copilot determines
  routing. Connection IDs remain stable across renames; native handles/selections may need reselecting.
  Default names are **OpenRouter: RC**, then **OpenRouter: RC1**, **OpenRouter: RC2**, and so on.
  Existing user-chosen names are preserved.
- Both supported modes retain OpenRouter request fields, including session/reasoning/cache behavior.
  Proxy catalogs are authoritative: discovery failure or an empty list offers no fallback models.
  Unknown pricing remains unavailable; returned token counts/costs are tracked locally per connection.
- **There is no proxy allowance/balance feature.** Custom endpoint/schema support, fixed budget lanes,
  the checkbox, and background allowance reads were removed at the user's request. Proxy refreshes
  do not query balance, credit, or preset APIs. Do not reintroduce deployment-specific assumptions.
- Internal `gateway` means proxy. Saved `openai-compatible` records are legacy compatibility only:
  their runtime behavior persists until an explicit Save converts them to proxy mode. Conversion
  preserves ID, allowed credential, and scoped history/settings, and removes manual model definitions.
  Obsolete `proxyAllowance` fields are discarded. No third mode appears in the editor.

## Evidence available at this checkpoint

| Check | Result and limits |
| --- | --- |
| Strict TypeScript compilation and integration suite | 562 passing on Linux, VS Code 1.145.2, 2026-11-10. Extension requests/secrets are stubbed; this is not a live-service or interactive UI run. |
| Packaging | Current candidate builds a VSIX. Removed allowance code, development fixtures, tests, and scratch data are absent. Installed activation of this exact package is pending. |
| Panel | Final editor/proxy tab reviewed in Chromium at 1000px and 380px widths. Earlier native form checks cover mode switching, keyless saves, prefix rejection, and fixed direct URL. A browser preview does not prove VS Code command/native group wiring. |
| Refresh boundary | A temporary compiled-extension harness checked 18 proxy cases with old flags and token/keyless/blocked-key states: no HTTP or direct preset reads. A direct positive control still reads key/credit data; disabling the proxy guard fails the no-fetch check. This harness is scratch evidence, not a committed test command. |
| Independent review | Source review found no remaining actionable issues after the keyless-proxy fix and allowance removal. Review does not replace runtime probes. |
| Earlier normal-host and live checks | Copied-module persistence/routing, an older installed package, and bounded direct/proxy tool-streaming checks passed. Those are historical evidence, not activation or end-to-end acceptance of this candidate. |

## Probe order

Use isolated profiles, dummy credentials, and intercepted HTTP responses first. The user's preferred
interactive entry point is the existing **Run and Debug → Run Extension (dev host, no watch)**.
For automated probes, create a separate client profile and extensions directory. Preserve the user's
current VS Code window and native model configuration. A disposable profile does **not** isolate the
OS keychain: activation/migration could still read real legacy credentials. Install fake/in-memory
SecretStorage and fetch interception **before activation**, including for normal installed-package
checks. Use an isolated persistent fake credential store for cross-process persistence probes.
Automated tests use fetch stubs and never touch the network or real keychain. An actual local HTTP
server harness is a separate, explicitly scoped integration probe; live-service probes need separately
authorized credentials and scope. If interception cannot be established, mark that probe unrun.

1. **Packaged activation and production wiring.** Build/install the candidate in a disposable normal
   client profile with the pre-activation interceptors above. Verify activation, management command, Settings/named tabs, two mode choices,
   model discovery, and one controlled streamed/tool response through the registered provider.
   Record the loaded extension path and client version so an older installed copy cannot explain a result.
2. **Native group lifecycle and settings writes.** Exercise actual Add, Rename, Disable/Enable, and
   Delete actions. Confirm both registry and native JSON agree after success, cancellation, and error.
   Select the same upstream model through two groups, edit native reasoning/context settings, and
   check isolation. Observe saved chat selections/pins across rename, reload, and restart; do not
   assume they survive a rename just because the permanent connection ID does.
3. **Group form and credentials.** Combine rename/type/URL/key changes in one save; test no key,
   blank-key retention, replacement, immediate clearing, Cancel, and unsaved drafts during refresh.
   Attempt `sk-or-` input and a retained direct key during conversion; confirm rejection before any
   proxy request and that Clear key still recovers. Never record actual secrets in evidence.
4. **Routing and failure isolation.** Simulate two endpoints with the same model ID through fetch stubs. Check
   request URL, original upstream ID, template, authentication presence, and per-connection spend.
   Switch panel tabs independently of Copilot selection. Change/delete/disable a connection while
   discovery or streaming is pending; test catalog errors, 401, missing metadata, redirects, retries,
   and cancellation. Distinguish transport bugs from server rejection of unsupported request fields.
5. **Normal-host persistence and migration.** Restart a normal client, not only an extension-test
   host, and verify IDs, credentials, requests, context choices, and history. The integration runner's
   memento storage cannot establish cross-process production durability. Probe legacy conversion
   and obsolete-flag cleanup against disposable fixture data, including interrupted saves.

Report each result as pass, failure, or unrun, with candidate commit, client/profile, reproduction,
observed request/state/UI effect, and the limitation of the harness. Group recommendations into
reproducible defects, missing acceptance evidence, and optional product decisions. Prefer the smallest
useful next change based on the findings; do not implement a new endpoint abstraction just to complete
a checklist. Direct OpenRouter inherited-budget presentation is a pending implementation/scope
decision, separate from the verification gaps above.

## Reproducible entry points

```bash
npm run compile
npm test
npm run package
npm run preview
npm run test:groups
```

The integration suite launches a disposable VS Code test profile. A headless Linux host needs a
display/Xvfb; clear inherited `VSCODE_*` variables when launching a separate client to avoid reusing
the active host's agent sockets. Use the repository's existing VS Code tasks where available.

`test:groups` is a static grouping prototype with its own fixture extension, not production registry
or native menu acceptance. Its runner supports `OPENROUTER_RC_VSCODE_EXECUTABLE` for a specific client.
The panel preview uses representative fixtures and an API stub, not real VS Code persistence.

For wire evidence, the existing **Run Extension (dev host, request dump)** configuration sets
`OPENROUTER_RC_DEBUG=1`. Dumps go under ignored `tmp/` and contain verbatim prompts/tools. Do not
commit or share them without redaction. A missing dump in a host started without that environment
variable is not evidence that no request ran. Keep TLS verification enabled.

If a reused checkout still contains compiled files for deleted allowance sources/tests, remove those
specific stale outputs or perform a clean build before testing/packaging: TypeScript does not delete
output files when their source files disappear. Compare the package contents rather than relying
only on a successful build.
