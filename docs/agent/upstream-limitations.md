# Known upstream limitations (no client-side fix; for the README when publishing)

- **Agents window / Copilot SDK under WSL (and Dev Containers)**: this provider never appears in the
  agent-host model list there. The BYOK model bridge is unavailable on the remote path because
  `chat.agentHost.byokModels.enabled` is a `scope:"local"` agent-host root-config key that is never
  mirrored to a `vscode-remote://` host, and the sessions window additionally refuses any extension
  with a `main` entry point. Affects **every** BYOK/custom-endpoint provider, not just this one
  (microsoft/vscode#332085, #325738, #333016). Regular Copilot Chat in the same WSL window is
  unaffected; a local Windows window works. See [Agent-host BYOK visibility](harness-boundary.md).
- **Gemini via OpenRouter**: prompt caching is broken (0% hits through the OpenAI→Gemini
  translation layer, microsoft/vscode#332772), and Gemini 3.1 agent mode 400s on a stripped
  `thought_signature` (microsoft/vscode#296713). Avoid Gemini in agent mode via OpenRouter.
- **Qwen**: this extension only emits the top-level (Anthropic) `cache_control` form (P6),
  which OpenRouter honors for Anthropic/Vertex/Azure/Bedrock — not Alibaba;Qwen still needs
  per-block markers this extension doesn't send, so budget full input price for a Qwen route
  (or use a client that emits them: pi/omp/Kilo/OpenClaw).
- **Stream cancellation** stops billing only on providers OpenRouter lists as supporting it
  (DeepSeek and DeepInfra do; Google/Bedrock/Groq and others do not).
- WSL reports of "Request blocked by content filter" are an OpenRouter-side filter/rate-limit
  pattern (github/orgs/community#199784), not WSL-caused.
