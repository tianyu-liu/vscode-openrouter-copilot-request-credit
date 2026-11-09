import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { t } from './i18n';
import {
    DEFAULT_CONNECTION_NAME, nextConnectionName,
    type ConnectionDefinition, type ConnectionInput, type ConnectionPatch, type ManualModel,
} from './connections';
import type { GatewayAllowance, GatewayBudget } from './gatewayAllowance';
import {
    presetSlugFromPickerValue,
    stripTemplateComments,
    routeCostCells,
    costAmountText,
    cacheShareSuffix,
    UNATTRIBUTED_SESSION_ID,
    MAX_TRACKED_SESSIONS,
    type SessionCost,
} from './provider';
import {
    buildDetail,
    effectiveIncludeByok,
    formatReset,
    KeyInfo,
    ResetPeriod,
    resetPeriodLabel,
    AccountCredits,
} from './logic';
import {
    ASSUMED_CONTEXT_TOKENS,
    DEFAULT_OUTPUT_RESERVE_MAX_TOKENS,
    DEFAULT_OUTPUT_RESERVE_MIN_TOKENS,
    DEFAULT_OUTPUT_RESERVE_PERCENT,
    effectiveOutputReserve,
    normalizeOutputReservePolicy,
    OUTPUT_RESERVE_PERCENT_MAX,
    OUTPUT_RESERVE_PERCENT_MIN,
    type ModelCatalogEntry,
} from './modelInfo';

const MAX_REFRESH_INTERVAL_MINUTES = 1440;
const RESET_PERIODS: readonly ResetPeriod[] = ['daily', 'weekly', 'monthly', 'never'];

const DEFAULT_RESERVE_K = Math.round(
    effectiveOutputReserve({ context_length: ASSUMED_CONTEXT_TOKENS } as ModelCatalogEntry) / 1000
);

const PANEL_NOTES = {
    storage: { term: 'Storage', text: 'Your API key is kept in VS Code SecretStorage.' },
    byokRoutes: {
        term: 'BYOK routes',
        text: 'When OpenRouter reports zero, the session total uses the upstream provider\u2019s reported cost.',
    },
    unattributed: {
        term: 'Unattributed',
        text: 'Spend that reached OpenRouter with no Copilot chat identifier. An agent-host or SDK session talks to this provider through a client-BYOK bridge that carries no chat id, so nothing here is charged to an unrelated chat and no <code>session_id</code> is sent for it.',
    },
    sessionList: {
        term: 'Session list',
        text: 'One entry per Copilot chat session (<code>session_id</code>), newest first, up to the {0} most recent. Named from the chat title when VS Code has one, otherwise the id; times are local. Stored locally and kept across window reloads.',
    },
    hideUnavailable: {
        term: 'Hide unavailable models',
        text: 'Intersects the catalog with the models available to this key (provider preferences, privacy settings, guardrails) and hides the rest from the model picker. Falls back to the full catalog when the query fails.',
    },
    promptSanitization: {
        term: 'Prompt sanitization',
        text: 'Removes long base64-like runs from request text (messages, reasoning, tool arguments) to avoid encoded-prompt guardrails. Image attachments are not changed.',
    },
    streaming: { term: 'Streaming', text: 'Responses stream automatically; no <code>stream</code> field is needed.' },
    liveConversation: {
        term: 'Live conversation',
        text: 'Copilot supplies the conversation, model, and tools; pasted <code>messages</code>, <code>prompt</code>, and <code>model</code> fields are ignored.',
    },
    thinkingEffort: {
        term: 'Thinking effort',
        text: 'The model picker controls <code>reasoning.effort</code> and <code>reasoning.enabled</code>; other reasoning options are preserved.',
    },
    providerRouting: {
        term: 'Provider routing',
        text: 'No routing is added automatically. A pasted <code>provider</code> object passes through unchanged.',
    },
    anthropicCaching: {
        term: 'Anthropic caching',
        text: 'Anthropic-family models (<code>anthropic/*</code>, including <code>~anthropic/*</code>) get a top-level, 5-minute <code>cache_control</code> breakpoint unless the template sets one.',
    },
    presetSelection: {
        term: 'Preset selection',
        text: 'Selecting a preset replaces the saved request with <code>{"preset": "&lt;slug&gt;"}</code>. Selecting "No preset loaded" clears it. The resolved configuration appears below as <code>//</code> comments; copy fields into the JSON to override the preset.',
    },
    pickerPresets: {
        term: 'Picker presets',
        text: '<code>@preset/&lt;slug&gt;</code> applies only while that picker entry is selected; it takes precedence over a different template preset.',
    },
    outputReserve: {
        term: 'Output reserve',
        text: 'The reply budget held back from the window for the picker\u2019s context budget. With the default {0}%, ~{1}K on a 1M-token window, bounded by the lower and upper limits so tiny windows stay sane and huge ones are capped. Limits are entered in K (1 K = 1000 tokens). A real published cap is reserved as-is unless the upper limit is smaller; it is never inflated to the lower limit. The per-model Context size menu still sets the prompt budget itself.',
    },
    autoLimit: {
        term: 'Server-side limit',
        text: 'The key has its own server-side limit; these local controls apply only when it has none. Include BYOK usage shows the key\u2019s authoritative <code>include_byok_in_limit</code> setting read-only.',
    },
} as const;

type PanelNoteId = keyof typeof PANEL_NOTES;

/** Positional arguments (`{0}`, `{1}`, …) for the notes that carry dynamic values. */
const PANEL_NOTE_ARGS: Partial<Record<PanelNoteId, Array<string | number>>> = {
    sessionList: [MAX_TRACKED_SESSIONS],
    outputReserve: [DEFAULT_OUTPUT_RESERVE_PERCENT, DEFAULT_RESERVE_K],
};

function renderNoteList(ids: PanelNoteId[]): string {
    const items = ids.map((id) => {
        const { term, text } = PANEL_NOTES[id];
        return `<li><strong>${t(term)}:</strong> ${t(text, ...(PANEL_NOTE_ARGS[id] ?? []))}</li>`;
    });
    return `<ul class="helptext">${items.join('')}</ul>`;
}

function renderNote(id: PanelNoteId): string {
    return renderNoteList([id]);
}

function emptyState(text: string): string {
    return `<p class="helptext empty">${text}</p>`;
}

export interface PanelSettings {
    sanitizeBase64Content: boolean;
    hideUnavailableModels: boolean;
    outputReservePercent: number;
    outputReserveMinTokens: number;
    outputReserveMaxTokens: number;
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
    sanitizeBase64Content: boolean;
    hideUnavailableModels: boolean;
    outputReservePercent: number;
    outputReserveMinTokens: number;
    outputReserveMaxTokens: number;
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
    const rawSanitize = globalSetting<boolean>(cfg, 'sanitizeBase64Content', true);
    const sanitizeBase64Content = typeof rawSanitize === 'boolean' ? rawSanitize : true;
    const rawHide = globalSetting<boolean>(cfg, 'hideUnavailableModels', true);
    const hideUnavailableModels = typeof rawHide === 'boolean' ? rawHide : true;
    const reserve = normalizeOutputReservePolicy(
        globalSetting<number>(cfg, 'outputReservePercent', DEFAULT_OUTPUT_RESERVE_PERCENT),
        globalSetting<number>(cfg, 'outputReserveMinTokens', DEFAULT_OUTPUT_RESERVE_MIN_TOKENS),
        globalSetting<number>(cfg, 'outputReserveMaxTokens', DEFAULT_OUTPUT_RESERVE_MAX_TOKENS)
    );
    return {
        limit,
        resetPeriod,
        includeByok,
        refreshIntervalMinutes,
        sanitizeBase64Content,
        hideUnavailableModels,
        outputReservePercent: reserve.percent,
        outputReserveMinTokens: reserve.minTokens,
        outputReserveMaxTokens: reserve.maxTokens,
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
export function renderSessionCosts(sessions: SessionCost[] | undefined, generic = false): string {
    const withSpend = (sessions ?? []).filter(s => s.paid > 0 || s.costUnavailable || (generic && s.calls > 0));
    const chats = withSpend.filter(s => s.sessionId !== UNATTRIBUTED_SESSION_ID);
    const unattributed = withSpend.find(s => s.sessionId === UNATTRIBUTED_SESSION_ID);
    if (chats.length === 0 && unattributed === undefined) {
        if (generic) return emptyState(t('No session usage recorded yet. Calls and token counts appear when the server reports usage.'));
        return emptyState(t('No OpenRouter spend recorded yet. Totals appear here once a turn reports a cost. Spend that carried no chat identifier is collected under the <strong>Unattributed</strong> entry.'));
    }
    const rows = chats.map((session, index) => renderSessionDetails(session, index === 0, generic)).join('');
    const unattributedHtml = unattributed ? renderSessionDetails(unattributed, chats.length === 0, generic) : '';
    return `${rows}${unattributedHtml}${renderNote('sessionList')}`;
}

/** One collapsible spend entry; the unattributed bucket explains itself. */
function renderSessionDetails(session: SessionCost, open: boolean, generic = false): string {
    const short = session.sessionId.replace(/^copilot-chat:/, '');
    const label =
        session.sessionId === UNATTRIBUTED_SESSION_ID
            ? t('Unattributed (no chat id)')
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
                                ${generic ? `<td class="num">${r.promptTokens.toLocaleString()}</td><td class="num">${r.completionTokens.toLocaleString()}</td>` : ''}
                            </tr>`;
        })
        .join('');
    const cacheShare = cacheShareSuffix(session);
    const updated = session.updatedAt >= 1e12 ? formatReset(new Date(session.updatedAt), true) : undefined;
    const cost = costAmountText(session);
    const calls = session.calls === 1 ? t('{0} call', session.calls) : t('{0} calls', session.calls);
    return `<details class="session"${open ? ' open' : ''}>
                        <summary>
                            <span class="sessioncost">${esc(cost)}</span>
                            <span class="sessionname">${esc(label)}</span>
                            <span class="muted">${esc(calls)}${esc(cacheShare)}</span>
                            ${updated ? `<span class="muted sessiontime">${esc(updated)}</span>` : ''}
                        </summary>
                        <div class="sessionbody">
                            <table class="routes">
                                <thead>
                                    <tr><th>${t('Cost')}</th><th>${t('Provider')}</th><th>${t('Model')}</th><th>${t('Calls')}</th><th>${t('Cached')}</th>${generic ? `<th>${t('Input tokens')}</th><th>${t('Output tokens')}</th>` : ''}</tr>
                                </thead>
                                <tbody>${routeRows}</tbody>
                            </table>
                            ${session.sessionId === UNATTRIBUTED_SESSION_ID
                                ? generic ? emptyState(t('Usage without a Copilot chat identifier is kept here, separate from named chats.')) : renderNote('unattributed')
                                : `<p class="muted">${t(generic ? 'Session <code>{0}</code>' : 'OpenRouter session <code>{0}</code>', esc(session.sessionId))}</p>`}
                        </div>
                    </details>`;
}

export interface PanelRenderOptions {
    connections?: ConnectionDefinition[];
    selectedConnectionId?: string;
    info?: KeyInfo;
    limit?: number;
    resetPeriod?: ResetPeriod;
    includeByok?: boolean;
    refreshIntervalMinutes?: number;
    fetchedAt?: Date;
    maskedKey?: string;
    accountCredits?: AccountCredits;
    gatewayAllowance?: GatewayAllowance;
    gatewayAllowanceStale?: boolean;
    errorMessage?: string;
    template?: Record<string, unknown>;
    presets?: PresetRow[];
    presetConfig?: Record<string, unknown>;
    sessions?: SessionCost[];
    settings?: Partial<PanelSettings>;
}

function gatewayAmount(value: number | null | undefined): string {
    return typeof value === 'number' && Number.isFinite(value)
        ? `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
        : t('Unavailable');
}

function gatewayTime(value: string | null | undefined): string {
    if (!value) return t('Unavailable');
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? formatReset(date, true) : t('Unavailable');
}

function renderGatewayAllowance(allowance: GatewayAllowance | undefined, stale: boolean): string {
    const rows = (['cheap', 'default'] as const).map(name => {
        const lane = allowance?.[name];
        const reported = lane?.status === 'reported';
        const budget: GatewayBudget | null | undefined = reported ? lane.effective_budget : undefined;
        const period = budget?.reset;
        const periodText = period && isResetPeriod(period) ? resetPeriodLabel(period) : period || t('Unavailable');
        return `<tr data-lane="${name}">
            <th scope="row" class="label">${name === 'cheap' ? t('Cheap lane') : t('Default lane')}</th>
            <td>${reported ? t('Reported') : t('Unknown')}</td>
            <td class="col">${esc(gatewayAmount(budget?.remaining))}</td>
            <td class="col">${esc(gatewayAmount(budget?.limit))}</td>
            <td class="col">${esc(gatewayAmount(budget?.usage))}</td>
            <td>${esc(periodText)}</td><td>${esc(gatewayTime(budget?.resets_at))}</td>
        </tr>`;
    }).join('');
    return `${stale ? `<p class="warn">${t('Saved allowance is stale. Refresh to try again.')}</p>` : ''}
        ${allowance ? '' : emptyState(t('No gateway allowance yet. Save a gateway token, then refresh.'))}
        <div class="table-scroll"><table class="rows">
            <thead><tr><th class="label">${t('Lane')}</th><th>${t('Status')}</th>
            <th>${t('Remaining')}</th><th>${t('Interval allowance')}</th><th>${t('Interval usage')}</th>
            <th>${t('Reset period')}</th><th>${t('Next reset')}</th></tr></thead><tbody>${rows}</tbody>
        </table></div>
        <p class="helptext">${t('Each lane shows its effective interval budget. Unavailable values do not mean zero usage or unlimited access. Lanes are not added together.')}</p>
        <p class="helptext">${t('Gateway retrieved: {0}. Retrieval times do not guarantee current billing counters.', esc(gatewayTime(allowance?.fetched_at)))}</p>
        <p class="helptext">${t('Direct and gateway connections may share the same upstream funds; using both does not add funds.')}</p>`;
}

export function renderPanelHtml(options: PanelRenderOptions): string {
    const {
        info,
        limit = 0,
        resetPeriod = 'daily',
        includeByok = true,
        refreshIntervalMinutes = 5,
        fetchedAt,
        maskedKey,
        accountCredits,
        errorMessage,
        template,
        presets,
        presetConfig,
        sessions,
        settings = {},
    } = options;
    const connections = options.connections ?? [{
        id: 'default', name: DEFAULT_CONNECTION_NAME, kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1',
        enabled: true, revision: 1,
        settings: { creditLimit: limit, creditResetPeriod: resetPeriod, creditIncludeByok: includeByok,
            hideUnavailableModels: settings.hideUnavailableModels ?? true },
    }];
    const connection = connections.find(item => item.id === options.selectedConnectionId) ?? connections[0];
    const connectionId = connection?.id ?? '';
    const newConnectionName = nextConnectionName(connections);
    const isOpenRouter = !connection || connection.kind === 'openrouter';
    const isGateway = connection?.kind === 'gateway';
    const jsonForScript = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');
    const nonce = randomBytes(16).toString('hex');
    const detail = info ? buildDetail(info, limit, resetPeriod, includeByok, accountCredits) : undefined;
    const usageTable = detail
        ? `<table class="rows">
               <caption class="tabletitle">${t('Usage')}</caption>
               <thead><tr><th class="col">${t('OpenRouter')}</th><th class="col">${t('BYOK')}</th><th class="col">${t('Sum')}</th><th class="label">${t('Period')}</th></tr></thead>
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
    const rollingWeekly = detail?.resetPeriod === 'weekly' && detail.highlight !== null;
    const resetText = rollingWeekly
        ? t('Rolling 7-day window')
        : t('Next reset: {0}', detail?.resetDate ?? t('No reset'));
    const remainingLine = detail
        ? `<div class="remainingline${detail.background === 'error' ? ' exhausted' : ''}"><span class="label">${t('Remaining')}</span><span class="limitvalue">${esc(detail.remaining)} / ${esc(detail.limitValue)}</span><span class="muted">${esc(resetText)}</span></div>`
        : '';
    const freeTierLine = detail
        ? `<p class="freetier">${t('Free tier: {0}', detail.freeTier)}</p>`
        : '';
    const modeLine = detail
        ? `<div class="modeline">${esc(detail.modeText)}</div>`
        : '';
    const errorBanner = errorMessage
        ? `<div class="errbanner">${esc(errorMessage)}</div>`
        : '';
    const keyState = maskedKey
        ? `<span class="ok">\u2713 ${t('Key set')}</span>`
        : `<span class="warn">${t('No API key set')}</span>`;
    const autoMode = detail?.mode === 'auto';
    const includeByokShown = autoMode && info ? effectiveIncludeByok(info, includeByok) : includeByok;
    const limitFieldValue = autoMode
        ? detail?.limitNum != null ? String(detail.limitNum) : ''
        : String(limit);
    const periodSelection = autoMode ? detail?.resetPeriod ?? resetPeriod : resetPeriod;
    const limitLine = `<div class="limitline">
               <label class="limitlabel" for="limit">${t('Spending limit')}</label>
               <span>$</span>
                <input type="number" id="limit" min="0" step="0.01" value="${esc(limitFieldValue)}"${autoMode ? ' disabled' : ''} />
               <select id="resetPeriod" aria-label="${t('Spending limit reset period')}" title="${t('How often the local spending limit resets')}"${autoMode ? ' disabled' : ''}>
                   ${RESET_PERIODS.map((p) => `<option value="${p}" ${periodSelection === p ? 'selected' : ''}>${resetPeriodLabel(p)}</option>`).join('')}
               </select>
                <label class="optlabel"><input type="checkbox" id="includeByok" ${includeByokShown ? 'checked' : ''}${autoMode ? ' disabled' : ''} title="${autoMode ? t('Set on the API key; local controls apply only when the key has none') : t('Count bring-your-own-key usage in the remaining balance')}" /> ${t('Include BYOK usage')}${autoMode ? t(' (set on the key)') : ''}</label>
           </div>
           ${autoMode ? renderNote('autoLimit') : ''}`;
    const sessionCostHtml = renderSessionCosts(sessions, !isOpenRouter);
    const updatedLine = `<div class="keyline updatedline">
            ${fetchedAt ? `<span class="muted">${t(isGateway ? 'Retrieved locally: {0}' : 'Updated {0}', esc(formatReset(fetchedAt, true)))}</span>` : ''}
            <button id="refresh">${isGateway ? t('Refresh allowance') : t('Refresh')}</button>
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
        label: `${p.name}${p.model ? ` \u2192 ${p.model}` : p.lookupSkipped ? t(' (model not checked)') : t(' (routing profile)')}`,
    }));
    if (currentPreset !== '' && !presetOptions.some(p => p.slug === currentPreset)) {
        presetOptions.push({ slug: currentPreset, label: `${currentPreset}${t(' (not in list)')}` });
    }
    const presetSelectHtml = `<select id="presetSelect">
            <option value="" ${currentPreset === '' ? 'selected' : ''}>${t('No preset loaded')}</option>
            ${presetOptions
            .map(
                (p) => `<option value="${esc(p.slug)}" ${p.slug === currentPreset ? 'selected' : ''}>${esc(p.label)}</option>`
            )
            .join('')}
        </select>`;
    const presetsHint = presets === undefined
        ? emptyState(t('Presets could not be loaded for this key.'))
        : presets.length === 0
            ? emptyState(t('No presets found for this key.'))
            : '';
    const sanitizeBase64Content = settings.sanitizeBase64Content ?? true;
    const hideUnavailableModels = settings.hideUnavailableModels ?? true;
    const outputReservePercent = settings.outputReservePercent ?? DEFAULT_OUTPUT_RESERVE_PERCENT;
    const outputReserveMinTokens = settings.outputReserveMinTokens ?? DEFAULT_OUTPUT_RESERVE_MIN_TOKENS;
    const outputReserveMaxTokens = settings.outputReserveMaxTokens ?? DEFAULT_OUTPUT_RESERVE_MAX_TOKENS;
    const ktok = (tokens: number): string => String(parseFloat((tokens / 1000).toFixed(3)));

    return `<!DOCTYPE html>
<html lang="${esc(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
    .wrap { max-width: 1100px; }
    .connection-form { display: grid; gap: 10px; max-width: 700px; }
    .connection-form label { display: grid; gap: 5px; }
    .connection-form input[type=text], .connection-form select { width: 100%; box-sizing: border-box; }
    .connection-form .optlabel { display: flex; }
    .connection-url { overflow-wrap: anywhere; }
    .table-scroll { overflow-x: auto; }
    @media (max-width: 480px) { body { padding: 12px; } input[type=password], input[type=text] { max-width: 100%; } .keyline { align-items: stretch; } .sessionbody { padding-left: 0; overflow-x: auto; } }
    body { font-family: var(--vscode-font-family); padding: 16px 20px; color: var(--vscode-foreground); }
    .section { margin-bottom: 22px; }
    .tabs { display: flex; overflow-x: auto; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.15)); margin: 0 0 16px; }
    .tab { color: var(--vscode-descriptionForeground, #888); background: transparent; border-bottom: 2px solid transparent; }
    .tab[aria-selected="true"] { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
    .tab:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -2px; }
    .tab-panel[hidden] { display: none; }
    .section-title { font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
                     font-weight: 600; color: var(--vscode-foreground); margin-bottom: 10px; }
    .keyline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
    .fieldgroup { display: inline-flex; align-items: center; gap: 8px; }
    .fieldgroup .muted { font-style: normal; }
    .sep { color: var(--vscode-descriptionForeground, #888); }
    textarea {
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent); padding: 8px;
        width: 100%; box-sizing: border-box; font-family: var(--vscode-editor-font-family, monospace);
        font-size: inherit; white-space: pre; resize: vertical; }
    input[type=password], input[type=text] {
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent); padding: 4px 8px; width: 320px; box-sizing: border-box;
        font: inherit; }
    input[type=number] {
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, transparent); padding: 4px 8px; width: 90px;
        font: inherit; -moz-appearance: textfield; appearance: textfield; }
    input[type=number]::-webkit-inner-spin-button,
    input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
    #outputReservePercent { width: 52px; }
    #outputReserveMinTokens, #outputReserveMaxTokens { width: 60px; }
    select {
        max-width: 100%;
        background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
        border: 1px solid var(--vscode-dropdown-border, transparent); padding: 4px 8px;
        font: inherit; }
    input:disabled, select:disabled {
        opacity: .7; cursor: not-allowed; }
    .optlabel { color: var(--vscode-descriptionForeground, #888); display: inline-flex; align-items: center; gap: 6px; }
    #refreshInterval { width: 56px; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
             border: none; padding: 5px 12px; cursor: pointer; white-space: nowrap; font: inherit; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .7; cursor: not-allowed; }
    .ok { color: var(--vscode-charts-green, #89d185); }
    .warn { color: var(--vscode-errorForeground, #f14c4c); }
    .errbanner { color: var(--vscode-errorForeground, #f14c4c);
                 background: var(--vscode-inputValidation-errorBackground, rgba(255, 0, 0, 0.1));
                 border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(255, 0, 0, 0.4));
                 padding: 6px 10px; margin: 0 0 10px; border-radius: 4px; }
    .limitline { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-bottom: 10px; }
    .limitlabel { color: var(--vscode-descriptionForeground, #888); }
    .limitvalue { font-size: 1.5em; font-weight: 600; }
    .updatedline { justify-content: flex-start; gap: 12px; align-items: baseline; }
    .rows { border: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.15)); border-radius: 4px;
            border-collapse: collapse; margin-top: 10px; }
    caption.tabletitle { text-align: left; font-size: 12px; text-transform: uppercase;
            letter-spacing: .05em; font-weight: 600; color: var(--vscode-foreground);
            padding: 8px 0 4px; }
    .rows caption.tabletitle { padding: 8px 12px 4px;
            border-bottom: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.1)); }
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
    .helptext.empty { font-style: italic; }
    ul.helptext { padding-left: 18px; }
    ul.helptext li { margin: 2px 0; }
    .sessioncost { font-family: var(--vscode-editor-font-family, monospace); font-weight: 600; }
    details.session { border: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.1));
                      border-radius: 4px; margin: 6px 0; padding: 2px 8px; }
    details.session summary { cursor: pointer; padding: 6px 0; display: flex; gap: 8px; align-items: baseline; }
    details.session summary::marker { color: var(--vscode-descriptionForeground, #888); }
    .sessionname { flex: 1; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    .sessiontime { white-space: nowrap; font-size: 11px; }
    .sessionbody { padding: 0 0 4px 18px; overflow-x: auto; }
    .sessionbody p { margin: 0; }
    table.routes { margin: 2px 0 6px; border-collapse: collapse; font-size: 12px;
                   font-family: var(--vscode-editor-font-family, monospace); }
    table.routes th { text-align: left; font-weight: 600; padding: 2px 12px 2px 0;
                      color: var(--vscode-descriptionForeground, #888);
                      border-bottom: 1px solid var(--vscode-panel-border, rgba(0,0,0,0.1)); }
    table.routes td { padding: 2px 12px 2px 0; vertical-align: top; }
    table.routes td:last-child, table.routes th:last-child { padding-right: 0; }
    table.routes td.num { text-align: right; }
    @media (max-width: 480px) {
        details.session summary { flex-wrap: wrap; }
        .sessionname { flex-basis: 160px; min-width: 0; overflow-wrap: anywhere; }
        .sessiontime { white-space: normal; overflow-wrap: anywhere; }
        .sessionbody { padding-left: 0; }
    }

</style>
</head>
<body>
<div class="wrap">
    <div class="tabs" role="tablist" aria-label="${t('Connections and settings')}">
        <button class="tab" id="tab-settings" role="tab" aria-selected="true" aria-controls="panel-settings" tabindex="0">${t('Settings')}</button>
        ${connections.map(item => `<button class="tab" id="tab-connection-${esc(encodeURIComponent(item.id))}" data-connection-id="${esc(item.id)}" role="tab" aria-selected="false" aria-controls="panel-connection" tabindex="-1">${esc(item.name)}${item.enabled ? '' : ` (${t('Disabled')})`}</button>`).join('')}
    </div>
    ${errorBanner}
    <section class="tab-panel" id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" tabindex="0">
    <div class="section">
        <div class="section-title">${t('Keys')}</div>
        <p class="helptext">${t('Manage named connections here. Choose a model from its connection group in Copilot to route a request.')}</p>
        <div class="keyline">
            <label class="optlabel" for="connectionSelect">${t('Connection')}</label>
            <select id="connectionSelect">${connections.map(item => `<option value="${esc(item.id)}"${item.id === connectionId ? ' selected' : ''}>${esc(item.name)}${item.enabled ? '' : ` (${t('Disabled')})`}</option>`).join('')}</select>
            <button id="addConnection">${t('Add connection')}</button>
            ${connection ? `<button id="toggleConnection">${connection.enabled ? t('Disable') : t('Enable')}</button><button id="deleteConnection">${t('Delete connection')}</button>` : ''}
        </div>
        <form id="connectionForm" class="connection-form">
            <label>${t('Connection name')}<input id="connectionName" type="text" required value="${esc(connection?.name ?? newConnectionName)}" placeholder="${t('For example: Personal, Work, Local')}" /></label>
            <label>${t('API type')}<select id="connectionKind"${connection ? ' disabled' : ''}><option value="openrouter"${isOpenRouter ? ' selected' : ''}>OpenRouter</option><option value="gateway"${isGateway ? ' selected' : ''}>${t('Gateway')}</option><option value="openai-compatible"${connection?.kind === 'openai-compatible' ? ' selected' : ''}>${t('OpenAI compatible')}</option></select></label>
            <label>${t('Base URL')}<input id="connectionUrl" type="text" required value="${esc(connection?.baseUrl ?? 'https://openrouter.ai/api/v1')}" placeholder="http://localhost:1234/v1" /></label>
            <div class="keyline"><button id="saveConnection" type="submit">${t('Save connection')}</button><button id="cancelConnection" type="button" hidden>${t('Cancel')}</button><span id="newConnectionHint" class="helptext" hidden>${t('Enter the new connection details, then save.')}</span></div>
        </form>
        ${maskedKey && !isOpenRouter ? `<p class="helptext">${t('Clear the saved key before changing this connection’s base URL.')}</p>` : ''}
    </div>
    <div class="section">
        <div class="section-title">${isOpenRouter ? t('OpenRouter API key') : t('API key')}</div>
        <div class="keyline">
            <input type="${maskedKey ? 'text' : 'password'}" id="key" aria-label="${isOpenRouter ? t('OpenRouter API key') : t('API key')}" placeholder="${isOpenRouter ? t('OpenRouter API key (sk-or-v1-...)') : isGateway ? t('Gateway bearer token') : t('API key (optional for local servers)')}" />
            <button id="saveKey"${connection ? '' : ' disabled'}>${t('Save key')}</button>
            ${maskedKey ? `<button id="clearKey">${t('Clear key')}</button>` : ''}
            ${keyState}
        </div>
        ${renderNote('storage')}
    </div>
    <div class="section">
        <div class="section-title">${t('Shared settings')}</div>
        <div class="keyline">
            <label class="optlabel" for="refreshInterval">${t('Usage refresh interval (minutes)')}</label>
            <input type="number" id="refreshInterval" min="1" max="${MAX_REFRESH_INTERVAL_MINUTES}" step="1" aria-label="${t('Usage refresh interval in minutes')}" title="${t('Refresh usage data every 1 to {0} minutes', MAX_REFRESH_INTERVAL_MINUTES)}" value="${esc(String(refreshIntervalMinutes))}" />
        </div>
    </div>
    <div class="section">
        <div class="section-title">${t('Output reserve')}</div>
        <div class="keyline">
            <span class="fieldgroup">
                <label class="optlabel" for="outputReservePercent">${t('Target:')}</label>
                <input type="number" id="outputReservePercent" min="${OUTPUT_RESERVE_PERCENT_MIN}" max="${OUTPUT_RESERVE_PERCENT_MAX}" step="0.5" aria-label="${t('Output reserve as percent of window')}" value="${esc(String(outputReservePercent))}" />
                <span class="muted">%</span>
            </span>
            <span class="sep">.</span>
            <span class="fieldgroup">
                <label class="optlabel" for="outputReserveMinTokens">${t('Lower limit:')}</label>
                <input type="number" id="outputReserveMinTokens" min="0.5" step="0.5" aria-label="${t('Lower bound on the output reserve in K')}" value="${esc(ktok(outputReserveMinTokens))}" />
                <span class="muted">K</span>
            </span>
            <span class="sep">.</span>
            <span class="fieldgroup">
                <label class="optlabel" for="outputReserveMaxTokens">${t('Upper limit:')}</label>
                <input type="number" id="outputReserveMaxTokens" min="0.5" step="0.5" aria-label="${t('Upper bound on the output reserve in K')}" value="${esc(ktok(outputReserveMaxTokens))}" />
                <span class="muted">K</span>
            </span>
        </div>
        ${renderNote('outputReserve')}
    </div>
    <div class="section">
        <div class="section-title">${t('Prompt safeguard')}</div>
        <label class="optlabel"><input type="checkbox" id="sanitizeBase64" ${sanitizeBase64Content ? 'checked' : ''} /> ${t('Remove long base64-like text from prompts')}</label>
        ${renderNote('promptSanitization')}
    </div>
    </section>
    <section class="tab-panel" id="panel-connection" role="tabpanel" aria-labelledby="tab-connection-${esc(encodeURIComponent(connectionId))}" tabindex="0" hidden>
    ${connection ? `<p class="helptext connection-url">${esc(connection.name)} · ${esc(connection.baseUrl)}</p>${connection.enabled ? '' : `<p class="warn">${t('This connection is disabled. Enable it in Settings to show its models in Copilot.')}</p>`}` : emptyState(t('Add a connection in Settings to get started.'))}
    ${isOpenRouter ? `    <div class="section">
        <div class="section-title">${t('Credit usage')}</div>
        ${detail ? `${modeLine}<div class="table-scroll">${usageTable}</div>${freeTierLine}${remainingLine}` : emptyState(t('No usage information yet. Save an API key to load account details.'))}
        ${limitLine}
        ${updatedLine}
    </div>
    <div class="section">
        <div class="section-title">${t('Model availability')}</div>
        <label class="optlabel"><input type="checkbox" id="hideUnavailableModels" ${hideUnavailableModels ? 'checked' : ''} /> ${t('Hide models this key cannot use')}</label>
        ${renderNote('hideUnavailable')}
    </div>
` : isGateway ? `<div class="section"><div class="section-title">${t('Gateway allowance')}</div>
        ${renderGatewayAllowance(options.gatewayAllowance, options.gatewayAllowanceStale ?? false)}
        ${updatedLine}
    </div>
    <div class="section"><div class="section-title">${t('Model availability')}</div>
        <p class="helptext">${t('The gateway supplies the models available to this token. If discovery fails, no models are offered until it succeeds.')}</p>
    </div>` : `<div class="section"><div class="section-title">${t('Usage')}</div>${emptyState(t('This API does not provide OpenRouter credits or authoritative cost data. Token counts may be reported by the server.'))}</div>
    <div class="section"><div class="section-title">${t('Manual models')}</div>
        <p class="helptext">${t('Optional model definitions override or supplement /models. Use an array with id, name, contextLength, maxOutputTokens, toolCalling, and imageInput.')}</p>
        <textarea id="manualModels" rows="6" aria-label="${t('Manual model definitions JSON')}">${esc(JSON.stringify(connection?.models ?? [], null, 2))}</textarea>
        <button id="saveManualModels">${t('Save models')}</button>
    </div>`}
    <div class="section">
        <div class="section-title">${t('Session spend')}</div>
        ${sessionCostHtml}
        ${isOpenRouter ? renderNote('byokRoutes') : ''}
    </div>
    ${isOpenRouter ? `<div class="section">
        <div class="section-title">${t('Presets')}</div>
        <div class="keyline">
            <label class="optlabel" for="presetSelect">${t('Preset')}</label>
            ${presetSelectHtml}
        </div>
        ${presetsHint}
        ${renderNoteList(['presetSelection', 'pickerPresets'])}
    </div>` : ''}

    <div class="section">
        <div class="section-title">${t('Custom request')}</div>
        ${isOpenRouter ? '' : `<p class="helptext">${esc(t('To request token usage from servers that support it, include "stream_options": {"include_usage": true} in the request JSON.'))}</p>`}
        <textarea id="template" aria-label="${t('Custom request JSON')}" rows="10" placeholder="${t('Paste a request body from the OpenRouter Request Builder (or any Chat Completions JSON).')}"></textarea>
        <div class="keyline">
            <button id="saveTemplate">${t('Save request')}</button>
        </div>
        ${renderNoteList(isOpenRouter ? ['streaming', 'liveConversation', 'thinkingEffort', 'providerRouting', 'anthropicCaching'] : ['streaming', 'liveConversation'])}
    </div>
    </section>

    <script nonce="${nonce}">
        const vsc = acquireVsCodeApi();
        const savedState = vsc.getState() || {};
        const connectionId = ${jsonForScript(connectionId)};
        const requireConnectionScope = ${JSON.stringify(options.connections !== undefined)};
        const connectionEnabled = ${JSON.stringify(connection?.enabled ?? false)};
        const connectionDrafts = savedState.connectionDrafts || {};
        const draft = { ...(connectionDrafts[connectionId] || {}), activeTab: savedState.activeTab };
        const sharedDraft = savedState.sharedDraft || {};
        for (const prop of ['reservePercent', 'reservePercentBase', 'reserveMin', 'reserveMinBase', 'reserveMax', 'reserveMaxBase']) {
            draft[prop] = sharedDraft[prop];
        }
        let stateTimer;
        const persistState = () => {
            if (stateTimer) {
                clearTimeout(stateTimer);
                stateTimer = undefined;
            }
            connectionDrafts[connectionId] = {
                template: draft.template, templateBase: draft.templateBase,
                preset: draft.preset, presetBase: draft.presetBase,
                manualModels: draft.manualModels, manualModelsBase: draft.manualModelsBase,
            };
            const sharedDraft = {};
            for (const prop of ['reservePercent', 'reservePercentBase', 'reserveMin', 'reserveMinBase', 'reserveMax', 'reserveMaxBase']) {
                sharedDraft[prop] = draft[prop];
            }
            vsc.setState({ activeTab: draft.activeTab, connectionDrafts, sharedDraft });
        };
        const persistStateSoon = () => {
            if (stateTimer) clearTimeout(stateTimer);
            stateTimer = setTimeout(persistState, 250);
        };
        const post = (type, value) => vsc.postMessage({ type, value, connectionId });
        const bind = (id, event, fn) => {
            const el = document.getElementById(id);
            if (el) el.addEventListener(event, fn);
        };
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
        const activateTab = (tab, notify = true) => {
            const targetId = tab.dataset.connectionId;
            const nextKey = document.getElementById('key');
            if (nextKey) { nextKey.value = currentKeyMask; nextKey.type = currentKeyMask ? 'text' : 'password'; }
            tabs.forEach((item) => {
                const selected = item === tab;
                item.setAttribute('aria-selected', String(selected));
                item.tabIndex = selected ? 0 : -1;
            });
            document.getElementById('panel-settings').hidden = !!targetId;
            document.getElementById('panel-connection').hidden = !targetId || targetId !== connectionId;
            if (targetId) document.getElementById('panel-connection').setAttribute('aria-labelledby', tab.id);
            draft.activeTab = tab.id;
            persistState();
            if (notify && targetId && targetId !== connectionId) {
                vsc.postMessage({ type: 'selectConnection', connectionId: targetId });
            }
        };
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
        const rendered = {
            template: ${templateJson},
            preset: ${JSON.stringify(currentPreset).replace(/</g, '\\u003c')},
            reservePercent: ${JSON.stringify(String(outputReservePercent))},
            reserveMin: ${JSON.stringify(ktok(outputReserveMinTokens))},
            reserveMax: ${JSON.stringify(ktok(outputReserveMaxTokens))},
        };
        const templateEl = document.getElementById('template');
        templateEl.value = ${templateJson};
        if (typeof draft.template === 'string' && draft.templateBase === rendered.template) {
            templateEl.value = draft.template;
        }
        templateEl.addEventListener('input', () => {
            draft.template = templateEl.value;
            draft.templateBase = rendered.template;
            persistStateSoon();
        });
        const keyEl = document.getElementById('key');
        const currentKeyMask = ${JSON.stringify(maskedKey ?? '').replace(/</g, '\\u003c')};
        keyEl.value = currentKeyMask;
        keyEl.addEventListener('input', () => {
            if (keyEl.value !== currentKeyMask) keyEl.type = 'password';
        });
        bind('saveKey', 'click', () => {
            vsc.postMessage({ type: 'saveKey', value: keyEl.value, currentKeyMasked: currentKeyMask, connectionId });
        });
        bind('clearKey', 'click', () => {
            post('clearKey');
        });
        const presetEl = document.getElementById('presetSelect');
        const restorePreset = (value) => {
            if (!presetEl) return;
            const exists = Array.from(presetEl.options).some((o) => o.value === value);
            if (!exists && value !== '') {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = value + ${JSON.stringify(t(' (not in list)'))};
                presetEl.appendChild(option);
            }
            presetEl.value = value;
        };
        if (presetEl && typeof draft.preset === 'string' && draft.presetBase === rendered.preset) {
            restorePreset(draft.preset);
        }
        bind('presetSelect', 'change', () => {
            draft.preset = presetEl.value;
            draft.presetBase = rendered.preset;
            persistState();
            post('selectPreset', presetEl.value);
        });
        const bindReserveField = (id, prop, baseProp, messageType) => {
            const el = document.getElementById(id);
            if (!el) return;
            if (draft[prop] !== undefined && draft[baseProp] === rendered[prop]) {
                el.value = draft[prop];
            }
            el.addEventListener('input', () => {
                draft[prop] = el.value;
                draft[baseProp] = rendered[prop];
                persistStateSoon();
            });
            el.addEventListener('change', () => {
                draft[prop] = el.value;
                draft[baseProp] = rendered[prop];
                persistState();
                vsc.postMessage({ type: messageType, value: el.value });
            });
        };
        bindReserveField('outputReservePercent', 'reservePercent', 'reservePercentBase', 'saveOutputReservePercent');
        bindReserveField('outputReserveMinTokens', 'reserveMin', 'reserveMinBase', 'saveOutputReserveMinTokens');
        bindReserveField('outputReserveMaxTokens', 'reserveMax', 'reserveMaxBase', 'saveOutputReserveMaxTokens');
        bind('limit', 'change', () => {
            post('saveLimit', document.getElementById('limit').value);
        });
        bind('refresh', 'click', () => {
            post('refresh');
        });
        bind('resetPeriod', 'change', () => {
            post('saveResetPeriod', document.getElementById('resetPeriod').value);
        });
        bind('includeByok', 'change', () => {
            post('saveIncludeByok', document.getElementById('includeByok').checked);
        });
        bind('refreshInterval', 'change', () => {
            vsc.postMessage({ type: 'saveRefreshInterval', value: document.getElementById('refreshInterval').value });
        });
        bind('sanitizeBase64', 'change', () => {
            vsc.postMessage({ type: 'saveSanitizeBase64', value: document.getElementById('sanitizeBase64').checked });
        });
        bind('hideUnavailableModels', 'change', () => {
            post('saveHideUnavailableModels', document.getElementById('hideUnavailableModels').checked);
        });
        bind('saveTemplate', 'click', () => {
            post('saveTemplate', templateEl.value);
        });
        let creatingConnection = false;
        bind('connectionSelect', 'change', () => {
            persistState();
            vsc.postMessage({ type: 'selectConnection', connectionId: document.getElementById('connectionSelect').value, value: 'settings' });
        });
        bind('addConnection', 'click', () => {
            creatingConnection = true;
            document.getElementById('connectionName').value = ${jsonForScript(newConnectionName)};
            document.getElementById('connectionUrl').value = 'https://openrouter.ai/api/v1';
            document.getElementById('connectionKind').value = 'openrouter';
            document.getElementById('newConnectionHint').hidden = false;
            document.getElementById('cancelConnection').hidden = false;
            document.getElementById('connectionKind').disabled = false;
            document.getElementById('key').value = '';
            document.getElementById('saveKey').disabled = true;
            const clear = document.getElementById('clearKey');
            if (clear) clear.disabled = true;
            for (const id of ['toggleConnection', 'deleteConnection', 'addConnection']) {
                const control = document.getElementById(id);
                if (control) control.disabled = true;
            }
            document.getElementById('connectionName').focus();
        });
        bind('cancelConnection', 'click', () => {
            creatingConnection = false;
            const saved = ${jsonForScript(connection ?? {})};
            document.getElementById('connectionName').value = saved.name || ${jsonForScript(newConnectionName)};
            document.getElementById('connectionUrl').value = saved.baseUrl || 'https://openrouter.ai/api/v1';
            document.getElementById('connectionKind').value = saved.kind || 'openrouter';
            document.getElementById('connectionKind').disabled = !!connectionId;
            document.getElementById('newConnectionHint').hidden = true;
            document.getElementById('cancelConnection').hidden = true;
            keyEl.value = currentKeyMask;
            document.getElementById('saveKey').disabled = !connectionId;
            const clear = document.getElementById('clearKey');
            if (clear) clear.disabled = false;
            for (const id of ['toggleConnection', 'deleteConnection', 'addConnection']) {
                const control = document.getElementById(id);
                if (control) control.disabled = false;
            }
        });
        bind('connectionForm', 'submit', (event) => {
            event.preventDefault();
            const value = {
                name: document.getElementById('connectionName').value,
                baseUrl: document.getElementById('connectionUrl').value,
                kind: document.getElementById('connectionKind').value,
            };
            if (creatingConnection || !connectionId) vsc.postMessage({ type: 'addConnection', value });
            else post('updateConnection', value);
        });
        bind('toggleConnection', 'click', () => post('setConnectionEnabled', !connectionEnabled));
        bind('deleteConnection', 'click', () => post('deleteConnection'));
        const manualEl = document.getElementById('manualModels');
        if (manualEl) {
            const manualBase = manualEl.value;
            if (typeof draft.manualModels === 'string' && draft.manualModelsBase === manualBase) manualEl.value = draft.manualModels;
            manualEl.addEventListener('input', () => {
                draft.manualModels = manualEl.value;
                draft.manualModelsBase = manualBase;
                persistStateSoon();
            });
            bind('saveManualModels', 'click', () => post('saveManualModels', manualEl.value));
        }
        const initialTab = tabs.find((tab) => tab.id === draft.activeTab) || tabs[0];
        activateTab(initialTab, false);
        window.addEventListener('message', (event) => {
            const m = event.data;
            if (!m || typeof m !== 'object') return;
            if (requireConnectionScope ? m.connectionId !== connectionId : m.connectionId && m.connectionId !== connectionId) {
                return;
            }
            if (m.type === 'templateCleared') {
                templateEl.value = '';
                delete draft.template;
                delete draft.templateBase;
                delete draft.preset;
                delete draft.presetBase;
                if (presetEl) presetEl.value = '';
                persistState();
                return;
            }
            if (m.type !== 'presetSelection' || typeof m.value !== 'string') {
                return;
            }
            restorePreset(m.value);
            draft.preset = m.value;
            draft.presetBase = rendered.preset;
            persistStateSoon();
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
    connectionId?: string;
}

export interface PanelDeps {
    selectConnection?: (id: string) => Promise<void>;
    addConnection?: (input: ConnectionInput) => Promise<void>;
    updateConnection?: (id: string, patch: ConnectionPatch) => Promise<void>;
    deleteConnection?: (id: string) => Promise<void>;
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
}

function parseConnectionInput(value: unknown): ConnectionInput | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    if (typeof input.name !== 'string' || !input.name.trim()
        || (input.kind !== 'openrouter' && input.kind !== 'openai-compatible' && input.kind !== 'gateway')
        || typeof input.baseUrl !== 'string') return undefined;
    try {
        const url = new URL(input.baseUrl.trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            return undefined;
        }
    } catch {
        return undefined;
    }
    return { name: input.name.trim(), kind: input.kind, baseUrl: input.baseUrl.trim() };
}

function parseManualModels(value: unknown): ManualModel[] | undefined {
    let parsed: unknown;
    try {
        parsed = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
        return undefined;
    }
    if (!Array.isArray(parsed)) return undefined;
    const ids = new Set<string>();
    const models: ManualModel[] = [];
    for (const value of parsed) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
        const model = value as Record<string, unknown>;
        if (typeof model.id !== 'string' || !model.id.trim() || ids.has(model.id.trim())) return undefined;
        if (model.name !== undefined && (typeof model.name !== 'string' || !model.name.trim())) return undefined;
        for (const field of ['contextLength', 'maxOutputTokens']) {
            if (model[field] !== undefined && (!Number.isSafeInteger(model[field]) || Number(model[field]) <= 0)) {
                return undefined;
            }
        }
        for (const field of ['toolCalling', 'imageInput']) {
            if (model[field] !== undefined && typeof model[field] !== 'boolean') return undefined;
        }
        if (Object.keys(model).some(field => !['id', 'name', 'contextLength', 'maxOutputTokens', 'toolCalling', 'imageInput'].includes(field))) {
            return undefined;
        }
        ids.add(model.id.trim());
        models.push({ ...model, id: model.id.trim() } as unknown as ManualModel);
    }
    return models;
}

export async function handlePanelMessage(msg: PanelMessage, deps: PanelDeps): Promise<void> {
    switch (msg.type) {
        case 'selectConnection':
            if (msg.connectionId) await deps.selectConnection?.(msg.connectionId);
            return;
        case 'addConnection':
        case 'updateConnection': {
            const input = parseConnectionInput(msg.value);
            if (!input) {
                deps.error(t('Enter a connection name, API type, and an HTTP or HTTPS base URL without credentials, query, or fragment.'));
                return;
            }
            if (msg.type === 'addConnection') await deps.addConnection?.(input);
            else if (msg.connectionId) await deps.updateConnection?.(msg.connectionId, input);
            return;
        }
        case 'deleteConnection':
            if (msg.connectionId) await deps.deleteConnection?.(msg.connectionId);
            return;
        case 'setConnectionEnabled':
            if (msg.connectionId && typeof msg.value === 'boolean') {
                await deps.updateConnection?.(msg.connectionId, { enabled: msg.value });
            }
            return;
        case 'saveManualModels': {
            const models = parseManualModels(msg.value);
            if (!models) {
                deps.error(t('Enter a JSON array of models with unique ids and valid optional names, token limits, and capability flags.'));
                return;
            }
            if (msg.connectionId) await deps.updateConnection?.(msg.connectionId, { models });
            return;
        }
        case 'saveKey': {
            const trimmed = String(msg.value ?? '').trim();
            if (!trimmed) {
                await deps.clearKey();
                await deps.doRefresh();
                deps.info(t('API key cleared.'));
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
                deps.error(t('Enter a limit of 0 or more.'));
                return;
            }
            await saveConfig(deps, 'creditLimit', n);
            return;
        }
        case 'saveResetPeriod': {
            const value = String(msg.value);
            if (!isResetPeriod(value)) {
                deps.error(t('Select a valid reset period.'));
                return;
            }
            await saveConfig(deps, 'creditResetPeriod', value);
            return;
        }
        case 'saveIncludeByok': {
            if (typeof msg.value !== 'boolean') {
                deps.error(t('Choose whether BYOK usage counts.'));
                return;
            }
            await saveConfig(deps, 'creditIncludeByok', msg.value);
            return;
        }
        case 'saveRefreshInterval': {
            const n = Math.round(Number(msg.value));
            if (!Number.isFinite(n) || n < 1 || n > MAX_REFRESH_INTERVAL_MINUTES) {
                deps.error(t('Enter a refresh interval from 1 to {0} minutes.', MAX_REFRESH_INTERVAL_MINUTES));
                return;
            }
            await saveConfig(deps, 'creditRefreshIntervalMinutes', n);
            return;
        }
        case 'saveSanitizeBase64': {
            if (typeof msg.value !== 'boolean') {
                deps.error(t('Choose whether long base64-like text is removed.'));
                return;
            }
            await saveConfig(deps, 'sanitizeBase64Content', msg.value);
            return;
        }
        case 'saveHideUnavailableModels': {
            if (typeof msg.value !== 'boolean') {
                deps.error(t('Choose whether unavailable models are hidden.'));
                return;
            }
            await saveConfig(deps, 'hideUnavailableModels', msg.value);
            return;
        }
        case 'saveOutputReservePercent': {
            const n = Number(msg.value);
            if (!Number.isFinite(n) || n < OUTPUT_RESERVE_PERCENT_MIN || n > OUTPUT_RESERVE_PERCENT_MAX) {
                deps.error(t('Enter an output reserve from {0}% to {1}%.', OUTPUT_RESERVE_PERCENT_MIN, OUTPUT_RESERVE_PERCENT_MAX));
                return;
            }
            await saveConfig(deps, 'outputReservePercent', n);
            return;
        }
        case 'saveOutputReserveMinTokens': {
            const n = Math.round(Number(msg.value) * 1000);
            if (!Number.isFinite(n) || n < 1) {
                deps.error(t('Enter an output reserve lower limit above 0 K.'));
                return;
            }
            await saveConfig(deps, 'outputReserveMinTokens', n);
            return;
        }
        case 'saveOutputReserveMaxTokens': {
            const n = Math.round(Number(msg.value) * 1000);
            if (!Number.isFinite(n) || n < 1) {
                deps.error(t('Enter an output reserve upper limit above 0 K.'));
                return;
            }
            await saveConfig(deps, 'outputReserveMaxTokens', n);
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
                deps.info(t('Custom request cleared.'));
                return;
            }
            const result = await deps.saveTemplate(raw);
            if (!result.ok) {
                deps.error(result.error ?? t('The request template is not valid.'));
                return;
            }
            deps.syncPresetSelection(presetSlugOf(raw));
            await deps.doRefresh();
            deps.info(t('Custom request saved.'));
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
                deps.info(t('Preset unloaded; custom request cleared.'));
                return;
            }
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) {
                deps.error(t('Enter a valid preset slug.'));
                return;
            }
            const result = await deps.saveTemplate(JSON.stringify({ preset: slug }));
            if (!result.ok) {
                deps.error(result.error ?? t('The request template is not valid.'));
                return;
            }
            await deps.doRefresh();
            deps.info(t('Preset "{0}" loaded as the request template.', slug));
            return;
        }
        case 'refresh':
            await deps.refresh();
            return;
        default:
            return;
    }
}
