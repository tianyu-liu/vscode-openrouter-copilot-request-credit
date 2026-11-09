import * as vscode from 'vscode';
import { promises as fsp } from 'fs';
import { setTranslator, t } from './i18n';
import { buildStatus, KeyInfo, maskKey, AccountCredits, parseSessionTitle } from './logic';
import {
    getConfig,
    handlePanelMessage,
    PanelDeps,
    PanelMessage,
    readConfig,
    renderPanelHtml,
    templatePresetSlug,
} from './panel';
import { readKey, resolveSecretStorage } from './storage';
import { getSessionCosts, OpenRouterChatProvider, SESSION_ID_PREFIX, type SessionCost } from './provider';
import {
    ConnectionRegistry, type ConnectionDefinition, type ConnectionPatch, type ConnectionSettings,
} from './connections';
import { ConnectionChatProvider } from './connectionProvider';
import { NativeGroupManager } from './nativeGroups';
import { GatewayAllowanceRefreshState, refreshGatewayAllowanceState } from './gatewayAllowanceRefresh';

export { readConfig } from './panel';

const MAX_ERROR_LENGTH = 300;
const APP_PREFIX = 'OpenRouter: ';

let statusBarItem: vscode.StatusBarItem | undefined;
let statusText = '';
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let panel: vscode.WebviewPanel | undefined;
let lastPanelHtml: string | undefined;
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
    'saveTemplate', 'clearTemplate', 'selectPreset', 'refresh', 'updateConnection', 'deleteConnection',
    'setConnectionEnabled', 'saveManualModels',
]);

interface CreditState extends GatewayAllowanceRefreshState {
    info?: KeyInfo;
    accountCredits?: AccountCredits;
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
    return selectedConnectionId ? registry?.get(selectedConnectionId) : undefined;
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

function setStatus(text: string, tooltip: string, background?: vscode.ThemeColor): void {
    if (!statusBarItem) return;
    statusText = text;
    updateStatusIcon();
    statusBarItem.tooltip = new vscode.MarkdownString(tooltip);
    statusBarItem.accessibilityInformation = { label: `OpenRouter: ${text.replace(/\$\([^)]+\)\s*/g, '')}` };
    statusBarItem.backgroundColor = background;
    statusBarItem.show();
}

function updateStatusIcon(): void {
    if (!statusBarItem) return;
    const kind = vscode.window.activeColorTheme.kind;
    const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
    statusBarItem.text = `$(openrouter-rc-${light ? 'ink' : 'cloud'}) ${statusText}`;
}

export function getStatusText(): string | undefined {
    return statusBarItem?.text;
}

async function getJson(url: string, apiKey: string, signal?: AbortSignal, timeoutMs = 15000): Promise<unknown> {
    try {
        const res = await fetch(url, {
            redirect: 'error',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'User-Agent': 'vscode-openrouter-copilot-request-credit',
                Accept: 'application/json',
            },
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
        if (typeof res.url === 'string' && /^http:/i.test(res.url)) {
            throw new Error(t('Blocked insecure redirect to {0}', res.url));
        }
        const text = await res.text();
        if (!res.ok) {
            throw new Error(t('HTTP {0}: {1}', res.status, text.slice(0, 500)));
        }
        if (!text.trim()) {
            throw new Error(t('Empty response body (HTTP {0})', res.status));
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(t('Invalid JSON response (HTTP {0}): {1}', res.status, text.slice(0, 200)));
        }
    } catch (err) {
        if (err instanceof Error && err.message === 'fetch failed' && err.cause) {
            const cause = err.cause as Error;
            throw new Error(cause.message || t('Request failed'));
        }
        throw err;
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

/** Normalize the per-render nonce so identical panel content compares equal. */
export function panelHtmlComparable(html: string): string {
    return html
        .replace(/nonce-[0-9a-f]{32}/g, 'nonce')
        .replace(/nonce="[0-9a-f]{32}"/g, 'nonce="n"');
}

async function updatePanel(
    secrets: vscode.SecretStorage,
    info: KeyInfo | undefined,
    signal?: AbortSignal,
    storedKey?: string | null
): Promise<void> {
    if (!panel) return;
    const render = ++panelRenderSeq;
    const connection = selectedConnection();
    const id = connection?.id;
    const state = id ? creditState(id) : undefined;
    const activeProvider = id ? router?.getProvider(id) : provider;
    const stale = (): boolean => render !== panelRenderSeq || (signal?.aborted ?? false) || !panel
        || (id !== undefined && (selectedConnectionId !== id || registry?.get(id)?.revision !== connection?.revision));
    const config = readConfig();
    const {
        refreshIntervalMinutes,
        sanitizeBase64Content,
        outputReservePercent,
        outputReserveMinTokens,
        outputReserveMaxTokens,
    } = config;
    const limit = connection?.settings.creditLimit ?? config.limit;
    const resetPeriod = connection?.settings.creditResetPeriod ?? config.resetPeriod;
    const includeByok = connection?.settings.creditIncludeByok ?? config.includeByok;
    const hideUnavailableModels = connection?.settings.hideUnavailableModels ?? config.hideUnavailableModels;
    const key = storedKey !== undefined ? storedKey : id ? await registry?.readKey(id) : await readKey(secrets);
    if (stale()) return;
    const template = await activeProvider?.getTemplate();
    if (stale()) return;
    const presets = activeProvider ? await activeProvider.getPresets() : [];
    if (stale()) return;
    const presetSlug = templatePresetSlug(template);
    const presetConfig = presetSlug && activeProvider ? await activeProvider.getPresetConfig(presetSlug) : undefined;
    if (stale()) return;
    const sessions = await withSessionTitles(id ? router?.getSessionCosts(id) ?? [] : getSessionCosts());
    if (stale()) return;
    const html = renderPanelHtml({
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
        gatewayAllowance: state?.gatewayAllowance,
        gatewayAllowanceStale: state?.gatewayAllowanceStale,
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
        },
    });
    if (stale()) return;
    const comparable = panelHtmlComparable(html);
    if (comparable === lastPanelHtml) return;
    lastPanelHtml = comparable;
    panel.webview.html = html;
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
    };
}

async function selectConnection(id: string, secrets: vscode.SecretStorage): Promise<void> {
    if (!registry?.get(id)) throw new Error(t('Connection no longer exists.'));
    selectedConnectionId = id;
    provider = router?.getProvider(id);
    ++panelRenderSeq;
    await extensionState?.update('selectedConnectionId', id);
    await updatePanel(secrets, creditState(id).info);
    await refresh(secrets, id);
}

export async function updateConnectionWithGroup(
    store: Pick<ConnectionRegistry, 'get' | 'update'>,
    groups: Pick<NativeGroupManager, 'update'>,
    id: string,
    patch: ConnectionPatch
): Promise<ConnectionDefinition> {
    const before = store.get(id);
    if (!before) throw new Error(t('Connection no longer exists.'));
    const updated = await store.update(id, patch);
    if (updated.name !== before.name) {
        try {
            await groups.update(updated);
        } catch (error) {
            await store.update(id, {
                name: before.name, kind: before.kind, baseUrl: before.baseUrl,
                enabled: before.enabled, settings: before.settings, models: before.models,
            });
            throw error;
        }
    }
    return updated;
}

function createConnectionPanelDeps(secrets: vscode.SecretStorage, id: string | undefined): PanelDeps {
    const store = registry!;
    const requireConnection = (): ConnectionDefinition => {
        const connection = id ? store.get(id) : undefined;
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
            if (['creditLimit', 'creditResetPeriod', 'creditIncludeByok', 'hideUnavailableModels'].includes(key)) {
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
        selectConnection: selected => selectConnection(selected, secrets),
        addConnection: async input => {
            const connection = await store.add(input);
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
        updateConnection: async (connectionId, patch) => {
            const before = store.get(connectionId);
            if (!before) throw new Error(t('Connection no longer exists.'));
            try {
                const updated = await updateConnectionWithGroup(store, nativeGroups!, connectionId, patch);
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
        deleteConnection: async connectionId => {
            const connection = store.get(connectionId);
            if (!connection) return;
            const confirmation = await vscode.window.showWarningMessage(
                t('Delete connection “{0}”, its saved key, request settings, and local spend history?', connection.name),
                { modal: true }, t('Delete connection')
            );
            if (confirmation !== t('Delete connection')) return;
            try {
                await nativeGroups?.remove(connectionId);
                await store.remove(connectionId);
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
        panel = vscode.window.createWebviewPanel(
            'openrouterCopilot',
            t('OpenRouter for Copilot'),
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        panel.onDidDispose(() => {
            panel = undefined;
            lastPanelHtml = undefined;
        });
        panel.webview.onDidReceiveMessage((msg) => {
            const message = msg as PanelMessage;
            panelMessageQueue = panelMessageQueue.then(async () => {
                if (registry && CONNECTION_MESSAGES.has(message.type) && !message.connectionId) {
                    throw new Error(t('Select a connection first.'));
                }
                const deps = registry ? createConnectionPanelDeps(secrets, message.connectionId)
                    : provider ? createPanelDeps(secrets, provider) : undefined;
                if (deps) await handlePanelMessage(message, deps);
            }).catch(showError);
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
    const connection = connectionId ? registry?.get(connectionId) : undefined;
    if (connectionId && !connection) return undefined;
    const config = readConfig();
    const limit = connection?.settings.creditLimit ?? config.limit;
    const resetPeriod = connection?.settings.creditResetPeriod ?? config.resetPeriod;
    const includeByok = connection?.settings.creditIncludeByok ?? config.includeByok;
    const stale = (): boolean => signal.aborted || (connectionId !== undefined
        && registry?.get(connectionId)?.revision !== connection?.revision);
    const status = (text: string, tooltip: string, background?: vscode.ThemeColor): void => {
        if (stale() || (connectionId !== undefined && selectedConnectionId !== connectionId)) return;
        setStatus(connection ? `${connection.name} · ${text}` : text, tooltip, background);
    };
    const render = async (key?: string | null): Promise<void> => {
        if (stale() || (connectionId !== undefined && selectedConnectionId !== connectionId)) return;
        await updatePanel(secrets, state.info, signal, key);
    };
    if (connection && (!connection.enabled || connection.kind === 'openai-compatible')) {
        state.info = undefined;
        state.accountCredits = undefined;
        state.error = undefined;
        status(connection.enabled ? t('Usage tracked') : t('Disabled'),
            connection.enabled ? t('Token usage and reported cost are tracked per connection.') : t('Connection disabled.'));
        await render();
        return undefined;
    }
    status('$(sync~spin) …', connection?.kind === 'gateway'
        ? t('Refreshing gateway allowance…') : t('Refreshing OpenRouter key info…'));
    let apiKey: string | undefined;
    try {
        apiKey = connectionId ? await registry?.readKey(connectionId) : await readKey(secrets);
        if (stale()) return undefined;
        if (!apiKey) {
            state.info = undefined;
            state.fetchedAt = undefined;
            state.accountCredits = undefined;
            state.error = undefined;
            state.gatewayAllowance = undefined;
            state.gatewayAllowanceStale = false;
            if (connectionId) status(t('$(key) No key'), t('Open Settings in the panel to set this connection’s API key.'));
            else showNoKey();
            await render(null);
            return undefined;
        }
        if (connection?.kind === 'gateway') {
            const outcome = await refreshGatewayAllowanceState(state, {
                baseUrl: connection.baseUrl, apiKey, signal, isCurrent: () => !stale(),
            });
            if (outcome === 'superseded') return undefined;
            if (outcome === 'failed') state.error = t('Gateway allowance refresh failed.');
            const allowance = state.gatewayAllowance;
            const labels = { cheap: t('Cheap'), default: t('Default') };
            const lanes = (['cheap', 'default'] as const).map(name => {
                const lane = allowance?.[name];
                const budget = lane?.status === 'reported' ? lane.effective_budget : undefined;
                const remaining = budget?.remaining;
                return `${labels[name]} ${remaining == null ? t('Unknown') : `$${remaining.toFixed(2)}`}`;
            });
            const staleLabel = state.gatewayAllowanceStale ? ` · ${t('Stale')}` : '';
            status(`${lanes.join(' · ')}${staleLabel}`, state.error ?? t(
                'Gateway allowances are separate. Open the panel for usage and reset details. Billing counters may lag.'
            ));
            await render(apiKey);
            return undefined;
        }
        const info = await fetchApi<KeyInfo>(apiKey, 'key', signal);
        if (stale()) return undefined;
        state.info = info;
        state.fetchedAt = new Date();
        let accountCredits: AccountCredits | undefined;
        if ((info.limit === null || info.limit === undefined) && limit <= 0) {
            try {
                accountCredits = await fetchApi<AccountCredits>(apiKey, 'credits', signal);
            } catch {
            }
        }
        if (stale()) return undefined;
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
    extensionState = context.globalState;
    const secrets = resolveSecretStorage(context.secrets);
    const legacy = readConfig();
    registry = new ConnectionRegistry(context.globalState, secrets);
    await registry.initialize({
        creditLimit: legacy.limit,
        creditResetPeriod: legacy.resetPeriod,
        creditIncludeByok: legacy.includeByok,
        hideUnavailableModels: legacy.hideUnavailableModels,
    });
    router = new ConnectionChatProvider(registry);
    nativeGroups = new NativeGroupManager();
    const savedSelection = context.globalState.get<string>('selectedConnectionId');
    selectedConnectionId = savedSelection && registry.get(savedSelection)
        ? savedSelection : registry.list()[0]?.id;
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

    const revisions = new Map(registry.list().map(connection => [connection.id, connection.revision]));
    context.subscriptions.push(registry.onDidChange(() => {
        const connections = registry!.list();
        const existing = new Set(connections.map(connection => connection.id));
        for (const [id, state] of connectionCredits) {
            const revision = connections.find(connection => connection.id === id)?.revision;
            if (revision !== revisions.get(id)) {
                state.currentRun?.controller.abort();
                connectionCredits.delete(id);
            }
        }
        revisions.clear();
        for (const connection of connections) revisions.set(connection.id, connection.revision);
        if (selectedConnectionId && !existing.has(selectedConnectionId)) {
            selectedConnectionId = connections[0]?.id;
            void extensionState?.update('selectedConnectionId', selectedConnectionId);
        }
        provider = selectedConnectionId ? router?.getProvider(selectedConnectionId) : undefined;
        ++panelRenderSeq;
        if (selectedConnectionId) {
            void doRefresh(secrets, selectedConnectionId).catch(() => undefined);
        } else {
            setStatus(t('No connections'), t('Open Settings in the panel to add a connection.'));
            void updatePanel(secrets, undefined).catch(() => undefined);
        }
    }));

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.name = 'OpenRouter';
    context.subscriptions.push(statusBarItem);
    context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(updateStatusIcon));
    setStatus('$(sync~spin) …', t('OpenRouter: loading…'));

    const openAndRefresh = (): void => {
        openPanel(secrets);
        if (selectedConnectionId) {
            refresh(secrets, selectedConnectionId).catch(showError);
            const initial = registry?.list()[0];
            if (initial && !extensionState?.get<boolean>('nativeConnectionGroupInitialized')) {
                void nativeGroups?.update(initial).then(async () => {
                    await extensionState?.update('nativeConnectionGroupInitialized', true);
                }).catch(showError).finally(() => panel?.reveal());
            }
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
            openPanel(secrets);
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
            for (const connection of registry?.list() ?? []) {
                if (connection.enabled) void refresh(secrets, connection.id).catch(() => undefined);
            }
        }, refreshIntervalMinutes * 60 * 1000);
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration('openrouterCopilot')) return;
            applyConfig();
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
    if (!context.globalState.get<boolean>('nativeConnectionGroupInitialized')) {
        const initial = registry.list()[0];
        if (initial) {
            try {
                const outcome = await nativeGroups.ensureDefault(initial);
                if (outcome === 'added') await context.globalState.update('nativeConnectionGroupInitialized', true);
            } catch (error) {
                showError(error);
            }
        }
    }
    if (selectedConnectionId) void refresh(secrets, selectedConnectionId).catch(() => undefined);
}

export function deactivate(): void {
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
