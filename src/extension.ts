import * as vscode from 'vscode';
import { profileDirectory } from './profileStorage';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'fs';
import { setTranslator, t } from './i18n';
import { buildStatus, KeyInfo, maskKey, AccountCredits, parseSessionTitle } from './logic';
import {
    getConfig,
    handlePanelMessage,
    PanelDeps,
    PanelMessage,
    readConfig,
    renderPanel,
    templatePresetSlug,
} from './panel';
import { readKey, resolveSecretStorage } from './storage';
import {
    getSessionCosts, OpenRouterChatProvider, SESSION_ID_PREFIX, setRequestDumpDirectory, type SessionCost,
} from './provider';
import {
    ConnectionRegistry, LEGACY_CONNECTION_ID,
    type ConnectionDefinition, type ConnectionPatch, type ConnectionSettings,
} from './connections';
import { ConnectionChatProvider } from './connectionProvider';
import { NativeGroupManager } from './nativeGroups';

export { readConfig } from './panel';

const MAX_ERROR_LENGTH = 300;
const APP_PREFIX = 'OpenRouter: ';

let statusBarItem: vscode.StatusBarItem | undefined;
let statusText = '';
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let panel: vscode.WebviewPanel | undefined;
type PanelContent = ReturnType<typeof renderPanel>['live'];
let panelDocument: { id: string; connectionId?: string; layout: string; initial: PanelContent; live: PanelContent } | undefined;
const presetSelectionResults = new Map<string | undefined, PanelMessage>();
let provider: OpenRouterChatProvider | undefined;
let sessionTitleDir: vscode.Uri | undefined;
let registry: ConnectionRegistry | undefined;
let router: ConnectionChatProvider | undefined;
let nativeGroups: NativeGroupManager | undefined;
let selectedConnectionId: string | undefined;
let extensionState: vscode.Memento | undefined;
let panelMessageQueue: Promise<void> = Promise.resolve();

const CONNECTION_MESSAGES = new Set([
    'saveKey', 'clearKey', 'saveLimit', 'saveResetPeriod', 'saveIncludeByok', 'saveHideUnavailableModels',
    'saveShowBudgetInStatusBar',
    'saveTemplate', 'clearTemplate', 'selectPreset', 'refresh', 'updateConnection', 'deleteConnection', 'repairModelGroup',
    'setConnectionEnabled', 'saveManualModels',
]);

interface CreditState {
    info?: KeyInfo;
    accountCredits?: AccountCredits;
    fetchedAt?: Date;
    error?: string;
    currentRun?: { controller: AbortController; done: Promise<KeyInfo | undefined> };
}
const connectionCredits = new Map<string, CreditState>();

function creditState(id: string): CreditState {
    let value = connectionCredits.get(id);
    if (!value) {
        value = {};
        connectionCredits.set(id, value);
    }
    return value;
}

function selectedConnection(): ConnectionDefinition | undefined {
    return selectedConnectionId ? registry?.getOpenRouter(selectedConnectionId) : undefined;
}

function initialGroupConnection(): ConnectionDefinition | undefined {
    return registry?.getOpenRouter(LEGACY_CONNECTION_ID) ?? registry?.listOpenRouter()[0];
}

const CHAT_SESSIONS_DIR = 'chatSessions';
const SESSION_TITLE_MAX_BYTES = 64 * 1024;
const SESSION_FILE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function chatSessionsDir(storageUri: vscode.Uri | undefined): vscode.Uri | undefined {
    if (!storageUri) return undefined;
    const parts = storageUri.path.split('/');
    parts.pop();
    parts.push(CHAT_SESSIONS_DIR);
    return storageUri.with({ path: parts.join('/') });
}

export async function readSessionTitleFromDisk(file: vscode.Uri): Promise<string | undefined> {
    let handle;
    try {
        handle = await fsp.open(file.fsPath, 'r');
    } catch {
        return undefined;
    }
    try {
        const buffer = Buffer.alloc(SESSION_TITLE_MAX_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return parseSessionTitle(buffer.subarray(0, bytesRead).toString('utf8'));
    } catch {
        return undefined;
    } finally {
        await handle.close();
    }
}

async function withSessionTitles(sessions: SessionCost[]): Promise<SessionCost[]> {
    const dir = sessionTitleDir;
    if (!dir) return sessions;
    return Promise.all(
        sessions.map(async (session) => {
            if (session.title || !session.sessionId.startsWith(SESSION_ID_PREFIX)) return session;
            const id = session.sessionId.slice(SESSION_ID_PREFIX.length);
            if (!SESSION_FILE_ID_PATTERN.test(id)) return session;
            const title = await readSessionTitleFromDisk(vscode.Uri.joinPath(dir, `${id}.jsonl`));
            return title ? { ...session, title } : session;
        })
    );
}

const legacyCredits: CreditState = {};

let refreshTimerDisarmedForTesting = false;

export function stopRefreshTimerForTesting(): void {
    refreshTimerDisarmedForTesting = true;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
}

function errorMessage(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}\u2026` : message;
}

function showError(err: unknown): void {
    vscode.window.showErrorMessage(`${APP_PREFIX}${errorMessage(err)}`);
}

function setStatus(
    text: string, tooltip: string | vscode.MarkdownString, background?: vscode.ThemeColor,
    accessibleLabel?: string
): void {
    if (!statusBarItem) return;
    statusText = text;
    updateStatusIcon();
    statusBarItem.tooltip = typeof tooltip === 'string' ? new vscode.MarkdownString(tooltip) : tooltip;
    const label = accessibleLabel ?? text.replace(/\$\([^)]+\)\s*/g, '');
    statusBarItem.accessibilityInformation = { label: label ? `OpenRouter: ${label}` : 'OpenRouter' };
    statusBarItem.backgroundColor = background;
    statusBarItem.show();
}

function updateBudgetStatus(): void {
    if (!registry) return;
    const { statusBarBudgetDisplay } = readConfig();
    const label = statusBarBudgetDisplay === 'usage' ? t('Usage') : t('Remaining');
    const tooltip = new vscode.MarkdownString();
    const amounts: string[] = [];
    const descriptions: string[] = [];
    let exhausted = false;
    for (const connection of registry.listOpenRouter()) {
        if (!connection.enabled || connection.settings.showBudgetInStatusBar === false) continue;
        const state = connectionCredits.get(connection.id);
        if (!state?.info && !state?.error) continue;
        if (descriptions.length) tooltip.appendMarkdown('\n\n');
        tooltip.appendMarkdown('**').appendText(connection.name).appendMarkdown('**  \n');
        if (state.error) {
            tooltip.appendText(state.error);
            descriptions.push(`${connection.name}: ${state.error}`);
            continue;
        }
        const { creditLimit, creditResetPeriod, creditIncludeByok } = connection.settings;
        const view = buildStatus(state.info!, creditLimit, creditResetPeriod, creditIncludeByok,
            state.accountCredits, statusBarBudgetDisplay);
        tooltip.appendMarkdown(view.tooltip);
        amounts.push(view.text);
        descriptions.push(`${connection.name}: ${view.text}`);
        exhausted ||= view.background === 'error';
    }
    const background = exhausted ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    setStatus(amounts.join(' | '), descriptions.length ? tooltip : t('Open Settings in the panel to manage key budgets.'),
        background, descriptions.length ? `${label}: ${descriptions.join(', ')}` : undefined);
}

function updateStatusIcon(): void {
    if (!statusBarItem) return;
    const kind = vscode.window.activeColorTheme.kind;
    const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
    statusBarItem.text = `$(openrouter-rc-${light ? 'ink' : 'cloud'})${statusText ? ` ${statusText}` : ''}`;
}

export function getStatusText(): string | undefined {
    return statusBarItem?.text;
}

async function getJson(url: string, apiKey: string, signal?: AbortSignal, timeoutMs = 15000): Promise<unknown> {
    let res: Response;
    let text: string;
    try {
        res = await fetch(url, {
            redirect: 'error',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'User-Agent': 'vscode-openrouter-copilot-request-credit',
                Accept: 'application/json',
            },
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
        text = res.ok ? await res.text() : '';
    } catch {
        throw new Error(t('OpenRouter request failed.'));
    }
    if (typeof res.url === 'string' && /^http:/i.test(res.url)) {
        void res.body?.cancel().catch(() => undefined);
        throw new Error(t('OpenRouter: blocked insecure redirect.'));
    }
    if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        throw new Error(t('OpenRouter request failed ({0}).', res.status));
    }
    if (!text.trim()) {
        throw new Error(t('Empty response body (HTTP {0})', res.status));
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(t('Invalid JSON response (HTTP {0}).', res.status));
    }
}

function asDataObject(json: unknown, endpoint: string): Record<string, unknown> {
    const data = (json as { data?: unknown } | null)?.data;
    if (typeof json !== 'object' || json === null || typeof data !== 'object' || data === null) {
        throw new Error(t('Unexpected response shape from {0}', endpoint));
    }
    return data as Record<string, unknown>;
}

async function fetchApi<T>(apiKey: string, resource: string, signal?: AbortSignal): Promise<T> {
    const json = await getJson(`https://openrouter.ai/api/v1/${resource}`, apiKey, signal);
    return asDataObject(json, `/api/v1/${resource}`) as unknown as T;
}

let panelRenderSeq = 0;

export async function sendPanelRefresh(
    webview: Pick<vscode.Webview, 'postMessage'>, documentId: string, previous: PanelContent, current: PanelContent,
    reopening = false
): Promise<void> {
    const content: Partial<PanelContent> = reopening ? {
        templateBase: current.templateBase, templateDisplay: current.templateDisplay, preset: current.preset,
    } : {};
    for (const key of Object.keys(current) as (keyof PanelContent)[]) {
        if (current[key] !== previous[key]) content[key] = current[key];
    }
    if (Object.keys(content).length) await webview.postMessage({ type: 'panelRefresh', documentId, content });
}

function finishPanelPresetSelection(connectionId: string | undefined, presetMutationId: string, preset?: string): void {
    const result = { type: 'presetSelectionResult', connectionId, presetMutationId, value: preset };
    presetSelectionResults.set(connectionId, result);
    if (preset !== undefined && selectedConnectionId === connectionId) ++panelRenderSeq;
    const current = panelDocument;
    if (!current || current.connectionId !== connectionId) return;
    if (preset !== undefined) {
        const base = preset ? JSON.stringify({ preset }, null, 2) : '';
        if (current.live.templateBase !== base) {
            current.live = { ...current.live, templateBase: base, templateDisplay: base, preset };
        }
    }
    void panel?.webview.postMessage(result);
}

async function updatePanel(
    secrets: vscode.SecretStorage,
    info: KeyInfo | undefined,
    signal?: AbortSignal,
    storedKey?: string | null
): Promise<void> {
    const targetPanel = panel;
    if (!targetPanel) return;
    const render = ++panelRenderSeq;
    const connection = selectedConnection();
    const id = connection?.id;
    const state = id ? creditState(id) : undefined;
    const activeProvider = id ? router?.getProvider(id) : provider;
    const stale = (): boolean => render !== panelRenderSeq || (signal?.aborted ?? false) || panel !== targetPanel
        || (id !== undefined && (selectedConnectionId !== id || registry?.getOpenRouter(id)?.revision !== connection?.revision));
    const config = readConfig();
    const {
        refreshIntervalMinutes,
        sanitizeBase64Content,
        outputReservePercent,
        outputReserveMinTokens,
        outputReserveMaxTokens,
        statusBarBudgetDisplay,
    } = config;
    const limit = connection?.settings.creditLimit ?? config.limit;
    const resetPeriod = connection?.settings.creditResetPeriod ?? config.resetPeriod;
    const includeByok = connection?.settings.creditIncludeByok ?? config.includeByok;
    const hideUnavailableModels = connection?.settings.hideUnavailableModels ?? config.hideUnavailableModels;
    const key = storedKey !== undefined ? storedKey : id ? await registry?.readKey(id)
        : registry ? undefined : await readKey(secrets);
    if (stale()) return;
    const template = await activeProvider?.getTemplate();
    if (stale()) return;
    const presetsProvider = connection?.enabled === false ? undefined : activeProvider;
    const presets = presetsProvider ? await presetsProvider.getPresets() : [];
    if (stale()) return;
    const presetSlug = templatePresetSlug(template);
    const presetConfig = presetSlug && presetsProvider
        ? await presetsProvider.getPresetConfig(presetSlug) : undefined;
    if (stale()) return;
    const sessions = await withSessionTitles(id ? router?.getSessionCosts(id) ?? [] : getSessionCosts());
    if (stale()) return;
    const view = renderPanel({
        connections: registry?.list(),
        selectedConnectionId: id,
        info: state ? state.info : info,
        limit,
        resetPeriod,
        includeByok,
        refreshIntervalMinutes,
        fetchedAt: state ? state.fetchedAt : legacyCredits.fetchedAt,
        maskedKey: key ? maskKey(key) : undefined,
        accountCredits: state ? state.accountCredits : legacyCredits.accountCredits,
        errorMessage: state ? state.error : legacyCredits.error,
        template,
        presets,
        presetConfig,
        sessions,
        settings: {
            sanitizeBase64Content,
            hideUnavailableModels,
            outputReservePercent,
            outputReserveMinTokens,
            outputReserveMaxTokens,
            statusBarBudgetDisplay,
        },
    });
    if (stale()) return;
    const current = panelDocument;
    if (current?.layout === view.layout) {
        const previous = current.live;
        current.live = view.live;
        await sendPanelRefresh(targetPanel.webview, current.id, previous, view.live);
        return;
    }
    panelDocument = { id: view.documentId, connectionId: id, layout: view.layout, initial: view.live, live: view.live };
    targetPanel.webview.html = view.html;
}

export function createPanelDeps(
    secrets: vscode.SecretStorage,
    prov: Pick<OpenRouterChatProvider, 'setTemplate' | 'clearTemplate' | 'setKey' | 'clearKey'>
): PanelDeps {
    return {
        updateConfig: (key, value) => getConfig().update(key, value, vscode.ConfigurationTarget.Global),
        error: (message) => void vscode.window.showErrorMessage(`${APP_PREFIX}${message}`),
        info: (message) => void vscode.window.showInformationMessage(`${APP_PREFIX}${message}`),
        doRefresh: () => doRefresh(secrets),
        refresh: () => refresh(secrets),
        saveTemplate: (raw) => prov.setTemplate(raw),
        clearTemplate: () => prov.clearTemplate(),
        setKey: (value) => prov.setKey(value),
        clearKey: () => prov.clearKey(),
        syncPresetSelection: (slug) =>
            void panel?.webview.postMessage({ type: 'presetSelection', value: slug ?? '' }),
        finishPresetSelection: (mutationId, preset) => finishPanelPresetSelection(undefined, mutationId, preset),
    };
}

async function selectConnection(id: string, secrets: vscode.SecretStorage): Promise<void> {
    const connection = registry?.getOpenRouter(id);
    if (!connection) throw new Error(t('Connection no longer exists.'));
    const previousId = selectedConnectionId;
    await extensionState?.update('selectedConnectionId', id);
    selectedConnectionId = id;
    provider = router?.getProvider(id);
    ++panelRenderSeq;
    try {
        await updatePanel(secrets, creditState(id).info);
    } catch (error) {
        if (selectedConnectionId === id) {
            selectedConnectionId = previousId;
            provider = previousId ? router?.getProvider(previousId) : undefined;
            ++panelRenderSeq;
            await extensionState?.update('selectedConnectionId', previousId);
        }
        throw error;
    }
    void refresh(secrets, id).catch(showError);
}

export async function updateConnectionWithGroup(
    store: Pick<ConnectionRegistry, 'get' | 'update'>,
    groups: Pick<NativeGroupManager, 'update'>,
    id: string,
    patch: ConnectionPatch,
    apiKey?: string | null
): Promise<ConnectionDefinition> {
    const before = store.get(id);
    if (!before) throw new Error(t('Connection no longer exists.'));
    const snapshot: ConnectionPatch = JSON.parse(JSON.stringify(patch));
    const name = typeof snapshot.name === 'string' ? snapshot.name.trim() : before.name;
    const rename = name.length > 0 && name !== before.name;
    if (rename) await groups.update({ id, name });
    try {
        return await store.update(id, snapshot, apiKey);
    } catch (error) {
        // Cleanup may fail after the definition and credential have already committed together.
        if (rename && store.get(id)?.name === before.name) {
            try {
                await groups.update(before);
            } catch (rollbackError) {
                throw new AggregateError([error, rollbackError],
                    t('Connection save failed and the native model group name could not be restored.'));
            }
        }
        throw error;
    }
}

export async function removeConnectionWithGroup(
    store: Pick<ConnectionRegistry, 'get' | 'remove'>,
    groups: Pick<NativeGroupManager, 'remove'>,
    id: string
): Promise<void> {
    const restoreGroup = await groups.remove(id);
    try {
        await store.remove(id);
    } catch (error) {
        if (restoreGroup && store.get(id)) {
            try {
                await restoreGroup();
            } catch (rollbackError) {
                throw new AggregateError([error, rollbackError], t(
                    'Connection deletion failed and the native model group could not be restored. '
                    + 'Review Language Models JSON, then choose Repair model group.'
                ));
            }
        }
        throw error;
    }
}

function createConnectionPanelDeps(secrets: vscode.SecretStorage, id: string | undefined): PanelDeps {
    const store = registry!;
    const requireConnection = (): ConnectionDefinition => {
        const connection = id ? store.getOpenRouter(id) : undefined;
        if (!connection) throw new Error(t('Select a connection first.'));
        return connection;
    };
    const requireProvider = (): OpenRouterChatProvider => {
        const child = router?.getProvider(requireConnection().id);
        if (!child) throw new Error(t('Connection no longer exists.'));
        return child;
    };
    const refreshCurrent = async (): Promise<void> => {
        await doRefresh(secrets, requireConnection().id);
    };
    return {
        error: message => void vscode.window.showErrorMessage(`${APP_PREFIX}${message}`),
        info: message => void vscode.window.showInformationMessage(`${APP_PREFIX}${message}`),
        updateConfig: async (key, value) => {
            if (key === 'showBudgetInStatusBar') {
                const connection = requireConnection();
                if (typeof value !== 'boolean') return;
                await store.setBudgetVisibility(connection.id, value);
                updateBudgetStatus();
                await updatePanel(secrets, selectedConnectionId ? creditState(selectedConnectionId).info : undefined);
                if (value && connection.enabled && !connectionCredits.get(connection.id)?.info) {
                    await refresh(secrets, connection.id);
                }
            } else if (['creditLimit', 'creditResetPeriod', 'creditIncludeByok', 'hideUnavailableModels'].includes(key)) {
                const connection = requireConnection();
                await store.update(connection.id, { settings: { [key]: value } as Partial<ConnectionSettings> });
            } else {
                await getConfig().update(key, value, vscode.ConfigurationTarget.Global);
            }
        },
        doRefresh: refreshCurrent,
        refresh: async () => { await refresh(secrets, requireConnection().id); },
        saveTemplate: async raw => requireProvider().setTemplate(raw),
        clearTemplate: async () => {
            await requireProvider().clearTemplate();
            await updatePanel(secrets, id ? creditState(id).info : undefined);
        },
        setKey: async value => { await store.storeKey(requireConnection().id, value); },
        clearKey: async () => { await store.clearKey(requireConnection().id); },
        syncPresetSelection: slug => {
            if (selectedConnectionId === id) {
                void panel?.webview.postMessage({ type: 'presetSelection', value: slug ?? '', connectionId: id });
            }
        },
        finishPresetSelection: (mutationId, preset) => finishPanelPresetSelection(id, mutationId, preset),
        selectConnection: selected => selectConnection(selected, secrets),
        addConnection: async (input, apiKey) => {
            if (input.kind !== 'openrouter') throw new Error(t('Connection no longer exists.'));
            const connection = await store.add(input, apiKey);
            try {
                await nativeGroups?.add(connection);
            } catch (error) {
                await store.remove(connection.id);
                throw error;
            } finally {
                panel?.reveal();
            }
            await selectConnection(connection.id, secrets);
        },
        updateConnection: async (connectionId, patch, apiKey) => {
            const before = store.getOpenRouter(connectionId);
            if (!before || (patch.kind !== undefined && patch.kind !== 'openrouter')) {
                throw new Error(t('Connection no longer exists.'));
            }
            try {
                const updated = await updateConnectionWithGroup(store, nativeGroups!, connectionId, patch, apiKey);
                if (updated.name !== before.name) {
                    void vscode.window.showInformationMessage(t(
                        'Connection renamed. Select its model again in Copilot; saved selections may use the old group name.'
                    ));
                }
            } finally {
                panel?.reveal();
            }
            await updatePanel(secrets, selectedConnectionId ? creditState(selectedConnectionId).info : undefined);
        },
        repairModelGroup: async () => {
            try {
                await nativeGroups!.repair(requireConnection());
                void vscode.window.showInformationMessage(`${APP_PREFIX}${t('Model group synchronized.')}`);
            } finally {
                panel?.reveal();
            }
        },
        deleteConnection: async connectionId => {
            const connection = store.getOpenRouter(connectionId);
            if (!connection) return;
            const confirmation = await vscode.window.showWarningMessage(
                t('Delete connection “{0}”, its saved key, request settings, and local spend history?', connection.name),
                { modal: true }, t('Delete connection')
            );
            if (confirmation !== t('Delete connection')) return;
            try {
                await removeConnectionWithGroup(store, nativeGroups!, connectionId);
            } finally {
                panel?.reveal();
            }
        },
    };
}

export interface PasteTemplateResult {
    applied: boolean;
    error?: string;
}

export async function pasteTemplateFromClipboard(
    readClipboard: () => Thenable<string>,
    prov: Pick<OpenRouterChatProvider, 'setTemplate'>
): Promise<PasteTemplateResult> {
    let text: string;
    try {
        text = await readClipboard();
    } catch {
        return { applied: false };
    }
    if (text.trim() === '') return { applied: false };
    const result = await prov.setTemplate(text);
    return result.ok ? { applied: true } : { applied: false, error: result.error };
}

function openPanel(secrets: vscode.SecretStorage): void {
    if (panel) {
        panel.reveal();
    } else {
        const opened = vscode.window.createWebviewPanel(
            'openrouterCopilot',
            t('OpenRouter for Copilot'),
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        panel = opened;
        opened.onDidDispose(() => {
            panel = undefined;
            panelDocument = undefined;
            presetSelectionResults.clear();
        });
        const pendingSelections = new Set<string>();
        const rejectSelection = (connectionId: string): void => {
            void opened.webview.postMessage({ type: 'connectionSelectionFailed', connectionId });
        };
        opened.webview.onDidReceiveMessage((msg) => {
            const message = msg as PanelMessage;
            if (message.type === 'panelReady') {
                const current = panelDocument;
                if (panel === opened && current && message.documentId === current.id) {
                    // VS Code may recreate a hidden webview from its original HTML.
                    void sendPanelRefresh(opened.webview, current.id, current.initial, current.live, true).catch(showError);
                    const presetResult = presetSelectionResults.get(current.connectionId);
                    if (presetResult && presetResult.presetMutationId === message.presetMutationId) {
                        void opened.webview.postMessage(presetResult);
                    }
                    if (message.connectionId && !pendingSelections.has(message.connectionId)) {
                        rejectSelection(message.connectionId);
                    }
                }
                return;
            }
            const selection = message.type === 'selectConnection' ? message.connectionId : undefined;
            if (selection) pendingSelections.add(selection);
            panelMessageQueue = panelMessageQueue.then(async () => {
                if (registry && CONNECTION_MESSAGES.has(message.type) && !message.connectionId) {
                    throw new Error(t('Select a connection first.'));
                }
                const deps = registry ? createConnectionPanelDeps(secrets, message.connectionId)
                    : provider ? createPanelDeps(secrets, provider) : undefined;
                if (deps) await handlePanelMessage(message, deps);
            }).catch(error => {
                if (selection && panel === opened) rejectSelection(selection);
                showError(error);
            }).finally(() => {
                if (selection) pendingSelections.delete(selection);
            });
        });
    }
    updatePanel(secrets, selectedConnectionId ? creditState(selectedConnectionId).info : legacyCredits.info).catch(showError);
}

function showNoKey(): void {
    setStatus(
        t('$(key) No key'),
        t('{0}set your API key.  \nOpen the panel (click) and paste your key to begin.', APP_PREFIX)
    );
}

export function doRefresh(secrets: vscode.SecretStorage, connectionId?: string): Promise<KeyInfo | undefined> {
    const state = connectionId ? creditState(connectionId) : legacyCredits;
    state.currentRun?.controller.abort();
    const controller = new AbortController();
    const done = doRefreshRun(secrets, controller.signal, state, connectionId);
    state.currentRun = { controller, done };
    const cleanup = (): void => {
        if (state.currentRun?.done === done) state.currentRun = undefined;
    };
    void done.then(cleanup, cleanup);
    return done;
}

async function doRefreshRun(
    secrets: vscode.SecretStorage, signal: AbortSignal, state: CreditState, connectionId?: string
): Promise<KeyInfo | undefined> {
    const connection = connectionId ? registry?.getOpenRouter(connectionId) : undefined;
    if (connectionId !== undefined && !connection) return undefined;
    const config = readConfig();
    const limit = connection?.settings.creditLimit ?? config.limit;
    const resetPeriod = connection?.settings.creditResetPeriod ?? config.resetPeriod;
    const includeByok = connection?.settings.creditIncludeByok ?? config.includeByok;
    const stale = (): boolean => signal.aborted || (connectionId !== undefined
        && registry?.getOpenRouter(connectionId)?.revision !== connection?.revision);
    const status = (text: string, tooltip: string, background?: vscode.ThemeColor): void => {
        if (stale()) return;
        if (connection) updateBudgetStatus();
        else setStatus(text, tooltip, background);
    };
    const render = async (key?: string | null): Promise<void> => {
        if (stale() || (connectionId !== undefined && selectedConnectionId !== connectionId)) return;
        await updatePanel(secrets, state.info, signal, key);
    };
    if (connection && !connection.enabled) {
        state.info = undefined;
        state.accountCredits = undefined;
        state.fetchedAt = undefined;
        state.error = undefined;
        status(t('Disabled'), t('Connection disabled.'));
        await render();
        return undefined;
    }
    status('…', t('Refreshing OpenRouter key info…'));
    let apiKey: string | undefined;
    try {
        apiKey = connectionId ? await registry?.readKey(connectionId) : await readKey(secrets);
        if (stale()) return undefined;
        if (!apiKey) {
            state.info = undefined;
            state.fetchedAt = undefined;
            state.accountCredits = undefined;
            state.error = undefined;
            if (connectionId) status(t('$(key) No key'), t('Open Settings in the panel to set this connection’s API key.'));
            else showNoKey();
            await render(null);
            return undefined;
        }
        const info = await fetchApi<KeyInfo>(apiKey, 'key', signal);
        if (stale()) return undefined;
        let accountCredits: AccountCredits | undefined;
        if ((info.limit === null || info.limit === undefined) && limit <= 0) {
            try {
                accountCredits = await fetchApi<AccountCredits>(apiKey, 'credits', signal);
            } catch {
            }
        }
        if (stale()) return undefined;
        state.info = info;
        state.fetchedAt = new Date();
        state.accountCredits = accountCredits;
        state.error = undefined;
        const view = buildStatus(info, limit, resetPeriod, includeByok, accountCredits);

        status(
            view.text,
            view.tooltip,
            view.background === 'error'
                ? new vscode.ThemeColor('statusBarItem.errorBackground')
                : undefined
        );

        await render(apiKey);
        return info;
    } catch (err) {
        if (stale()) return undefined;
        const message = errorMessage(err);
        state.error = t('Refresh failed: {0}', message);
        status(t('$(error) Error'), t('OpenRouter error: {0}', message));
        await render(apiKey);
        return undefined;
    }
}

export function refresh(secrets: vscode.SecretStorage, connectionId?: string): Promise<KeyInfo | undefined> {
    const state = connectionId ? creditState(connectionId) : legacyCredits;
    return state.currentRun?.done ?? doRefresh(secrets, connectionId);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    setTranslator((message, ...args) => vscode.l10n.t(message, ...args));
    setRequestDumpDirectory(context.extensionMode === vscode.ExtensionMode.Development ? context.logUri.fsPath : undefined);
    extensionState = context.globalState;
    const secrets = resolveSecretStorage(context.secrets);
    const legacy = readConfig();
    const directory = await profileDirectory(context.globalStorageUri.fsPath, context.globalState,
        vscode.commands, vscode.env.machineId);
    const store = new ConnectionRegistry(context.globalState, secrets, directory, context.globalStorageUri.fsPath);
    try {
        await store.initialize({
            creditLimit: legacy.limit,
            creditResetPeriod: legacy.resetPeriod,
            creditIncludeByok: legacy.includeByok,
            hideUnavailableModels: legacy.hideUnavailableModels,
        });
    } catch (error) {
        await store.dispose();
        throw error;
    }
    registry = store;
    const workspaceId = context.storageUri
        && createHash('sha256').update(context.storageUri.toString()).digest('hex');
    router = new ConnectionChatProvider(registry, false, workspaceId);
    nativeGroups = new NativeGroupManager();
    const savedSelection = context.globalState.get<string>('selectedConnectionId');
    selectedConnectionId = savedSelection && registry.getOpenRouter(savedSelection)
        ? savedSelection : registry.listOpenRouter()[0]?.id;
    provider = selectedConnectionId ? router.getProvider(selectedConnectionId) : undefined;
    sessionTitleDir = chatSessionsDir(context.storageUri);

    context.subscriptions.push(
        registry,
        router,
        vscode.lm.registerLanguageModelChatProvider('openrouter-copilot-request-credit', router)
    );

    context.subscriptions.push(router.onTurnCost(cost => {
        if (cost.connectionId && cost.connectionId === selectedConnectionId) {
            void updatePanel(secrets, creditState(cost.connectionId).info).catch(() => undefined);
        }
    }));

    const revisions = new Map(registry.listOpenRouter().map(connection => [connection.id, connection.revision]));
    context.subscriptions.push(registry.onDidChange(() => {
        const connections = registry!.listOpenRouter();
        const changed = connections.filter(connection => connection.revision !== revisions.get(connection.id));
        for (const [id, state] of connectionCredits) {
            const revision = connections.find(connection => connection.id === id)?.revision;
            if (revision !== revisions.get(id)) {
                state.currentRun?.controller.abort();
                connectionCredits.delete(id);
            }
        }
        revisions.clear();
        for (const connection of connections) revisions.set(connection.id, connection.revision);
        if (!connections.some(connection => connection.id === selectedConnectionId)) {
            selectedConnectionId = connections[0]?.id;
            void extensionState?.update('selectedConnectionId', selectedConnectionId);
        }
        provider = selectedConnectionId ? router?.getProvider(selectedConnectionId) : undefined;
        ++panelRenderSeq;
        updateBudgetStatus();
        for (const connection of changed) {
            if (connection.id !== selectedConnectionId && connection.enabled
                && connection.settings.showBudgetInStatusBar !== false) {
                void doRefresh(secrets, connection.id).catch(() => undefined);
            }
        }
        if (selectedConnectionId) {
            void doRefresh(secrets, selectedConnectionId).catch(() => undefined);
        } else {
            void updatePanel(secrets, undefined).catch(() => undefined);
        }
    }));

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.name = 'OpenRouter';
    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(updateStatusIcon));
    updateBudgetStatus();

    const openAndRefresh = (): void => {
        openPanel(secrets);
        if (selectedConnectionId) refresh(secrets, selectedConnectionId).catch(showError);
        if (!context.globalState.get<boolean>('nativeConnectionGroupInitialized')) {
            panelMessageQueue = panelMessageQueue.then(async () => {
                const initial = initialGroupConnection();
                if (!initial || !nativeGroups || context.globalState.get<boolean>('nativeConnectionGroupInitialized')) {
                    return;
                }
                try {
                    await nativeGroups.repair(initial);
                    await context.globalState.update('nativeConnectionGroupInitialized', true);
                } finally {
                    panel?.reveal();
                }
            }).catch(showError);
        }
    };
    const SHOW = 'openrouterCopilot.show';
    statusBarItem.command = SHOW;
    context.subscriptions.push(
        vscode.commands.registerCommand(SHOW, openAndRefresh),
        vscode.commands.registerCommand('openrouterCopilot.manage', openAndRefresh),
        vscode.commands.registerCommand('openrouterCopilot.pasteTemplate', async () => {
            if (provider) {
                const result = await pasteTemplateFromClipboard(
                    () => vscode.env.clipboard.readText(),
                    provider
                );
                if (result.applied) {
                    void vscode.window.showInformationMessage(t('{0}Custom request saved from clipboard.', APP_PREFIX));
                } else if (result.error) {
                    void vscode.window.showErrorMessage(`${APP_PREFIX}${result.error}`);
                }
            }
            openAndRefresh();
        }),
        vscode.commands.registerCommand('openrouterCopilot.clearTemplate', async () => {
            const open = panel;
            const connectionId = selectedConnectionId;
            if (provider && open) {
                await handlePanelMessage({ type: 'clearTemplate', connectionId },
                    createConnectionPanelDeps(secrets, connectionId));
                void open.webview.postMessage({ type: 'templateCleared', connectionId });
                return;
            }
            await provider?.clearTemplate();
            void vscode.window.showInformationMessage(t('{0}Request template cleared.', APP_PREFIX));
        })
    );

    const applyConfig = (): void => {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = undefined;
        if (refreshTimerDisarmedForTesting) return;
        const { refreshIntervalMinutes } = readConfig();
        refreshTimer = setInterval(() => {
            for (const connection of registry?.listOpenRouter() ?? []) {
                if (connection.enabled) void refresh(secrets, connection.id).catch(() => undefined);
            }
        }, refreshIntervalMinutes * 60 * 1000);
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration('openrouterCopilot')) return;
            applyConfig();
            if (e.affectsConfiguration('openrouterCopilot.statusBarBudgetDisplay')) updateBudgetStatus();
            if (e.affectsConfiguration('openrouterCopilot.hideUnavailableModels')) {
                router?.resetCatalogCache();
            }
            if (
                e.affectsConfiguration('openrouterCopilot.outputReservePercent') ||
                e.affectsConfiguration('openrouterCopilot.outputReserveMinTokens') ||
                e.affectsConfiguration('openrouterCopilot.outputReserveMaxTokens')
            ) {
                router?.refreshModelInfo();
            }
            if (
                e.affectsConfiguration('openrouterCopilot.creditLimit') ||
                e.affectsConfiguration('openrouterCopilot.creditResetPeriod') ||
                e.affectsConfiguration('openrouterCopilot.creditIncludeByok')
            ) {
                if (selectedConnectionId) void doRefresh(secrets, selectedConnectionId).catch(() => undefined);
            }
            if (
                e.affectsConfiguration('openrouterCopilot.sanitizeBase64Content') ||
                e.affectsConfiguration('openrouterCopilot.creditRefreshIntervalMinutes')
            ) {
                void updatePanel(secrets, selectedConnectionId ? creditState(selectedConnectionId).info : undefined)
                    .catch(() => undefined);
            }
            void updatePanel(secrets, selectedConnectionId ? creditState(selectedConnectionId).info : undefined)
                .catch(() => undefined);
        })
    );

    applyConfig();
    for (const connection of registry.listOpenRouter()) {
        if (connection.id === selectedConnectionId || (connection.enabled
            && connection.settings.showBudgetInStatusBar !== false)) {
            void refresh(secrets, connection.id).catch(() => undefined);
        }
    }
}

export function deactivate(): void {
    setRequestDumpDirectory(undefined);
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    legacyCredits.currentRun?.controller.abort();
    legacyCredits.currentRun = undefined;
    for (const state of connectionCredits.values()) state.currentRun?.controller.abort();
    connectionCredits.clear();
    statusBarItem = undefined;
    panel?.dispose();
    panel = undefined;
    router?.dispose();
    registry?.dispose();
    router = undefined;
    registry = undefined;
    nativeGroups = undefined;
    selectedConnectionId = undefined;
    extensionState = undefined;
    provider = undefined;
}
