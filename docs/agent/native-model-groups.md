# Native model group prototype

This records the original `0.5.0-test.1` grouping prototype and its runtime findings. The prototype
remains development-only; `0.5.0-test.2` now integrates named connections in production through
`connections.ts`, `connectionProvider.ts`, and `nativeGroups.ts`. See [architecture](architecture.md)
for the current implementation and [the update plan](../multi-provider-plan.md) for remaining work.

## Run it

```bash
npm run test:groups
```

The runner defaults to the latest stable VS Code integration client. To check a particular installed
client, set `OPENROUTER_RC_VSCODE_EXECUTABLE` to its application executable (the Electron binary, not the
CLI wrapper). Linux needs a display, such as an isolated Xvfb display. The runner uses the standard
`@vscode/test-electron` launch arguments and leaves inference TLS behavior unchanged.

The runner creates a temporary fixture extension with the existing package/publisher/vendor IDs,
replaces activation with static discovery and response functions, and launches two sequential client
processes sharing one temporary profile. Each process uses a separate extensions directory from the
user's installation. The fixture never reads SecretStorage or calls an inference/discovery endpoint.
Inherited `VSCODE_*` environment variables are removed from child processes so the prototype does not
reuse the current host's agent sockets. VS Code's own background services may still run.

The temporary profile, fixture, and evidence file are removed on completion or failure. The final
evidence is printed to the console. Nothing under `src/test/` or its compiled output ships in the VSIX.

## Checked behavior

The installed remote runtime and matching cached desktop test client are VS Code 1.143.1, commit
`e646868227c3e3a9e3f24277c8c7220be42c0be7`. This records the inspected implementation; support is determined
by the actual APIs and runtime checks, rather than inferred from that version number.

The automated checks use `lm.addLanguageModelsProviderGroup` for creation and save the isolated profile's
native `chatLanguageModels.json` for settings, rename, and removal. Assertions run through
`vscode.lm.selectChatModels` and actual fixture responses:

- Add two named groups with separate permanent connection IDs.
- Independently select and route the same upstream model through both groups.
- Read different native model settings with connection-scoped public model IDs.
- Preserve extension-owned preferences by connection ID across rename and removal within one host.
- Rename a native group; a previously acquired model handle fails with its former native identifier,
  while a newly acquired handle works and retains the group's model settings.
- Remove a group; its former handle fails instead of switching to the remaining connection.
- Characterize raw duplicate public IDs: they coexist and route through their own native groups.
- Restart the client and restore the renamed native group, its route, and its native model settings.

The integration client deliberately uses **in-memory memento storage** when `--extensionTestsPath` is
present (`getStorageOptions` in the installed `out/mainImpl.js`). Consequently, this runner verifies
native JSON persistence across processes and connection-keyed preferences within a process. It does
not verify `globalState` durability across processes.

A separate normal-host check on the same client, without `--extensionTestsPath`, did verify durable
preferences: the first process saved `context:65536` for `fixture-a` and `context:32768` for `fixture-b`,
then quit gracefully. After a group rename in the isolated native JSON, the second process recovered
both values without writing them and routed both models independently. Read-only inspection of a
copied isolated profile database confirmed the stored values. Both processes exited successfully.
This observation is separate from the repeatable integration suite; repeat it when validating the
production registry/migration implementation.

An isolated normal-host UI check also confirmed that the native **Language Models** management page
renders separate Personal and Work groups with their own model rows. Its **Rename Group** action
updated both the rendered header and saved native JSON while preserving the connection ID. The
**Delete** menu action was visible and invoked, but completion could not be verified through the
renderer automation; it is not counted as a successful deletion check.

## Contracts for the connection implementation

The published `@types/vscode` preparation options expose `silent`. The inspected runtime also forwards
`options.configuration` for each configured provider group. It strips the native reserved fields
`name`, `vendor`, `range`, `modelsRange`, and `settings`; the extension must receive its own permanent
`connectionId` in the remaining configuration. The fixture types this additional field structurally,
matching the repository's existing defensive use of proposed API fields.

The fixture manifest declares a provider `configuration` schema requiring `connectionId` and omits
`managementCommand`. The production manifest's existing management command bypasses native group
configuration. Integrating native groups must account for that difference while retaining panel access.
Discovery with no configured connection returns no fixture models.

The extension host builds the internal native identifier as:

```text
<vendor>/<group name>/<provider model ID>
```

Public `LanguageModelChat.id` contains only the provider model ID. Group rename changes the internal
identifier even when that public ID is stable. Store extension-owned preferences and accounting by
permanent connection ID. Do not promise that native chat selection, pins, or recent-model entries will
survive a rename.

The inspected native `setModelConfiguration` implementation first looks for a same-vendor group with
`settings[model.id]`, before resolving the selected model's group. Raw duplicate public model IDs are
therefore ambiguous for native settings updates. This is a source-level finding; the fixture verifies
settings read-through and raw-ID routing, not the native settings menu's write behavior.

Use a connection-scoped provider model ID and keep the original upstream ID on the model information
object. The runtime retains that object and passes it to response/token-count callbacks. The fixture
demonstrates this with `<connectionId>::<upstreamId>`; the registry milestone must finalize a collision-
safe encoding and send only the original upstream ID in API bodies.

## Remaining gate and release checks

The automated prototype does not exercise native menu actions or visual grouping in the Copilot
picker. The separate UI observation covers management-page rendering and Rename Group. Before
declaring the grouping gate complete, finish native Add/Delete confirmation in a normal isolated
profile, saved chat selection and pins after rename/reload, and native settings edits with the same
upstream model on two connections.

The production implementation was also exercised in a normal isolated client using copied compiled
modules, the production manifest, fake SecretStorage, and stubbed fetch responses. It rendered Settings
and named tabs, isolated key rotation and template saves, renamed a native group, restored those values
after restart, and streamed a generic response through a real `vscode.lm` model handle. The captured
fixture request used the intended endpoint, rotated key, original upstream ID, and saved template.

A packaged production rollout remains release verification work. Later live streaming/tool checks are
recorded in [verification status](verification.md); fixture success alone does not establish live endpoint compatibility.
