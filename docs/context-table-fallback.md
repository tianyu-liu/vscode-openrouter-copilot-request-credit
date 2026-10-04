# Context table fallback (retired)

Dev-only. Not shipped in the VSIX.

## Status: the panel Context tab is retired (historical note)

The per-model context-size control now lives **only** in the native model picker's
**Context size** menu (`LanguageModelChatInformation.configurationSchema`, key
`contextSize`, group `tokens`, built by `buildContextCapSchema` in `src/modelInfo.ts`).
The panel's Context tab, the global tiered-price policy
(`openrouterCopilot.contextWindowPolicy`), the Custom-cap reduction
(`openrouterCopilot.contextSafetyMarginPercent`), and the per-model Custom cap are all
removed. The picker is the only **per-model** context-size control; the global output-reserve
settings (`openrouterCopilot.outputReserve*`) remain active and shape the budget the picker
sizes are measured against.

- Values are the **prompt budget** (the size Copilot packs against; it adds the
  output reserve on top) as sizes: one entry per price step plus the whole window.
  No `Auto`, no `Custom`.
- The provider stores the picker value verbatim (`applyPickerContextCap` in
  `src/provider.ts`), and `defaultContextCap` picks the step closest to 256K at or
  above a 196K floor when nothing is chosen.
- Small budgets carry an `enumDescriptions` advisory (`sizeAdvisory`) based on the
  prompt budget: `<64K` a stop sign, `≤128K` a warning. Comfortable entries use
  Copilot's native wording (`Default recommended context size` / `Longer sessions`).

## Why the picker needed `group: 'tokens'`

VS Code's model picker builds at most **one submenu per group** (`_buildItems` →
`getModelConfigurationActions` → `RQ(model, access, group)`) and reads only two groups:
`navigation` (reasoning) and `tokens` (context size). A control in `navigation` is
shadowed by `reasoningEffort`; only a `tokens`-group property renders as **Context
size**. VS Code's `_groupForConfigKey` confirms `contextSize`/`contextTier` → `tokens`.

## Historical panel implementation (for reference)

Before the retire, the panel drove context caps with a per-model table and global
controls. That code is in commit **`17b5548`**:

```powershell
git show 17b5548:src/panel.ts
git show 17b5548:src/provider.ts
git show 17b5548:src/modelInfo.ts
```

It included `renderContextTiers` (a `Model | Step starts | Base $/1M | Stepped $/1M |
Effective input cap | Policy | Custom cap` table), a global `#contextPolicy` select, a
`#contextMargin` number, `policyTierCap` / `DEFAULT_CONTEXT_POLICY` /
`MAX_CONTEXT_MARGIN_PERCENT`, provider `contextTierRows()` / `setContextMargin()` /
`resetContextCaps()`, and the caps-base store. None of it remains, and the internal cap
model it used (prompt-only budgets with a policy cap) is gone: `effectiveMaxInputTokens`
now only applies a per-model `overrideTokens` on top of `window − reserve`.

To resurrect any of it, port from `17b5548` onto the current types
(`ContextCapValue = number | 'full'`, `ContextBudgetOptions = { overrideTokens?: number; outputReserve?: OutputReservePolicy }`).
