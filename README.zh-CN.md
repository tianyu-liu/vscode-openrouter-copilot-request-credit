# 适用于 Copilot 的 OpenRouter：自定义请求与额度检查

[English](README.md) | **简体中文** | [日本語](README.ja.md)

在 Copilot Chat 中使用多个 OpenRouter API 密钥。每个具名连接独立管理密钥、请求设置、模型组和支出历史。扩展使用固定的 OpenRouter API 地址 `https://openrouter.ai/api/v1`。

## 安装与快速开始

从 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=tianyu-liu.openrouter-copilot-request-credit) 安装或更新。也可以在 VS Code 扩展菜单中选择**从 VSIX 安装…**，然后选取发布包。

1. 在命令面板中运行 **OpenRouter：管理提供程序**，或点击状态栏上的 OpenRouter 图标。
2. 在**设置 → 分组管理**中选择 **OpenRouter: RC**，输入 OpenRouter API 密钥，然后选择**保存连接**。如需添加其他密钥，请选择**添加连接**，输入不同的连接名称和密钥，然后保存。
3. 在 Copilot Chat 中，从所需密钥对应的分组中选择模型。要为同一个模型切换密钥，只需从另一个分组选择该模型。

从 0.4.1 升级时，扩展会将现有密钥、请求设置、上下文选择和支出历史导入 **OpenRouter: RC**。更新后打开 **OpenRouter：管理提供程序**，以便 VS Code 在当前配置文件中创建模型组或关联现有模型组。

## 管理连接和请求

- 在**设置 → 分组管理**中重命名、启用或停用连接。密钥栏留空会保留已保存的密钥，选择**清除密钥**可将其移除。更换密钥或重新启用连接后，请在 Copilot 中重新选择模型。重命名后也可能需要重新选择。如果模型组在 VS Code 中被删除或改名，请选择**修复模型组**。
- 打开各连接的标签页，可以查看额度用量和会话支出、设置模型可见性或选择 OpenRouter 预设。选择预设会替换该连接已保存的请求。Copilot 中选定的模型决定请求使用哪个连接。
- 在 [OpenRouter Request Builder](https://openrouter.ai/request-builder) 中构建 JSON 请求，将其粘贴到对应连接标签页中的**自定义请求**，然后选择**保存请求**。提供商路由、采样和缓存等设置会应用于该连接，直到清除或替换请求。模型、消息和工具由 Copilot 提供。

### 状态栏

OpenRouter 图标旁会显示 `$12.40 | $8.20` 这样的金额。将鼠标悬停在状态栏项上，可按相同顺序查看连接名称和详细信息。已启用且保存了密钥的连接默认会纳入显示。可在各连接标签页中勾选或取消**在状态栏中显示此预算**，选择要显示的连接。

在**设置 → 共享设置 → 状态栏显示内容**中选择**剩余**（默认）或**用量**。对应的 VS Code 设置为 `openrouterCopilot.statusBarBudgetDisplay`（`remaining` 或 `usage`）。剩余金额以密钥报告的限额、用于显示的本地上限或可用账户余额为准。服务端限额由 OpenRouter 执行。

### 共享设置

- **用量刷新间隔**默认为 5 分钟。
- **输出预留**为回复保留 token。OpenRouter 未提供可靠的输出上限时，默认按上下文窗口的 12.5% 预留，范围为 16,384 到 262,144 token。可靠的输出上限仅受该上限值约束。选择**输出预留**中的**恢复默认值**可恢复这三个值。
- **提示防护**默认开启。它会移除消息、推理和工具参数中较长的类 base64 文本，并保留图片附件。

## Copilot 功能

- 模型选择器显示价格、上下文和输出上限以及模型能力。**隐藏此密钥无法使用的模型**默认开启，依据 OpenRouter 提供的可用性数据。检查失败时，选择器会显示完整目录。
- 兼容模型支持流式回复、工具调用、图片输入、推理轨迹，以及在模型选择器中设置推理强度和上下文大小。
- **会话支出**按提供商和模型显示每个连接的近期聊天费用。对于使用上游自带密钥（BYOK）的请求，如果 OpenRouter 报告费用为零且提供了上游费用，则使用上游费用。

模型可用性取决于 Copilot 的运行框架和窗口类型。在 WSL、SSH 和 Dev Containers 等远程窗口中，Copilot 运行框架可能不会显示由扩展提供的模型。[VS Code 问题 348630](https://github.com/microsoft/vscode/issues/348630)

## 隐私

- 扩展使用所选连接的密钥向 OpenRouter 发送推理请求。请求正文可能包含 Copilot 提供的聊天消息和上下文、图片附件、工具定义和结果，以及生效的请求设置。扩展使用对应连接的密钥查询账户、模型可用性、额度和预设。OpenRouter 将推理请求路由到上游模型提供商。[OpenRouter 隐私政策](https://openrouter.ai/privacy)
- 请在 API 密钥字段中输入凭据，由 VS Code 将各密钥分别保存在 SecretStorage 中。请求模板和支出记录（包括用于归属的聊天 ID）保存在当前 VS Code 配置文件的本地数据库中。会话文件可用时，面板从 VS Code 的本地会话文件中读取 Copilot 聊天标题，用于标记支出记录。
- Copilot 提供聊天 ID 时，扩展会据此生成 OpenRouter `session_id`。部分辅助调用可能使用同一连接和工作区内的近期聊天 ID。Agent SDK 的调用可能缺少可用的聊天 ID。无法归属到聊天的调用会在不带 `session_id` 的情况下发送，返回的费用计入**未归属**。
- 仅在 VS Code 扩展开发宿主中，设置 `OPENROUTER_RC_DEBUG=1` 才会将请求正文写入扩展日志目录下的 `openrouter-requests.jsonl` 文件。调试记录可能包含敏感的提示词、工具内容和图片。
