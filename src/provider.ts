/// <reference path="../typings/vscode.proposed.languageModelThinkingPart.d.ts" />
import * as vscode from 'vscode';
import { clearStoredKey, readKey, storeKey } from './storage';
import {
    buildModelInfo,
    buildReasoningSchema,
    effortFromModelConfiguration,
    enabledFromModelConfiguration,
    type ModelCatalogEntry,
} from './modelInfo';
import { formatUsdPrecise, roundSignificant } from './logic';

const TEMPLATE_KEY = 'requestTemplate';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const PRESET_ID_PREFIX = '@preset/';
const MAX_PRESET_LOOKUPS = 25;
const WINDOW_SESSION_ID = crypto.randomUUID();
const SESSION_ID_PREFIX = 'copilot-chat:';
const MAX_SESSION_ID_CHARS = 256;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_BACKOFF_MS = 10000;
const MAX_SSE_BUFFER_CHARS = 4_000_000;
const PRESET_LOOKUP_CONCURRENCY = 5;
const USAGE_MIME = 'usage';
const NANO_AIU_PER_CREDIT = 1_000_000_000;
const POST_RESPONSE_TIMEOUT_MS = 60_000;

export interface PresetSummary {
    slug: string;
    name: string;
    model?: string;
    lookupSkipped?: boolean;
}

function presetModelOf(config: Record<string, unknown> | undefined): string | undefined {
    const model = config?.model;
    return typeof model === 'string' && model.trim() !== '' ? model : undefined;
}

export function presetSlugFromPickerValue(value: string): string {
    const trimmed = value.trim();
    return trimmed.toLowerCase().startsWith(PRESET_ID_PREFIX)
        ? trimmed.slice(PRESET_ID_PREFIX.length)
        : trimmed;
}

function presetSlugFromModelId(modelId: string): string | undefined {
    const index = modelId.indexOf(PRESET_ID_PREFIX);
    return index >= 0 ? modelId.slice(index + PRESET_ID_PREFIX.length) : undefined;
}

async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
}

export function stripTemplateComments(raw: string): string {
    return raw
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
}

type ResponsePart = vscode.LanguageModelResponsePart | vscode.LanguageModelThinkingPart;
const thinkingPartCtor = vscode.LanguageModelThinkingPart as
    | (new (value: string | string[]) => vscode.LanguageModelThinkingPart)
    | undefined;

let warnedBadBaseUrl = false;
let delayFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let postTimeoutMs = POST_RESPONSE_TIMEOUT_MS;
let lastStreamUsage: unknown;
let lastStreamProvider: string | undefined;

export function getLastStreamProvider(): string | undefined {
    return lastStreamProvider;
}

export function setRetryDelayForTesting(fn: (ms: number) => Promise<void>): void {
    delayFn = fn;
}

export function setPostTimeoutForTesting(ms: number): void {
    postTimeoutMs = ms;
}

export function getLastStreamUsage(): unknown {
    return lastStreamUsage;
}

export function sessionIdFor(conversationId: unknown): string {
    if (typeof conversationId !== 'string') {
        return WINDOW_SESSION_ID;
    }
    const trimmed = conversationId.trim();
    if (trimmed === '') {
        return WINDOW_SESSION_ID;
    }
    return `${SESSION_ID_PREFIX}${trimmed}`.slice(0, MAX_SESSION_ID_CHARS);
}

/**
 * How long after the last real chat turn an unidentified call may still be
 * attributed to it. Internal calls (sub-agents, summarization) happen while the
 * parent turn runs, so a generous window is safe; beyond it, attributing spend to
 * a long-finished chat would be worse than dropping it.
 */
const PARENT_ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000;

let lastActiveSessionId: string | undefined;
let lastActiveAt = 0;

/**
 * Decide which session a model call's cost belongs to.
 *
 * A call that carries Copilot's conversation id **is** a chat turn and becomes the
 * current session. A call without one is an internal call — a sub-agent or
 * summarization pass — and is attributed to the chat that triggered it (the most
 * recently active session) rather than inventing a session of its own.
 *
 * The parent *cannot* be read from the request: the copilot extension passes
 * `conversationId` to sub-agent calls only inside `telemetryProperties`, which is
 * never forwarded to a provider — `ExtensionContributedChatEndpoint` puts only the
 * top-level `conversationId` into `modelOptions._conversationId`. Hence the
 * most-recently-active heuristic. It is correct while internal calls run inside
 * their parent turn (the normal case); two chats interleaving could occasionally
 * misattribute, which is why the window is bounded.
 *
 * Returns `undefined` when there is nothing to attribute to, in which case the call
 * is not tracked at all rather than creating a meaningless entry.
 */
export function resolveCostSession(sessionId: string, hasConversationId: boolean, now = Date.now()): string | undefined {
    if (hasConversationId) {
        lastActiveSessionId = sessionId;
        lastActiveAt = now;
        persistParentSession?.(sessionId, now);
        return sessionId;
    }
    if (lastActiveSessionId !== undefined && now - lastActiveAt <= PARENT_ATTRIBUTION_WINDOW_MS) {
        return lastActiveSessionId;
    }
    return undefined;
}

/**
 * Restore the last active chat from a previous window so an internal call right
 * after a reload still joins its parent's OpenRouter session. The attribution
 * window still applies, so a long-idle parent is not resurrected.
 */
export function hydrateParentAttribution(stored: { sessionId?: unknown; at?: unknown } | undefined): void {
    if (!stored || typeof stored.sessionId !== 'string' || !stored.sessionId.startsWith(SESSION_ID_PREFIX)) {
        return;
    }
    const at = typeof stored.at === 'number' && Number.isFinite(stored.at) ? stored.at : 0;
    if (at > lastActiveAt) {
        lastActiveSessionId = stored.sessionId;
        lastActiveAt = at;
    }
}

export function resetParentAttributionForTesting(): void {
    lastActiveSessionId = undefined;
    lastActiveAt = 0;
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function buildUsagePart(usage: unknown): Record<string, unknown> | undefined {
    if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
        return undefined;
    }
    const raw = usage as Record<string, unknown>;
    const prompt = finiteNumber(raw.prompt_tokens);
    const completion = finiteNumber(raw.completion_tokens);
    const total = finiteNumber(raw.total_tokens);
    if (prompt === undefined || completion === undefined || total === undefined) {
        return undefined;
    }
    const rawDetails =
        typeof raw.prompt_tokens_details === 'object' && raw.prompt_tokens_details !== null
            ? (raw.prompt_tokens_details as Record<string, unknown>)
            : {};
    const part: Record<string, unknown> = {
        prompt_tokens: Math.max(0, prompt),
        completion_tokens: Math.max(0, completion),
        total_tokens: Math.max(0, total),
        prompt_tokens_details: {
            ...rawDetails,
            cached_tokens: Math.max(0, finiteNumber(rawDetails.cached_tokens) ?? 0),
        },
    };
    const cost = finiteNumber(raw.cost);
    if (cost !== undefined && cost > 0) {
        part.copilot_usage = { total_nano_aiu: cost * NANO_AIU_PER_CREDIT };
    }
    return part;
}

export interface TurnCost {
    openRouter: number;
    upstream?: number;
    isByok: boolean;
    provider?: string;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
}

const turnCostEmitter = new vscode.EventEmitter<TurnCost>();
export const onTurnCost: vscode.Event<TurnCost> = turnCostEmitter.event;

export function turnCostOf(usage: unknown, provider?: string): TurnCost | undefined {
    if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
        return undefined;
    }
    const raw = usage as Record<string, unknown>;
    const details =
        typeof raw.cost_details === 'object' && raw.cost_details !== null
            ? (raw.cost_details as Record<string, unknown>)
            : {};
    const openRouter = finiteNumber(raw.cost) ?? 0;
    const upstream = finiteNumber(details.upstream_inference_cost);
    const orPayable = openRouter > 0 ? openRouter : 0;
    const byokPayable = upstream !== undefined && upstream > 0 ? upstream : undefined;
    if (orPayable === 0 && byokPayable === undefined) {
        return undefined;
    }
    const promptTokens = Math.max(0, finiteNumber(raw.prompt_tokens) ?? 0);
    const tokenDetails =
        typeof raw.prompt_tokens_details === 'object' && raw.prompt_tokens_details !== null
            ? (raw.prompt_tokens_details as Record<string, unknown>)
            : {};
    const cachedTokens = Math.max(0, finiteNumber(tokenDetails.cached_tokens) ?? 0);
    return {
        openRouter: Math.max(0, orPayable),
        upstream: byokPayable !== undefined ? Math.max(0, byokPayable) : undefined,
        isByok: raw.is_byok === true || (orPayable === 0 && byokPayable !== undefined),
        provider: typeof provider === 'string' && provider.trim() !== '' ? provider : undefined,
        promptTokens,
        completionTokens: Math.max(0, finiteNumber(raw.completion_tokens) ?? 0),
        cachedTokens,
    };
}

/**
 * Running spend for one chat session.
 *
 * Keyed by session id because Copilot drives a tool-using turn as **one model
 * call per tool round**, and each round enters as a separate invocation of
 * `provideLanguageModelChatResponse`. Per-invocation state therefore could not
 * see the whole turn; this deliberately outlives the call.
 */
export interface CostBucket {
    paid: number;
    openRouter: number;
    upstream: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    calls: number;
}

/** One model/provider pair within a session: a session can mix several, e.g. a
 *  Fireworks BYOK route for most turns and an OpenRouter-hosted model for one. */
export interface CostRoute extends CostBucket {
    /** `provider` is the serving host; `model` the requested model slug. */
    provider: string;
    model: string;
    byok: boolean;
    updatedAt: number;
}

export interface SessionCost extends CostBucket {
    sessionId: string;
    /** Name of the session as the window reports it, when known. */
    title?: string;
    byok: boolean;
    routes: CostRoute[];
    updatedAt: number;
}

const sessionCosts = new Map<string, SessionCost>();
export const MAX_TRACKED_SESSIONS = 10;
const SESSION_COSTS_KEY = 'sessionCosts';
const PARENT_SESSION_KEY = 'parentSession';

/** Persist hook, supplied by the provider once it has global state. Kept as a
 *  module-level callback so the accumulator stays callable from tests. */
let persistSessionCosts: ((snapshot: SessionCost[]) => void) | undefined;
let persistParentSession: ((sessionId: string, at: number) => void) | undefined;

let lastStamp = 0;

/**
 * A strictly increasing recency stamp, in milliseconds.
 *
 * `Date.now()` alone is not enough: several sessions can be recorded inside the
 * same millisecond (tests, or a burst of tool rounds), and equal stamps make the
 * cap's ordering fall back to insertion order — which evicts the *newest* and
 * keeps stale sessions. Bumping past the previous value guarantees a total order
 * while staying a usable timestamp.
 */
function stamp(): number {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return lastStamp;
}

function trimToCap(): void {
    if (sessionCosts.size <= MAX_TRACKED_SESSIONS) {
        return;
    }
    const keep = [...sessionCosts.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_TRACKED_SESSIONS);
    sessionCosts.clear();
    for (const session of keep) {
        sessionCosts.set(session.sessionId, session);
    }
}

/**
 * Merge persisted costs into the in-memory store at startup.
 *
 * Deliberately additive rather than a replace: constructing a provider must not
 * discard live state, so an entry already in memory wins (it is the newer one)
 * and only genuinely-absent sessions are restored. That also makes hydration
 * idempotent if a second provider instance is ever created.
 */
export function hydrateSessionCosts(sessions: SessionCost[] | undefined): void {
    for (const session of sessions ?? []) {
        if (
            session &&
            typeof session.sessionId === 'string' &&
            // Only real chat sessions are restored. Entries persisted by an earlier
            // revision for unidentified calls carry a bare per-window UUID; those
            // are now attributed to their parent instead, so they are dropped.
            session.sessionId.startsWith(SESSION_ID_PREFIX) &&
            Number.isFinite(session.paid) &&
            session.paid > 0 &&
            !sessionCosts.has(session.sessionId)
        ) {
            sessionCosts.set(session.sessionId, { ...session, routes: session.routes ?? [] });
        }
    }
    trimToCap();
}

export function resetSessionCostsForTesting(): void {
    sessionCosts.clear();
}

function newBucket(): CostBucket {
    return { paid: 0, openRouter: 0, upstream: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, calls: 0 };
}

function addToBucket(bucket: CostBucket, cost: TurnCost): void {
    const payable = cost.openRouter > 0 ? cost.openRouter : (cost.upstream ?? 0);
    bucket.paid = roundSignificant(bucket.paid + payable);
    bucket.openRouter = roundSignificant(bucket.openRouter + cost.openRouter);
    bucket.upstream = roundSignificant(bucket.upstream + (cost.upstream ?? 0));
    bucket.promptTokens += cost.promptTokens;
    bucket.completionTokens += cost.completionTokens;
    bucket.cachedTokens += cost.cachedTokens;
    bucket.calls += 1;
}

/** Fold one model call's usage into its session's total and its route bucket.
 *  Returns the updated snapshot, or `undefined` when the call reported no
 *  payable cost. */
export function accumulateSessionCost(
    sessionId: string,
    usage: unknown,
    provider?: string,
    model?: string
): SessionCost | undefined {
    // An unidentified call is not tracked: a session of its own would be a
    // meaningless row that never accumulates (see `resolveCostSession`).
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        return undefined;
    }
    const cost = turnCostOf(usage, provider);
    if (!cost) {
        return undefined;
    }
    const now = stamp();
    const session = sessionCosts.get(sessionId) ?? {
        sessionId,
        ...newBucket(),
        byok: false,
        routes: [],
        updatedAt: now,
    };
    addToBucket(session, cost);
    session.byok = session.byok || cost.isByok;
    session.updatedAt = now;

    const routeKey = `${cost.provider ?? 'unknown'}\u0000${model ?? ''}`;
    let route = session.routes.find(r => `${r.provider}\u0000${r.model}` === routeKey);
    if (!route) {
        route = { provider: cost.provider ?? 'unknown', model: model ?? '', byok: cost.isByok, ...newBucket(), updatedAt: now };
        session.routes.push(route);
    }
    addToBucket(route, cost);
    route.byok = route.byok || cost.isByok;
    route.updatedAt = now;
    // Most expensive route first: that is what a reader wants to see.
    session.routes.sort((a, b) => b.paid - a.paid);

    sessionCosts.set(sessionId, session);

    // Bound the map: keep only the most recently updated sessions.
    trimToCap();
    persistSessionCosts?.(getSessionCosts());
    turnCostEmitter.fire(cost);
    return snapshotSession(session);
}

function snapshotSession(session: SessionCost): SessionCost {
    return { ...session, routes: session.routes.map(r => ({ ...r })) };
}

/** Every tracked session's running total, most recent first. */
export function getSessionCosts(): SessionCost[] {
    return [...sessionCosts.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(snapshotSession);
}

/** The session's running total, or `undefined` if it has spent nothing yet. */
export function getSessionCost(sessionId: string): SessionCost | undefined {
    const found = sessionCosts.get(sessionId);
    return found ? snapshotSession(found) : undefined;
}

/** One route's line, e.g. `$0.0031 · Fireworks (BYOK) · deepseek/deepseek-v4.1-flash · 3 calls`.
 *  An OpenRouter-charged route carries no marker (the absence of `(BYOK)` says it). */
export function routeCostLine(route: CostRoute): string {
    const kind = route.openRouter > 0 ? '' : ' (BYOK)';
    const model = route.model ? ` \u00b7 ${route.model}` : '';
    return `${formatUsdPrecise(route.paid)} \u00b7 ${route.provider}${kind}${model} \u00b7 ${route.calls} call(s)`;
}

function reportUsagePart(progress: vscode.Progress<ResponsePart>, usage: unknown): void {
    const part = buildUsagePart(usage);
    if (part) {
        progress.report(
            new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(part)), USAGE_MIME)
        );
    }
}

export function baseUrl(): string {
    const cfg = vscode.workspace.getConfiguration('openrouterCopilot');
    const inspected = cfg.inspect<string>('baseUrl');
    const raw = String(inspected?.globalValue ?? inspected?.defaultValue ?? DEFAULT_BASE_URL);
    let cleaned = raw.replace(/\/+$/, '');
    cleaned = cleaned.replace(/\/chat\/completions$/i, '');
    let parsed: URL | undefined;
    try {
        parsed = new URL(cleaned);
    } catch {
        parsed = undefined;
    }
    if (!parsed || parsed.protocol !== 'https:' || !parsed.host) {
        if (!warnedBadBaseUrl) {
            warnedBadBaseUrl = true;
            vscode.window.showWarningMessage(
                `OpenRouter: ignoring baseUrl "${raw}" — must be an https:// URL set in user (global) settings.`
            );
        }
        return DEFAULT_BASE_URL;
    }
    warnedBadBaseUrl = false;
    return parsed.href.replace(/\/+$/, '');
}

function isRetryable(status: number): boolean {
    return status === 429 || status >= 500;
}

function jitteredDelay(baseMs: number): number {
    const jitter = Math.round(baseMs * (Math.random() - 0.5) * 0.4);
    return Math.min(Math.max(baseMs + jitter, 0), MAX_BACKOFF_MS);
}

async function fetchWithRetry(
    url: string,
    init: RequestInit,
    token: vscode.CancellationToken
): Promise<Response> {
    let attempt = 0;
    for (; ;) {
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        let response: Response | undefined;
        let thrown: unknown;
        try {
            response = await fetch(url, init);
        } catch (err) {
            thrown = err;
        }
        if (thrown !== undefined) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            if (init.signal?.aborted && !token.isCancellationRequested) {
                throw thrown;
            }
            if (attempt >= MAX_RETRIES) {
                throw thrown;
            }
        } else if (response !== undefined && (!isRetryable(response.status) || attempt >= MAX_RETRIES)) {
            return response;
        }
        if (response !== undefined) {
            await response.body?.cancel();
        }
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        await delayFn(jitteredDelay(RETRY_DELAYS_MS[attempt]));
        attempt += 1;
    }
}

async function throwIfNotOk(response: Response): Promise<void> {
    if (response.ok) {
        return;
    }
    const text = await response.text();
    throw mapResponseError(response.status, text, response.headers.get('x-generation-id') ?? undefined);
}

export function mapResponseError(status: number, body: string, generationId?: string): Error {
    const snippet = body.trim().slice(0, 200);
    let message: string;
    if (status === 401) {
        message = 'OpenRouter rejected your API key (401): it is invalid or expired. Paste a fresh key in the OpenRouter panel.';
    } else if (status === 402) {
        message = 'OpenRouter: not enough credits (402). Check your balance in the status bar or the usage dashboard.';
    } else if (status === 429) {
        message = 'OpenRouter: rate limited (429) after retries. Try again in a moment.';
    } else {
        message = `OpenRouter request failed (${status}): ${snippet || 'no error body'}`;
    }
    if (generationId) {
        message += ` [generation ${generationId}]`;
    }
    if (status === 401) {
        return vscode.LanguageModelError.NoPermissions(message);
    }
    if (status === 402 || status === 429) {
        return vscode.LanguageModelError.Blocked(message);
    }
    return new Error(message);
}

export function mapStreamedError(json: unknown, generationId?: string): Error | undefined {
    const raw = (json as { error?: unknown } | null)?.error;
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const e = raw as { message?: unknown; code?: unknown; metadata?: { provider_name?: unknown } };
    const message =
        typeof e.message === 'string' && e.message.trim() !== '' ? e.message.trim().slice(0, 200) : 'unknown stream error';
    const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : undefined;
    const providerName =
        typeof e.metadata === 'object' && e.metadata !== null && typeof e.metadata.provider_name === 'string'
            ? e.metadata.provider_name
            : undefined;
    let text = `OpenRouter stream error: ${message}`;
    if (code) {
        text += ` (code: ${code})`;
    }
    if (providerName) {
        text += ` [provider: ${providerName}]`;
    }
    if (generationId) {
        text += ` [generation ${generationId}]`;
    }
    const codeText = (code ?? '').toLowerCase();
    if (codeText.includes('auth') || codeText.includes('permission') || codeText.includes('key')) {
        return vscode.LanguageModelError.NoPermissions(text);
    }
    if (codeText.includes('rate') || codeText.includes('quota') || codeText.includes('credit') || codeText.includes('blocked')) {
        return vscode.LanguageModelError.Blocked(text);
    }
    return new Error(text);
}

interface ReasoningDetail {
    type?: unknown;
    text?: unknown;
    summary?: unknown;
    output_text?: unknown;
}

export function flattenReasoningDetails(details: unknown): { thinking: string; text: string } {
    const thinking: string[] = [];
    const text: string[] = [];
    if (!Array.isArray(details)) {
        return { thinking: '', text: '' };
    }
    for (const item of details) {
        if (typeof item !== 'object' || item === null) {
            continue;
        }
        const d = item as ReasoningDetail;
        const type = typeof d.type === 'string' ? d.type : '';
        const pick = (...values: unknown[]): string => {
            for (const v of values) {
                if (typeof v === 'string' && v.length > 0) {
                    return v;
                }
            }
            return '';
        };
        if (type.includes('response')) {
            const part = pick(d.output_text, d.text);
            if (part) {
                text.push(part);
            }
        } else if (
            type === '' ||
            type.includes('reasoning') ||
            type === 'summary' ||
            type === 'text' ||
            type === 'final'
        ) {
            const part = pick(d.summary, d.text);
            if (part) {
                thinking.push(part);
            }
        } else {
            const part = pick(d.summary, d.text, d.output_text);
            if (part) {
                thinking.push(part);
            }
        }
    }
    return { thinking: thinking.join('\n'), text: text.join('\n') };
}

function mergeReasoningConfig(body: Record<string, unknown>, key: string, value: unknown): void {
    if (value === undefined) {
        return;
    }
    const existing = body.reasoning;
    const base =
        typeof existing === 'object' && existing !== null && !Array.isArray(existing)
            ? existing
            : {};
    body.reasoning = { ...(base as Record<string, unknown>), [key]: value };
}

export function buildRequestBody(
    template: Record<string, unknown> | undefined,
    modelId: string,
    messages: unknown[],
    tools: unknown,
    modelConfiguration: { readonly [key: string]: unknown } | undefined,
    cacheModelId?: string,
    sessionId?: string
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        ...(template ?? {}),
        model: modelId,
        messages,
        tools,
        stream: true,
    };
    delete body.session_id;
    if (typeof sessionId === 'string' && sessionId.trim() !== '') {
        body.session_id = sessionId;
    }
    if (presetSlugFromModelId(modelId) !== undefined) {
        delete body.preset;
    }
    const effort = effortFromModelConfiguration(modelConfiguration);
    if (effort === 'none') {
        const existing = body.reasoning;
        if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
            const clone = { ...(existing as Record<string, unknown>) };
            delete clone.effort;
            body.reasoning = clone;
        }
        mergeReasoningConfig(body, 'enabled', false);
    } else {
        mergeReasoningConfig(body, 'effort', effort);
    }
    mergeReasoningConfig(body, 'enabled', enabledFromModelConfiguration(modelConfiguration));
    const cacheId = cacheModelId ?? modelId;
    if (cacheId.replace(/^~/, '').split('/')[0] === 'anthropic' && !('cache_control' in body)) {
        body.cache_control = { type: 'ephemeral' };
    }
    return body;
}

interface ChatModelInfo extends vscode.LanguageModelChatInformation {
    configurationSchema?: { properties: Record<string, unknown> };
}

export class OpenRouterChatProvider implements vscode.LanguageModelChatProvider {
    private cachedInfo: ChatModelInfo[] | undefined;
    private catalogPromise: Promise<ModelCatalogEntry[]> | undefined;
    private cachedPresets: PresetSummary[] | undefined;
    private presetsPromise: Promise<PresetSummary[] | undefined> | undefined;
    private readonly presetConfigs = new Map<string, Record<string, unknown>>();
    private key: string | undefined;
    private template: Record<string, unknown> | undefined;
    private readonly infoChangeEvent = new vscode.EventEmitter<void>();
    private persistQueue: Promise<unknown> = Promise.resolve();

    readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this.infoChangeEvent.event;

    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly state: vscode.Memento
    ) {
        // Restore spend recorded in previous windows, then keep it up to date.
        // Persisted so the panel's Session spend survives a reload or restart;
        // the accumulator itself stays a module-level map so it is testable.
        hydrateSessionCosts(this.state.get<SessionCost[]>(SESSION_COSTS_KEY));
        hydrateParentAttribution(this.state.get<{ sessionId: string; at: number }>(PARENT_SESSION_KEY));
        persistSessionCosts = (snapshot) => {
            const value = snapshot.length === 0 ? undefined : snapshot;
            this.persistQueue = this.persistQueue
                .then(() => this.state.update(SESSION_COSTS_KEY, value))
                .catch(() => undefined);
        };
        persistParentSession = (sessionId, at) => {
            this.persistQueue = this.persistQueue
                .then(() => this.state.update(PARENT_SESSION_KEY, { sessionId, at }))
                .catch(() => undefined);
        };
    }

    dispose(): void {
        this.infoChangeEvent.dispose();
    }

    async setKey(value: string): Promise<void> {
        this.key = value;
        this.cachedInfo = undefined;
        this.catalogPromise = undefined;
        this.cachedPresets = undefined;
        this.presetsPromise = undefined;
        this.presetConfigs.clear();
        await storeKey(this.secrets, value);
        this.infoChangeEvent.fire();
    }

    async clearKey(): Promise<void> {
        this.key = undefined;
        this.cachedInfo = undefined;
        this.catalogPromise = undefined;
        this.cachedPresets = undefined;
        this.presetsPromise = undefined;
        this.presetConfigs.clear();
        await clearStoredKey(this.secrets);
        this.infoChangeEvent.fire();
    }

    resetCatalogCache(): void {
        this.cachedInfo = undefined;
        this.catalogPromise = undefined;
        this.cachedPresets = undefined;
        this.presetsPromise = undefined;
        this.presetConfigs.clear();
        this.infoChangeEvent.fire();
    }

    async setTemplate(raw: string): Promise<{ ok: boolean; error?: string }> {
        const cleaned = stripTemplateComments(raw);
        if (cleaned.trim() === '') {
            await this.clearTemplate();
            return { ok: true };
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(cleaned);
        } catch {
            return { ok: false, error: 'The pasted text is not valid JSON.' };
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { ok: false, error: 'The template must be a JSON object (a request body).' };
        }
        const body = parsed as Record<string, unknown>;
        const { messages, prompt, model, tools, stream, session_id, ...params } = body;
        this.template = params;
        await this.state.update(TEMPLATE_KEY, params);
        return { ok: true };
    }

    async getTemplate(): Promise<Record<string, unknown> | undefined> {
        if (this.template) {
            return this.template;
        }
        this.template = this.state.get<Record<string, unknown>>(TEMPLATE_KEY);
        return this.template;
    }

    async clearTemplate(): Promise<void> {
        this.template = undefined;
        await this.state.update(TEMPLATE_KEY, undefined);
    }

    async getKey(silent: boolean): Promise<string | undefined> {
        if (this.key) {
            return this.key;
        }
        const stored = await readKey(this.secrets);
        if (stored) {
            this.key = stored;
            return stored;
        }
        if (silent) {
            return undefined;
        }
        const value = await vscode.window.showInputBox({
            prompt: 'Paste your OpenRouter key (sk-or-...)',
            password: true,
            ignoreFocusOut: true,
        });
        if (value) {
            await this.setKey(value.trim());
            return this.key;
        }
        return undefined;
    }

    async provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions,
        token: vscode.CancellationToken
    ): Promise<ChatModelInfo[]> {
        if (this.cachedInfo) {
            return this.cachedInfo;
        }
        const key = await this.getKey(options.silent);
        if (!key) {
            return [];
        }
        const models = await this.ensureCatalog(key, token);
        const info = models.map(m => this.toInfo(m));
        this.cachedInfo = info;
        if (this.cachedPresets) {
            this.appendPresetEntries(info, models);
            return info;
        }
        void this.attachPresets(key, models, info);
        return info;
    }

    private ensureCatalog(key: string, token: vscode.CancellationToken): Promise<ModelCatalogEntry[]> {
        const existing = this.catalogPromise;
        if (existing) {
            return existing;
        }
        const promise = this.fetchCatalog(key, token).finally(() => {
            if (this.catalogPromise === promise) {
                this.catalogPromise = undefined;
            }
        });
        this.catalogPromise = promise;
        return promise;
    }

    private appendPresetEntries(info: ChatModelInfo[], models: ModelCatalogEntry[]): void {
        for (const preset of this.cachedPresets ?? []) {
            const entry = this.toPresetInfo(preset, models);
            if (entry) {
                info.push(entry);
            }
        }
    }

    private async attachPresets(
        key: string,
        models: ModelCatalogEntry[],
        snapshot: ChatModelInfo[]
    ): Promise<void> {
        try {
            const presets = await this.ensurePresets(key);
            if (presets === undefined || this.cachedInfo !== snapshot) {
                return;
            }
            this.cachedPresets = presets;
            const entries = presets
                .map(p => this.toPresetInfo(p, models))
                .filter((e): e is ChatModelInfo => e !== undefined);
            if (entries.length === 0 || this.cachedInfo !== snapshot) {
                return;
            }
            this.cachedInfo = [...snapshot, ...entries];
            this.infoChangeEvent.fire();
        } catch {
            // the picker stays models-only until the next query when the sweep fails or is cancelled
        }
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<ResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const key = await this.getKey(true);
        if (!key) {
            throw vscode.LanguageModelError.NoPermissions(
                'OpenRouter key not configured. Run "OpenRouter: Manage provider".'
            );
        }

        const template = (await this.getTemplate()) ?? {};
        const modelConfiguration = (
            options as { modelConfiguration?: { readonly [key: string]: unknown } }
        ).modelConfiguration;
        const conversationId = (options.modelOptions as { _conversationId?: unknown } | undefined)?._conversationId;
        const hasConversationId = typeof conversationId === 'string' && conversationId.trim() !== '';
        // Attribute the call to the chat that owns it: the chat itself for a turn,
        // or the last active chat for an internal (sub-agent / utility) call, so
        // OpenRouter's Sessions view agrees with the panel. With no known parent no
        // `session_id` is sent at all, so an unowned call cannot mint an orphan
        // OpenRouter session.
        const sessionId = resolveCostSession(sessionIdFor(conversationId), hasConversationId);
        const presetSlug = presetSlugFromModelId(model.id);
        const presetModel = presetSlug !== undefined ? presetModelOf(this.presetConfigs.get(presetSlug)) : undefined;
        const body = buildRequestBody(
            template,
            model.id,
            toOpenAI(messages),
            options.tools?.map(tool => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
            })),
            modelConfiguration,
            presetModel,
            sessionId
        );

        lastStreamUsage = undefined;
        lastStreamProvider = undefined;
        let usage: unknown;
        let provider: string | undefined;

        const controller = new AbortController();
        const abortListener = token.onCancellationRequested(() => controller.abort());
        const timeoutId = setTimeout(() => controller.abort(), postTimeoutMs);

        try {
            const response = await fetchWithRetry(
                `${baseUrl()}/chat/completions`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${key}`,
                        'HTTP-Referer': 'https://github.com/tianyu-liu/vscode-openrouter-copilot-request-credit',
                        'X-Title': 'OpenRouter for Copilot',
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                },
                token
            );
            clearTimeout(timeoutId);
            await throwIfNotOk(response);
            if (!response.body) {
                throw new Error('OpenRouter returned no response body.');
            }

            const generationId = response.headers.get('x-generation-id') ?? undefined;
            const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                if (token.isCancellationRequested) {
                    await reader.cancel();
                    throw new vscode.CancellationError();
                }
                const { done, value } = await reader.read();
                if (done) {
                    flushToolCalls(toolCalls, progress);
                    reportUsagePart(progress, usage);
                    if (sessionId !== undefined) {
                        accumulateSessionCost(sessionId, usage, provider, model.id);
                    }
                    lastStreamUsage = usage;
                    lastStreamProvider = provider;
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                if (buffer.length > MAX_SSE_BUFFER_CHARS) {
                    throw new Error('OpenRouter: oversized SSE line in the stream response.');
                }
                let newline: number;
                while ((newline = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    if (!line.startsWith('data:')) {
                        continue;
                    }
                    const data = line.slice(5).trim();
                    if (data === '') {
                        continue;
                    }
                    if (data === '[DONE]') {
                        flushToolCalls(toolCalls, progress);
                        reportUsagePart(progress, usage);
                        if (sessionId !== undefined) {
                            accumulateSessionCost(sessionId, usage, provider, model.id);
                        }
                        lastStreamUsage = usage;
                        lastStreamProvider = provider;
                        return;
                    }
                    let json: any;
                    try {
                        json = JSON.parse(data);
                    } catch {
                        throw new Error('OpenRouter: malformed SSE data line in the stream response.');
                    }
                    if (json.error !== undefined) {
                        throw mapStreamedError(json, generationId) ?? new Error('OpenRouter stream error.');
                    }
                    if (typeof json.provider === 'string' && json.provider.trim() !== '') {
                        provider = json.provider;
                    }
                    if (json.usage !== undefined && typeof json.usage === 'object' && json.usage !== null) {
                        usage = json.usage;
                    }
                    const choice = json.choices?.[0];
                    if (!choice) {
                        continue;
                    }
                    const delta = choice.delta ?? {};
                    if (typeof delta.content === 'string' && delta.content.length > 0) {
                        progress.report(new vscode.LanguageModelTextPart(delta.content));
                    }
                    reportThinkingParts(delta, progress);
                    for (const tc of delta.tool_calls ?? []) {
                        accumulateToolCall(toolCalls, tc);
                    }
                    if (choice.finish_reason === 'tool_calls') {
                        flushToolCalls(toolCalls, progress);
                    }
                }
            }
        } catch (err) {
            if (token.isCancellationRequested && !(err instanceof vscode.CancellationError)) {
                throw new vscode.CancellationError();
            }
            if (controller.signal.aborted && !token.isCancellationRequested) {
                throw new Error(
                    `OpenRouter did not respond within ${POST_RESPONSE_TIMEOUT_MS / 1000} seconds.`
                );
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
            abortListener.dispose();
            controller.abort();
        }
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        if (typeof text === 'string') {
            return Math.ceil(text.length / 4);
        }
        let count = 0;
        for (const part of text.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                count += part.value.length;
            }
        }
        return Math.ceil(count / 4);
    }

    private async fetchCatalog(key: string, token: vscode.CancellationToken): Promise<ModelCatalogEntry[]> {
        const response = await fetchWithRetry(
            `${baseUrl()}/models`,
            { headers: { Authorization: `Bearer ${key}` } },
            token
        );
        await throwIfNotOk(response);
        let json: { data?: ModelCatalogEntry[] };
        try {
            json = (await response.json()) as { data?: ModelCatalogEntry[] };
        } catch {
            throw new Error('OpenRouter /models returned an unexpected (non-JSON) response body.');
        }
        return json.data ?? [];
    }

    async getPresets(): Promise<PresetSummary[] | undefined> {
        if (this.cachedPresets) {
            return this.cachedPresets;
        }
        const key = await this.getKey(true);
        if (!key) {
            return [];
        }
        let presets: PresetSummary[] | undefined;
        try {
            presets = await this.ensurePresets(key);
        } catch {
            return undefined;
        }
        if (presets === undefined) {
            return undefined;
        }
        if (!this.cachedPresets) {
            this.cachedPresets = presets;
        }
        return this.cachedPresets;
    }

    private ensurePresets(key: string): Promise<PresetSummary[] | undefined> {
        const existing = this.presetsPromise;
        if (existing) {
            return existing;
        }
        const cts = new vscode.CancellationTokenSource();
        const promise = this.fetchPresets(key, cts.token).finally(() => {
            cts.dispose();
            if (this.presetsPromise === promise) {
                this.presetsPromise = undefined;
            }
        });
        this.presetsPromise = promise;
        return promise;
    }

    private async fetchPresets(key: string, token: vscode.CancellationToken): Promise<PresetSummary[] | undefined> {
        try {
            const response = await fetchWithRetry(
                `${baseUrl()}/presets?limit=100`,
                { headers: { Authorization: `Bearer ${key}` } },
                token
            );
            if (!response.ok) {
                return undefined;
            }
            const json = (await response.json()) as { data?: Array<Record<string, unknown>> };
            const summaries: PresetSummary[] = (json.data ?? [])
                .filter((raw) => raw.status === 'active' && typeof raw.slug === 'string' && raw.slug.trim() !== '')
                .map((raw) => {
                    const slug = raw.slug as string;
                    return {
                        slug,
                        name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : slug,
                    };
                });
            await mapWithConcurrency(summaries.slice(0, MAX_PRESET_LOOKUPS), PRESET_LOOKUP_CONCURRENCY, async (summary) => {
                summary.model = presetModelOf(await this.fetchPresetConfig(key, summary.slug, token));
            });
            for (const summary of summaries.slice(MAX_PRESET_LOOKUPS)) {
                summary.lookupSkipped = true;
            }
            return summaries;
        } catch (err) {
            if (err instanceof vscode.CancellationError) {
                throw err;
            }
            return undefined;
        }
    }

    async getPresetConfig(slug: string): Promise<Record<string, unknown> | undefined> {
        const cached = this.presetConfigs.get(slug);
        if (cached) {
            return cached;
        }
        const key = await this.getKey(true);
        if (!key) {
            return undefined;
        }
        const cts = new vscode.CancellationTokenSource();
        try {
            return await this.fetchPresetConfig(key, slug, cts.token);
        } finally {
            cts.dispose();
        }
    }

    private async fetchPresetConfig(
        key: string,
        slug: string,
        token: vscode.CancellationToken
    ): Promise<Record<string, unknown> | undefined> {
        try {
            const response = await fetchWithRetry(
                `${baseUrl()}/presets/${encodeURIComponent(slug)}`,
                { headers: { Authorization: `Bearer ${key}` } },
                token
            );
            if (!response.ok) {
                return undefined;
            }
            const json = (await response.json()) as {
                data?: { designated_version?: { config?: unknown } };
            };
            const config = json.data?.designated_version?.config;
            if (!config || typeof config !== 'object' || Array.isArray(config)) {
                return undefined;
            }
            const result = config as Record<string, unknown>;
            this.presetConfigs.set(slug, result);
            return result;
        } catch (err) {
            if (err instanceof vscode.CancellationError) {
                throw err;
            }
            return undefined;
        }
    }

    private resolvePresetBase(model: string, models: ModelCatalogEntry[]): ModelCatalogEntry | undefined {
        const byId = (id: string): ModelCatalogEntry | undefined => models.find(m => m.id === id);
        const exact = byId(model);
        if (exact) {
            return exact;
        }
        const withoutFullDate = model.replace(/-\d{8}$/, '');
        if (withoutFullDate !== model) {
            const match = byId(withoutFullDate);
            if (match) {
                return match;
            }
        }
        const withoutShortDate = model.replace(/-(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])$/, '');
        if (withoutShortDate !== model) {
            const match = byId(withoutShortDate);
            if (match) {
                return match;
            }
        }
        return undefined;
    }

    private toPresetInfo(preset: PresetSummary, models: ModelCatalogEntry[]): ChatModelInfo | undefined {
        if (!preset.model) {
            return undefined;
        }
        const id = `${PRESET_ID_PREFIX}${preset.slug}`;
        const base = this.resolvePresetBase(preset.model, models);
        const baseInfo = base ? buildModelInfo(base) : undefined;
        const tooltip = [
            `**Preset: ${preset.name}**`,
            `\`${id}\` → \`${preset.model}\` with the preset's pinned provider routing.`,
            'The extension adds no default provider routing; a pasted `provider` still overrides the preset.',
            baseInfo?.tooltip ?? 'The preset\u2019s model is not in the public catalog; token limits are assumed defaults.',
        ].join('\n\n');
        const info: ChatModelInfo = {
            id,
            name: preset.name,
            family: 'preset',
            version: id,
            maxInputTokens: baseInfo?.maxInputTokens ?? 1_048_576,
            maxOutputTokens: baseInfo?.maxOutputTokens ?? 16_384,
            detail: baseInfo?.detail ? `preset · ${baseInfo.detail}` : 'preset',
            tooltip,
            capabilities: {
                toolCalling: base?.supports_tool_parameters !== false,
                imageInput: (base?.architecture?.input_modalities ?? []).includes('image'),
            },
        };
        const reasoningSchema = base ? buildReasoningSchema(base) : undefined;
        if (reasoningSchema) {
            info.configurationSchema = reasoningSchema;
        }
        return info;
    }

    private toInfo(m: ModelCatalogEntry): ChatModelInfo {
        const [family] = m.id.split('/');
        const { detail, tooltip, maxInputTokens, maxOutputTokens } = buildModelInfo(m);
        const info: ChatModelInfo = {
            id: m.id,
            name: m.name ?? m.id,
            family: family ?? 'openrouter',
            version: m.id,
            maxInputTokens,
            maxOutputTokens,
            detail,
            tooltip,
            capabilities: {
                toolCalling: m.supports_tool_parameters !== false,
                imageInput: (m.architecture?.input_modalities ?? []).includes('image'),
            },
        };
        const reasoningSchema = buildReasoningSchema(m);
        if (reasoningSchema) {
            info.configurationSchema = reasoningSchema;
        }
        return info;
    }
}

function contentOrString(text: string[], multimodal: unknown[]): string | unknown[] | null {
    const content: unknown[] = [];
    if (text.length > 0) {
        content.push(multimodal.length > 0 ? { type: 'text', text: text.join('\n') } : text.join('\n'));
    }
    content.push(...multimodal);
    if (content.length === 0) {
        return null;
    }
    return content.length === 1 && typeof content[0] === 'string' ? content[0] : content;
}

export function toOpenAI(messages: readonly vscode.LanguageModelChatRequestMessage[]): unknown[] {
    const out: unknown[] = [];
    for (const message of messages) {
        const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
        const text: string[] = [];
        const thinking: string[] = [];
        const multimodal: unknown[] = [];
        const toolCalls: unknown[] = [];
        const toolResults: unknown[] = [];
        for (const part of message.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                if (part.value.length > 0) {
                    text.push(part.value);
                }
            } else if (thinkingPartCtor && part instanceof thinkingPartCtor) {
                const value = Array.isArray(part.value) ? part.value.join('\n') : part.value;
                if (value.trim().length > 0) {
                    thinking.push(value);
                }
            } else if (part instanceof vscode.LanguageModelToolCallPart) {
                toolCalls.push({
                    id: part.callId,
                    type: 'function',
                    function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
                });
            } else if (part instanceof vscode.LanguageModelToolResultPart) {
                const resultText = part.content
                    .map(c => (typeof c === 'string' ? c : c instanceof vscode.LanguageModelTextPart ? c.value : JSON.stringify(c)))
                    .join('\n');
                toolResults.push({ role: 'tool', tool_call_id: part.callId, content: resultText });
            } else if (part instanceof vscode.LanguageModelDataPart) {
                if (part.mimeType.startsWith('image/')) {
                    const base64 = Buffer.from(part.data).toString('base64');
                    multimodal.push({
                        type: 'image_url',
                        image_url: { url: `data:${part.mimeType};base64,${base64}` },
                    });
                }
            }
        }
        if (role === 'user' && toolResults.length > 0) {
            out.push(...toolResults);
            const userContent = contentOrString(text, multimodal);
            if (userContent !== null) {
                out.push({ role: 'user', content: userContent });
            }
            continue;
        }
        if (role === 'assistant') {
            const converted: Record<string, unknown> = { role };
            if (thinking.length > 0) {
                converted.reasoning = thinking.join('\n');
            }
            if (toolCalls.length > 0) {
                converted.content = text.length > 0 ? text.join('\n') : null;
                converted.tool_calls = toolCalls;
            } else {
                const content = contentOrString(text, multimodal);
                if (content === null) {
                    if (thinking.length === 0) {
                        continue;
                    }
                    converted.content = null;
                } else {
                    converted.content = content;
                }
            }
            out.push(converted);
            continue;
        }
        const converted: Record<string, unknown> = { role };
        const content = contentOrString(text, multimodal);
        if (content === null) {
            continue;
        }
        converted.content = content;
        out.push(converted);
    }
    return out;
}

function reportThinkingParts(delta: any, progress: vscode.Progress<ResponsePart>): void {
    if (!thinkingPartCtor) {
        return;
    }
    if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
        progress.report(new thinkingPartCtor(delta.reasoning));
        return;
    }
    if (Array.isArray(delta.reasoning_details)) {
        const { thinking, text } = flattenReasoningDetails(delta.reasoning_details);
        if (thinking.length > 0) {
            progress.report(new thinkingPartCtor(thinking));
        }
        if (text.length > 0) {
            progress.report(new vscode.LanguageModelTextPart(text));
        }
    }
}

function accumulateToolCall(
    toolCalls: Map<number, { id: string; name: string; arguments: string }>,
    tc: any
): void {
    const index = tc.index ?? 0;
    const current = toolCalls.get(index) ?? { id: tc.id ?? `call_${index}`, name: '', arguments: '' };
    if (tc.id) {
        current.id = tc.id;
    }
    if (tc.function?.name) {
        current.name = tc.function.name;
    }
    if (tc.function?.arguments) {
        current.arguments += tc.function.arguments;
    }
    toolCalls.set(index, current);
}

function flushToolCalls(
    toolCalls: Map<number, { id: string; name: string; arguments: string }>,
    progress: vscode.Progress<ResponsePart>
): void {
    for (const call of toolCalls.values()) {
        let input: object;
        try {
            input = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
            input = { raw: call.arguments };
        }
        progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
    }
    toolCalls.clear();
}
