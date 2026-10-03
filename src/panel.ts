import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import {
    presetSlugFromPickerValue,
    stripTemplateComments,
    routeCostCells,
    cacheShareSuffix,
    UNATTRIBUTED_SESSION_ID,
    MAX_TRACKED_SESSIONS,
    type ContextCapValue,
    type ContextTierRow,
    type SessionCost,
} from './provider';
import {
    buildDetail,
    formatReset,
    formatUsdPrecise,
    KeyInfo,
    ResetPeriod,
    resetPeriodLabel,
    AccountCredits,
} from './logic';
import { formatPricePerM, MAX_CONTEXT_MARGIN_PERCENT } from './modelInfo';

const MAX_REFRESH_INTERVAL_MINUTES = 1440;
const RESET_PERIODS: readonly ResetPeriod[] = ['daily', 'weekly', 'monthly', 'never'];

export interface PanelSettings {
    sanitizeBase64Content: boolean;
}

export function isResetPeriod(value: string): value is ResetPeriod {
    return (RESET_PERIODS as readonly string[]).includes(value);
}

export function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('openrouterCopilot');
}

function globalSetting<T>(cfg: vscode.WorkspaceConfiguration, key: string, fallback: T): T {
    const inspected = cfg.inspect<T>(key);
    return (inspected?.globalValue ?? inspected?.defaultValue ?? fallback) as T;
}

export interface ConfigSnapshot {
    limit: number;
    resetPeriod: ResetPeriod;
    includeByok: boolean;
    refreshIntervalMinutes: number;
    contextPolicy: 'auto' | 'full';
    contextMarginPercent: number;
    sanitizeBase64Content: boolean;
}

export function readConfig(cfg: vscode.WorkspaceConfiguration = getConfig()): ConfigSnapshot {
    const rawLimit = globalSetting<number>(cfg, 'creditLimit', 0);
    const limit = Number.isFinite(rawLimit) ? Math.max(0, rawLimit) : 0;
    const rawPeriod = globalSetting<string>(cfg, 'creditResetPeriod', 'daily');
    const resetPeriod: ResetPeriod = isResetPeriod(rawPeriod) ? rawPeriod : 'daily';
    const rawByok = globalSetting<boolean>(cfg, 'creditIncludeByok', true);
    const includeByok = typeof rawByok === 'boolean' ? rawByok : true;
    const rawInterval = globalSetting<number>(cfg, 'creditRefreshIntervalMinutes', 5);
    const rounded = Math.round(rawInterval);
    const refreshIntervalMinutes =
        Number.isFinite(rawInterval) && rounded >= 1
            ? Math.min(rounded, MAX_REFRESH_INTERVAL_MINUTES)
            : 5;
    const rawPolicy = globalSetting<string>(cfg, 'contextWindowPolicy', 'auto');
    const contextPolicy: 'auto' | 'full' = rawPolicy === 'full' ? 'full' : 'auto';
    const rawMargin = globalSetting<number>(cfg, 'contextSafetyMarginPercent', 0);
    const contextMarginPercent = Number.isFinite(rawMargin)
        ? Math.min(MAX_CONTEXT_MARGIN_PERCENT, Math.max(0, Math.round(rawMargin)))
        : 0;
    const rawSanitize = globalSetting<boolean>(cfg, 'sanitizeBase64Content', true);
    const sanitizeBase64Content = typeof rawSanitize === 'boolean' ? rawSanitize : true;
    return {
        limit,
        resetPeriod,
        includeByok,
        refreshIntervalMinutes,
        contextPolicy,
        contextMarginPercent,
        sanitizeBase64Content,
    };
}

export interface PresetRow {
    slug: string;
    name: string;
    model?: string;
    lookupSkipped?: boolean;
}

/**
 * Render the window's spend as a list of collapsible sessions. Only one session
 * is expanded at a time (the newest with spend), and each expanded session lists
 * its per-provider/model routes, since one session can mix a BYOK host with an
 * OpenRouter-hosted model.
 *
 * Spend that carried no chat identifier (an agent-host or SDK session, whose
 * client-BYOK bridge sends none) renders as a single trailing "Unattributed"
 * entry instead of being charged to an unrelated chat.
 *
 * The markup is `<details>`, so expansion works without any script and survives
 * the panel being re-rendered on every message.
 */
export function renderSessionCosts(sessions: SessionCost[] | undefined): string {
    const withSpend = (sessions ?? []).filter(s => s.paid > 0);
    const chats = withSpend.filter(s => s.sessionId !== UNATTRIBUTED_SESSION_ID);
    const unattributed = withSpend.find(s => s.sessionId === UNATTRIBUTED_SESSION_ID);
    if (chats.length === 0 && unattributed === undefined) {
        return '<p class="helptext">No OpenRouter spend recorded yet. Totals appear here once a turn reports a cost. An agent-host or SDK session (client BYOK) sends no chat identifier at all, so its spend is collected under an <strong>Unattributed</strong> entry rather than a chat.</p>';
    }
    const rows = chats.map((session, index) => renderSessionDetails(session, index === 0)).join('');
    const unattributedHtml = unattributed
        ? renderSessionDetails(
              unattributed,
              chats.length === 0,
              'Spend that reached OpenRouter with no Copilot chat identifier. An agent-host or SDK session talks to this provider through a client-BYOK bridge that carries no chat id, so nothing here is charged to an unrelated chat and no <code>session_id</code> is sent for it.'
          )
        : '';
    const unattributedNote = unattributed
        ? ' Spend that carried no chat identifier is collected under the Unattributed entry.'
        : '';
    return `${rows}${unattributedHtml}
        <p class="helptext">One entry per Copilot chat session (<code>session_id</code>), newest first, up to the ${MAX_TRACKED_SESSIONS} most recent. Named from the chat title when VS Code has one, otherwise the id; times are local. Stored locally and kept across window reloads.${unattributedNote}</p>`;
}

/** One collapsible spend entry; `note` replaces the session-id footer line. */
function renderSessionDetails(session: SessionCost, open: boolean, note?: string): string {
    const short = session.sessionId.replace(/^copilot-chat:/, '');
    const label =
        session.sessionId === UNATTRIBUTED_SESSION_ID
            ? 'Unattributed (no chat id)'
            : session.title ?? `${short.slice(0, 8)}${short.length > 8 ? '\u2026' : ''}`;
    const routeRows = session.routes
        .map(r => {
            const c = routeCostCells(r);
            return `<tr>
                                <td class="num">${esc(c.cost)}</td>
                                <td>${esc(c.provider)}</td>
                                <td>${esc(c.model ?? '\u2014')}</td>
                                <td class="num">${esc(c.calls)}</td>
                                <td class="num">${esc(c.cached ?? '\u2014')}</td>
                            </tr>`;
        })
        .join('');
    const cacheShare = cacheShareSuffix(session);
    const updated = session.updatedAt >= 1e12 ? formatReset(new Date(session.updatedAt), true) : undefined;
    return `<details class="session"${open ? ' open' : ''}>
                        <summary>
                            <span class="sessioncost">${esc(formatUsdPrecise(session.paid))}</span>
                            <span class="sessionname">${esc(label)}</span>
                            <span class="muted">${esc(String(session.calls))} call(s)${esc(cacheShare)}</span>
                            ${updated ? `<span class="muted sessiontime">${esc(updated)}</span>` : ''}
                        </summary>
                        <div class="sessionbody">
                            <table class="routes">
                                <thead>
                                    <tr><th>Cost</th><th>Provider</th><th>Model</th><th>Calls</th><th>Cached</th></tr>
                                </thead>
                                <tbody>${routeRows}</tbody>
                            </table>
                            <p class="helptext">${note ?? `OpenRouter session <code>${esc(session.sessionId)}</code>`}</p>
                        </div>
                    </details>`;
}

/**
 * The Context limits table: one row per catalog model that carries a
 * long-context price step, with its threshold, base vs stepped prompt price,
 * the effective input cap, and an Auto / Full / Custom control.
 */
export function renderContextTiers(rows: ContextTierRow[] | undefined): string {
    if (!rows || rows.length === 0) {
        return '<p class="helptext">No model in the current catalog has a long-context price step. OpenRouter exposes the step under <code>pricing.overrides</code>; it appears here once a model has one.</p>';
    }
    const fmt = (n: number): string => n.toLocaleString('en-US');
    const body = rows
        .map((r, i) => {
            const mode = r.override === 'full' ? 'full' : typeof r.override === 'number' ? 'custom' : 'auto';
            const customValue = typeof r.override === 'number' ? r.override : r.effectiveCap;
            return `<tr>
                        <td class="ctxmodel">${esc(r.label)}</td>
                        <td class="num">${esc(fmt(r.threshold))}</td>
                        <td class="num">${esc(formatPricePerM(r.basePromptPerM))}</td>
                        <td class="num">${esc(formatPricePerM(r.tierPromptPerM))}</td>
                        <td class="num">${esc(fmt(r.effectiveCap))}</td>
                        <td><select class="capmode" data-idx="${i}" data-model="${esc(r.modelId)}">
                            <option value="auto" ${mode === 'auto' ? 'selected' : ''}>Auto</option>
                            <option value="full" ${mode === 'full' ? 'selected' : ''}>Full</option>
                            <option value="custom" ${mode === 'custom' ? 'selected' : ''}>Custom</option>
                        </select></td>
                        <td><input type="number" class="capval" id="capval-${i}" aria-label="Custom input cap in tokens for ${esc(r.label)}" title="Enter a token cap; the custom-cap reduction applies to this saved value." data-idx="${i}" data-model="${esc(r.modelId)}" min="1" step="1" value="${esc(String(customValue))}" /></td>
                    </tr>`;
        })
        .join('');
    return `<table class="routes contexttiers">
                <thead><tr><th>Model</th><th>Step starts</th><th>Base $/1M</th><th>Stepped $/1M</th><th>Effective input cap</th><th>Policy</th><th>Custom cap (tokens)</th></tr></thead>
                <tbody>${body}</tbody>
            </table>
        <p class="helptext">A stepped price applies at and above the threshold. Auto uses the threshold; Full uses the model input budget; Custom uses the saved token cap. Hover a model in the picker for context and pricing details.</p>`;
}

export function renderPanelHtml(
    info: KeyInfo | undefined,
    limit: number,
    resetPeriod: ResetPeriod,
    includeByok: boolean,
    refreshIntervalMinutes: number,
    fetchedAt?: Date,
    maskedKey?: string,
    accountCredits?: AccountCredits,
    errorMessage?: string,
    template?: Record<string, unknown>,
    presets?: PresetRow[],
    presetConfig?: Record<string, unknown>,
    sessions?: SessionCost[],
    contextPolicy?: string,
    contextMarginPercent?: number,
    contextTiers?: ContextTierRow[],
    settings: Partial<PanelSettings> = {}
): string {
    const nonce = randomBytes(16).toString('hex');
    const detail = info ? buildDetail(info, limit, resetPeriod, includeByok, accountCredits) : undefined;
    const usageTable = detail
        ? `<table class="rows">
               <caption class="tabletitle">Usage</caption>
               <thead><tr><th class="col">OpenRouter</th><th class="col">BYOK</th><th class="col">Sum</th><th class="label">Period</th></tr></thead>
               <tbody>${detail.rows
            .map((r, i) => {
                const hl = (col: 'or' | 'sum'): string =>
                    detail.highlight !== null && detail.highlight.row === i && detail.highlight.col === col
                        ? ' hl'
                        : '';
                return `<tr>
                           <td class="col${hl('or')}">${esc(r.orValue)}</td>
                           <td class="col">${esc(r.byokValue)}</td>
                           <td class="col sum${hl('sum')}">${esc(r.sumValue)}</td>
                           <td class="label">${esc(r.label)}</td></tr>`;
            })
            .join('')}</tbody>
           </table>`
        : '';
    const remainingLine = detail
        ? `<div class="remainingline${detail.background === 'error' ? ' exhausted' : ''}"><span class="label">Remaining</span><span class="limitvalue">${esc(detail.remaining)} / ${esc(detail.limitValue)}</span><span class="muted">Next reset: ${esc(detail.resetDate ?? 'No reset')}</span></div>`
        : '';
    const freeTierLine = detail
        ? `<p class="freetier">Free tier: ${esc(detail.freeTier)}</p>`
        : '';
    const modeLine = detail
        ? `<div class="modeline">${esc(detail.modeText)}</div>`
        : '';
    const errorBanner = errorMessage
        ? `<div class="errbanner">${esc(errorMessage)}</div>`
        : '';
    const keyState = maskedKey
        ? `<span class="ok">\u2713 Key set</span>`
        : `<span class="warn">No API key set</span>`;
    const limitLine = `<div class="limitline">
               <label class="limitlabel" for="limit">Spending limit</label>
               <span>$</span>
                <input type="number" id="limit" min="0" step="0.01" value="${esc(String(limit))}" />
               <select id="resetPeriod" aria-label="Spending limit reset period" title="How often the local spending limit resets">
                   ${RESET_PERIODS.map((p) => `<option value="${p}" ${resetPeriod === p ? 'selected' : ''}>${resetPeriodLabel(p)}</option>`).join('')}
               </select>
                <label class="optlabel"><input type="checkbox" id="includeByok" ${includeByok ? 'checked' : ''} title="Count bring-your-own-key usage in the remaining balance" /> Include BYOK usage</label>
           </div>`;
    const sessionCostHtml = renderSessionCosts(sessions);
    const policyValue = contextPolicy === 'full' ? 'full' : 'auto';
    const marginValue = Number.isFinite(contextMarginPercent)
        ? Math.min(MAX_CONTEXT_MARGIN_PERCENT, Math.max(0, Math.round(contextMarginPercent as number)))
        : 0;
    const contextSectionHtml = `<div class="section">
        <div class="section-title">Context limits</div>
        <div class="keyline">
            <label class="optlabel" for="contextPolicy">Tiered-price policy</label>
            <select id="contextPolicy">
                <option value="auto" ${policyValue === 'auto' ? 'selected' : ''}>Auto</option>
                <option value="full" ${policyValue === 'full' ? 'selected' : ''}>Full</option>
            </select>
            <label class="optlabel" for="contextMargin">Custom-cap reduction (%)</label>
            <input type="number" id="contextMargin" min="0" max="${MAX_CONTEXT_MARGIN_PERCENT}" step="1" value="${esc(String(marginValue))}" class="intervalinput" />
        </div>
        <p class="helptext"><strong>Tiered-price policy:</strong> Auto caps tiered models at the surcharge threshold; Full uses the full input budget, <code>context_length \u2212 max_output</code>.</p>
        <p class="helptext"><strong>Custom-cap reduction:</strong> Changing this percentage scales every saved numeric Custom cap in place across all models. Auto and Full selections are unchanged.</p>
        ${renderContextTiers(contextTiers)}
    </div>`;
    const updatedLine = `<div class="keyline updatedline">
            <label class="optlabel" for="refreshInterval">Usage refresh interval (minutes)</label>
            <input type="number" id="refreshInterval" min="1" max="${MAX_REFRESH_INTERVAL_MINUTES}" step="1" aria-label="Usage refresh interval in minutes" title="Refresh usage data every 1 to ${MAX_REFRESH_INTERVAL_MINUTES} minutes" value="${esc(String(refreshIntervalMinutes))}" class="intervalinput" />
            ${fetchedAt ? `<span class="muted">Updated ${esc(formatReset(fetchedAt, true))}</span>` : ''}
            <button id="refresh">Refresh</button>
        </div>`;
    const templateValue = template ? JSON.stringify(template, null, 2) : '';
    const selectedPreset = templatePresetSlug(template) ?? '';
    const presetComment = template && presetConfig && selectedPreset !== ''
        ? JSON.stringify(presetConfig, null, 2)
            .split('\n')
            .map((line) => `// ${line}`)
            .join('\n')
        : '';
    const templateJson = JSON.stringify(presetComment ? `${templateValue}\n${presetComment}` : templateValue).replace(/</g, '\\u003c');
    const currentPreset = selectedPreset;
    const presetOptions: Array<{ slug: string; label: string }> = (presets ?? []).map(p => ({
        slug: p.slug,
        label: `${p.name}${p.model ? ` \u2192 ${p.model}` : p.lookupSkipped ? ' (lookup skipped)' : ' (routing profile)'}`,
    }));
    if (currentPreset !== '' && !presetOptions.some(p => p.slug === currentPreset)) {
        presetOptions.push({ slug: currentPreset, label: `${currentPreset} (not in list)` });
    }
    const presetSelectHtml = `<select id="presetSelect">
            <option value="" ${currentPreset === '' ? 'selected' : ''}>No preset loaded</option>
            ${presetOptions
            .map(
                (p) => `<option value="${esc(p.slug)}" ${p.slug === currentPreset ? 'selected' : ''}>${esc(p.label)}</option>`
            )
            .join('')}
        </select>`;
    const presetsHint = presets === undefined
        ? '<p class="helptext">Presets could not be loaded for this key.</p>'
        : presets.length === 0
            ? '<p class="helptext">No presets found for this key.</p>'
            : '';
    const behaviorNotes: Array<[string, string]> = [
        ['Streaming', 'Responses stream automatically; no <code>stream</code> field is needed.'],
        ['Live conversation', 'Copilot supplies the conversation, model, and tools. Pasted <code>messages</code>, <code>prompt</code>, and <code>model</code> fields are ignored.'],
        ['Thinking effort', 'The model picker controls <code>reasoning.effort</code> and <code>reasoning.enabled</code>; other reasoning options are preserved.'],
        ['Provider routing', 'No routing is added automatically. A pasted <code>provider</code> object passes through unchanged.'],
        ['Anthropic caching', 'Anthropic-family models (<code>anthropic/*</code>, including <code>~anthropic/*</code>) get a top-level, 5-minute <code>cache_control</code> breakpoint unless the template sets one.'],
        ['Picker presets', '<code>@preset/&lt;slug&gt;</code> applies only while that picker entry is selected; it takes precedence over a different template preset.'],
        ['Context usage', 'OpenRouter reports token usage per request. Copilot’s context indicator can change between requests.'],
    ];
    const renderNotes = (topics: string[]): string => behaviorNotes
        .filter(([topic]) => topics.includes(topic))
        .map(([topic, text]) => `<p class="helptext"><strong>${topic}:</strong> ${text}</p>`)
        .join('');
    const keyNotesHtml = '<p class="helptext"><strong>Storage:</strong> Your API key is kept in VS Code SecretStorage.</p>';
    const sessionNotesHtml = '<p class="helptext"><strong>BYOK routes:</strong> When OpenRouter reports zero, the session total uses the upstream provider\u2019s reported cost.</p>';
    const sanitizeBase64Content = settings.sanitizeBase64Content ?? true;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
    body { font-family: var(--vscode-font-family); padding: 16px 20px; color: var(--vscode-foreground); }
    .section { margin-bottom: 22px; }
    .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.15)); margin: 0 0 16px; }
    .tab { color: var(--vscode-descriptionForeground, #888); background: transparent; border-bottom: 2px solid transparent; }
    .tab[aria-selected="true"] { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
    .tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -2px; }
    .tab-panel[hidden] { display: none; }
    .section-title { font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
                     font-weight: 600; color: var(--vscode-foreground); margin-bottom: 10px; }
    .keyline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    textarea {
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent); padding: 8px;
        width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace);
        white-space: pre; resize: vertical; }
    input[type=password], input[type=text] {
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent); padding: 4px 8px; width: 320px; }
    input[type=number] {
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent); padding: 4px 8px; width: 90px; }
    select {
        background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
        border: 1px solid var(--vscode-dropdown-border, transparent); padding: 4px 8px; }
    input:disabled, select:disabled {
        opacity: .7; cursor: not-allowed; }
    .optlabel { color: var(--vscode-descriptionForeground, #888); display: inline-flex; align-items: center; gap: 6px; }
    #refreshInterval { width: 56px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
             border: none; padding: 5px 12px; cursor: pointer; white-space: nowrap; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .7; cursor: not-allowed; }
    .ok { color: var(--vscode-charts-green, #89d185); }
    .warn { color: var(--vscode-errorForeground, #f14c4c); }
    .errbanner { color: var(--vscode-errorForeground, #f14c4c);
                 background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
                 border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255, 0, 0, 0.4));
                 padding: 6px 10px; margin: 0 0 10px; border-radius: 4px; }
    .limitline { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; }
    .limitlabel { color: var(--vscode-descriptionForeground, #888); }
    .limitvalue { font-size: 1.5em; font-weight: 600; }
    .updatedline { justify-content: flex-start; gap: 12px; align-items: baseline; }
    .rows { border: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.15)); border-radius: 4px;
            border-collapse: collapse; margin-top: 10px; }
    .rows caption.tabletitle { text-align: left; font-size: 12px; text-transform: uppercase;
            letter-spacing: .05em; font-weight: 600; color: var(--vscode-foreground);
            padding: 8px 12px 4px; border-bottom: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.1)); }
    .rows th, .rows td { padding: 6px 12px; text-align: right; white-space: nowrap;
            border-bottom: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.1)); }
    .rows thead th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
                     font-weight: 500; color: var(--vscode-descriptionForeground, #888); }
    .rows tbody tr:last-child td { border-bottom: none; }
    .rows th.label, .rows td.label { text-align: left; color: var(--vscode-descriptionForeground, #888); }
    .label { color: var(--vscode-descriptionForeground, #888); white-space: nowrap; }
    .col { font-variant-numeric: tabular-nums; font-weight: 500; }
    .col.sum { font-weight: 600; }
    .rows td.hl { background: var(--vscode-editor-selectionBackground, rgba(135, 206, 250, 0.25)); font-weight: 700; }
    .remainingline { display: flex; align-items: baseline; gap: 12px; margin-top: 10px; }
    .remainingline.exhausted .limitvalue { color: var(--vscode-errorForeground, #f14c4c); }
    .freetier { font-style: italic; color: var(--vscode-descriptionForeground, #888); margin: 6px 0 0; }
    .modeline { font-style: italic; color: var(--vscode-descriptionForeground, #888); margin: 0 0 10px; }
    .muted { color: var(--vscode-descriptionForeground, #888); font-style: italic; }
    .helptext { font-size: 12px; line-height: 1.45; color: var(--vscode-descriptionForeground, #888); margin: 6px 0 0; }
    .sessioncost { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; }
    details.session { border: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.1));
                      border-radius: 4px; margin: 6px 0; padding: 2px 8px; }
    details.session summary { cursor: pointer; padding: 6px 0; display: flex; gap: 8px; align-items: baseline; }
    details.session summary::marker { color: var(--vscode-descriptionForeground, #888); }
    .sessionname { flex: 1; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    .sessiontime { white-space: nowrap; font-size: 11px; }
    .sessionbody { padding: 0 0 4px 18px; }
    .sessionbody p { margin: 0; }
    table.routes { margin: 2px 0 6px; border-collapse: collapse; font-size: 12px;
                   font-family: var(--vscode-editor-font-family, monospace); }
    table.routes th { text-align: left; font-weight: 600; padding: 2px 12px 2px 0;
                      color: var(--vscode-descriptionForeground, #888);
                      border-bottom: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.1)); }
    table.routes td { padding: 2px 12px 2px 0; vertical-align: top; }
    table.routes td:last-child, table.routes th:last-child { padding-right: 0; }
    table.routes td.num { text-align: right; }

</style>
</head>
<body>
<div class="wrap">
    <div class="tabs" role="tablist" aria-label="OpenRouter settings">
        <button class="tab" id="tab-key-info" role="tab" aria-selected="true" aria-controls="panel-key-info" tabindex="0">Key Info</button>
        <button class="tab" id="tab-session-spend" role="tab" aria-selected="false" aria-controls="panel-session-spend" tabindex="-1">Session Spend</button>
        <button class="tab" id="tab-request" role="tab" aria-selected="false" aria-controls="panel-request" tabindex="-1">Request</button>
        <button class="tab" id="tab-context" role="tab" aria-selected="false" aria-controls="panel-context" tabindex="-1">Context</button>
    </div>

    <section class="tab-panel" id="panel-key-info" role="tabpanel" aria-labelledby="tab-key-info" tabindex="0">
    <div class="section">
        <div class="section-title">OpenRouter API key</div>
        <div class="keyline">
            <input type="${maskedKey ? 'text' : 'password'}" id="key" aria-label="OpenRouter API key" placeholder="OpenRouter API key (sk-or-v1-...)" />
            <button id="saveKey">Save key</button>
            ${keyState}
        </div>
        ${errorBanner}
    </div>
    <div class="section">
        <div class="section-title">Credit usage</div>
        ${detail ? `${modeLine}${usageTable}${freeTierLine}${remainingLine}` : `<p class="helptext">No usage information yet. Save an API key to load account details.</p>`}
        ${limitLine}
        ${updatedLine}
    </div>
    ${keyNotesHtml}
    </section>

    <section class="tab-panel" id="panel-session-spend" role="tabpanel" aria-labelledby="tab-session-spend" tabindex="0" hidden>
    <div class="section">
        <div class="section-title">Session Spend</div>
        ${sessionCostHtml}
        ${sessionNotesHtml}
    </div>
    </section>

    <section class="tab-panel" id="panel-request" role="tabpanel" aria-labelledby="tab-request" tabindex="0" hidden>
    <div class="section">
        <div class="section-title">Prompt safeguard</div>
        <label class="optlabel"><input type="checkbox" id="sanitizeBase64" ${sanitizeBase64Content ? 'checked' : ''} /> Remove long base64-like text from prompts</label>
        <p class="helptext"><strong>Prompt sanitization:</strong> Removes long base64-like runs from text to avoid encoded-prompt guardrails. Image attachments are not changed.</p>
    </div>
    <div class="section">
        <div class="section-title">Presets</div>
        <div class="keyline">
            <label class="optlabel" for="presetSelect">Preset</label>
            ${presetSelectHtml}
        </div>
        ${presetsHint}
        <p class="helptext">Selecting a preset replaces the saved request with <code>{"preset": "&lt;slug&gt;"}</code>. Selecting “No preset loaded” clears it. The resolved configuration appears below as <code>//</code> comments; copy fields into the JSON to override the preset.</p>
    </div>

    <div class="section">
        <div class="section-title">Custom request</div>
        <textarea id="template" aria-label="Custom request JSON" rows="10" placeholder="Paste a request body from the OpenRouter Request Builder (or any Chat Completions JSON)."></textarea>
        <div class="keyline">
            <button id="saveTemplate">Save request</button>
        </div>
        ${renderNotes(['Streaming', 'Live conversation', 'Thinking effort', 'Provider routing', 'Anthropic caching', 'Picker presets'])}
    </div>
    </section>

    <section class="tab-panel" id="panel-context" role="tabpanel" aria-labelledby="tab-context" tabindex="0" hidden>
    ${contextSectionHtml}
    ${renderNotes(['Context usage'])}
    </section>

    <script nonce="${nonce}">
        const vsc = acquireVsCodeApi();
        const bind = (id, event, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(event, fn);
        };
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
        const activateTab = (tab) => {
            tabs.forEach((item) => {
                const selected = item === tab;
                item.setAttribute('aria-selected', String(selected));
                item.tabIndex = selected ? 0 : -1;
                document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
            });
            vsc.setState({ activeTab: tab.id });
        };
        const savedTab = vsc.getState()?.activeTab;
        const initialTab = tabs.find((tab) => tab.id === savedTab) || tabs[0];
        activateTab(initialTab);
        tabs.forEach((tab, index) => {
            tab.addEventListener('click', () => activateTab(tab));
            tab.addEventListener('keydown', (event) => {
                let nextIndex;
                if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
                else if (event.key === 'ArrowLeft') nextIndex = (index + tabs.length - 1) % tabs.length;
                else if (event.key === 'Home') nextIndex = 0;
                else if (event.key === 'End') nextIndex = tabs.length - 1;
                else return;
                event.preventDefault();
                tabs[nextIndex].focus();
                activateTab(tabs[nextIndex]);
            });
        });
        const templateEl = document.getElementById('template');
        templateEl.value = ${templateJson};
        const keyEl = document.getElementById('key');
        const currentKeyMask = ${JSON.stringify(maskedKey ?? '').replace(/</g, '\\u003c')};
        keyEl.value = currentKeyMask;
        keyEl.addEventListener('input', () => {
            if (keyEl.value !== currentKeyMask) keyEl.type = 'password';
        });
        bind('saveKey', 'click', () => {
            vsc.postMessage({ type: 'saveKey', value: keyEl.value, currentKeyMasked: currentKeyMask });
        });
        bind('limit', 'change', () => {
            vsc.postMessage({ type: 'saveLimit', value: document.getElementById('limit').value });
        });
        bind('refresh', 'click', () => {
            vsc.postMessage({ type: 'refresh' });
        });
        bind('resetPeriod', 'change', () => {
            vsc.postMessage({ type: 'saveResetPeriod', value: document.getElementById('resetPeriod').value });
        });
        bind('includeByok', 'change', () => {
            vsc.postMessage({ type: 'saveIncludeByok', value: document.getElementById('includeByok').checked });
        });
        bind('refreshInterval', 'change', () => {
            vsc.postMessage({ type: 'saveRefreshInterval', value: document.getElementById('refreshInterval').value });
        });
        bind('sanitizeBase64', 'change', () => {
            vsc.postMessage({ type: 'saveSanitizeBase64', value: document.getElementById('sanitizeBase64').checked });
        });
        bind('contextPolicy', 'change', () => {
            vsc.postMessage({ type: 'saveContextPolicy', value: document.getElementById('contextPolicy').value });
        });
        bind('contextMargin', 'change', () => {
            vsc.postMessage({ type: 'saveContextMargin', value: document.getElementById('contextMargin').value });
        });
        document.querySelectorAll('select.capmode').forEach((el) => {
            el.addEventListener('change', () => {
                const idx = el.getAttribute('data-idx');
                const valEl = document.getElementById('capval-' + idx);
                vsc.postMessage({
                    type: 'setContextCap',
                    modelId: el.getAttribute('data-model'),
                    mode: el.value,
                    value: valEl ? valEl.value : undefined,
                });
            });
        });
        document.querySelectorAll('input.capval').forEach((el) => {
            el.addEventListener('change', () => {
                const idx = el.getAttribute('data-idx');
                const selEl = document.querySelector('select.capmode[data-idx="' + idx + '"]');
                vsc.postMessage({
                    type: 'setContextCap',
                    modelId: el.getAttribute('data-model'),
                    mode: selEl ? selEl.value : 'custom',
                    value: el.value,
                });
            });
        });
        bind('saveTemplate', 'click', () => {
            vsc.postMessage({ type: 'saveTemplate', value: templateEl.value });
        });
        bind('presetSelect', 'change', () => {
            vsc.postMessage({ type: 'selectPreset', value: document.getElementById('presetSelect').value });
        });
        window.addEventListener('message', (event) => {
            const m = event.data;
            if (!m || m.type !== 'presetSelection' || typeof m.value !== 'string') {
                return;
            }
            const selectEl = document.getElementById('presetSelect');
            if (!selectEl) {
                return;
            }
            const exists = Array.from(selectEl.options).some((o) => o.value === m.value);
            if (!exists && m.value !== '') {
                const option = document.createElement('option');
                option.value = m.value;
                option.textContent = m.value + ' (not in list)';
                selectEl.appendChild(option);
            }
            selectEl.value = m.value;
        });
    </script>
</div>
</body>
</html>`;
}

function esc(s: string): string {
    return s.replace(/[&<>"]/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
    );
}

export interface PanelMessage {
    type: string;
    value?: unknown;
    modelId?: string;
    mode?: string;
    currentKeyMasked?: string;
}

export interface PanelDeps {
    updateConfig: (key: string, value: unknown) => Thenable<void>;
    error: (message: string) => void;
    info: (message: string) => void;
    doRefresh: () => Promise<unknown>;
    refresh: () => Promise<unknown>;
    saveTemplate: (raw: string) => Promise<{ ok: boolean; error?: string }>;
    clearTemplate: () => Promise<void>;
    setKey: (value: string) => Promise<void>;
    clearKey: () => Promise<void>;
    syncPresetSelection: (slug: string | undefined) => void;
    setContextCap: (modelId: string, value: ContextCapValue | null) => Promise<void>;
}

export function templatePresetSlug(template: Record<string, unknown> | undefined): string | undefined {
    const preset = template?.preset;
    return typeof preset === 'string' && preset.trim() !== '' ? preset : undefined;
}

function presetSlugOf(raw: string): string | undefined {
    try {
        return templatePresetSlug(JSON.parse(stripTemplateComments(raw)) as Record<string, unknown>);
    } catch {
        return undefined;
    }
}

async function saveConfig(deps: PanelDeps, key: string, value: unknown): Promise<void> {
    await deps.updateConfig(key, value);
    await deps.doRefresh();
}

export async function handlePanelMessage(msg: PanelMessage, deps: PanelDeps): Promise<void> {
    switch (msg.type) {
        case 'saveKey': {
            const trimmed = String(msg.value ?? '').trim();
            if (!trimmed) {
                await deps.clearKey();
                await deps.doRefresh();
                deps.info('API key cleared.');
                return;
            }
            if (msg.currentKeyMasked === trimmed) {
                return;
            }
            await deps.setKey(trimmed);
            await deps.doRefresh();
            return;
        }
        case 'saveLimit': {
            const input = String(msg.value ?? '').trim();
            const n = Number(input);
            if (input === '' || !Number.isFinite(n) || n < 0) {
                deps.error('invalid limit');
                return;
            }
            await saveConfig(deps, 'creditLimit', n);
            return;
        }
        case 'saveResetPeriod': {
            const value = String(msg.value);
            if (!isResetPeriod(value)) {
                deps.error('invalid reset period');
                return;
            }
            await saveConfig(deps, 'creditResetPeriod', value);
            return;
        }
        case 'saveIncludeByok': {
            if (typeof msg.value !== 'boolean') {
                deps.error('invalid BYOK flag');
                return;
            }
            await saveConfig(deps, 'creditIncludeByok', msg.value);
            return;
        }
        case 'saveRefreshInterval': {
            const n = Math.round(Number(msg.value));
            if (!Number.isFinite(n) || n < 1 || n > MAX_REFRESH_INTERVAL_MINUTES) {
                deps.error(`invalid refresh interval (1-${MAX_REFRESH_INTERVAL_MINUTES} minutes)`);
                return;
            }
            await saveConfig(deps, 'creditRefreshIntervalMinutes', n);
            return;
        }
        case 'saveSanitizeBase64': {
            if (typeof msg.value !== 'boolean') {
                deps.error('invalid base64 sanitization flag');
                return;
            }
            await saveConfig(deps, 'sanitizeBase64Content', msg.value);
            return;
        }
        case 'saveContextPolicy': {
            const value = String(msg.value ?? '');
            if (value !== 'auto' && value !== 'full') {
                deps.error('invalid context policy');
                return;
            }
            await deps.updateConfig('contextWindowPolicy', value);
            return;
        }
        case 'saveContextMargin': {
            const n = Math.round(Number(msg.value));
            if (!Number.isFinite(n) || n < 0 || n > MAX_CONTEXT_MARGIN_PERCENT) {
                deps.error(`invalid safety margin (0-${MAX_CONTEXT_MARGIN_PERCENT}%)`);
                return;
            }
            await deps.updateConfig('contextSafetyMarginPercent', n);
            return;
        }
        case 'setContextCap': {
            const modelId = String(msg.modelId ?? '').trim();
            if (modelId === '') {
                deps.error('invalid model for the context cap');
                return;
            }
            const mode = String(msg.mode ?? 'auto');
            if (mode === 'auto') {
                await deps.setContextCap(modelId, null);
                await deps.doRefresh();
                return;
            }
            if (mode === 'full') {
                await deps.setContextCap(modelId, 'full');
                await deps.doRefresh();
                return;
            }
            const n = Math.round(Number(msg.value));
            if (!Number.isFinite(n) || n < 1) {
                deps.error('invalid context cap');
                return;
            }
            await deps.setContextCap(modelId, n);
            await deps.doRefresh();
            return;
        }
        case 'clearKey':
            await deps.clearKey();
            await deps.doRefresh();
            deps.info('API key cleared.');
            return;
        case 'saveTemplate': {
            const raw = String(msg.value ?? '');
            if (raw.trim() === '') {
                await deps.clearTemplate();
                deps.syncPresetSelection(undefined);
                deps.info('Custom request cleared.');
                return;
            }
            const result = await deps.saveTemplate(raw);
            if (!result.ok) {
                deps.error(result.error ?? 'invalid template');
                return;
            }
            deps.syncPresetSelection(presetSlugOf(raw));
            await deps.doRefresh();
            deps.info('Custom request saved.');
            return;
        }
        case 'clearTemplate':
            await deps.clearTemplate();
            deps.syncPresetSelection(undefined);
            deps.info('Custom request cleared.');
            return;
        case 'selectPreset': {
            const slug = presetSlugFromPickerValue(String(msg.value ?? ''));
            if (slug === '') {
                await deps.clearTemplate();
                await deps.doRefresh();
                deps.info('Preset unloaded; custom request cleared.');
                return;
            }
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
                deps.error('invalid preset');
                return;
            }
            const result = await deps.saveTemplate(JSON.stringify({ preset: slug }));
            if (!result.ok) {
                deps.error(result.error ?? 'invalid template');
                return;
            }
            await deps.doRefresh();
            deps.info(`Preset "${slug}" loaded as the request template.`);
            return;
        }
        case 'refresh':
            await deps.refresh();
            return;
        default:
            return;
    }
}
