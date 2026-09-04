import * as vscode from 'vscode';
import { buildStatus, KeyInfo, maskKey, AccountCredits } from './logic';
import {
    apiBaseUrl,
    getConfig,
    handlePanelMessage,
    PanelDeps,
    PanelMessage,
    readConfig,
    renderPanelHtml,
    templatePresetSlug,
} from './panel';
import { readKey } from './storage';
import { OpenRouterChatProvider } from './provider';

export { apiBaseUrl, readConfig } from './panel';

const MAX_ERROR_LENGTH = 300;
const APP_PREFIX = 'OpenRouter: ';

let statusBarItem: vscode.StatusBarItem | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let panel: vscode.WebviewPanel | undefined;
let provider: OpenRouterChatProvider | undefined;

let lastInfo: KeyInfo | undefined;
let lastFetchAt: Date | undefined;
let lastAccountCredits: AccountCredits | undefined;
let lastErrorMessage: string | undefined;

let currentRun: { controller: AbortController; done: Promise<KeyInfo | undefined> } | undefined;

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
    statusBarItem.text = text;
    statusBarItem.tooltip = new vscode.MarkdownString(tooltip);
    statusBarItem.backgroundColor = background;
    statusBarItem.show();
}

export function getStatusText(): string | undefined {
    return statusBarItem?.text;
}

async function getJson(url: string, apiKey: string, signal?: AbortSignal, timeoutMs = 15000): Promise<unknown> {
    try {
        const res = await fetch(url, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'User-Agent': 'vscode-openrouter-copilot-request-credit',
                Accept: 'application/json',
            },
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        });
        if (typeof res.url === 'string' && /^http:/i.test(res.url)) {
            throw new Error(`Blocked insecure redirect to ${res.url}`);
        }
        const text = await res.text();
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
        }
        if (!text.trim()) {
            throw new Error(`Empty response body (HTTP ${res.status})`);
        }
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`Invalid JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
        }
    } catch (err) {
        if (err instanceof Error && err.message === 'fetch failed' && err.cause) {
            const cause = err.cause as Error;
            throw new Error(cause.message || 'Request failed');
        }
        throw err;
    }
}

function asDataObject(json: unknown, endpoint: string): Record<string, unknown> {
    const data = (json as { data?: unknown } | null)?.data;
    if (typeof json !== 'object' || json === null || typeof data !== 'object' || data === null) {
        throw new Error(`Unexpected response shape from ${endpoint}`);
    }
    return data as Record<string, unknown>;
}

async function fetchApi<T>(apiKey: string, resource: string, signal?: AbortSignal): Promise<T> {
    const json = await getJson(`${apiBaseUrl()}/api/v1/${resource}`, apiKey, signal);
    return asDataObject(json, `/api/v1/${resource}`) as unknown as T;
}

let panelRenderSeq = 0;

async function updatePanel(
    secrets: vscode.SecretStorage,
    info: KeyInfo | undefined,
    signal?: AbortSignal,
    storedKey?: string | null
): Promise<void> {
    if (!panel) return;
    const render = ++panelRenderSeq;
    const stale = (): boolean => render !== panelRenderSeq || (signal?.aborted ?? false) || !panel;
    const { limit, resetPeriod, includeByok, refreshIntervalMinutes } = readConfig();
    const key = storedKey !== undefined ? storedKey : await readKey(secrets);
    if (stale()) return;
    const template = provider ? await provider.getTemplate() : undefined;
    if (stale()) return;
    const presets = provider ? await provider.getPresets() : [];
    if (stale()) return;
    const presetSlug = templatePresetSlug(template);
    const presetConfig = presetSlug && provider ? await provider.getPresetConfig(presetSlug) : undefined;
    if (stale()) return;
    panel.webview.html = renderPanelHtml(
        info,
        limit,
        resetPeriod,
        includeByok,
        refreshIntervalMinutes,
        lastFetchAt,
        key ? maskKey(key) : undefined,
        lastAccountCredits,
        lastErrorMessage,
        template,
        presets,
        presetConfig
    );
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

function openPanel(secrets: vscode.SecretStorage): void {
    if (panel) {
        panel.reveal();
    } else {
        panel = vscode.window.createWebviewPanel(
            'openrouterCopilot',
            'OpenRouter for Copilot',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );
        panel.onDidDispose(() => {
            panel = undefined;
        });
        panel.webview.onDidReceiveMessage((msg) => {
            if (provider) {
                handlePanelMessage(msg as PanelMessage, createPanelDeps(secrets, provider)).catch(showError);
            }
        });
    }
    updatePanel(secrets, lastInfo).catch(showError);
}

function showNoKey(): void {
    setStatus(
        '$(key) OR: no key',
        `${APP_PREFIX}set your API key\nOpen the panel (click) and paste your key to begin.`
    );
}

export function doRefresh(secrets: vscode.SecretStorage): Promise<KeyInfo | undefined> {
    currentRun?.controller.abort();
    const controller = new AbortController();
    const done = doRefreshRun(secrets, controller.signal);
    currentRun = { controller, done };
    const cleanup = (): void => {
        if (currentRun?.done === done) currentRun = undefined;
    };
    void done.then(cleanup, cleanup);
    return done;
}

async function doRefreshRun(secrets: vscode.SecretStorage, signal: AbortSignal): Promise<KeyInfo | undefined> {
    const { limit, resetPeriod, includeByok } = readConfig();

    setStatus('$(sync~spin) OR …', 'Refreshing OpenRouter key info…');

    const apiKey = await readKey(secrets);
    if (signal.aborted) return undefined;

    if (!apiKey) {
        lastInfo = undefined;
        lastFetchAt = undefined;
        lastAccountCredits = undefined;
        lastErrorMessage = undefined;
        showNoKey();
        await updatePanel(secrets, undefined, signal, null);
        return undefined;
    }

    try {
        const info = await fetchApi<KeyInfo>(apiKey, 'key', signal);
        if (signal.aborted) return undefined;
        lastInfo = info;
        lastFetchAt = new Date();
        let accountCredits: AccountCredits | undefined;
        if ((info.limit === null || info.limit === undefined) && limit <= 0) {
            try {
                accountCredits = await fetchApi<AccountCredits>(apiKey, 'credits', signal);
            } catch {
            }
        }
        if (signal.aborted) return undefined;
        lastAccountCredits = accountCredits;
        lastErrorMessage = undefined;
        const view = buildStatus(info, limit, resetPeriod, includeByok, accountCredits);

        setStatus(
            view.text,
            view.tooltip,
            view.background === 'error'
                ? new vscode.ThemeColor('statusBarItem.errorBackground')
                : undefined
        );

        await updatePanel(secrets, info, signal, apiKey);
        return info;
    } catch (err) {
        if (signal.aborted) return undefined;
        const message = errorMessage(err);
        lastErrorMessage = `Refresh failed: ${message}`;
        setStatus('$(error) OR error', `OpenRouter error: ${message}`);
        await updatePanel(secrets, lastInfo, signal, apiKey);
        return undefined;
    }
}

export function refresh(secrets: vscode.SecretStorage): Promise<KeyInfo | undefined> {
    return currentRun?.done ?? doRefresh(secrets);
}

export function activate(context: vscode.ExtensionContext): void {
    provider = new OpenRouterChatProvider(context.secrets, context.globalState);

    context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider('openrouter-copilot-request-credit', provider)
    );

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(statusBarItem);
    setStatus('$(sync~spin) OR …', 'OpenRouter: loading…');

    const openAndRefresh = (): void => {
        openPanel(context.secrets);
        refresh(context.secrets).catch(showError);
    };
    const SHOW = 'openrouterCopilot.show';
    statusBarItem.command = SHOW;
    context.subscriptions.push(
        vscode.commands.registerCommand(SHOW, openAndRefresh),
        vscode.commands.registerCommand('openrouterCopilot.manage', openAndRefresh),
        vscode.commands.registerCommand('openrouterCopilot.pasteTemplate', openAndRefresh),
        vscode.commands.registerCommand('openrouterCopilot.clearTemplate', async () => {
            await provider?.clearTemplate();
            vscode.window.showInformationMessage(`${APP_PREFIX}Request template cleared.`);
        })
    );

    const applyConfig = (): void => {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = undefined;
        if (refreshTimerDisarmedForTesting) return;
        const { refreshIntervalMinutes } = readConfig();
        refreshTimer = setInterval(() => {
            refresh(context.secrets).catch(() => undefined);
        }, refreshIntervalMinutes * 60 * 1000);
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration('openrouterCopilot')) return;
            applyConfig();
            if (e.affectsConfiguration('openrouterCopilot.baseUrl')) {
                provider?.resetCatalogCache();
            }
            if (
                e.affectsConfiguration('openrouterCopilot.creditLimit') ||
                e.affectsConfiguration('openrouterCopilot.creditResetPeriod') ||
                e.affectsConfiguration('openrouterCopilot.creditIncludeByok') ||
                e.affectsConfiguration('openrouterCopilot.creditBaseUrl')
            ) {
                doRefresh(context.secrets).catch(() => undefined);
            }
        })
    );

    applyConfig();
    refresh(context.secrets).catch(() => undefined);
}

export function deactivate(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    currentRun?.controller.abort();
    currentRun = undefined;
    statusBarItem = undefined;
    panel?.dispose();
    panel = undefined;
    provider = undefined;
}
