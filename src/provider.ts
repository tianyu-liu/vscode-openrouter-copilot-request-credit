import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { t } from './i18n';
import { clearStoredKey, readKey, storeKey } from './storage';
import { assertConnectionCredential } from './connectionCredentials';
import {
    ASSUMED_CONTEXT_TOKENS,
    buildContextCapSchema,
    buildModelInfo,
    buildReasoningSchema,
    contextCapFromPicker,
    defaultContextCap,
    DEFAULT_OUTPUT_RESERVE_MAX_TOKENS,
    DEFAULT_OUTPUT_RESERVE_MIN_TOKENS,
    DEFAULT_OUTPUT_RESERVE_PERCENT,
    effectiveMaxInputTokens,
    effortFromModelConfiguration,
    enabledFromModelConfiguration,
    normalizeOutputReservePolicy,
    supportsToolCalling,
    type ContextBudgetOptions,
    type ModelCatalogEntry,
    type OutputReservePolicy,
} from './modelInfo';
import { formatUsdPrecise, roundSignificant } from './logic';
import type { ConnectionKind, ManualModel } from './connections';

const TEMPLATE_KEY = 'requestTemplate';
const OPENROUTER_API_BASE_URL = 'https://openrouter.ai/api/v1';
const PRESET_ID_PREFIX = '@preset/';
const MAX_PRESET_LOOKUPS = 25;
export const SESSION_ID_PREFIX = 'copilot-chat:';
/**
 * Cost-bucket key for spend that belongs to no known Copilot chat.
 *
 * Deliberately *not* prefixed with `copilot-chat:`, so it can never be mistaken
 * for a real chat id, and it is never used as an outgoing `session_id` — see the
 * agent-host BYOK note on `resolveCostSession`.
 */
export const UNATTRIBUTED_SESSION_ID = 'unattributed';
const MAX_SESSION_ID_CHARS = 256;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_BACKOFF_MS = 10000;
const MAX_SSE_BUFFER_CHARS = 4_000_000;
const PRESET_LOOKUP_CONCURRENCY = 5;
const USAGE_MIME = 'usage';
const NANO_AIU_PER_CREDIT = 1_000_000_000;
const POST_RESPONSE_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 30_000;
const CONTEXT_CAPS_KEY = 'contextCaps';
/** Retired margin-based context policy keys, still read by the one-time migration. */
const LEGACY_CONTEXT_CAPS_BASE_KEY = 'contextCapsBase';
const LEGACY_CONTEXT_MARGIN_KEY = 'contextMarginPercent';

/** A per-model context override: a prompt budget, or `'full'` for the whole window. */
export type ContextCapValue = number | 'full';

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

/**
 * A catalog model id plus the datestamp aliases it may be pinned under: the
 * full `-YYYYMMDD` suffix and the short `-MMDD` one (e.g. `-0731`).
 */
function modelIdAliases(model: string): string[] {
    const candidates = [model];
    const withoutFullDate = model.replace(/-\d{8}$/, '');
    if (withoutFullDate !== model) {
        candidates.push(withoutFullDate);
    }
    const withoutShortDate = model.replace(/-(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])$/, '');
    if (withoutShortDate !== model && withoutShortDate !== withoutFullDate) {
        candidates.push(withoutShortDate);
    }
    return candidates;
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

const BASE64_RUN_REGEX = /[A-Za-z0-9+/=_-]{200,}/g;
export const GUARDRAIL_RETRY_NOTICE =
    '\n[OpenRouter blocked the request (base64 injection guardrail); retrying with base64 content removed.]\n';

export function sanitizeBase64Text(text: string): { text: string; removed: number } {
    let removed = 0;
    const out = text.replace(BASE64_RUN_REGEX, (match) => {
        removed += match.length;
        return t('[base64 content removed: {0} chars]', match.length);
    });
    return { text: out, removed };
}

/**
 * Strip long base64-like runs from prompt TEXT only: message text, assistant
 * tool-call argument JSON and echoed prior reasoning. Image `image_url` parts
 * (data URLs) and every non-text part are left untouched.
 */
export function sanitizeRequestBody(body: Record<string, unknown>): { body: Record<string, unknown>; removed: number } {
    const messages = body.messages;
    if (!Array.isArray(messages)) {
        return { body, removed: 0 };
    }
    let removed = 0;
    const cleaned = messages.map((msg) => {
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            return msg;
        }
        const record = msg as Record<string, unknown>;
        let next = record;
        let changed = false;

        const reasoning = record.reasoning;
        if (typeof reasoning === 'string') {
            const s = sanitizeBase64Text(reasoning);
            if (s.removed > 0) {
                removed += s.removed;
                changed = true;
                next = { ...next, reasoning: s.text };
            }
        }

        const toolCalls = record.tool_calls;
        if (Array.isArray(toolCalls)) {
            let callsChanged = false;
            const sanitizedCalls = toolCalls.map((call) => {
                if (!call || typeof call !== 'object' || Array.isArray(call)) {
                    return call;
                }
                const entry = call as Record<string, unknown>;
                const fn = entry.function;
                if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
                    return call;
                }
                const fnRecord = fn as Record<string, unknown>;
                if (typeof fnRecord.arguments !== 'string') {
                    return call;
                }
                const s = sanitizeBase64Text(fnRecord.arguments);
                if (s.removed === 0) {
                    return call;
                }
                removed += s.removed;
                callsChanged = true;
                return { ...entry, function: { ...fnRecord, arguments: s.text } };
            });
            if (callsChanged) {
                changed = true;
                next = { ...next, tool_calls: sanitizedCalls };
            }
        }

        const content = record.content;
        if (typeof content === 'string') {
            const s = sanitizeBase64Text(content);
            if (s.removed > 0) {
                removed += s.removed;
                changed = true;
                next = { ...next, content: s.text };
            }
        } else if (Array.isArray(content)) {
            let partsChanged = false;
            const parts = content.map((part) => {
                if (!part || typeof part !== 'object') {
                    return part;
                }
                const p = part as Record<string, unknown>;
                if (p.type === 'text' && typeof p.text === 'string') {
                    const s = sanitizeBase64Text(p.text);
                    if (s.removed > 0) {
                        partsChanged = true;
                        removed += s.removed;
                        return { ...p, text: s.text };
                    }
                }
                return part;
            });
            if (partsChanged) {
                changed = true;
                next = { ...next, content: parts };
            }
        }
        return changed ? next : msg;
    });
    return removed > 0 ? { body: { ...body, messages: cleaned }, removed } : { body, removed: 0 };
}

function sanitizeBase64Enabled(): boolean {
    return vscode.workspace.getConfiguration('openrouterCopilot').get<boolean>('sanitizeBase64Content', true);
}

/**
 * When on (the default), the catalog is intersected with the models the
 * account can actually use (`GET /models/user`), so the picker and the Context
 * Steps table hide models the key is not entitled to. A failed availability
 * query falls back to the full catalog rather than hiding everything.
 */
function hideUnavailableModelsEnabled(): boolean {
    return vscode.workspace.getConfiguration('openrouterCopilot').get<boolean>('hideUnavailableModels', true);
}

/**
 * The global output-reserve policy: a ratio of the served window bounded by
 * fixed lower and upper token limits, used when the published cap is not a real
 * one. Read per model-information build, so a settings change applies after
 * `refreshModelInfo`.
 */
function outputReservePolicy(): OutputReservePolicy {
    const cfg = vscode.workspace.getConfiguration('openrouterCopilot');
    return normalizeOutputReservePolicy(
        cfg.get<number>('outputReservePercent', DEFAULT_OUTPUT_RESERVE_PERCENT),
        cfg.get<number>('outputReserveMinTokens', DEFAULT_OUTPUT_RESERVE_MIN_TOKENS),
        cfg.get<number>('outputReserveMaxTokens', DEFAULT_OUTPUT_RESERVE_MAX_TOKENS)
    );
}

async function isGuardrailBlock(response: Response): Promise<boolean> {
    try {
        const text = await response.clone().text();
        return /base64|prompt injection|request blocked/i.test(text);
    } catch {
        return false;
    }
}

/**
 * Structural shape of the proposed `LanguageModelThinkingPart` (VS Code's
 * `languageModelThinkingPart` proposal; absent from stable `@types/vscode`).
 * Only the member this extension reads is declared; the runtime constructor is
 * probed by {@link probeThinkingPartCtor}.
 */
interface ThinkingPart {
    value: string | string[];
}

type ResponsePart = vscode.LanguageModelResponsePart | ThinkingPart;
type ThinkingPartCtor = new (value: string | string[]) => ThinkingPart;

export function probeThinkingPartCtor(host: object): { ctor?: ThinkingPartCtor; error?: string } {
    try {
        const ctor: unknown = Reflect.get(host, 'LanguageModelThinkingPart');
        return { ctor: typeof ctor === 'function' ? (ctor as ThinkingPartCtor) : undefined };
    } catch (error) {
        return { error: String(error) };
    }
}

const thinkingProbe = probeThinkingPartCtor(vscode);
const thinkingPartCtor = thinkingProbe.ctor;
if (thinkingProbe.error !== undefined) {
    console.warn(
        'OpenRouter: LanguageModelThinkingPart probe failed; reasoning output will not be displayed.',
        thinkingProbe.error
    );
}

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

export function sessionIdFor(conversationId: unknown): string | undefined {
    if (typeof conversationId !== 'string') {
        return undefined;
    }
    const trimmed = conversationId.trim();
    if (trimmed === '') {
        return undefined;
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

interface SpendLedger {
    sessionCosts: Map<string, SessionCost>;
    lastActiveSessionId?: string;
    lastActiveAt: number;
    lastStamp: number;
    persistQueue: Promise<unknown>;
    persistSessionCosts?: (snapshot: SessionCost[]) => void;
    persistParentSession?: (sessionId: string, at: number) => void;
}
function createSpendLedger(): SpendLedger {
    return { sessionCosts: new Map(), lastActiveAt: 0, lastStamp: 0, persistQueue: Promise.resolve() };
}
const defaultLedger = createSpendLedger();

/**
 * Whether a request came through the Copilot harness at all.
 *
 * `ExtensionContributedChatEndpoint.makeChatRequest2` is the only place that builds
 * a `modelOptions` bag for an extension-contributed provider, and it always sets
 * `_capturingTokenCorrelationId` (and `_otelTraceContext`) as own keys. A bag
 * without them was therefore built by some *other* caller — in practice an
 * agent-host / SDK chat session, whose client-BYOK bridge (`AgentHostByokLmHandler`)
 * forwards the caller's `modelOptions` untouched and has no session identifier to
 * put in them. Such calls must never be folded into some unrelated chat.
 */
export function isHarnessOwnedModelOptions(modelOptions: unknown): boolean {
    return (
        typeof modelOptions === 'object' &&
        modelOptions !== null &&
        '_capturingTokenCorrelationId' in (modelOptions as Record<string, unknown>)
    );
}

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
 * The heuristic only applies to calls that came through the harness at all
 * (`harnessOwned`). An agent-host / SDK session sends no conversation id and no
 * harness marker, so nothing links its spend to a chat; charging it to whichever
 * chat happened to be active would be wrong, and it would be invisible after the
 * window lapsed. Those calls go to the `UNATTRIBUTED_SESSION_ID` bucket instead, so
 * the spend stays visible without being blamed on a chat.
 *
 * Never returns `undefined`: every call has somewhere to go. The caller decides
 * separately whether the bucket it returned may be sent as an outgoing `session_id`
 * (only a real chat id may).
 */
export function resolveCostSession(
    sessionId: string,
    hasConversationId: boolean,
    now = Date.now(),
    harnessOwned = true,
    ledger: SpendLedger = defaultLedger
): string {
    if (hasConversationId) {
        ledger.lastActiveSessionId = sessionId;
        ledger.lastActiveAt = now;
        ledger.persistParentSession?.(sessionId, now);
        return sessionId;
    }
    if (harnessOwned && ledger.lastActiveSessionId !== undefined && now - ledger.lastActiveAt <= PARENT_ATTRIBUTION_WINDOW_MS) {
        return ledger.lastActiveSessionId;
    }
    return UNATTRIBUTED_SESSION_ID;
}

/**
 * Restore the last active chat from a previous window so an internal call right
 * after a reload still joins its parent's OpenRouter session. The attribution
 * window still applies, so a long-idle parent is not resurrected.
 */
export function hydrateParentAttribution(
    stored: { sessionId?: unknown; at?: unknown } | undefined, ledger: SpendLedger = defaultLedger
): void {
    if (!stored || typeof stored.sessionId !== 'string' || !stored.sessionId.startsWith(SESSION_ID_PREFIX)) {
        return;
    }
    const at = typeof stored.at === 'number' && Number.isFinite(stored.at) ? stored.at : 0;
    if (at > ledger.lastActiveAt) {
        ledger.lastActiveSessionId = stored.sessionId;
        ledger.lastActiveAt = at;
    }
}

export function resetParentAttributionForTesting(): void {
    const ledger = defaultLedger;
    ledger.lastActiveSessionId = undefined;
    ledger.lastActiveAt = 0;
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
    const rawCompletionDetails = raw.completion_tokens_details;
    if (
        typeof rawCompletionDetails === 'object' &&
        rawCompletionDetails !== null &&
        !Array.isArray(rawCompletionDetails)
    ) {
        part.completion_tokens_details = rawCompletionDetails;
    }
    const cost = finiteNumber(raw.cost);
    if (cost !== undefined && cost > 0) {
        part.copilot_usage = { total_nano_aiu: cost * NANO_AIU_PER_CREDIT };
    }
    return part;
}

export interface TurnCost {
    connectionId?: string;
    costUnavailable?: boolean;
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
    costUnavailable?: boolean;
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

export const MAX_TRACKED_SESSIONS = 10;
const SESSION_COSTS_KEY = 'sessionCosts';
const PARENT_SESSION_KEY = 'parentSession';

/**
 * A strictly increasing recency stamp, in milliseconds.
 *
 * `Date.now()` alone is not enough: several sessions can be recorded inside the
 * same millisecond (tests, or a burst of tool rounds), and equal stamps make the
 * cap's ordering fall back to insertion order — which evicts the *newest* and
 * keeps stale sessions. Bumping past the previous value guarantees a total order
 * while staying a usable timestamp.
 */
function stamp(ledger: SpendLedger): number {
    ledger.lastStamp = Math.max(Date.now(), ledger.lastStamp + 1);
    return ledger.lastStamp;
}

function trimToCap(ledger: SpendLedger): void {
    if (ledger.sessionCosts.size <= MAX_TRACKED_SESSIONS) {
        return;
    }
    // The unattributed bucket is not a chat and must not be evicted by chat
    // churn, so it keeps its slot and the chat entries share what is left.
    const unattributedBucket = ledger.sessionCosts.get(UNATTRIBUTED_SESSION_ID);
    const keep = [...ledger.sessionCosts.values()]
        .filter(session => session.sessionId !== UNATTRIBUTED_SESSION_ID)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_TRACKED_SESSIONS - (unattributedBucket ? 1 : 0));
    ledger.sessionCosts.clear();
    for (const session of keep) {
        ledger.sessionCosts.set(session.sessionId, session);
    }
    if (unattributedBucket) {
        ledger.sessionCosts.set(UNATTRIBUTED_SESSION_ID, unattributedBucket);
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
export function hydrateSessionCosts(
    sessions: SessionCost[] | undefined, ledger: SpendLedger = defaultLedger
): void {
    for (const session of sessions ?? []) {
        if (
            session &&
            typeof session.sessionId === 'string' &&
            // Only real chat sessions (and the shared unattributed bucket) are
            // restored. Entries persisted by an earlier revision for unidentified
            // calls carry a bare per-window UUID; those are now attributed to
            // their parent or the bucket, so they are dropped.
            (session.sessionId.startsWith(SESSION_ID_PREFIX) || session.sessionId === UNATTRIBUTED_SESSION_ID) &&
            Number.isFinite(session.paid) &&
            (session.paid > 0 || (ledger !== defaultLedger && session.paid === 0
                && Number.isFinite(session.calls) && session.calls > 0)) &&
            !ledger.sessionCosts.has(session.sessionId)
        ) {
            const raw = session as unknown as Record<string, unknown>;
            const rawRoutes: unknown[] = Array.isArray(raw.routes) ? raw.routes : [];
            const routes = rawRoutes
                .filter((route): route is Record<string, unknown> =>
                    typeof route === 'object' && route !== null && !Array.isArray(route)
                )
                .map((route): CostRoute => ({
                    ...restoredBucket(route),
                    provider: typeof route.provider === 'string' ? route.provider : 'unknown',
                    model: typeof route.model === 'string' ? route.model : '',
                    byok: route.byok === true,
                    updatedAt: finiteNumber(route.updatedAt) ?? 0,
                }));
            ledger.sessionCosts.set(session.sessionId, {
                ...session,
                ...restoredBucket(raw),
                byok: session.byok === true,
                updatedAt: finiteNumber(raw.updatedAt) ?? 0,
                routes,
            });
        }
    }
    trimToCap(ledger);
}

export function resetSessionCostsForTesting(): void {
    const ledger = defaultLedger;
    ledger.sessionCosts.clear();
}

function newBucket(): CostBucket {
    return { paid: 0, openRouter: 0, upstream: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, calls: 0 };
}

/** Restore a persisted bucket, substituting zero for missing or corrupted fields. */
function restoredBucket(raw: Record<string, unknown>): CostBucket {
    return {
        ...(raw.costUnavailable === true ? { costUnavailable: true } : {}),
        paid: Math.max(0, finiteNumber(raw.paid) ?? 0),
        openRouter: Math.max(0, finiteNumber(raw.openRouter) ?? 0),
        upstream: Math.max(0, finiteNumber(raw.upstream) ?? 0),
        promptTokens: Math.max(0, finiteNumber(raw.promptTokens) ?? 0),
        completionTokens: Math.max(0, finiteNumber(raw.completionTokens) ?? 0),
        cachedTokens: Math.max(0, finiteNumber(raw.cachedTokens) ?? 0),
        calls: Math.max(0, finiteNumber(raw.calls) ?? 0),
    };
}

function addToBucket(bucket: CostBucket, cost: TurnCost): void {
    if (cost.costUnavailable) { bucket.costUnavailable = true; }
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
 *  Generic connections also keep token-only calls and mark an unavailable cost;
 *  legacy callers retain the payable-cost-only behavior. */
export function accumulateSessionCost(
    sessionId: string,
    usage: unknown,
    provider?: string,
    model?: string,
    ledger: SpendLedger = defaultLedger,
    connectionId?: string,
    includeTokenOnlyUsage = false
): SessionCost | undefined {
    // An empty key means "no bucket at all" — `resolveCostSession` never returns
    // one, so this only guards a bad direct call.
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        return undefined;
    }
    let cost = turnCostOf(usage, provider);
    if (!cost && includeTokenOnlyUsage && usage && typeof usage === 'object' && !Array.isArray(usage)) {
        const raw = usage as Record<string, unknown>;
        const promptTokens = finiteNumber(raw.prompt_tokens);
        const completionTokens = finiteNumber(raw.completion_tokens);
        const amount = finiteNumber(raw.cost);
        const details = raw.cost_details && typeof raw.cost_details === 'object'
            ? raw.cost_details as Record<string, unknown> : {};
        const upstream = finiteNumber(details.upstream_inference_cost);
        const reportedCost = (amount !== undefined && amount >= 0) || (upstream !== undefined && upstream >= 0);
        const tokenDetails = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object'
            ? raw.prompt_tokens_details as Record<string, unknown> : {};
        if (promptTokens !== undefined || completionTokens !== undefined || reportedCost) {
            cost = {
                openRouter: 0, isByok: raw.is_byok === true, provider,
                promptTokens: Math.max(0, promptTokens ?? 0), completionTokens: Math.max(0, completionTokens ?? 0),
                cachedTokens: Math.max(0, finiteNumber(tokenDetails.cached_tokens) ?? 0),
                ...(!reportedCost ? { costUnavailable: true } : {}),
            };
        }
    }
    if (!cost) { return undefined; }
    const now = stamp(ledger);
    const session = ledger.sessionCosts.get(sessionId) ?? {
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

    ledger.sessionCosts.set(sessionId, session);

    // Bound the map: keep only the most recently updated sessions.
    trimToCap(ledger);
    ledger.persistSessionCosts?.(getSessionCosts(ledger));
    turnCostEmitter.fire({ ...cost, ...(connectionId ? { connectionId } : {}) });
    return snapshotSession(session);
}

function snapshotSession(session: SessionCost): SessionCost {
    return { ...session, routes: session.routes.map(r => ({ ...r })) };
}

/** Every tracked session's running total, most recent first. */
export function getSessionCosts(ledger: SpendLedger = defaultLedger): SessionCost[] {
    return [...ledger.sessionCosts.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(snapshotSession);
}

/** The session's running total, or `undefined` if it has spent nothing yet. */
export function getSessionCost(sessionId: string, ledger: SpendLedger = defaultLedger): SessionCost | undefined {
    const found = ledger.sessionCosts.get(sessionId);
    return found ? snapshotSession(found) : undefined;
}

/** Bare cache-rate percentage, e.g. `82.3%`; `undefined` when the bucket saw no
 *  prompt tokens, so the figure is never a misleading `0.0%`. */
export function cacheSharePercent(bucket: { promptTokens: number; cachedTokens: number }): string | undefined {
    if (!(bucket.promptTokens > 0)) {
        return undefined;
    }
    return `${((bucket.cachedTokens / bucket.promptTokens) * 100).toFixed(1)}%`;
}

/** Share of a bucket's prompt tokens served from cache, e.g. `82.3% cached`. */
export function cacheShareText(bucket: { promptTokens: number; cachedTokens: number }): string | undefined {
    const percent = cacheSharePercent(bucket);
    return percent ? t('{0} cached', percent) : undefined;
}

/** `cacheShareText` with its inline separator, e.g. ` · 82.3% cached`; empty
 *  when there is no rate to show. */
export function cacheShareSuffix(bucket: { promptTokens: number; cachedTokens: number }): string {
    const text = cacheShareText(bucket);
    return text ? ` \u00b7 ${text}` : '';
}

/** One route's row cells. The cache rate is per route, not per session:
 *  switching models mid-chat splits the session into several routes whose cache
 *  behavior differs, so a blended figure would hide the good or bad one. */
export interface CostRouteCells {
    cost: string;
    /** Provider name, marked `(BYOK)` when the route's stored billing came from
     *  the user's own key rather than OpenRouter's credit pool. */
    provider: string;
    /** Model slug, or `undefined` when the call did not report one. */
    model?: string;
    calls: string;
    /** Bare rate, e.g. `82.3%` — the `Cached` column header supplies the word.
     *  `undefined` when no prompt tokens were reported. */
    cached?: string;
}

export function costAmountText(bucket: Pick<CostBucket, 'paid' | 'costUnavailable'>): string {
    if (bucket.costUnavailable) {
        return bucket.paid > 0 ? t('{0} + unavailable', formatUsdPrecise(bucket.paid)) : t('Unavailable');
    }
    return formatUsdPrecise(bucket.paid);
}

export function routeCostCells(route: CostRoute): CostRouteCells {
    const providerName = route.provider === 'unknown' ? t('unknown') : route.provider;
    return {
        cost: costAmountText(route),
        provider: route.byok ? t('{0} (BYOK)', providerName) : providerName,
        model: route.model || undefined,
        calls: String(route.calls),
        cached: cacheSharePercent(route),
    };
}

function reportUsagePart(progress: vscode.Progress<ResponsePart>, usage: unknown): void {
    const part = buildUsagePart(usage);
    if (part) {
        progress.report(
            new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(part)), USAGE_MIME)
        );
    }
}

let requestDumpDirectory: string | undefined;

export function setRequestDumpDirectory(directory: string | undefined): void {
    requestDumpDirectory = directory;
}

function dumpRequestBody(body: unknown): void {
    if (!requestDumpDirectory || process.env.OPENROUTER_RC_DEBUG !== '1') return;
    try {
        fs.mkdirSync(requestDumpDirectory, { recursive: true, mode: 0o700 });
        const file = path.join(requestDumpDirectory, 'openrouter-requests.jsonl');
        const existing = fs.lstatSync(file, { throwIfNoEntry: false });
        if (existing && (!existing.isFile() || existing.nlink !== 1)) return;
        const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fs.constants;
        const fd = fs.openSync(file, O_WRONLY | O_APPEND | O_CREAT | (O_NOFOLLOW ?? 0), 0o600);
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== 'win32' && (stat.mode & 0o077))) return;
            fs.appendFileSync(fd, `${JSON.stringify(body)}\n`);
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return;
    }
}

function isRetryable(status: number): boolean {
    return status === 429 || status >= 500;
}

function jitteredDelay(baseMs: number): number {
    const jitter = Math.round(baseMs * (Math.random() - 0.5) * 0.4);
    return Math.min(Math.max(baseMs + jitter, 0), MAX_BACKOFF_MS);
}

/** The backoff table entry for an attempt, clamped to the last delay so an
 *  attempt past the table never yields `undefined` (and thus a NaN delay). */
export function retryBaseDelayMs(attempt: number): number {
    return RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), RETRY_DELAYS_MS.length - 1)];
}

/**
 * A redirect away from HTTPS is never accepted: the key travels on every
 * request, so an http final URL means the credential may have been exposed.
 */
function assertSecureResponse(response: Response): void {
    const finalUrl = typeof response.url === 'string' ? response.url : '';
    if (finalUrl !== '' && !/^https:/i.test(finalUrl)) {
        throw new Error(t('OpenRouter: blocked insecure redirect.'));
    }
}

/**
 * A fetch signal bounded by the caller's cancellation token and a fixed
 * timeout. Uses `AbortSignal.any`/`AbortSignal.timeout` when the runtime has
 * them, wiring both into one controller otherwise.
 */
function boundedFetchSignal(token: vscode.CancellationToken): { signal: AbortSignal; dispose(): void } {
    const controller = new AbortController();
    const subscription = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) {
        controller.abort();
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let signal: AbortSignal = controller.signal;
    const timeoutFactory = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout;
    const anyFactory = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
    if (typeof timeoutFactory === 'function' && typeof anyFactory === 'function') {
        signal = anyFactory([controller.signal, timeoutFactory(FETCH_TIMEOUT_MS)]);
    } else {
        timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    }
    return {
        signal,
        dispose: () => {
            if (timeoutId !== undefined) {
                clearTimeout(timeoutId);
            }
            subscription.dispose();
        },
    };
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
        try {
            response = await fetch(url, { ...init, redirect: 'error' });
        } catch {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            if (init.signal?.aborted || attempt >= MAX_RETRIES) {
                throw new Error(t('OpenRouter request failed.'));
            }
        }
        if (response !== undefined) {
            if (/^https:/i.test(url)) {
                assertSecureResponse(response);
            }
            if (!isRetryable(response.status) || attempt >= MAX_RETRIES) {
                return response;
            }
            await discardBody(response);
        }
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        await delayFn(jitteredDelay(retryBaseDelayMs(attempt)));
        attempt += 1;
    }
}

async function discardBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch {
        // Discarding an error response must not expose its transport error.
    }
}

async function throwIfNotOk(response: Response): Promise<void> {
    if (response.ok) {
        return;
    }
    await discardBody(response);
    throw mapResponseError(response.status, response.headers.get('x-generation-id') ?? undefined);
}

function generationSuffix(generationId?: string): string {
    return generationId && /^gen-\d{10}-[A-Za-z0-9]{1,64}$/.test(generationId)
        ? t(' [generation {0}]', generationId) : '';
}

function isHttpErrorStatus(status: unknown): status is number {
    return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600;
}

export function mapResponseError(status: number, generationId?: string): Error {
    let message: string;
    if (status === 401) {
        message = t('OpenRouter rejected your API key (401): it is invalid or expired. Paste a fresh key in the OpenRouter panel.');
    } else if (status === 402) {
        message = t('OpenRouter: not enough credits (402). Check your balance in the status bar or the usage dashboard.');
    } else if (status === 429) {
        message = t('OpenRouter: rate limited (429) after retries. Try again in a moment.');
    } else if (isHttpErrorStatus(status)) {
        message = t('OpenRouter request failed ({0}).', status);
    } else {
        message = t('OpenRouter request failed.');
    }
    message += generationSuffix(generationId);
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
    const { code } = raw as { code?: unknown };
    const status = typeof code === 'string' && /^[45]\d\d$/.test(code) ? Number(code) : code;
    if (isHttpErrorStatus(status)) {
        return mapResponseError(status, generationId);
    }
    const text = t('OpenRouter stream error.') + generationSuffix(generationId);
    const codeText = typeof code === 'string' ? code.toLowerCase() : '';
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
    sessionId?: string,
    requireToolCall?: boolean,
    openRouter = true
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        ...(template ?? {}),
        model: modelId,
        messages,
        tools,
        stream: true,
    };
    delete body.prompt;
    if (Array.isArray(body.tools) && body.tools.length === 0) {
        delete body.tools;
    }
    if (openRouter) {
        delete body.session_id;
    }
    if (openRouter && typeof sessionId === 'string' && sessionId.trim() !== '') {
        body.session_id = sessionId;
    }
    // Copilot's toolMode is an obligation on the provider. Auto (the default) needs
    // nothing; Required must force a tool call, but a pasted template tool_choice
    // stays the escape hatch and wins.
    if (requireToolCall === true && !('tool_choice' in body)) {
        body.tool_choice = 'required';
    }
    if (presetSlugFromModelId(modelId) !== undefined) {
        delete body.preset;
    }
    const effort = openRouter ? effortFromModelConfiguration(modelConfiguration) : undefined;
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
    if (openRouter) {
        mergeReasoningConfig(body, 'enabled', enabledFromModelConfiguration(modelConfiguration));
    }
    const cacheId = cacheModelId ?? modelId;
    if (openRouter && cacheId.replace(/^~/, '').split('/')[0] === 'anthropic' && !('cache_control' in body)) {
        body.cache_control = { type: 'ephemeral' };
    }
    return body;
}

function validGatewayCatalog(data: unknown[]): data is ModelCatalogEntry[] {
    const record = (value: unknown): value is Record<string, unknown> =>
        value !== null && typeof value === 'object' && !Array.isArray(value);
    const strings = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string');
    const optional = (value: unknown, valid: (item: unknown) => boolean): boolean => value == null || valid(value);
    const tokenLimit = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const ids = new Set<string>();
    return data.every(entry => {
        if (!record(entry) || typeof entry.id !== 'string' || !entry.id.trim() || entry.id !== entry.id.trim()
            || ids.has(entry.id)) { return false; }
        ids.add(entry.id);
        if (!optional(entry.name, value => typeof value === 'string')
            || !optional(entry.context_length, tokenLimit)
            || !optional(entry.supported_parameters, strings)
            || !optional(entry.supports_tool_parameters, value => typeof value === 'boolean')) { return false; }
        for (const field of ['architecture', 'top_provider', 'pricing', 'reasoning']) {
            if (!optional(entry[field], record)) { return false; }
        }
        const architecture = entry.architecture as Record<string, unknown> | undefined;
        const top = entry.top_provider as Record<string, unknown> | undefined;
        const reasoning = entry.reasoning as Record<string, unknown> | undefined;
        const pricing = entry.pricing as Record<string, unknown> | undefined;
        return optional(architecture?.input_modalities, strings) && optional(architecture?.output_modalities, strings)
            && optional(top?.context_length, tokenLimit) && optional(top?.max_completion_tokens, tokenLimit)
            && optional(reasoning?.supported_efforts, strings)
            && optional(pricing?.overrides, value => Array.isArray(value) && value.every(record));
    });
}

export interface ProviderRuntimeConfig {
    connectionId?: string;
    baseUrl?: string;
    kind?: ConnectionKind;
    hideUnavailableModels?: boolean;
    manualModels?: ManualModel[];
    accounting?: OpenRouterChatProvider;
    isCurrent?: () => boolean;
    readKey?: () => Promise<string | undefined>;
}

interface ChatModelInfo extends vscode.LanguageModelChatInformation {
    configurationSchema?: { properties: Record<string, unknown> };
}

export class OpenRouterChatProvider implements vscode.LanguageModelChatProvider {
    private cachedInfo: ChatModelInfo[] | undefined;
    private cachedCatalog: ModelCatalogEntry[] | undefined;
    private readonly genericAssumptions = new WeakMap<ModelCatalogEntry, string[]>();
    private catalogPromise: Promise<ModelCatalogEntry[]> | undefined;
    private cachedAvailableIds: Set<string> | undefined;
    private availableCacheKey: string | undefined;
    private availablePromise: Promise<Set<string> | undefined> | undefined;
    private availablePromiseKey: string | undefined;
    private cachedPresets: PresetSummary[] | undefined;
    private presetsPromise: Promise<PresetSummary[] | undefined> | undefined;
    private presetsPromiseKey: string | undefined;
    private readonly presetConfigs = new Map<string, Record<string, unknown>>();
    private readonly presetConfigPromises = new Map<string, Promise<Record<string, unknown> | undefined>>();
    private cacheGeneration = 0;
    private key: string | undefined;
    private template: Record<string, unknown> | undefined;
    private readonly infoChangeEvent = new vscode.EventEmitter<void>();
    private contextCapQueue: Promise<void> = Promise.resolve();
    private readonly ledger: SpendLedger;

    readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this.infoChangeEvent.event;

    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly state: vscode.Memento,
        private readonly runtime: ProviderRuntimeConfig = {}
    ) {
        this.ledger = runtime.accounting?.ledger ?? (runtime.connectionId ? createSpendLedger() : defaultLedger);
        // Production connections own their ledger; the default ledger preserves
        // the exported accounting helpers used by legacy callers and tests.
        hydrateSessionCosts(this.state.get<SessionCost[]>(SESSION_COSTS_KEY), this.ledger);
        hydrateParentAttribution(this.state.get<{ sessionId: string; at: number }>(PARENT_SESSION_KEY), this.ledger);
        this.migrateLegacyContextCaps();
        this.ledger.persistSessionCosts = (snapshot) => {
            const value = snapshot.length === 0 ? undefined : snapshot;
            this.ledger.persistQueue = this.ledger.persistQueue
                .then(() => this.state.update(SESSION_COSTS_KEY, value))
                .catch(() => undefined);
        };
        this.ledger.persistParentSession = (sessionId, at) => {
            this.ledger.persistQueue = this.ledger.persistQueue
                .then(() => this.state.update(PARENT_SESSION_KEY, { sessionId, at }))
                .catch(() => undefined);
        };
    }

    getSessionCosts(): SessionCost[] {
        return getSessionCosts(this.ledger);
    }

    private get isDirectOpenRouter(): boolean {
        return this.runtime.kind === undefined || this.runtime.kind === 'openrouter';
    }

    private get isGateway(): boolean {
        return this.runtime.kind === 'gateway';
    }

    private get supportsOpenRouterRequestFields(): boolean {
        return this.isDirectOpenRouter || this.isGateway;
    }

    private get baseUrl(): string {
        if (this.isGateway && !this.runtime.baseUrl) {
            throw new Error('A gateway API base URL is required.');
        }
        return (this.runtime.baseUrl ?? OPENROUTER_API_BASE_URL).replace(/\/+$/, '');
    }

    private get hideUnavailable(): boolean {
        return this.isDirectOpenRouter && (this.runtime.hideUnavailableModels ?? hideUnavailableModelsEnabled());
    }

    private headers(key: string | undefined): Record<string, string> {
        assertConnectionCredential(this.runtime.kind, key);
        return key ? { Authorization: `Bearer ${key}` } : {};
    }

    dispose(): void {
        this.invalidateCatalogCaches();
        this.infoChangeEvent.dispose();
    }

    /**
     * One-time upgrade from the retired margin-based context policy: caps were
     * persisted margin-reduced (`contextCaps`), with the gross user choice in
     * `contextCapsBase`. Restore the gross choice so a saved budget survives,
     * then drop both retired keys.
     */
    private migrateLegacyContextCaps(): void {
        try {
            const base = this.state.get<Record<string, number>>(LEGACY_CONTEXT_CAPS_BASE_KEY);
            const margin = this.state.get<number>(LEGACY_CONTEXT_MARGIN_KEY, 0);
            if (!base && !margin) {
                return;
            }
            const factor = 1 - Math.min(50, Math.max(0, margin)) / 100;
            const caps = { ...this.getContextCaps() };
            for (const [modelId, value] of Object.entries(caps)) {
                if (typeof value !== 'number' || !(value > 0)) {
                    continue;
                }
                const stored = base?.[modelId];
                const gross = typeof stored === 'number' && stored > 0
                    ? stored
                    : margin > 0
                        ? Math.max(1, Math.round(value / factor))
                        : value;
                caps[modelId] = Math.floor(gross);
            }
            void this.state.update(CONTEXT_CAPS_KEY, Object.keys(caps).length > 0 ? caps : undefined);
            void this.state.update(LEGACY_CONTEXT_CAPS_BASE_KEY, undefined);
            void this.state.update(LEGACY_CONTEXT_MARGIN_KEY, undefined);
        } catch {
            // A state read failure must never block activation.
        }
    }

    async setKey(value: string): Promise<void> {
        assertConnectionCredential(this.runtime.kind, value);
        this.key = value;
        this.invalidateCatalogCaches();
        await storeKey(this.secrets, value);
        this.infoChangeEvent.fire();
    }

    async clearKey(): Promise<void> {
        this.key = undefined;
        this.invalidateCatalogCaches();
        await clearStoredKey(this.secrets);
        this.infoChangeEvent.fire();
    }

    resetCatalogCache(): void {
        this.invalidateCatalogCaches();
        this.infoChangeEvent.fire();
    }

    /**
     * Bump the cache generation and drop every cached view of the account's
     * catalog. The generation makes an in-flight request from the old key
     * unable to repopulate any of these caches after the switch.
     */
    private invalidateCatalogCaches(): void {
        this.cacheGeneration += 1;
        this.cachedInfo = undefined;
        this.cachedCatalog = undefined;
        this.catalogPromise = undefined;
        this.cachedAvailableIds = undefined;
        this.availableCacheKey = undefined;
        this.availablePromise = undefined;
        this.availablePromiseKey = undefined;
        this.cachedPresets = undefined;
        this.presetsPromise = undefined;
        this.presetsPromiseKey = undefined;
        this.presetConfigs.clear();
        this.presetConfigPromises.clear();
    }

    /**
     * Re-report the picker's model information after a settings change that
     * alters the computed budgets (the output-reserve policy). The catalog cache
     * is kept; only the information derived from it is rebuilt.
     */
    refreshModelInfo(): void {
        this.cachedInfo = undefined;
        this.infoChangeEvent.fire();
    }

    getContextCaps(): Record<string, ContextCapValue> {
        const value = this.state.get<Record<string, ContextCapValue>>(CONTEXT_CAPS_KEY);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    async setContextCap(modelId: string, value: ContextCapValue | null): Promise<void> {
        this.contextCapQueue = this.contextCapQueue.then(async () => {
            const caps = { ...this.getContextCaps() };
            if (value === 'full') {
                caps[modelId] = 'full';
            } else if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                const model = (this.cachedCatalog ?? []).find((entry) => entry.id === modelId);
                const fullCap = model
                    ? effectiveMaxInputTokens(model, { outputReserve: outputReservePolicy() })
                    : undefined;
                caps[modelId] =
                    fullCap !== undefined ? Math.max(1, Math.min(Math.floor(value), fullCap)) : Math.floor(value);
            } else {
                delete caps[modelId];
            }
            this.cachedInfo = undefined;
            await this.state.update(CONTEXT_CAPS_KEY, Object.keys(caps).length > 0 ? caps : undefined);
            this.infoChangeEvent.fire();
        }).catch(() => undefined);
        return this.contextCapQueue;
    }

    /**
     * Apply a Context size chosen in the model picker. The picker value is the
     * prompt budget itself (Copilot adds the output reserve on top), so it is
     * persisted verbatim to the same cap store the panel uses. VS Code delivers the
     * per-model picker value only on the request (`options.modelConfiguration`),
     * never to `provideLanguageModelChatInformation`, so the choice is persisted and
     * the model information refreshed; the new budget applies from the next turn.
     */
    private applyPickerContextCap(modelId: string, choice: unknown): void {
        if (modelId.startsWith(PRESET_ID_PREFIX)) {
            return;
        }
        const parsed = contextCapFromPicker(choice);
        let value: number | 'full' | null;
        if (parsed === undefined) {
            value = null;
        } else if (parsed === 'full') {
            value = 'full';
        } else {
            value = Math.max(1, Math.round(parsed));
        }
        const current = this.getContextCaps()[modelId];
        const same = value === null ? current === undefined : current === value;
        if (!same) {
            void this.setContextCap(modelId, value);
        }
    }

    contextBudgetFor(modelId: string): ContextBudgetOptions {
        const outputReserve = outputReservePolicy();
        const stored = this.getContextCaps()[modelId];
        if (typeof stored === 'number') {
            return { overrideTokens: stored, outputReserve };
        }
        if (stored === 'full') {
            return { outputReserve };
        }
        const model = (this.cachedCatalog ?? []).find((entry) => entry.id === modelId);
        if (!model) {
            return { outputReserve };
        }
        const fallback = defaultContextCap(model, outputReserve);
        return typeof fallback === 'number' ? { overrideTokens: fallback, outputReserve } : { outputReserve };
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
            return { ok: false, error: t('The pasted text is not valid JSON.') };
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { ok: false, error: t('The template must be a JSON object (a request body).') };
        }
        const body = parsed as Record<string, unknown>;
        const { messages, prompt, model, tools, stream, ...params } = body;
        if (this.supportsOpenRouterRequestFields) {
            delete params.session_id;
        }
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
            assertConnectionCredential(this.runtime.kind, this.key);
            return this.key;
        }
        const generation = this.cacheGeneration;
        const stored = this.runtime.readKey ? await this.runtime.readKey() : await readKey(this.secrets);
        assertConnectionCredential(this.runtime.kind, stored);
        if (stored) {
            if (generation === this.cacheGeneration) { this.key = stored; }
            return stored;
        }
        if (silent || !this.isDirectOpenRouter) {
            return undefined;
        }
        const value = await vscode.window.showInputBox({
            prompt: t('Paste your OpenRouter key (sk-or-...)'),
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
        const generation = this.cacheGeneration;
        const key = await this.getKey(options.silent);
        if (this.isGateway && generation !== this.cacheGeneration) { return []; }
        if (!key && this.isDirectOpenRouter) {
            return [];
        }
        const models = await this.ensureCatalog(key ?? '', token);
        const visible = await this.resolveVisibleCatalog(key ?? '', models, token, generation);
        const stale = generation !== this.cacheGeneration;
        if (!stale) {
            this.cachedCatalog = visible;
        }
        const info = visible.map(m => this.toInfo(m));
        if (stale) {
            return this.isGateway ? [] : info;
        }
        this.cachedInfo = info;
        if (!this.isDirectOpenRouter) {
            return info;
        }
        if (this.cachedPresets) {
            this.appendPresetEntries(info, models);
            return info;
        }
        void this.attachPresets(key ?? '', models, info, generation);
        return info;
    }

    /**
     * Intersect the public catalog with the account's available models when the
     * setting is on. Availability is best-effort: any failure (network, non-OK,
     * empty or disjoint list) leaves the full catalog visible rather than hiding
     * every model behind a bad query.
     */
    private async resolveVisibleCatalog(
        key: string,
        models: ModelCatalogEntry[],
        token: vscode.CancellationToken,
        generation: number
    ): Promise<ModelCatalogEntry[]> {
        if (!this.hideUnavailable) {
            return models;
        }
        let available: Set<string> | undefined;
        if (this.cachedAvailableIds && this.availableCacheKey === key) {
            available = this.cachedAvailableIds;
        } else {
            try {
                available = await this.ensureAvailableIds(key, token);
            } catch (err) {
                if (err instanceof vscode.CancellationError) {
                    throw err;
                }
                return models;
            }
        }
        if (!available || available.size === 0) {
            return models;
        }
        const visible = models.filter((m) => this.isAvailableModelId(m.id, available as Set<string>));
        if (visible.length === 0) {
            return models;
        }
        if (generation === this.cacheGeneration) {
            this.cachedAvailableIds = available;
            this.availableCacheKey = key;
        }
        return visible;
    }

    private isAvailableModelId(id: string, ids: Set<string>): boolean {
        if (ids.has(id)) {
            return true;
        }
        const colon = id.indexOf(':');
        return colon > 0 && ids.has(id.slice(0, colon));
    }

    /**
     * A preset's designated model may be datestamped (e.g. `-20260826`) while the
     * availability list carries the undated slug, so try the same date aliases
     * `resolvePresetBase` accepts before deciding a pinned preset is unavailable.
     */
    private presetModelAvailable(model: string): boolean {
        const ids = this.cachedAvailableIds;
        if (!ids || ids.size === 0) {
            return true;
        }
        for (const candidate of modelIdAliases(model)) {
            if (this.isAvailableModelId(candidate, ids)) {
                return true;
            }
        }
        return false;
    }

    private ensureAvailableIds(key: string, token: vscode.CancellationToken): Promise<Set<string> | undefined> {
        const existing = this.availablePromise;
        if (existing && this.availablePromiseKey === key) {
            return existing;
        }
        const promise = this.fetchAvailableIds(key, token).finally(() => {
            if (this.availablePromise === promise) {
                this.availablePromise = undefined;
                this.availablePromiseKey = undefined;
            }
        });
        this.availablePromise = promise;
        this.availablePromiseKey = key;
        return promise;
    }

    private async fetchAvailableIds(key: string, token: vscode.CancellationToken): Promise<Set<string> | undefined> {
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        const bounded = boundedFetchSignal(token);
        try {
            const response = await fetch(`${this.baseUrl}/models/user?output_modalities=all`, {
                headers: this.headers(key),
                signal: bounded.signal,
                redirect: 'error',
            });
            assertSecureResponse(response);
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            if (!response.ok) {
                return undefined;
            }
            const json = (await response.json()) as { data?: Array<{ id?: unknown }> };
            const ids = new Set<string>();
            for (const entry of json.data ?? []) {
                if (entry && typeof entry.id === 'string' && entry.id.trim() !== '') {
                    ids.add(entry.id);
                }
            }
            return ids.size > 0 ? ids : undefined;
        } catch (err) {
            if (err instanceof vscode.CancellationError || token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }
            return undefined;
        } finally {
            bounded.dispose();
        }
    }

    private ensureCatalog(key: string, token: vscode.CancellationToken): Promise<ModelCatalogEntry[]> {
        if (this.cachedCatalog) {
            return Promise.resolve(this.cachedCatalog);
        }
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
        snapshot: ChatModelInfo[],
        generation: number
    ): Promise<void> {
        try {
            const presets = await this.ensurePresets(key);
            if (presets === undefined || this.cachedInfo !== snapshot || generation !== this.cacheGeneration) {
                return;
            }
            this.cachedPresets = presets;
            const entries = presets
                .map(p => this.toPresetInfo(p, models))
                .filter((e): e is ChatModelInfo => e !== undefined);
            if (entries.length === 0 || this.cachedInfo !== snapshot || generation !== this.cacheGeneration) {
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
        const generation = this.cacheGeneration;
        const template = structuredClone((await this.getTemplate()) ?? {});
        const key = await this.getKey(true);
        if (this.runtime.isCurrent && !this.runtime.isCurrent()) {
            throw vscode.LanguageModelError.NotFound('This connection changed while preparing the request. Select it again.');
        }
        if (!key && this.isDirectOpenRouter) {
            throw vscode.LanguageModelError.NoPermissions(
                t('OpenRouter key not configured. Run "OpenRouter: Manage provider".')
            );
        }

        if (this.isGateway) {
            if (generation !== this.cacheGeneration) {
                throw vscode.LanguageModelError.NotFound('This connection changed while preparing the request. Select it again.');
            }
            const catalog = await this.ensureCatalog(key ?? '', token);
            if (generation !== this.cacheGeneration || (this.runtime.isCurrent && !this.runtime.isCurrent())
                || !catalog.some(entry => entry.id === model.id)) {
                throw vscode.LanguageModelError.NotFound(t('This model is unavailable in the gateway catalog. Select it again.'));
            }
        }

        const modelConfiguration = (
            options as { modelConfiguration?: { readonly [key: string]: unknown } }
        ).modelConfiguration;
        if (modelConfiguration && 'contextSize' in modelConfiguration) {
            this.applyPickerContextCap(model.id, modelConfiguration.contextSize);
        }
        const conversationId = (options.modelOptions as { _conversationId?: unknown } | undefined)?._conversationId;
        const hasConversationId = typeof conversationId === 'string' && conversationId.trim() !== '';
        // Attribute the call to the chat that owns it: the chat itself for a turn,
        // or the last active chat for an internal (sub-agent / utility) call, so
        // OpenRouter's Sessions view agrees with the panel. A call that did not come
        // through the Copilot harness at all (an agent-host / SDK session, whose
        // client-BYOK bridge carries no chat id) goes to the unattributed cost
        // bucket and sends no `session_id`, so it is neither blamed on an unrelated
        // chat nor able to mint an orphan OpenRouter session.
        const harnessOwned = isHarnessOwnedModelOptions(options.modelOptions);
        const costKey = resolveCostSession(
            sessionIdFor(conversationId) ?? '',
            hasConversationId,
            Date.now(),
            harnessOwned,
            this.ledger
        );
        const sessionId = costKey === UNATTRIBUTED_SESSION_ID ? undefined : costKey;
        const presetSlug = this.isDirectOpenRouter ? presetSlugFromModelId(model.id) : undefined;
        const presetModel = presetSlug !== undefined ? presetModelOf(this.presetConfigs.get(presetSlug)) : undefined;
        const recordedModel =
            presetModel !== undefined
                ? this.resolvePresetBase(presetModel, this.cachedCatalog ?? [])?.id ?? presetModel
                : model.id;
        const requireToolCall = options.toolMode === vscode.LanguageModelChatToolMode.Required;
        const body = buildRequestBody(
            template,
            model.id,
            toOpenAI(messages).map(message => {
                if (this.supportsOpenRouterRequestFields || !message || typeof message !== 'object') { return message; }
                const { reasoning_content, ...common } = message as Record<string, unknown>;
                return reasoning_content === '' ? common : message;
            }),
            options.tools?.map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema ?? { type: 'object', properties: {} },
                },
            })),
            modelConfiguration,
            presetModel,
            sessionId,
            requireToolCall,
            this.supportsOpenRouterRequestFields
        );

        lastStreamUsage = undefined;
        lastStreamProvider = undefined;
        let usage: unknown;
        let provider: string | undefined;
        let usageAccounted = false;
        const accountUsage = (): void => {
            if (usage === undefined || usageAccounted) {
                return;
            }
            usageAccounted = true;
            reportUsagePart(progress, usage);
            accumulateSessionCost(
                costKey, usage, provider, recordedModel, this.ledger, this.runtime.connectionId, !this.isDirectOpenRouter
            );
        };
        const streamState = { reportedAnyPart: false, sawReasoning: false };
        const trackedProgress: vscode.Progress<ResponsePart> = {
            report: (part: ResponsePart) => {
                if (!(part instanceof vscode.LanguageModelDataPart)) {
                    streamState.reportedAnyPart = true;
                }
                progress.report(part);
            },
        };

        const controller = new AbortController();
        const abortListener = token.onCancellationRequested(() => controller.abort());
        const timeoutId = setTimeout(() => controller.abort(), postTimeoutMs);
        let stallTimer: ReturnType<typeof setTimeout> | undefined;
        let stallExpired = false;

        try {
            const headers = {
                'Content-Type': 'application/json',
                ...this.headers(key),
                ...(this.isDirectOpenRouter ? {
                    'HTTP-Referer': 'https://github.com/tianyu-liu/vscode-openrouter-copilot-request-credit',
                    'X-Title': 'OpenRouter for Copilot',
                } : {}),
            };
            const init = (payload: unknown): RequestInit => {
                dumpRequestBody(payload);
                return {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                };
            };
            let payload: Record<string, unknown> = body;
            let sanitizedRemoved = 0;
            if (sanitizeBase64Enabled()) {
                const cleaned = sanitizeRequestBody(body);
                payload = cleaned.body;
                sanitizedRemoved = cleaned.removed;
            }
            let response = await fetchWithRetry(`${this.baseUrl}/chat/completions`, init(payload), token);
            if (response.status === 403 && sanitizedRemoved === 0 && (await isGuardrailBlock(response))) {
                const cleaned = sanitizeRequestBody(body);
                if (cleaned.removed > 0) {
                    await discardBody(response);
                    trackedProgress.report(new vscode.LanguageModelTextPart(t(GUARDRAIL_RETRY_NOTICE)));
                    response = await fetchWithRetry(
                        `${this.baseUrl}/chat/completions`,
                        init(cleaned.body),
                        token
                    );
                }
            }
            clearTimeout(timeoutId);
            await throwIfNotOk(response);
            if (!response.body) {
                throw new Error(t('OpenRouter returned no response body.'));
            }

            const generationId = response.headers.get('x-generation-id') ?? undefined;
            const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            const finishTurn = (): void => {
                flushToolCalls(toolCalls, trackedProgress);
                accountUsage();
                lastStreamUsage = usage;
                lastStreamProvider = provider;
                finishStream(trackedProgress, streamState);
            };
            const readChunk = async (): Promise<{ done: boolean; value: Uint8Array | undefined }> => {
                stallExpired = false;
                stallTimer = setTimeout(() => {
                    stallExpired = true;
                    void reader.cancel().catch(() => undefined);
                    controller.abort();
                }, postTimeoutMs);
                try {
                    const result = await reader.read();
                    return { done: result.done, value: result.value };
                } catch {
                    throw new Error(t('OpenRouter stream error.') + generationSuffix(generationId));
                } finally {
                    if (stallTimer !== undefined) {
                        clearTimeout(stallTimer);
                        stallTimer = undefined;
                    }
                }
            };
            while (true) {
                if (token.isCancellationRequested) {
                    await reader.cancel();
                    throw new vscode.CancellationError();
                }
                const chunk = await readChunk();
                if (stallExpired) {
                    throw new Error(t('OpenRouter stopped sending data after {0} seconds.', postTimeoutMs / 1000));
                }
                if (chunk.done) {
                    finishTurn();
                    break;
                }
                buffer += decoder.decode(chunk.value, { stream: true });
                if (buffer.length > MAX_SSE_BUFFER_CHARS) {
                    throw new Error(t('OpenRouter: oversized SSE line in the stream response.'));
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
                        finishTurn();
                        return;
                    }
                    let json: any;
                    try {
                        json = JSON.parse(data);
                    } catch {
                        throw new Error(t('OpenRouter: malformed SSE data line in the stream response.'));
                    }
                    if (json.error !== undefined) {
                        throw mapStreamedError(json, generationId) ?? new Error(t('OpenRouter stream error.'));
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
                        trackedProgress.report(new vscode.LanguageModelTextPart(delta.content));
                    }
                    reportThinkingParts(delta, trackedProgress, streamState);
                    for (const tc of delta.tool_calls ?? []) {
                        accumulateToolCall(toolCalls, tc);
                    }
                    if (choice.finish_reason === 'tool_calls') {
                        flushToolCalls(toolCalls, trackedProgress);
                    }
                }
            }
        } catch (err) {
            accountUsage();
            if (token.isCancellationRequested && !(err instanceof vscode.CancellationError)) {
                throw new vscode.CancellationError();
            }
            if (controller.signal.aborted && !token.isCancellationRequested) {
                throw new Error(
                    stallExpired
                        ? t('OpenRouter stopped sending data after {0} seconds.', postTimeoutMs / 1000)
                        : t('OpenRouter did not respond within {0} seconds.', postTimeoutMs / 1000)
                );
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
            if (stallTimer !== undefined) {
                clearTimeout(stallTimer);
            }
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
        let chars = 0;
        let imageTokens = 0;
        for (const part of text.content) {
            chars += countedPartChars(part);
            imageTokens += countedImageTokens(part);
        }
        return Math.ceil(chars / 4) + imageTokens;
    }

    private async fetchCatalog(key: string, token: vscode.CancellationToken): Promise<ModelCatalogEntry[]> {
        const bounded = boundedFetchSignal(token);
        try {
            const response = await fetchWithRetry(
                `${this.baseUrl}/models`,
                { headers: this.headers(key), signal: bounded.signal },
                token
            );
            await throwIfNotOk(response);
            let json: { data?: unknown };
            try {
                json = (await response.json()) as { data?: unknown };
            } catch {
                throw new Error(t('OpenRouter /models returned an unexpected (non-JSON) response body.'));
            }
            if (!json || !Array.isArray(json.data)) {
                throw new Error(t('OpenRouter /models returned an unexpected response body (missing the data array).'));
            }
            if (this.isGateway && !validGatewayCatalog(json.data)) {
                throw new Error(t('Gateway /models returned an invalid filtered catalog.'));
            }
            const models = (json.data as ModelCatalogEntry[]).filter(m => m && typeof m.id === 'string');
            return this.isDirectOpenRouter ? models : this.genericCatalog(models, !this.isGateway);
        } catch (error) {
            if (this.runtime.kind === 'openai-compatible' && this.runtime.manualModels?.length
                && !token.isCancellationRequested) {
                return this.genericCatalog([]);
            }
            throw error;
        } finally {
            bounded.dispose();
        }
    }

    private genericCatalog(models: ModelCatalogEntry[], includeManualModels = true): ModelCatalogEntry[] {
        const merged = new Map(models.map(m => [m.id, m]));
        for (const manual of includeManualModels ? this.runtime.manualModels ?? [] : []) {
            const previous = merged.get(manual.id);
            merged.set(manual.id, {
                ...previous,
                id: manual.id,
                ...(manual.name !== undefined ? { name: manual.name } : {}),
                ...(manual.contextLength !== undefined ? { context_length: manual.contextLength } : {}),
                ...(manual.maxOutputTokens !== undefined ? {
                    top_provider: { ...previous?.top_provider, max_completion_tokens: manual.maxOutputTokens },
                } : {}),
                ...(manual.toolCalling !== undefined ? { supported_parameters: manual.toolCalling ? ['tools'] : [] } : {}),
                ...(manual.imageInput !== undefined ? {
                    architecture: {
                        ...previous?.architecture, input_modalities: manual.imageInput ? ['text', 'image'] : ['text'],
                    },
                } : {}),
            });
        }
        const positive = (value: unknown): number | undefined =>
            typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
        return [...merged.values()].map(m => {
            const context = positive(m.context_length) ?? positive(m.top_provider?.context_length);
            const output = positive(m.top_provider?.max_completion_tokens);
            const toolsKnown = Array.isArray(m.supported_parameters) || typeof m.supports_tool_parameters === 'boolean';
            const imagesKnown = Array.isArray(m.architecture?.input_modalities);
            const assumed = [
                ...(!context ? ['context'] : []), ...(!output ? ['output'] : []),
                ...(!toolsKnown ? ['tools'] : []), ...(!imagesKnown ? ['images'] : []),
            ];
            const normalized: ModelCatalogEntry = {
                ...m,
                context_length: context ?? 8192,
                architecture: {
                    ...m.architecture, input_modalities: imagesKnown ? m.architecture?.input_modalities : ['text'],
                },
                supports_tool_parameters: typeof m.supports_tool_parameters === 'boolean'
                    ? m.supports_tool_parameters : false,
                top_provider: { ...m.top_provider, max_completion_tokens: output ?? 2048 },
            };
            this.genericAssumptions.set(normalized, assumed);
            return normalized;
        });
    }

    async getPresets(): Promise<PresetSummary[] | undefined> {
        if (!this.isDirectOpenRouter || this.runtime.isCurrent?.() === false) { return []; }
        if (this.cachedPresets) {
            return this.cachedPresets;
        }
        const generation = this.cacheGeneration;
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
        if (presets === undefined || generation !== this.cacheGeneration) {
            return undefined;
        }
        if (!this.cachedPresets) {
            this.cachedPresets = presets;
        }
        return this.cachedPresets;
    }

    private ensurePresets(key: string): Promise<PresetSummary[] | undefined> {
        const existing = this.presetsPromise;
        if (existing && this.presetsPromiseKey === key) {
            return existing;
        }
        const cts = new vscode.CancellationTokenSource();
        const promise = this.fetchPresets(key, cts.token).finally(() => {
            cts.dispose();
            if (this.presetsPromise === promise) {
                this.presetsPromise = undefined;
                this.presetsPromiseKey = undefined;
            }
        });
        this.presetsPromise = promise;
        this.presetsPromiseKey = key;
        return promise;
    }

    private async fetchPresets(key: string, token: vscode.CancellationToken): Promise<PresetSummary[] | undefined> {
        if (this.runtime.isCurrent?.() === false) return undefined;
        const generation = this.cacheGeneration;
        const bounded = boundedFetchSignal(token);
        try {
            const response = await fetchWithRetry(
                `${this.baseUrl}/presets?limit=100`,
                { headers: this.headers(key), signal: bounded.signal },
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
                summary.model = presetModelOf(await this.fetchPresetConfig(key, summary.slug, token, generation));
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
        } finally {
            bounded.dispose();
        }
    }

    async getPresetConfig(slug: string): Promise<Record<string, unknown> | undefined> {
        if (!this.isDirectOpenRouter || this.runtime.isCurrent?.() === false) { return undefined; }
        const cached = this.presetConfigs.get(slug);
        if (cached) {
            return cached;
        }
        const generation = this.cacheGeneration;
        const key = await this.getKey(true);
        if (!key || generation !== this.cacheGeneration) {
            return undefined;
        }
        const existing = this.presetConfigPromises.get(slug);
        if (existing) {
            return existing;
        }
        const cts = new vscode.CancellationTokenSource();
        const promise = this.fetchPresetConfig(key, slug, cts.token, generation).finally(() => {
            cts.dispose();
            if (this.presetConfigPromises.get(slug) === promise) {
                this.presetConfigPromises.delete(slug);
            }
        });
        this.presetConfigPromises.set(slug, promise);
        return promise;
    }

    private async fetchPresetConfig(
        key: string,
        slug: string,
        token: vscode.CancellationToken,
        generation: number
    ): Promise<Record<string, unknown> | undefined> {
        if (this.runtime.isCurrent?.() === false) return undefined;
        const bounded = boundedFetchSignal(token);
        try {
            const response = await fetchWithRetry(
                `${this.baseUrl}/presets/${encodeURIComponent(slug)}`,
                { headers: this.headers(key), signal: bounded.signal },
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
            if (generation === this.cacheGeneration) {
                this.presetConfigs.set(slug, result);
            }
            return result;
        } catch (err) {
            if (err instanceof vscode.CancellationError) {
                throw err;
            }
            return undefined;
        } finally {
            bounded.dispose();
        }
    }

    private resolvePresetBase(model: string, models: ModelCatalogEntry[]): ModelCatalogEntry | undefined {
        for (const candidate of modelIdAliases(model)) {
            const match = models.find(m => m.id === candidate);
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
        if (this.hideUnavailable && this.cachedAvailableIds && !this.presetModelAvailable(preset.model)) {
            return undefined;
        }
        const id = `${PRESET_ID_PREFIX}${preset.slug}`;
        const base = this.resolvePresetBase(preset.model, models);
        const baseInfo = base ? buildModelInfo(base, this.contextBudgetFor(base.id)) : undefined;
        const tooltip = [
            t('**Preset: {0}**', preset.name),
            t('`{0}` → `{1}` with the preset\u2019s pinned provider routing.', id, preset.model),
            t('The extension adds no default provider routing; a pasted `provider` still overrides the preset.'),
            baseInfo?.tooltip ?? t('The preset\u2019s model is not in the public catalog; token limits are assumed defaults.'),
        ].join('\n\n');
        const info: ChatModelInfo = {
            id,
            name: preset.name,
            family: 'preset',
            version: id,
            maxInputTokens: baseInfo?.maxInputTokens ?? ASSUMED_CONTEXT_TOKENS,
            maxOutputTokens: baseInfo?.maxOutputTokens ?? outputReservePolicy().maxTokens,
            detail: baseInfo?.detail ? t('preset \u00b7 {0}', baseInfo.detail) : t('preset'),
            tooltip,
            capabilities: {
                toolCalling: base ? supportsToolCalling(base) : true,
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
        const budget = this.contextBudgetFor(m.id);
        const { detail, tooltip, maxInputTokens, maxOutputTokens } = buildModelInfo(m, budget);
        let info: ChatModelInfo = {
            id: m.id,
            name: m.name ?? m.id,
            family: family ?? 'openrouter',
            version: m.id,
            maxInputTokens,
            maxOutputTokens,
            detail,
            tooltip,
            capabilities: {
                toolCalling: supportsToolCalling(m),
                imageInput: (m.architecture?.input_modalities ?? []).includes('image'),
            },
        };
        if (!this.isDirectOpenRouter) {
            const knownPrice = (value: unknown): boolean => typeof value === 'string' && value.trim() !== ''
                && Number.isFinite(Number(value)) && Number(value) >= 0;
            const completePricing = knownPrice(m.pricing?.prompt) && knownPrice(m.pricing?.completion);
            const genericInfo = completePricing ? { detail, tooltip } : buildModelInfo({ ...m, pricing: undefined }, budget);
            const assumed = this.genericAssumptions.get(m) ?? [];
            const labels: Record<string, string> = {
                context: t('context window'), output: t('maximum output tokens'),
                tools: t('tool calling'), images: t('image input'),
            };
            const missingFields = assumed.map(field => labels[field]).join(', ');
            const assumptionNote = assumed.length === 0 ? undefined : this.isGateway
                ? t('Missing endpoint metadata: conservative defaults for {0}.', missingFields)
                : t('Missing endpoint metadata: conservative defaults for {0}. Manual models can override them.',
                    missingFields);
            const pricingDetail = genericInfo.detail ?? t('Pricing: unknown');
            info = {
                ...info,
                tooltip: [genericInfo.tooltip.replace(
                    t('Pricing: not listed by OpenRouter'), t('Pricing: not listed by the endpoint')
                ), assumptionNote].filter(Boolean).join('\n\n'),
                detail: assumptionNote ? `${pricingDetail} \u00b7 ${t('conservative defaults')}` : pricingDetail,
            };
            if (!this.supportsOpenRouterRequestFields) return info;
        }
        const reasoningSchema = buildReasoningSchema(m);
        const capSchema = buildContextCapSchema(m, this.getContextCaps()[m.id], budget.outputReserve);
        const schemaProperties = {
            ...(reasoningSchema?.properties ?? {}),
            ...(capSchema?.properties ?? {}),
        };
        if (Object.keys(schemaProperties).length > 0) {
            info.configurationSchema = { properties: schemaProperties };
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

const RUNTIME_SYSTEM_ROLE = (vscode.LanguageModelChatMessageRole as unknown as { System?: number }).System;

function openAIRoleOf(message: vscode.LanguageModelChatRequestMessage): 'assistant' | 'system' | 'user' {
    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
        return 'assistant';
    }
    if (RUNTIME_SYSTEM_ROLE !== undefined && (message.role as number) === RUNTIME_SYSTEM_ROLE) {
        return 'system';
    }
    return 'user';
}

export function toOpenAI(messages: readonly vscode.LanguageModelChatRequestMessage[]): unknown[] {
    const out: unknown[] = [];
    for (const message of messages) {
        const role = openAIRoleOf(message);
        const name = typeof message.name === 'string' && message.name.trim() !== '' ? message.name : undefined;
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
                const resultParts: string[] = [];
                for (const c of part.content) {
                    if (typeof c === 'string') {
                        resultParts.push(c);
                    } else if (c instanceof vscode.LanguageModelTextPart) {
                        resultParts.push(c.value);
                    } else if (c instanceof vscode.LanguageModelPromptTsxPart) {
                        resultParts.push(typeof c.value === 'string' ? c.value : JSON.stringify(c.value ?? ''));
                    } else if (c instanceof vscode.LanguageModelDataPart) {
                        if (c.mimeType.startsWith('image/')) {
                            const base64 = Buffer.from(c.data).toString('base64');
                            multimodal.push({
                                type: 'image_url',
                                image_url: { url: `data:${c.mimeType};base64,${base64}` },
                            });
                        } else {
                            resultParts.push(Buffer.from(c.data).toString('utf8'));
                        }
                    } else {
                        resultParts.push(JSON.stringify(c));
                    }
                }
                toolResults.push({ role: 'tool', tool_call_id: part.callId, content: resultParts.join('\n') });
            } else if (part instanceof vscode.LanguageModelDataPart) {
                if (part.mimeType.startsWith('image/')) {
                    const base64 = Buffer.from(part.data).toString('base64');
                    multimodal.push({
                        type: 'image_url',
                        image_url: { url: `data:${part.mimeType};base64,${base64}` },
                    });
                } else {
                    const decoded = Buffer.from(part.data).toString('utf8');
                    if (decoded.length > 0) {
                        text.push(decoded);
                    }
                }
            }
        }
        if (role === 'user' && toolResults.length > 0) {
            out.push(...toolResults);
            const userContent = contentOrString(text, multimodal);
            if (userContent !== null) {
                const userMessage: Record<string, unknown> = { role: 'user', content: userContent };
                if (name) {
                    userMessage.name = name;
                }
                out.push(userMessage);
            }
            continue;
        }
        if (role === 'assistant') {
            const converted: Record<string, unknown> = { role };
            if (thinking.length > 0) {
                converted.reasoning = thinking.join('\n');
            } else {
                converted.reasoning_content = '';
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
            if (name) {
                converted.name = name;
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
        if (name) {
            converted.name = name;
        }
        out.push(converted);
    }
    return out;
}

export const EMPTY_RESPONSE_FALLBACK = ' ';
export const REASONING_ONLY_ERROR =
    'The model produced only reasoning output, which this version of VS Code could not display. ' +
    'Update VS Code, or pick a model that returns final text.';

export function finishStream(
    progress: vscode.Progress<ResponsePart>,
    state: { reportedAnyPart: boolean; sawReasoning: boolean }
): void {
    if (state.reportedAnyPart) {
        return;
    }
    if (state.sawReasoning) {
        throw new Error(t(REASONING_ONLY_ERROR));
    }
    progress.report(new vscode.LanguageModelTextPart(EMPTY_RESPONSE_FALLBACK));
}

function reportThinkingParts(
    delta: any,
    progress: vscode.Progress<ResponsePart>,
    state?: { sawReasoning: boolean }
): void {
    const reasoning = typeof delta.reasoning === 'string' ? delta.reasoning
        : typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
    const details = Array.isArray(delta.reasoning_details)
        ? flattenReasoningDetails(delta.reasoning_details)
        : undefined;
    const hasReasoning =
        reasoning.length > 0 ||
        (details !== undefined && (details.thinking.length > 0 || details.text.length > 0));
    if (state && hasReasoning) {
        state.sawReasoning = true;
    }
    if (!thinkingPartCtor) {
        return;
    }
    if (reasoning.length > 0) {
        progress.report(new thinkingPartCtor(reasoning));
        return;
    }
    if (details) {
        if (details.thinking.length > 0) {
            progress.report(new thinkingPartCtor(details.thinking));
        }
        if (details.text.length > 0) {
            progress.report(new vscode.LanguageModelTextPart(details.text));
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

/**
 * Characters attributable to one part for the rough `chars / 4` token estimate.
 * Text-bearing parts count their text form (tool-call input JSON, tool-result
 * content, thinking values, decoded data); image data is counted separately by
 * {@link countedImageTokens} from its pixel size.
 */
function countedPartChars(part: unknown): number {
    if (part instanceof vscode.LanguageModelTextPart) {
        return part.value.length;
    }
    if (thinkingPartCtor && part instanceof thinkingPartCtor) {
        return (Array.isArray(part.value) ? part.value.join('\n') : part.value).length;
    }
    if (part instanceof vscode.LanguageModelToolCallPart) {
        return part.name.length + JSON.stringify(part.input ?? {}).length;
    }
    if (part instanceof vscode.LanguageModelToolResultPart) {
        let chars = 0;
        for (const c of part.content) {
            chars += typeof c === 'string' ? c.length : countedPartChars(c);
        }
        return chars;
    }
    if (part instanceof vscode.LanguageModelPromptTsxPart) {
        return typeof part.value === 'string' ? part.value.length : JSON.stringify(part.value ?? '').length;
    }
    if (part instanceof vscode.LanguageModelDataPart && !part.mimeType.startsWith('image/')) {
        return Buffer.from(part.data).toString('utf8').length;
    }
    return 0;
}

/** A fixed fallback for images whose format header cannot be read. */
const UNKNOWN_IMAGE_TOKENS = 1_024;
/** Anthropic's documented rule of thumb (~750 pixels per vision token); a model-agnostic middle estimate. */
const PIXELS_PER_IMAGE_TOKEN = 750;
/** One image never estimates above this, so a corrupt header cannot swamp the budget. */
const MAX_IMAGE_TOKENS = 16_384;

/** Pixel dimensions from a PNG, GIF, JPEG or WebP header; undefined when unreadable. */
function imageDimensions(data: Uint8Array): { width: number; height: number } | undefined {
    const ascii = (offset: number, length: number): string => {
        let out = '';
        for (let i = 0; i < length; i++) {
            out += String.fromCharCode(data[offset + i]);
        }
        return out;
    };
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length >= 24 && ascii(0, 8) === '\x89PNG\r\n\x1a\n' && ascii(12, 4) === 'IHDR') {
        return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (data.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
        return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (data.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
        const format = ascii(12, 4);
        if (format === 'VP8X') {
            return {
                width: 1 + (data[24] | (data[25] << 8) | (data[26] << 16)),
                height: 1 + (data[27] | (data[28] << 8) | (data[29] << 16)),
            };
        }
        if (format === 'VP8 ' && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
            return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
        }
        if (format === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
            const bits = view.getUint32(21, true);
            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
        return undefined;
    }
    if (data.length >= 11 && data[0] === 0xff && data[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 <= data.length) {
            if (data[offset] !== 0xff) {
                offset++;
                continue;
            }
            const marker = data[offset + 1];
            if (marker === 0xff) {
                offset++;
                continue;
            }
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                offset += 2;
                continue;
            }
            const length = view.getUint16(offset + 2);
            if (length < 2) {
                return undefined;
            }
            const isFrameHeader =
                marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
            if (isFrameHeader) {
                return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
            }
            offset += 2 + length;
        }
        return undefined;
    }
    return undefined;
}

/** Rough vision-token estimate: pixel area over ~750 px/token, bounded at both ends. */
function imageTokenEstimate(data: Uint8Array): number {
    const size = imageDimensions(data);
    if (!size) {
        return UNKNOWN_IMAGE_TOKENS;
    }
    const tokens = Math.ceil((size.width * size.height) / PIXELS_PER_IMAGE_TOKEN);
    return Math.min(Math.max(tokens, 85), MAX_IMAGE_TOKENS);
}

/** Image tokens inside a part, including images nested in a tool result. */
function countedImageTokens(part: unknown): number {
    if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
        return imageTokenEstimate(part.data);
    }
    if (part instanceof vscode.LanguageModelToolResultPart) {
        let tokens = 0;
        for (const c of part.content) {
            tokens += typeof c === 'string' ? 0 : countedImageTokens(c);
        }
        return tokens;
    }
    return 0;
}
