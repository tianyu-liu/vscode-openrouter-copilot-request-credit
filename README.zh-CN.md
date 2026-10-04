[English](README.md) | **简体中文** | [日本語](README.ja.md)

# 适用于 Copilot 的 OpenRouter：自定义请求与额度检查

这是一款 VS Code 扩展，可在 Copilot Chat 中注册**可自定义的 OpenRouter 提供程序**。Copilot 内置的 OpenRouter 提供程序无法发送 OpenRouter 的 `provider` 路由对象或 `session_id`（microsoft/vscode#283201；microsoft/vscode-copilot-release#11420）。本扩展不经 Copilot 的 CAPI 代理，而是直接调用 OpenRouter，因此你粘贴的任何请求体设置都会应用到每个 Chat 请求；扩展还会在使用期间跟踪你的密钥额度用量。

## 功能

- **模型选择器：** 在 Copilot Chat 模型选择器中添加一个 “OpenRouter: RC” 分组，包含 OpenRouter 目录。默认情况下会隐藏你的密钥无法使用的模型（除此之外，客户端不限制任何模型）。
- **粘贴即应用请求：** 粘贴来自 [OpenRouter Request Builder](https://openrouter.ai/request-builder) 的请求体；其设置——`provider` 路由、采样参数、`response_format`、`plugins`、`transforms`、`cache_control` 等——会原样应用到每个请求，直到你清除或替换它。
- **预设：** 从你的 OpenRouter 账户中选择一个预设，其路由会应用到每个请求；指定了固定模型的预设还会以 `@preset/<slug>` 条目出现在选择器中（只有固定模型的预设会获得选择器条目；每次选择器查询最多会为 25 个预设解析配置）。
- **隐藏此密钥无法使用的模型**（默认开启）：模型选择器会使用账户自身的可用模型列表，剔除账户无法访问的模型。关闭后会显示完整目录。
- **思考强度：** 对于推理模型，会提供 VS Code 原生的思考强度选择器（或简单的开/关切换），推理轨迹也会显示在聊天中。
- **Anthropic 缓存：** Anthropic 系列模型（`anthropic/*`，包括 `~anthropic/*`）会自动添加一个顶层 `cache_control`，除非你粘贴的请求体已自行设置。
- **模型卡片：** 选择器条目会显示每 100 万 token 的估算加权平均价格、上下文窗口、最大输出和各项能力——并且在 OpenRouter 对超过某个长上下文阈值的请求加价时（例如 OpenAI GPT 超过 272K token），显示基础价格与阶梯价格。
- **上下文大小：** 对于有长上下文价格阶梯的模型，选择器的 **Context size** 菜单会把模型的固定大小（每个阶梯一项，外加整个窗口）列为**提示预算**——Copilot 会在其之上叠加输出预留。较小的预算会显示停止图标（`<64K`）或警告（`≤128K`）；未选择时，模型默认使用最接近 256K 的阶梯（下限为 196K）。这是唯一可按模型设置上下文大小的控件——面板没有上下文标签页（全局输出预留设置仍然适用）。
- **已用上下文大小：** 每一轮都会把 OpenRouter 自身的 `usage` 块（提示/补全 token、缓存读取）转发给 Copilot，因此上下文用量环会显示*已用 / 最大 token*。
- **会话支出：** 面板的“会话支出”部分会累计每个聊天会话在此窗口中的花费，并提供按提供程序和模型划分的可折叠明细（见下文）。聊天记录中不会添加任何内容。
- **每个聊天一个 OpenRouter 会话：** `session_id` 是聊天自身持久化的 id，因此即使在窗口重新加载后，各轮仍会归属于同一个 OpenRouter 会话（粘性路由 + Logs → Sessions 视图；按设计，完整重启后也应保留，但尚未验证）。新聊天是新的 OpenRouter 会话。后台/内部调用（子代理以及 Copilot 自身的辅助流程）会并入触发它们的聊天；当不存在这样的聊天时，不发送 `session_id`，因此不会创建多余的会话。
- **状态栏：** 显示剩余额度；面板中有用量仪表板。

由宿主管理的字段始终会被替换：`model`、`messages` 和 `tools` 来自 Copilot，`stream` 始终为 `true`，`session_id` 是扩展自身按聊天生成的 id（让提示缓存持续发挥作用）；粘贴的 `prompt` 会被丢弃。其他每个粘贴的字段都会生效。思考强度/启用状态来自选择器，且只覆盖 `reasoning.effort` / `reasoning.enabled`。

## 面板

这是一个名为“适用于 Copilot 的 OpenRouter”的 Webview，包含三个标签页：**密钥信息**、**会话支出**和**配置**。可从状态栏项（**OR …**）或“OpenRouter：管理提供程序”命令打开。对于有长上下文价格阶梯的模型，其上下文大小在模型选择器的 **Context size** 菜单中设置，而不是在面板中。

## 安装（从 VSIX）

此扩展仅以 VSIX 形式分发：它使用了 VS Code 的提议 API（`chatProvider`、`languageModelThinkingPart`），未发布到 Marketplace。

1. 构建：`npm install && npm run package` → `openrouter-copilot-request-credit-<version>.vsix`。
2. VS Code → 扩展 → “…” → **从 VSIX 安装…** → 选择该文件。
3. 打开面板并粘贴你的 OpenRouter 密钥（保存在操作系统的密钥链中）。
4. 在 Chat 中，从 **OpenRouter: RC** 分组选择一个模型，即可像其他 Copilot 模型一样使用。

## 用法

1. 在 [openrouter.ai/request-builder](https://openrouter.ai/request-builder) 构建一个请求并复制 JSON 请求体。
2. 将其粘贴到**自定义请求**框中，然后选择**保存请求**（会进行校验并报告错误）。
3. 之后每个 Copilot Chat 请求都会遵循它，直到你清除或替换它。

## 设置

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| `openrouterCopilot.creditLimit` | `0` | 以美元计的本地支出上限（`0` 禁用该上限并显示账户总余额）。 |
| `openrouterCopilot.creditResetPeriod` | `daily` | 本地支出上限的重置周期：`daily` / `weekly` / `monthly` / `never`。 |
| `openrouterCopilot.creditIncludeByok` | `true` | 将 BYOK 支出计入本地支出上限的计算。 |
| `openrouterCopilot.creditRefreshIntervalMinutes` | `5` | 用量刷新间隔（1–1440 分钟）。 |
| `openrouterCopilot.sanitizeBase64Content` | `true` | 从请求文本（消息、推理、工具调用参数；图片附件不受影响）中移除类似 base64 的长字符串，以免组织护栏阻止请求。 |
| `openrouterCopilot.hideUnavailableModels` | `true` | 在模型选择器中隐藏此密钥无法使用的模型。可用性查询失败时回退到完整目录。 |
| `openrouterCopilot.outputReservePercent` | `12.5` | 输出预留目标占上下文窗口的比例（%），在 OpenRouter 未公布真实的最大补全上限时使用（1–50）。 |
| `openrouterCopilot.outputReserveMinTokens` | `16384` | 输出预留的下限（以 token 计）：极小的窗口仍能保留合理的回复预算。 |
| `openrouterCopilot.outputReserveMaxTokens` | `262144` | 输出预留的上限（以 token 计）：真实公布的上限同样受此值限制。将两个限制设为相等即可获得固定预留。 |

所有九个设置都是应用级设置：工作区设置无法更改这些提供程序或用量偏好。提供程序相关请求和额度查询均发送到固定的 OpenRouter API 端点。

**输出预留：** 为回复而从上下文窗口中预留的预算。当 OpenRouter 未公布真实的最大补全上限（或仅公布占位值）时，扩展会按 `outputReservePercent` 的比例预留窗口容量，并受 token 下限与上限的约束；真实公布的上限会被直接采用，仅当其超过预留上限时才会按该上限封顶。窗口的其余部分会作为模型的输入预算报告给 Copilot。

## 面板中的会话支出

面板的**会话支出**部分显示每个 Copilot 聊天会话的花费（窗口重新加载后仍会保留）。每个会话占一行，可折叠；展开后，每个提供程序/模型路由会显示一行：`成本 | 提供程序 | 模型 | 调用 | 缓存占比`。

- **每个聊天会话一条记录**（其 OpenRouter `session_id`）：最新在前，最新的默认展开。点击可折叠/展开——使用 `<details>` 实现，因此无需脚本。
- **按 Copilot 的命名方式命名：** 当 VS Code 有 Copilot 聊天标题时（从 VS Code 自身的聊天会话存储本地读取——不会向 OpenRouter 发送任何内容），该行会以标题标注，否则使用短 id；每行还会显示会话的最后更新时间。
- **最多 10 条记录：** 保留最近的聊天；其中一个槽位预留给“未归属”条目，因此聊天共享九个槽位，随着新聊天出现，较旧的聊天会被移除。
- **内部调用归入最近的聊天（这是一种启发式，而非精确归属）：** 不带对话 id 的后台调用（子代理或摘要调用）会记入最近活跃的聊天，但仅限该聊天在 10 分钟内活跃过；超过 10 分钟，或该调用从未经过 Copilot 的聊天宿主时，其支出会归入“未归属”。
- **每个提供程序/模型路由一行：** 单个会话可以混合多条路由——例如大多数轮次使用 BYOK 路由，外加一轮使用 OpenRouter 托管的模型。路由按成本排序，最高者在前。
- **BYOK 标记：** 当计费来自你自己的上游密钥时，路由标签会标注 `(BYOK)`；由 OpenRouter 计费的路由不带标记。
- **`未归属（无聊天 id）`：** 在 Copilot 聊天宿主之外到达提供程序的调用（例如 agent-host/SDK 的客户端 BYOK 会话）所产生的支出，会收集到末尾的一个条目中，因为没有可计入的聊天。
- **没有窗口级总计：** 每个会话只显示各自的数字。

**采用哪个数字：** 当 OpenRouter 向你收费（共享池路由）时，使用 OpenRouter 的 `usage.cost`。在 **BYOK 路由上，OpenRouter 报告 `cost: 0`**，因为计费的是上游提供程序，所以扩展会回退到 OpenRouter 为该轮报告的上游成本（`usage.cost_details.upstream_inference_cost`）。

- **跨轮次合计：** 合计会在使用工具的轮次内跨多次独立模型调用保留下来（Copilot 每个工具轮次都会发起一次调用）。
- **持久化与精度：** 合计存储在 VS Code 全局状态中，因此会跨窗口重新加载保留（按设计，完整重启后也应保留，但尚未验证）；成本通常以微美元计，因此会按足够的精度显示，绝不会显示为 `$0.00`。
- **不写入聊天记录：** 成本是有意不写入聊天记录的。扩展提供的模型无法获取 Copilot 自身的响应页脚（`Model • N credits`）——它读取的是 Copilot 的 CAPI 用量——而在响应文本中加一行会污染对话（并会被作为上下文重新发送）。

## 已知限制

- **WSL 和 Dev Containers 下的 Agents 窗口 / Copilot SDK：** 此提供程序不会出现在那里的 agent-host 模型列表中（microsoft/vscode#332085；该问题会影响所有 BYOK/自定义终结点提供程序）。同一窗口中的常规 Copilot Chat 可用，本地 Windows 窗口也可用。
- **通过 OpenRouter 使用 Gemini：** 提示缓存不起作用（通过 OpenAI→Gemini 转换层的命中率为 0%），并且 Gemini 3.1 智能体模式在 `thought_signature` 被移除时可能返回 400。请避免在智能体模式下使用 Gemini。
- **Qwen：** 提示缓存需要此扩展不发送的逐块缓存标记，因此请为 Qwen 路由按完整输入价格做预算。
- **流取消：** 仅对 OpenRouter 列为支持取消的提供程序停止计费（DeepSeek 和 DeepInfra 支持；Google/Bedrock/Groq 等不支持）。

## 说明

- **兼容性：** 支持聊天和智能体模式（工具调用）；不支持内联补全（与 BYOK 相同）。
- **网络：** 密钥只会以 Authorization 标头的形式离开你的机器，且仅发往 OpenRouter。
- **本地限制：** 本地 `limit` 仅用于显示辅助；OpenRouter 的服务器端护栏才强制执行真正的上限。
