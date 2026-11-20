# Marketplace publishing

The [publish workflow](../../.github/workflows/publish.yml) tests the release on latest VS Code
Stable, builds a VSIX, and publishes that artifact using GitHub Actions OIDC. The publishing job
verifies the public Marketplace package against the uploaded file.

## Trusted Publishing policy

A publisher administrator creates the policy in [Marketplace publisher management](https://marketplace.visualstudio.com/manage/publishers/).
Open publisher `tianyu-liu`, select **Trusted Publishing**, and enter these values.

| Field | Value |
| --- | --- |
| Policy name | `OpenRouter RC release` |
| Repository owner | `tianyu-liu` |
| Repository | `vscode-openrouter-copilot-request-credit` |
| Workflow filename | `publish.yml` |
| Environment | Leave blank |

## Release

Update the manifest and lockfile to the same version and add the changelog entry. Push the release
commit to `main`, then push a matching tag such as `v0.5.1`. You can also run **Publish to VS Code
Marketplace** manually from `main` and enter the version in `package.json`.

The workflow grants `id-token: write` to the publishing job. Keep the two explicit proposed API
names aligned with the manifest. If only the final Marketplace check failed, check the public version
before rerunning the job because Marketplace versions are unique.

[Microsoft's Trusted Publishing documentation](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)
