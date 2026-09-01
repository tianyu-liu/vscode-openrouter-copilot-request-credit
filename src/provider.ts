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

const TEMPLATE_KEY = 'requestTemplate';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_PROVIDER: Record<string, unknown> = {
    quantizations: ['bf16', 'fp16', 'fp8', 'mxfp8', 'fp6', 'unknown'],
};
const SESSION_ID = crypto.randomUUID();
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_BACKOFF_MS = 10000;

type ResponsePart = vscode.LanguageModelResponsePart | vscode.LanguageModelThinkingPart;
const thinkingPartCtor = vscode.LanguageModelThinkingPart as
    | (new (value: string | string[]) => vscode.LanguageModelThinkingPart)
    | undefined;

let warnedBadBaseUrl = false;
let delayFn: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastStreamUsage: unknown;

export function setRetryDelayForTesting(fn: (ms: number) => Promise<void>): void {
    delayFn = fn;
}

export function getLastStreamUsage(): unknown {
    return lastStreamUsage;
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
    for (;;) {
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
            if (attempt >= MAX_RETRIES) {
                throw thrown;
            }
        } else if (response !== undefined && (!isRetryable(response.status) || attempt >= MAX_RETRIES)) {
            return response;
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
    body.reasoning = { ...(body.reasoning as Record<string, unknown> | undefined), [key]: value };
}

export function buildRequestBody(
    template: Record<string, unknown> | undefined,
    modelId: string,
    messages: unknown[],
    tools: unknown,
    modelConfiguration: { readonly [key: string]: unknown } | undefined
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        ...(template ?? {}),
        model: modelId,
        messages,
        tools,
        stream: true,
        session_id: SESSION_ID,
    };
    const provider = body.provider;
    if (provider === undefined) {
        body.provider = DEFAULT_PROVIDER;
    } else if (typeof provider === 'object' && provider !== null && !Array.isArray(provider)) {
        const user = provider as Record<string, unknown>;
        if (!('quantizations' in user)) {
            body.provider = { ...DEFAULT_PROVIDER, ...user };
        }
    }
    mergeReasoningConfig(body, 'effort', effortFromModelConfiguration(modelConfiguration));
    mergeReasoningConfig(body, 'enabled', enabledFromModelConfiguration(modelConfiguration));
    if (modelId.replace(/^~/, '').split('/')[0] === 'anthropic' && !('cache_control' in body)) {
        body.cache_control = { type: 'ephemeral' };
    }
    return body;
}

interface ChatModelInfo extends vscode.LanguageModelChatInformation {
    configurationSchema?: { properties: Record<string, unknown> };
}

export class OpenRouterChatProvider implements vscode.LanguageModelChatProvider {
    private cachedInfo: ChatModelInfo[] | undefined;
    private key: string | undefined;
    private template: Record<string, unknown> | undefined;
    private readonly infoChangeEvent = new vscode.EventEmitter<void>();

    readonly onDidChangeLanguageModelChatInformation: vscode.Event<void> = this.infoChangeEvent.event;

    constructor(
        private readonly secrets: vscode.SecretStorage,
        private readonly state: vscode.Memento
    ) {}

    async setKey(value: string): Promise<void> {
        this.key = value;
        this.cachedInfo = undefined;
        await storeKey(this.secrets, value);
        this.infoChangeEvent.fire();
    }

    async clearKey(): Promise<void> {
        this.key = undefined;
        this.cachedInfo = undefined;
        await clearStoredKey(this.secrets);;
        this.infoChangeEvent.fire();
    }

    async setTemplate(raw: string): Promise<{ ok: boolean; error?: string }> {
        if (raw.trim() === '') {
            await this.clearTemplate();
            return { ok: true };
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
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
        const models = await this.fetchCatalog(key, token);
        const info = models.map(m => this.toInfo(m));
        this.cachedInfo = info;
        return info;
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
        const body = buildRequestBody(
            template,
            model.id,
            toOpenAI(messages),
            options.tools?.map(tool => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
            })),
            modelConfiguration
        );

        const controller = new AbortController();
        const abortListener = token.onCancellationRequested(() => controller.abort());

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
                return;
            }
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
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
                if (json.usage !== undefined && typeof json.usage === 'object' && json.usage !== null) {
                    lastStreamUsage = json.usage;
                }
            }
        }
    } finally {
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
        const json = (await response.json()) as { data?: ModelCatalogEntry[] };
        return json.data ?? [];
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
        content.push(text.join('\n'));
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
