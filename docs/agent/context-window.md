# Context window sizing (P16)

`maxInputTokens` is reported as the accurate input budget `window − output reserve`
(never a percentage of it), so Copilot's own auto-compaction acts at the right point. The **window**
is the served window, not the catalog-wide maximum: `effectiveContextLength` (in `modelInfo.ts`, pure) takes the smaller of
the catalog's model-level `context_length` and the serving provider's `top_provider.context_length`,
because 34 catalog entries publish a provider window below the model-level one
(`google/gemini-3-pro-image` 131,072 vs 65,536, `minimax/minimax-m3` 1,048,576 vs 524,288,
`deepseek/deepseek-v4-pro` 1,048,576 vs 1,024,000). Advertising the model-level maximum would promise
window no provider will serve. `longContextTier`, `effectiveMaxInputTokens` and the picker's window
line all read the same helper. (Copilot's native OpenRouter provider uses
`context_length ?? top_provider.context_length` and does not take the `min`; this extension's `min`
is deliberate.) The reported window assumes the catalog `top_provider` data; a pasted template that
pins a provider route with a smaller window is not reflected in the budget (a disclosed limitation).
OpenRouter's `/models` publishes `pricing.overrides` — one or more stepped prices above each
`min_prompt_tokens` (mostly large-window OpenAI models above 272K; a few Qwen models have two steps) — and
`longContextTiers` (in `modelInfo.ts`, pure) returns every such threshold ascending (a numeric
threshold below the window on a genuine surcharge; time-of-day overrides and discounts are ignored);
`longContextTier` remains the smallest. `effectiveMaxInputTokens` reports `window − reserve` and applies
a per-model `overrideTokens` (`ContextBudgetOptions.overrideTokens`). A **default step policy** fills that
value when the user has not chosen: the provider's `contextBudgetFor` falls back to `defaultContextCap`
(the price-step threshold **closest to 256K** that is at or above 196K, by absolute distance) for a stepped model, so a stepped
model reports a comfortable mid-window budget until the picker overrides it; a non-stepped model has no
such default and reports `window − reserve`. The **output reserve** is a **bounded ratio**
(`effectiveOutputReserve` in `modelInfo.ts`, pure; settings `openrouterCopilot.outputReserve*` in [architecture.md](architecture.md)):
a published cap at or below half the window is **trusted** and reserved as-is, except that it is capped
at `outputReserveMaxTokens` (Anthropic 64K/200K and OpenAI 128K caps are unchanged; a real cap at or
below 256K is honored in full, and a larger one, e.g. 300K, is lowered to 256K) and it is never inflated up to
`outputReserveMinTokens` — reserving more than the model can
emit only wastes input. An absent cap or OpenRouter's **synthetic** `max_completion_tokens` (an exact
`floor(window × 0.9)` (83 entries) or `floor(window × 0.8)` (23) for providers that declare no real
cap; always above half the window, which is the trust test) instead gets `window × percent`, clamped
to `[minTokens, maxTokens]`: with the defaults (**12.5%**, **16384**, **262144**) that is ~131K on a
1M-token window, a 16K floor for small windows and a 256K ceiling for huge ones (with no
window at all, the ceiling applies). This departs from Copilot's **native OpenRouter provider**, which
clamps a synthetic cap to `floor(window / 2)` with a 16K fallback (`resolveModelCapabilities`:
`u = Math.min(l, Math.floor(c / 2))` with `l = cap ?? 16e3`), leaving a 1M-window model with a
half-window reserve purely because OpenRouter published `1,048,576 × 0.9`; here DeepSeek V4.1 Flash
reserves 131,072 and reports a 917,504 input budget. The result is always clamped to
`[1, floor(window / 2)]`, so `maxInputTokens + maxOutputTokens` equals the served window (a tiny
window is still split half and half). `declaredOutputCap` (a trusted cap, else `undefined`) is the
pure trust test; `normalizeOutputReservePolicy` validates the three settings and applies the two
limits in ascending order. Changing any reserve setting calls `refreshModelInfo` (the catalog cache
is kept, only the derived model information is rebuilt) through the config-change listener.
The model picker's **Context size** menu is the **only** control. `buildContextCapSchema` (in
`modelInfo.ts`) emits the `contextSize` property — group **`tokens`** (VS Code's picker renders at most
one submenu per group, and only `navigation`/`tokens` are read, so a control in `navigation` is shadowed
by `thinkingEffort`), string enum. It lists the model's **fixed sizes** only: one entry per price step
plus the whole window; a price step at or above the effective prompt budget (`window − output reserve`)
is omitted from the menu, and a saved or default choice is clamped to that budget (`contextCapOptions`
filters, `effectiveMaxInputTokens` clamps). Each value and label is the **prompt budget** — the size Copilot packs against
and the context ring shows — via `formatSize` (`400K`, `1.05M`, at most two decimals); Copilot adds the
output reserve on top, matching its native OpenRouter provider, so no reserve arithmetic happens in the
extension. There is **no `Auto` and no `Custom`** entry. Small budgets are prefixed with an icon and
explained in `enumDescriptions` (`sizeAdvisory`), based on the **prompt budget** rather than the total
window: `< 64K` gets a stop sign (`⛔`, "Too small — the system prompt and tool definitions alone can
exceed this"), `≤ 128K` a warning (`⚠️`, "Tight"). Comfortable entries instead use Copilot's native
wording — the dropdown's default step reads "Default recommended context size", larger sizes "Longer
sessions". The **default selection** for an unchosen stepped model is the step
closest to 256K at or above a 196K floor (`defaultContextCap`). VS Code delivers the per-model value only on the request
(`options.modelConfiguration.contextSize`), never to `provideLanguageModelChatInformation`, so
`provideLanguageModelChatResponse` persists the prompt budget verbatim (`applyPickerContextCap`) in
`globalState.contextCaps` and fires `onDidChangeLanguageModelChatInformation` — the new budget
applies from the next turn. **The panel has no Context tab** and `readConfig` no longer carries context
settings. The picker tooltip shows base vs stepped `$Mtok` in the markdown price table and the cap, with a
`· ≤{threshold}` marker on the detail line — rendered whenever the reported budget sits **inside
the base tier and below the model's own window-minus-output budget**, i.e. whenever a per-model size is
actually in effect. There is no separate long-context note (removed as stale — the table's stepped
columns already state the rate boundaries). The
info block is plain lines labelled `Context window:` / `Effective prompt cap:` / `Effective completion cap:` /
`Max completion:` (sizes in `formatSize` short form, e.g. `200K`). `Effective completion cap:` is the reserve
actually used (`effectiveOutputReserve`, always shown) and `Max completion:` reports the published
`top_provider.max_completion_tokens` verbatim (`not listed` when absent); a real cap below half the
window makes the two equal. `Effective prompt cap:` is the **effective prompt budget** Copilot packs against
(`effectiveMaxInputTokens`, including any per-model Context size step; `not listed (assuming …)` when no
window is known), the same number the tooltip's picker budget and the detail marker reflect. The
completion figure is a **reserve**, not a
promise the model will necessarily emit that many tokens.

## Compaction at the reported input budget (confirmed working, 2026-10-03)

Automatic compaction/summarization at the extension-reported `maxInputTokens` budget is **confirmed
working**: a long Copilot Chat session handed off a generated summary of earlier context once the
reported budget was approached. This is Copilot-side behavior by design — the extension only reports
the accurate input budget (`window − max_output_tokens`, P16) so the host's own auto-compaction
fires at the right point and otherwise stays out of the compaction mechanism — so an extension-visible
compaction marker is **not** expected in the persisted transcript; an earlier revision read the absence
of a marker as unresolved, but the absence is normal. For
future debugging, still record the model, the effective `maxInputTokens`, before/after user-visible
evidence, and timestamps.
