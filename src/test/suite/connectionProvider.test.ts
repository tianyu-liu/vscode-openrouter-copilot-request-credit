import * as assert from 'assert';
import * as vscode from 'vscode';
import { ConnectionRegistry, type ConnectionDefinition } from '../../connections';
import { ConnectionChatProvider, connectionModelId } from '../../connectionProvider';
import { formatMessage, resetTranslator, setTranslator } from '../../i18n';
import { OpenRouterChatProvider, setRetryDelayForTesting, UNATTRIBUTED_SESSION_ID } from '../../provider';

function memoryState(): vscode.Memento {
    const values = new Map<string, unknown>();
    return {
        keys: () => [...values.keys()],
        get: ((key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback) as vscode.Memento['get'],
        update: async (key, value) => { if (value === undefined) { values.delete(key); } else { values.set(key, value); } },
    };
}
function memorySecrets(): vscode.SecretStorage {
    const values = new Map<string, string>();
    return {
        keys: async () => [...values.keys()], get: async key => values.get(key),
        store: async (key, value) => { values.set(key, value); },
        delete: async key => { values.delete(key); },
        onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
    };
}
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function completed(cost: number | null = 0.25): Response {
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }], usage: {
        prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, ...(cost !== null ? { cost } : {}),
    } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

suite('connection provider routing', () => {
    let originalFetch: typeof fetch;
    let registry: ConnectionRegistry;
    let router: ConnectionChatProvider;
    let calls: Array<{ url: string; init?: RequestInit }>;
    let fetcher: (url: string, init?: RequestInit) => Promise<Response>;
    setup(async () => {
        calls = [];
        originalFetch = globalThis.fetch;
        fetcher = async url => url.endsWith('/models')
            ? Response.json({ data: [{ id: 'anthropic/shared' }] }) : completed();
        globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
            calls.push({ url: String(url), init });
            return fetcher(String(url), init);
        }) as typeof fetch;
        setRetryDelayForTesting(async () => {});
        registry = new ConnectionRegistry(memoryState(), memorySecrets());
        await registry.initialize();
        router = new ConnectionChatProvider(registry);
    });
    teardown(() => {
        router.dispose(); registry.dispose(); globalThis.fetch = originalFetch;
        setRetryDelayForTesting(ms => new Promise(resolve => setTimeout(resolve, ms)));
    });
    async function generic(name: string, port = 9000): Promise<ConnectionDefinition> {
        return registry.add({ name, kind: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1` });
    }
    async function models(connection: ConnectionDefinition): Promise<vscode.LanguageModelChatInformation[]> {
        return router.provideLanguageModelChatInformation({ silent: true, configuration: { connectionId: connection.id } } as never, token);
    }
    async function request(model: vscode.LanguageModelChatInformation, conversationId?: string): Promise<void> {
        await router.provideLanguageModelChatResponse(model, [], {
            toolMode: vscode.LanguageModelChatToolMode.Auto,
            modelOptions: conversationId ? { _conversationId: conversationId, _capturingTokenCorrelationId: 'marker' }
                : { _capturingTokenCorrelationId: 'marker' },
        }, { report() {} }, token);
    }
    test('duplicate upstream model IDs retain distinct stable identities and route key/body by selected connection', async () => {
        const one = await generic('One'); const two = await generic('Two', 9001);
        await registry.storeKey(one.id, 'one'); await registry.storeKey(two.id, 'two');
        const [first] = await models(one); const [second] = await models(two);
        assert.notStrictEqual(first.id, second.id);
        assert.strictEqual(first.id, connectionModelId(one.id, 'anthropic/shared'));
        await request(first); await request(second);
        const posts = calls.filter(call => call.init?.method === 'POST');
        assert.deepStrictEqual(posts.map(call => call.url), [one.baseUrl + '/chat/completions', two.baseUrl + '/chat/completions']);
        assert.deepStrictEqual(posts.map(call => (call.init?.headers as Record<string, string>).Authorization), ['Bearer one', 'Bearer two']);
        assert.ok(posts.every(call => JSON.parse(String(call.init?.body)).model === 'anthropic/shared'));
        assert.ok(calls.every(call => call.init?.redirect === 'error'));
    });
    test('generic discovery is keyless and conservative, with unknown pricing and no OpenRouter-only API calls', async () => {
        const connection = await generic('Local');
        const [model] = await models(connection);
        assert.deepStrictEqual(model.capabilities, { toolCalling: false, imageInput: false });
        assert.ok(model.maxInputTokens + model.maxOutputTokens <= 8192);
        assert.match(model.detail ?? '', /unknown/i);
        assert.match(String(model.tooltip), /not listed by the endpoint/);
        assert.match(model.detail ?? '', /conservative defaults/);
        assert.match(String(model.tooltip), /context window, maximum output tokens, tool calling, image input/);
        assert.deepStrictEqual(await router.getProvider(connection.id)!.getPresets(), []);
        await request(model, 'chat');
        assert.ok(calls.every(call => !new Headers(call.init?.headers).has('Authorization')));
        assert.ok(calls.every(call => !/models\/user|presets|credits|auth\/key/.test(call.url)));
        const body = JSON.parse(String(calls.find(call => call.init?.method === 'POST')?.init?.body));
        for (const key of ['session_id', 'cache_control', 'reasoning']) { assert.ok(!(key in body), key); }
        const headers = new Headers(calls.find(call => call.init?.method === 'POST')?.init?.headers);
        assert.ok(!headers.has('HTTP-Referer')); assert.ok(!headers.has('X-Title'));
    });
    test('generic templates preserve explicit provider fields while live model/messages stay authoritative', async () => {
        const connection = await generic('Local'); const [model] = await models(connection);
        await router.getProvider(connection.id)!.setTemplate(JSON.stringify({ session_id: 'custom', cache_control: null,
            reasoning: { effort: 'high' }, temperature: 0.5, model: 'wrong', messages: [], stream: false }));
        await request(model, 'chat');
        const body = JSON.parse(String(calls.find(call => call.init?.method === 'POST')?.init?.body));
        assert.strictEqual(body.session_id, 'custom'); assert.strictEqual(body.cache_control, null);
        assert.deepStrictEqual(body.reasoning, { effort: 'high' }); assert.strictEqual(body.temperature, 0.5);
        assert.strictEqual(body.model, 'anthropic/shared'); assert.strictEqual(body.stream, true);
    });
    test('manual metadata merges over endpoint models and works when /models is unsupported', async () => {
        const connection = await registry.add({ name: 'Manual', kind: 'openai-compatible', baseUrl: 'http://localhost:9000/v1',
            models: [{ id: 'manual', contextLength: 16384, maxOutputTokens: 4096, toolCalling: true, imageInput: true }] });
        fetcher = async () => new Response('missing', { status: 404 });
        const [model] = await models(connection);
        assert.strictEqual(model.maxOutputTokens, 4096); assert.strictEqual(model.maxInputTokens, 12288);
        assert.deepStrictEqual(model.capabilities, { toolCalling: true, imageInput: true });
        assert.doesNotMatch(model.detail ?? '', /conservative defaults/);
        assert.doesNotMatch(String(model.tooltip), /Missing endpoint metadata/);
    });
    test('fully supplied endpoint metadata has no assumption note', async () => {
        const connection = await generic('Complete');
        fetcher = async () => Response.json({ data: [{ id: 'complete', context_length: 16384,
            top_provider: { max_completion_tokens: 2048 }, supported_parameters: [],
            architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0.000001' },
        }] });
        const [model] = await models(connection);
        assert.strictEqual(model.maxInputTokens, 14336); assert.strictEqual(model.maxOutputTokens, 2048);
        assert.doesNotMatch(model.detail ?? '', /conservative defaults/);
        assert.doesNotMatch(String(model.tooltip), /Missing endpoint metadata/);
    });
    test('zero and malformed metadata use explicitly marked conservative defaults', async () => {
        const connection = await generic('Malformed');
        fetcher = async () => Response.json({ data: [{ id: 'malformed', context_length: 0,
            top_provider: { max_completion_tokens: 0 }, supports_tool_parameters: 'yes',
            architecture: { input_modalities: 'image' },
        }] });
        const [model] = await models(connection);
        assert.strictEqual(model.maxInputTokens + model.maxOutputTokens, 8192);
        assert.deepStrictEqual(model.capabilities, { toolCalling: false, imageInput: false });
        assert.match(model.detail ?? '', /conservative defaults/);
        assert.match(String(model.tooltip), /context window, maximum output tokens, tool calling, image input/);
    });
    test('generic unknown-price wording replaces the translated OpenRouter sentence', async () => {
        const connection = await generic('Localized');
        setTranslator((message, ...args) => message === 'Pricing: not listed by OpenRouter' ? '旧価格'
            : message === 'Pricing: not listed by the endpoint' ? '新価格' : formatMessage(message, ...args));
        try {
            const [model] = await models(connection);
            assert.match(String(model.tooltip), /新価格/); assert.doesNotMatch(String(model.tooltip), /旧価格/);
        } finally { resetTranslator(); }
    });
    async function gateway(): Promise<ConnectionDefinition> {
        const connection = await registry.add({ name: 'Gateway', kind: 'gateway', baseUrl: 'https://gateway.test/v1' });
        await registry.storeKey(connection.id, 'gateway-key');
        return connection;
    }
    test('gateway discovery requires its own bearer key and never borrows a direct connection key', async () => {
        await registry.storeKey(registry.list()[0].id, 'direct-key');
        const connection = await registry.add({ name: 'Gateway', kind: 'gateway', baseUrl: 'https://gateway.test/v1' });
        await assert.rejects(models(connection), /Gateway bearer key not configured/);
        assert.strictEqual(calls.length, 0);
        await registry.storeKey(connection.id, 'gateway-key');
        const [model] = await models(connection);
        await request(model);
        assert.ok(calls.every(call => new Headers(call.init?.headers).get('Authorization') === 'Bearer gateway-key'));
        assert.ok(calls.every(call => call.url.startsWith('https://gateway.test/v1/')));
        assert.ok(calls.every(call => call.init?.redirect === 'error'));
    });
    test('gateway preserves metadata and OpenRouter body features while using only gateway inference routes', async () => {
        const connection = await gateway();
        const events = [
            { choices: [{ delta: { content: 'answer' } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'lookup', arguments: '{"x":' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] },
            { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.01 } },
        ];
        fetcher = async url => url.endsWith('/models') ? Response.json({ data: [{
            id: 'anthropic/shared', name: 'Gateway Claude', context_length: 200000,
            top_provider: { max_completion_tokens: 64000 }, supported_parameters: ['tools', 'reasoning'],
            architecture: { input_modalities: ['text', 'image'] },
            pricing: { prompt: '0.000003', completion: '0.000015' },
            reasoning: { supported_efforts: ['high', 'low'], default_effort: 'high' },
        }] }) : new Response(new ReadableStream({ start(controller) {
            const wire = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
            for (let index = 0; index < wire.length; index += 13) {
                controller.enqueue(new TextEncoder().encode(wire.slice(index, index + 13)));
            }
            controller.close();
        } }), { headers: { 'content-type': 'text/event-stream' } });
        const [model] = await models(connection);
        assert.strictEqual(model.name, 'Gateway Claude');
        assert.deepStrictEqual(model.capabilities, { toolCalling: true, imageInput: true });
        assert.ok((model as { configurationSchema?: unknown }).configurationSchema);
        assert.doesNotMatch(String(model.tooltip), /conservative defaults/);
        const provider = router.getProvider(connection.id)!;
        assert.deepStrictEqual(await provider.getPresets(), []);
        assert.strictEqual(await provider.getPresetConfig('never-probe'), undefined);
        await provider.setTemplate('{"provider":{"only":["example"]},"reasoning":{"exclude":true},"session_id":"ignored"}');
        const parts: vscode.LanguageModelResponsePart[] = [];
        await router.provideLanguageModelChatResponse(model, [], {
            toolMode: vscode.LanguageModelChatToolMode.Required,
            tools: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }],
            modelOptions: { _conversationId: 'gateway-chat', _capturingTokenCorrelationId: 'marker' },
            modelConfiguration: { reasoningEffort: 'low' },
        } as never, { report: part => parts.push(part) }, token);
        const post = calls.find(call => call.init?.method === 'POST')!;
        const body = JSON.parse(String(post.init?.body));
        assert.strictEqual(body.model, 'anthropic/shared');
        assert.strictEqual(body.session_id, 'copilot-chat:gateway-chat');
        assert.deepStrictEqual(body.reasoning, { exclude: true, effort: 'low' });
        assert.deepStrictEqual(body.cache_control, { type: 'ephemeral' });
        assert.deepStrictEqual(body.provider, { only: ['example'] });
        assert.strictEqual(body.tool_choice, 'required');
        assert.strictEqual(body.tools[0].function.name, 'lookup');
        assert.ok(parts.some(part => part instanceof vscode.LanguageModelTextPart && part.value === 'answer'));
        const tool = parts.find(part => part instanceof vscode.LanguageModelToolCallPart) as vscode.LanguageModelToolCallPart;
        assert.strictEqual(tool.callId, 'call-1'); assert.deepStrictEqual(tool.input, { x: 1 });
        assert.ok(parts.some(part => part instanceof vscode.LanguageModelDataPart && part.mimeType === 'usage'));
        assert.ok(calls.every(call => /\/v1\/(models|chat\/completions)$/.test(call.url)));
        assert.ok(!new Headers(post.init?.headers).has('HTTP-Referer'));
        assert.ok(!new Headers(post.init?.headers).has('X-Title'));
    });
    test('gateway discovery failures and malformed lists never use a manual or unrestricted fallback', async () => {
        const provider = new OpenRouterChatProvider(memorySecrets(), memoryState(), {
            kind: 'gateway', baseUrl: 'https://gateway.test/v1', readKey: async () => 'gateway-key',
            manualModels: [{ id: 'bypass', toolCalling: true }],
        });
        const invalid = [null, {}, { data: null }, { data: [{ id: 'allowed' }, {}] },
            { data: [{ id: '' }] }, { data: [{ id: 'allowed' }, { id: 'allowed' }] },
            { data: [{ id: 'allowed', architecture: { input_modalities: 'image' } }] }];
        try {
            for (const body of invalid) {
                fetcher = async () => Response.json(body);
                await assert.rejects(provider.provideLanguageModelChatInformation({ silent: true }, token));
                provider.resetCatalogCache();
            }
            for (const status of [401, 403, 404, 503]) {
                fetcher = async () => new Response('unavailable', { status });
                await assert.rejects(provider.provideLanguageModelChatInformation({ silent: true }, token));
                provider.resetCatalogCache();
            }
            fetcher = async () => Response.json({ data: [] });
            assert.deepStrictEqual(await provider.provideLanguageModelChatInformation({ silent: true }, token), []);
            await assert.rejects(provider.provideLanguageModelChatResponse({ id: 'bypass' } as never, [], {
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            }, { report() {} }, token), /unavailable in the gateway catalog/);
            assert.ok(calls.every(call => call.url === 'https://gateway.test/v1/models'));
        } finally { provider.dispose(); }
    });
    test('gateway invalidation rejects old model handles when rediscovery fails or returns an empty catalog', async () => {
        const connection = await gateway(); const [model] = await models(connection);
        const provider = router.getProvider(connection.id)!;
        provider.resetCatalogCache();
        fetcher = async () => new Response('unavailable', { status: 403 });
        await assert.rejects(models(connection));
        await assert.rejects(request(model));
        provider.resetCatalogCache();
        fetcher = async () => Response.json({ data: [] });
        assert.deepStrictEqual(await models(connection), []);
        await assert.rejects(request(model), /unavailable in the gateway catalog/);
        assert.ok(calls.every(call => call.init?.method !== 'POST'));
    });
    test('a pending gateway credential read cannot restore a superseded credential or catalog', async () => {
        let release!: (key: string) => void;
        const provider = new OpenRouterChatProvider(memorySecrets(), memoryState(), {
            kind: 'gateway', baseUrl: 'https://gateway.test/v1',
            readKey: async () => new Promise<string>(resolve => { release = resolve; }),
        });
        try {
            const pending = provider.provideLanguageModelChatInformation({ silent: true }, token);
            await tick();
            await provider.setKey('replacement-key');
            release('obsolete-key');
            assert.deepStrictEqual(await pending, []);
            assert.strictEqual(calls.length, 0);
            const [model] = await provider.provideLanguageModelChatInformation({ silent: true }, token);
            assert.ok(model);
            assert.ok(calls.every(call => new Headers(call.init?.headers).get('Authorization') === 'Bearer replacement-key'));
        } finally { provider.dispose(); }
    });
    test('gateway ignores an obsolete in-flight discovery result after invalidation', async () => {
        const connection = await gateway();
        let release!: (response: Response) => void;
        fetcher = async () => new Promise<Response>(resolve => { release = resolve; });
        const pending = models(connection); await tick();
        router.getProvider(connection.id)!.resetCatalogCache();
        release(Response.json({ data: [{ id: 'obsolete' }] }));
        assert.deepStrictEqual(await pending, []);
        fetcher = async () => new Response('denied', { status: 403 });
        await assert.rejects(models(connection));
    });
    test('gateway rejects caller-forged models and cancels an active SSE reader', async () => {
        const connection = await gateway(); const [model] = await models(connection);
        await assert.rejects(request({ ...model, id: connectionModelId(connection.id, 'unlisted'),
            version: JSON.stringify(['unlisted', registry.get(connection.id)!.revision]) }), /unavailable in the gateway catalog/);
        let cancelled = false;
        const source = new vscode.CancellationTokenSource();
        fetcher = async () => new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
            },
            cancel() { cancelled = true; },
        }), { headers: { 'content-type': 'text/event-stream' } });
        try {
            await assert.rejects(router.provideLanguageModelChatResponse(model, [], {
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            }, { report(part) { if (part instanceof vscode.LanguageModelTextPart) { source.cancel(); } } }, source.token),
            error => error instanceof vscode.CancellationError);
            const post = calls.find(call => call.init?.method === 'POST')!;
            assert.ok(post.init?.signal?.aborted);
            assert.strictEqual(cancelled, true);
        } finally { source.dispose(); }
    });
    test('missing group configuration never discovers all connections or falls back to the last selected one', async () => {
        await generic('One');
        assert.deepStrictEqual(await router.provideLanguageModelChatInformation({ silent: true }, token), []);
        assert.strictEqual(calls.length, 0);
    });
    test('reconfigured, disabled and deleted selections are rejected before sending a request', async () => {
        const connection = await generic('One'); const [old] = await models(connection);
        await registry.update(connection.id, { name: 'Renamed' });
        await assert.rejects(request(old), /changed|unavailable/);
        const [fresh] = await models(registry.get(connection.id)!);
        assert.strictEqual(fresh.id, old.id);
        await registry.update(connection.id, { enabled: false });
        assert.ok(router.getProvider(connection.id), 'disabled connections can still be edited');
        assert.deepStrictEqual(await models(connection), []);
        await assert.rejects(request(fresh), /changed|unavailable/);
        await registry.remove(connection.id);
        await assert.rejects(request(fresh), /changed|unavailable/);
        assert.strictEqual(calls.filter(call => call.init?.method === 'POST').length, 0);
    });
    test('a delayed catalog cannot restore models after the connection is disabled', async () => {
        const connection = await generic('One');
        let release!: (response: Response) => void;
        fetcher = async () => new Promise<Response>(resolve => { release = resolve; });
        const pending = models(connection); await tick();
        await registry.update(connection.id, { enabled: false });
        release(Response.json({ data: [{ id: 'late' }] }));
        assert.deepStrictEqual(await pending, []);
        assert.deepStrictEqual(await models(connection), []);
    });
    test('session spend and most-recent parent attribution stay isolated and survive runtime replacements', async () => {
        const one = await generic('One'); const two = await generic('Two', 9001);
        const [first] = await models(one); const [second] = await models(two);
        await request(first, 'parent-one'); await request(second);
        assert.strictEqual(router.getSessionCosts(one.id)[0].sessionId, 'copilot-chat:parent-one');
        assert.strictEqual(router.getSessionCosts(two.id)[0].sessionId, UNATTRIBUTED_SESSION_ID);
        await registry.update(one.id, { name: 'Renamed' });
        const [updated] = await models(registry.get(one.id)!); await request(updated);
        assert.strictEqual(router.getSessionCosts(one.id)[0].paid, 0.5);
        assert.strictEqual(router.getSessionCosts(two.id)[0].paid, 0.25);
    });
    test('generic token-only and known-zero usage persist without treating unknown costs as free', async () => {
        const connection = await generic('One'); const [model] = await models(connection);
        fetcher = async () => completed(null);
        await request(model, 'unknown-cost');
        let history = router.getSessionCosts(connection.id);
        assert.strictEqual(history[0].paid, 0); assert.strictEqual(history[0].costUnavailable, true);
        assert.strictEqual(history[0].promptTokens, 4); assert.strictEqual(history[0].completionTokens, 2);
        assert.strictEqual(history[0].calls, 1); assert.strictEqual(history[0].routes[0].costUnavailable, true);
        fetcher = async () => completed(0.25); await request(model, 'unknown-cost');
        history = router.getSessionCosts(connection.id);
        assert.strictEqual(history[0].paid, 0.25); assert.strictEqual(history[0].costUnavailable, true);
        fetcher = async () => completed(0); await request(model, 'reported-free');
        assert.strictEqual(router.getSessionCosts(connection.id)[0].costUnavailable, undefined);
        await tick(); await registry.readKey(connection.id);
        router.dispose(); router = new ConnectionChatProvider(registry);
        history = router.getSessionCosts(connection.id);
        assert.strictEqual(history.length, 2);
        const unknown = history.find(session => session.sessionId === 'copilot-chat:unknown-cost')!;
        const free = history.find(session => session.sessionId === 'copilot-chat:reported-free')!;
        assert.strictEqual(unknown.paid, 0.25); assert.strictEqual(unknown.costUnavailable, true);
        assert.strictEqual(unknown.promptTokens, 8); assert.strictEqual(free.paid, 0);
        assert.strictEqual(free.calls, 1); assert.strictEqual(free.costUnavailable, undefined);
    });
    test('the template snapshot precedes an awaited credential lookup', async () => {
        let release!: (key: string) => void;
        const secrets = memorySecrets();
        secrets.get = async () => new Promise<string>(resolve => { release = resolve; });
        const provider = new OpenRouterChatProvider(secrets, memoryState(), {
            connectionId: 'snapshot', kind: 'openai-compatible', baseUrl: 'http://localhost:9000/v1',
        });
        try {
            await provider.setTemplate('{"temperature":0.1}');
            const pending = provider.provideLanguageModelChatResponse({ id: 'local' } as never, [], {
                toolMode: vscode.LanguageModelChatToolMode.Auto,
            }, { report() {} }, token);
            await tick();
            await provider.setTemplate('{"temperature":0.9}');
            release('captured-key');
            await pending;
            const post = calls.find(call => call.init?.method === 'POST')!;
            assert.strictEqual(JSON.parse(String(post.init?.body)).temperature, 0.1);
            assert.strictEqual(new Headers(post.init?.headers).get('Authorization'), 'Bearer captured-key');
        } finally { provider.dispose(); }
    });
    test('request template and key remain captured for a retry despite edits while the first POST is paused', async () => {
        const connection = await generic('One'); await registry.storeKey(connection.id, 'old-key');
        const [model] = await models(connection);
        await router.getProvider(connection.id)!.setTemplate('{"temperature":0.1}');
        let release!: (response: Response) => void;
        let posts = 0;
        fetcher = async url => url.endsWith('/models') ? Response.json({ data: [] })
            : ++posts === 1 ? new Promise<Response>(resolve => { release = resolve; }) : completed();
        const pending = request(model); await tick();
        await router.getProvider(connection.id)!.setTemplate('{"temperature":0.9}');
        await registry.storeKey(connection.id, 'new-key');
        release(new Response('retry', { status: 503 })); await pending;
        const requests = calls.filter(call => call.init?.method === 'POST');
        assert.strictEqual(requests.length, 2);
        assert.ok(requests.every(call => new Headers(call.init?.headers).get('Authorization') === 'Bearer old-key'));
        assert.ok(requests.every(call => JSON.parse(String(call.init?.body)).temperature === 0.1));
        assert.strictEqual(router.getSessionCosts(connection.id)[0].paid, 0.25);
    });
});
