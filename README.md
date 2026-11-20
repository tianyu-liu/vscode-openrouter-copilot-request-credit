# OpenRouter for Copilot with Custom Request & Credit Check

**English** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

Use multiple OpenRouter API keys in Copilot Chat. Each named connection has its own key, request settings, model group, and spend history. The extension uses the fixed OpenRouter API at `https://openrouter.ai/api/v1`.

## Install and quick start

Install or update from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=tianyu-liu.openrouter-copilot-request-credit), or select **Install from VSIX…** in the VS Code Extensions menu and choose the release VSIX.

1. Run **OpenRouter: Manage provider** from the Command Palette or click the OpenRouter status-bar icon.
2. Under **Settings → Group management**, select **OpenRouter: RC**, enter your OpenRouter API key, and select **Save connection**. To add another key, choose **Add connection**, enter a different name and the key, and save.
3. In Copilot Chat, select a model from the group for the key you want to use. To switch keys for the same model, pick it from a different group.

When upgrading from 0.4.1, the extension imports your existing key, request settings, context choices, and spend history into **OpenRouter: RC**. Open **OpenRouter: Manage provider** after updating so VS Code can set up the model group or adopt the existing group in your profile.

## Manage connections and requests

- Use **Settings → Group management** to rename, enable, or disable a connection. Leave the key field blank to keep the saved key, or choose **Clear key** to remove it. Select the model again in Copilot after replacing its key or re-enabling the connection. Renaming can also require reselection. If the group is missing or has been renamed in VS Code, select **Repair model group**.
- Open a connection's tab to check credit usage and session spend, configure model availability, or choose an OpenRouter preset. Selecting a preset replaces that connection's saved request. The model you select in Copilot determines which connection sends the request.
- Build a JSON request in the [OpenRouter Request Builder](https://openrouter.ai/request-builder), paste it into **Custom request** in the intended connection's tab, and select **Save request**. Options such as provider routing, sampling, and cache controls apply to that connection until you clear or replace the request. Copilot supplies the model, messages, and tools.

### Status bar

The OpenRouter icon appears beside amounts such as `$12.40 | $8.20`. Hover to see the connection names and details in the same order. Enabled connections with a saved key are included by default. Use **Show this budget in the status bar** in each connection's tab to choose which amounts appear.

Under **Settings → Shared settings → Status bar shows**, choose **Remaining** (the default) or **Usage**. The VS Code setting is `openrouterCopilot.statusBarBudgetDisplay` (`remaining` or `usage`). The remaining amount is based on the key's reported limit, your local display limit, or the available account balance. OpenRouter enforces server-side limits.

### Shared settings

- **Usage refresh interval** defaults to 5 minutes.
- **Output reserve** sets aside tokens for the reply. When OpenRouter has no reliable output cap, the default reserve targets 12.5% of the context window, bounded by 16,384 and 262,144 tokens. A reliable cap is bounded only by the upper limit. Use **Reset to defaults** in the **Output reserve** section to restore all three values.
- **Prompt safeguard** is enabled by default. It removes long base64-like text from messages, reasoning, and tool arguments while preserving attached images.

## Copilot features

- The model picker shows pricing, context and output limits, and capabilities. **Hide models this key cannot use** is on by default and uses OpenRouter's availability data. If the check fails, the picker shows the full catalog.
- Compatible models support streamed replies, tool calls, image input, thinking traces, and native picker controls for reasoning and context size.
- **Session spend** shows recent chat costs by provider and model for each connection. For upstream BYOK routes, the panel uses the upstream cost when OpenRouter reports zero and supplies that cost.

Model availability depends on the Copilot harness and window type. In remote windows such as WSL, SSH, and Dev Containers, the Copilot harness may omit extension-provided models. [VS Code issue 348630](https://github.com/microsoft/vscode/issues/348630)

## Privacy

- The extension sends inference requests to OpenRouter using the selected connection's key. Requests can include chat messages and context supplied by Copilot, attached images, tool definitions and results, and the applicable request settings. The extension uses the corresponding connection's key for account, model availability, credit, and preset lookups. OpenRouter routes inference to upstream model providers. [OpenRouter privacy policy](https://openrouter.ai/privacy)
- Enter credentials in the API key field so VS Code stores them separately in SecretStorage. The extension saves request templates and spend records, including chat IDs used for attribution, in a local database for the current VS Code profile. The panel reads Copilot chat titles from VS Code's local session files when available and uses them to label spend entries.
- When Copilot supplies a chat ID, the extension derives an OpenRouter `session_id` from it. Some utility calls can use a recent chat ID from the same connection and workspace. Agent SDK calls can arrive without a usable chat ID. Calls without a chat to attribute are sent without `session_id`, and returned costs appear under **Unattributed**.
- In the VS Code Extension Development Host only, setting `OPENROUTER_RC_DEBUG=1` writes request bodies to `openrouter-requests.jsonl` in the extension's log directory. These logs can contain sensitive prompts, tool content, and images.
