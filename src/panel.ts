import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import {
    presetSlugFromPickerValue,
    stripTemplateComments,
    routeCostLine,
    MAX_TRACKED_SESSIONS,
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


const DEFAULT_BASE_URL = 'https://openrouter.ai';
const MAX_REFRESH_INTERVAL_MINUTES = 1440;
const RESET_PERIODS: readonly ResetPeriod[] = ['daily', 'weekly', 'monthly', 'never'];

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

let warnedBadBaseUrl = false;

function rejectBaseUrl(raw: unknown): void {
    if (warnedBadBaseUrl) return;
    warnedBadBaseUrl = true;
    vscode.window.showWarningMessage(
        `OpenRouter: ignoring baseUrl "${String(raw)}" — must be an https:// URL set in user (global) settings.`
    );
}

export function apiBaseUrl(cfg: vscode.WorkspaceConfiguration = getConfig()): string {
    const raw = globalSetting<string>(cfg, 'creditBaseUrl', DEFAULT_BASE_URL);
    let parsed: URL | undefined;
    try {
        parsed = new URL(raw);
    } catch {
        parsed = undefined;
    }
    if (!parsed || parsed.protocol !== 'https:' || !parsed.host) {
        rejectBaseUrl(raw);
        return DEFAULT_BASE_URL;
    }
    warnedBadBaseUrl = false;
    return parsed.href.replace(/\/+$/, '');
}

export interface ConfigSnapshot {
    limit: number;
    resetPeriod: ResetPeriod;
    includeByok: boolean;
    refreshIntervalMinutes: number;
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
    return { limit, resetPeriod, includeByok, refreshIntervalMinutes };
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
 * The markup is `<details>`, so expansion works without any script and survives
 * the panel being re-rendered on every message.
 */
export function renderSessionCosts(sessions: SessionCost[] | undefined): string {
    const withSpend = (sessions ?? []).filter(s => s.paid > 0);
    if (withSpend.length === 0) {
        return '<p class="muted">No OpenRouter spend recorded yet. Totals appear here once a turn reports a cost.</p>';
    }
    const rows = withSpend
        .map((session, index) => {
            const short = session.sessionId.replace(/^copilot-chat:/, '');
            const label = session.title ?? `${short.slice(0, 8)}${short.length > 8 ? '\u2026' : ''}`;
            const open = index === 0 ? ' open' : '';
            const routeRows = session.routes
                .map(r => `<li class="route">${esc(routeCostLine(r))}</li>`)
                .join('');
            const cacheShare = session.promptTokens > 0
                ? ` \u00b7 ${((session.cachedTokens / session.promptTokens) * 100).toFixed(1)}% cached`
                : '';
            const updated = session.updatedAt >= 1e12 ? formatReset(new Date(session.updatedAt), true) : undefined;
            return `<details class="session"${open}>
                        <summary>
                            <span class="sessioncost">${esc(formatUsdPrecise(session.paid))}</span>
                            <span class="sessionname">${esc(label)}</span>
                            <span class="muted">${esc(String(session.calls))} call(s)${esc(cacheShare)}</span>
                            ${updated ? `<span class="muted sessiontime">${esc(updated)}</span>` : ''}
                        </summary>
                        <div class="sessionbody">
                            <ul class="routes">${routeRows}</ul>
                            <p class="muted">OpenRouter session <code>${esc(session.sessionId)}</code></p>
                        </div>
                    </details>`;
        })
        .join('');
    return `${rows}
        <p class="muted">One entry per Copilot chat session (<code>session_id</code>), newest first, up to the ${MAX_TRACKED_SESSIONS} most recent. Named from the chat title when VS Code has one, otherwise the id; times are local. Stored locally and kept across window reloads.</p>`;
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
    sessions?: SessionCost[]
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
    const manual = detail && detail.limitSource === 'manual';
    const guardrailDisabled = manual && limit <= 0;
    const controlsEnabled = manual && !guardrailDisabled;
    const limitInputValue = manual ? limit : (detail?.limitNum ?? limit);
    const selectedPeriod = manual ? resetPeriod : (detail?.resetPeriod ?? resetPeriod);
    const byokChecked = manual ? includeByok : (info && info.include_byok_in_limit !== false);
    const limitLine = detail
        ? `<div class="limitline">
               <span class="limitlabel">Limit</span>
               <span>$</span>
                <input type="number" id="limit" min="0" step="0.01" value="${esc(String(limitInputValue))}" ${manual ? '' : 'disabled'} />
               <select id="resetPeriod" ${controlsEnabled ? '' : 'disabled'}>
                   ${RESET_PERIODS.map((p) => `<option value="${p}" ${selectedPeriod === p ? 'selected' : ''}>${resetPeriodLabel(p)}</option>`).join('')}
               </select>
                <label class="optlabel"><input type="checkbox" id="includeByok" ${byokChecked ? 'checked' : ''} ${controlsEnabled ? '' : 'disabled'} /> BYOK included</label>
           </div>`
        : '';
    const sessionCostHtml = renderSessionCosts(sessions);
    const updatedLine = `<div class="keyline updatedline">
            <label class="optlabel">Auto-refresh (min)</label>
            <input type="number" id="refreshInterval" min="1" step="1" value="${esc(String(refreshIntervalMinutes))}" class="intervalinput" />
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
        ? '<p class="muted">Presets could not be loaded for this key.</p>'
        : presets.length === 0
            ? '<p class="muted">No presets found for this key.</p>'
            : '';
    const footnoteRows: Array<[string, string]> = [
        ['fn-1', '<code>stream</code> \u2014 always on; responses stream token-by-token.'],
        ['fn-2', '<code>session_id</code> \u2014 one OpenRouter session per Copilot chat session: the chat session\u2019s own id (which VS Code persists) is sent, so your prompt cache stays warm and every turn of that chat, reload or restart included, stays under one session in OpenRouter\u2019s Logs \u2192 Sessions view. When Copilot sends no chat-session id (an internal sub-agent call), the most recently active chat\u2019s id is used instead; if no chat is known, no <code>session_id</code> is sent at all \u2014 there is no per-window random ID.'],
        ['fn-3', 'Applied to every Copilot Chat request to OpenRouter until cleared; each turn the live conversation and tools are merged in, so any pasted <code>messages</code>/<code>prompt</code>/<code>model</code> fields are ignored.'],
        ['fn-4', 'Reasoning effort / enabled \u2014 taken from the model picker\u2019s Thinking Effort selector and spread into the template\u2019s <code>reasoning</code> object (overwrites <code>effort</code>/<code>enabled</code> only; other keys like <code>max_tokens</code>/<code>exclude</code> survive).'],
        ['fn-5', 'No built-in defaults \u2014 everything you paste, including a <code>provider</code> object, is sent verbatim to every request, with no separate UI for it.'],
        ['fn-6', 'Usage accounting \u2014 OpenRouter attaches a <code>usage</code> chunk to every streamed response automatically; nothing to paste.'],
        ['fn-7', 'Key storage (SecretStorage) and the https-only base URL are not configurable.'],
        ['fn-8', 'Anthropic-family models (<code>anthropic/*</code>) get a top-level <code>cache_control</code> (a 5-minute ephemeral breakpoint that advances with the conversation) unless your template sets its own <code>cache_control</code>.'],
        ['fn-9', 'Presets \u2014 selecting a preset in the Presets section sends <code>"preset": "&lt;slug&gt;"</code> with every request; model presets also appear in the model picker as <code>@preset/&lt;slug&gt;</code>. Picker preset entries only affect turns on that entry \u2014 other models are untouched while the custom request is empty. If both are set, the picker entry wins as the preset reference (a different <code>preset</code> in the custom request is dropped for that turn) and the custom request\u2019s other fields still apply on top. Preset requests keep the preset\u2019s own provider routing: the extension adds no default <code>provider</code>, so the preset\u2019s routing applies unless a pasted <code>provider</code> overrides it.'],
        ['fn-10', 'Per-turn usage \u2014 every turn forwards OpenRouter\u2019s own <code>usage</code> chunk (prompt/completion tokens, cache reads) back to Copilot, so the context-usage ring shows used / max tokens. Cost is accumulated per chat session in the <b>Session spend</b> section above, broken down by provider and model: OpenRouter\u2019s <code>cost</code> when OpenRouter charges you, or \u2014 on a BYOK route, where OpenRouter reports <code>cost: 0</code> because the upstream provider bills you \u2014 the upstream cost it reports in <code>cost_details.upstream_inference_cost</code>. Costs are never written into the chat transcript, and Copilot\u2019s own response footer is not reachable by an extension-provided model.'],
    ];
    const footnotesHtml = footnoteRows
        .map(([id, text]) => `<p class="tmplnote"><a id="${id}">${id.slice(3)}.</a> ${text}</p>`)
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
    body { font-family: var(--vscode-font-family); padding: 16px 20px; color: var(--vscode-foreground); }
    h1 { margin: 0 0 16px; font-size: 1.4em; }
    .section { margin-bottom: 22px; }
    .section-title { font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
                     font-weight: 600; color: var(--vscode-foreground); margin-bottom: 10px; }
    .keyline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    textarea {
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent); padding: 8px;
        width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace);
        white-space: pre; resize: vertical; }
    input[type=password] {
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
    .optblock { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.1)); }
    .divider { border-top: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.1)); padding-top: 16px; }
    .muted { color: var(--vscode-descriptionForeground, #888); font-style: italic; }
    .tmplnote { font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin: 4px 0 0; }
    .footnotes { margin-top: 10px; }
    .sessiontotal { font-weight: 600; }
    .sessioncost { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; }
    details.session { border: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.1));
                      border-radius: 4px; margin: 6px 0; padding: 2px 8px; }
    details.session summary { cursor: pointer; padding: 6px 0; display: flex; gap: 8px; align-items: baseline; }
    details.session summary::marker { color: var(--vscode-descriptionForeground, #888); }
    .sessionname { flex: 1; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    .sessiontime { white-space: nowrap; font-size: 11px; }
    .sessionbody { padding: 0 0 4px 18px; }
    .sessionbody p { margin: 0; }
    ul.routes { margin: 0 0 6px; padding-left: 18px; }
    li.route { font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); margin: 2px 0; }

</style>
</head>
<body>
<div class="wrap">
    <h1>OpenRouter for Copilot</h1>

    <div class="section">
        <div class="section-title">API key</div>
        <div class="keyline">
            <input type="${maskedKey ? 'text' : 'password'}" id="key" placeholder="OpenRouter API key (sk-or-v1-...)" />
            <button id="saveKey">Save Key</button>
            ${keyState}
        </div>
        ${errorBanner}
    </div>

    <div class="section divider">
        <div class="section-title">Key credit info</div>
        ${detail ? `${limitLine}${modeLine}${usageTable}${freeTierLine}${remainingLine}` : `<p class="muted">No key info yet. Save your API key to fetch usage.</p>`}
        ${updatedLine}
    </div>

    <div class="section divider">
        <div class="section-title">Session spend</div>
        ${sessionCostHtml}
    </div>

    <div class="section divider">
        <div class="section-title">Presets</div>
        <div class="keyline">
            <label class="optlabel" for="presetSelect">Preset</label>
            ${presetSelectHtml}
        </div>
        ${presetsHint}
        <p class="muted">Selecting a preset saves <code>{"preset": "&lt;slug&gt;"}</code> as the custom request below; the preset\u2019s own configuration then applies to every request. Select \u201cNo preset loaded\u201d to unload it. The resolved configuration is shown under the JSON as <code>//</code> comments, which are ignored on save \u2014 copy fields into the JSON to override the preset.</p>
    </div>

    <div class="section">
        <div class="section-title">Custom Request</div>
        <textarea id="template" rows="10" placeholder="Paste a request body from the OpenRouter Request Builder (or any Chat Completions JSON)."></textarea>
        <div class="keyline">
            <button id="saveTemplate">Save request</button>
        </div>
        <div class="footnotes">
            <div class="section-title">How your pasted request is applied</div>
            ${footnotesHtml}
        </div>
    </div>

    <script nonce="${nonce}">
        const vsc = acquireVsCodeApi();
        const bind = (id, event, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(event, fn);
        };
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
