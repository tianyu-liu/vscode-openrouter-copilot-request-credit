# Next agent harness handoff

Checkpoint: **2026-11-18**, direct-only **0.5.0**. Record `git rev-parse HEAD`, the worktree state,
and the VSIX checksum before testing a candidate. Read [AGENTS.md](../../AGENTS.md) and
[verification status](verification.md) for scope and existing evidence.

## Current behavior and product decisions

- Each named connection has its own SecretStorage key, request template, native model group, and
  spend history. The API base URL is fixed to `https://openrouter.ai/api/v1`.
- **Settings → Group management** edits name, key, and enabled state. Leaving the key field blank
  retains the saved key. **Clear key** removes it. Open **Manage provider** after upgrading to set
  up the initial native group or adopt the existing group in the active VS Code profile.
- The selected panel tab controls editing. The selected Copilot model group controls routing.
  A rename preserves the connection ID, but users may need to reselect the model in Copilot.
- Enabled connections with a saved key can contribute a status-bar amount. Connection tabs
  control inclusion. Shared settings switches between **Remaining** and **Usage**.
- Production discovery, routing, and the panel accept only direct OpenRouter connections.
  Saved `gateway` and `openai-compatible` records and associated data are preserved in place.
  Internal tests can still exercise the retained adapters.

## Evidence available at this checkpoint

[Verification status](verification.md) records Linux Stable integration and installed checks.
The privacy-hardened package passed a fresh-install smoke on 1.146.0. An earlier 0.5.0 build
passed the upgrade and restart smoke on 1.145.2. Both used synthetic credentials. Windows/WSL
upgrades and current remote Copilot harness behavior remain unverified.

## Probe order

Use a separate VS Code profile and extension directory for installed checks. A disposable VS Code
profile may still access the OS keychain. Install fake SecretStorage and fetch interception before
activation when using synthetic credentials. Use persistent fake credentials for cross-process
checks. Record the candidate, actual loaded extension path, client version, and observed effects.

1. **Upgrade and native groups.** Install the candidate over 0.4.1, run **Manage provider**, and
   confirm the existing key, template, context options, and spend move to the initial group.
   Check Add, Rename, Disable/Enable, and Delete where lifecycle changes are in scope.
2. **Routing and isolation.** Select the same upstream model through two named direct connections.
   Confirm the original model ID and each connection's own key, request settings, and spend.
   Change the panel tab independently. Seed an inactive proxy record to check that it produces no
   requests and leaves its saved state intact.
3. **Harness symptoms.** Test picker availability separately from request delivery. For a
   session-attribution change, capture a synthetic streamed response and compare its reported
   usage and actual outgoing `session_id` with the connection's spend history. See
   [Harness boundary](harness-boundary.md) for the distinct Copilot SDK path.

## Reproducible entry points

```bash
npm run compile
npm test
npm run package
npm run preview
npm run test:groups
```

The integration suite launches a disposable VS Code test profile. Headless Linux needs a display
or Xvfb. If a separate client would reuse the active host's agent sockets, clear inherited
`VSCODE_*` variables. `test:groups` runs a static grouping prototype and accepts
`OPENROUTER_RC_VSCODE_EXECUTABLE` to target a particular client. The browser preview uses
representative fixtures and a stubbed webview bridge.

For wire evidence, **Run Extension (dev host, request dump)** sets `OPENROUTER_RC_DEBUG=1`.
The Extension Development Host writes `openrouter-requests.jsonl` to the extension log
directory. The log can contain prompts, tool content, and images. Installed builds ignore the flag.

Use a clean build when auditing package contents. TypeScript leaves generated output for deleted
sources in place, so inspect the VSIX itself.
