import * as assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as vscode from 'vscode';
import { ConnectionRegistry, LEGACY_CONNECTION_ID, OPENROUTER_BASE_URL, type ConnectionDefinition } from '../../connections';
import { ConnectionChatProvider, connectionModelId } from '../../connectionProvider';
import { formatMessage, resetTranslator, setTranslator } from '../../i18n';
import { ProfileStorage } from '../../profileStorage';
import {
    MAX_TRACKED_SESSIONS, OpenRouterChatProvider, setRequestDumpDirectory, setRetryDelayForTesting,
    UNATTRIBUTED_SESSION_ID,
} from '../../provider';

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
        router = new ConnectionChatProvider(registry, true);
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

    test('the release router rejects saved proxy groups and stale proxy handles without using any key', async () => {
        const direct = await registry.add({ name: 'Direct', kind: 'openrouter' }, 'sk-or-direct-test');
        const legacy = await registry.add({ name: 'Legacy', kind: 'openai-compatible', baseUrl: OPENROUTER_BASE_URL },
            'legacy-token');
        const gateway = await registry.add({ name: 'Proxy', kind: 'gateway', baseUrl: 'https://proxy.test/v1' },
            'proxy-token');
        const staleModels = [await models(legacy), await models(gateway)];
        assert.ok(staleModels.every(found => found.length > 0), 'both groups had models in a test build');
        router.dispose();
        router = new ConnectionChatProvider(registry);
        calls.length = 0;

        for (const [index, connection] of [legacy, gateway].entries()) {
            assert.deepStrictEqual(await models(connection), []);
            assert.strictEqual(router.getProvider(connection.id), undefined);
            const stale = staleModels[index][0];
            await assert.rejects(request(stale), /connection changed or is unavailable/);
            await assert.rejects(router.provideTokenCount(stale, 'hello', token), /connection changed or is unavailable/);
        }
        assert.strictEqual(calls.length, 0);

        const [active] = await models(direct);
        await registry.setBudgetVisibility(direct.id, false);
        assert.strictEqual(registry.get(direct.id)?.settings.showBudgetInStatusBar, false);
        await request(active);
        const post = calls.find(call => call.init?.method === 'POST');
        assert.strictEqual(post?.url, OPENROUTER_BASE_URL + '/chat/completions');
        assert.strictEqual(new Headers(post?.init?.headers).get('Authorization'), 'Bearer sk-or-direct-test');
        assert.strictEqual(await registry.readKey(legacy.id), 'legacy-token');
        assert.strictEqual(await registry.readKey(gateway.id), 'proxy-token');
    });

    test('a disabled direct connection keeps its template without fetching preset metadata', async () => {
        const saved = await registry.add({ name: 'Disabled', kind: 'openrouter', enabled: false }, 'fixture-key');
        const child = router.getProvider(saved.id)!;
        await child.setTemplate('{"preset":"fixture"}');
        assert.deepStrictEqual(await child.getTemplate(), { preset: 'fixture' });
        assert.deepStrictEqual(await child.getPresets(), []);
        assert.strictEqual(await child.getPresetConfig('fixture'), undefined);
        assert.strictEqual(calls.length, 0);
    });

    test('an opted-in request dump stays in the configured log directory and leaves credentials out', async () => {
        const saved = await registry.add({ name: 'Debug', kind: 'openrouter' }, 'fixture-authorization');
        const [model] = await models(saved);
        const directory = await fs.mkdtemp(join(tmpdir(), 'openrouter-request-dump-'));
        const file = join(directory, 'openrouter-requests.jsonl');
        const previous = process.env.OPENROUTER_RC_DEBUG;
        try {
            process.env.OPENROUTER_RC_DEBUG = '1';
            setRequestDumpDirectory(directory);
            await request(model);
            const data = await fs.readFile(file, 'utf8');
            const payload = JSON.parse(data.trim());
            assert.strictEqual(payload.model, 'anthropic/shared');
            assert.ok(!data.includes('fixture-authorization'));
            if (process.platform !== 'win32') {
                assert.strictEqual((await fs.stat(file)).mode & 0o077, 0);
                const target = join(directory, 'test-target');
                await fs.rename(file, target);
                await fs.symlink(target, file);
                await request(model);
                assert.strictEqual(await fs.readFile(target, 'utf8'), data);
            }
        } finally {
            setRequestDumpDirectory(undefined);
            if (previous === undefined) delete process.env.OPENROUTER_RC_DEBUG;
            else process.env.OPENROUTER_RC_DEBUG = previous;
            await fs.rm(directory, { recursive: true, force: true });
        }
    });
    test('duplicate upstream model IDs retain distinct stable identities and route key/body by selected connection', async () => {
        const one = await generic('One'); const two = await generic('Two', 9001);
        await registry.storeKey(one.id, 'one'); await registry.storeKey(two.id, 'two');
        const [first] = await models(one); const [second] = await models(two);
        assert.notStrictEqual(first.id, second.id);
        assert.strictEqual(first.id, connectionModelId(one.id, 'anthropic/shared', registry.get(one.id)!.routingRevision));
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

    test('a combined endpoint and key save never discovers or requests the new endpoint with the old key', async () => {
        const connection = await registry.add({ name: 'Combined', kind: 'openai-compatible',
            baseUrl: 'https://one.test/v1' }, 'old-key');
        const [staleModel] = await models(connection);
        const discovery: Promise<vscode.LanguageModelChatInformation[]>[] = [];
        registry.onDidChange(() => { discovery.push(models(registry.get(connection.id)!)); });
        const updated = await registry.update(connection.id, { name: 'Updated', baseUrl: 'https://two.test/v1' }, 'new-key');
        const [[model]] = await Promise.all(discovery);
        await assert.rejects(request(staleModel), /changed|again|stale/i);
        await request(model);
        const newCalls = calls.filter(call => call.url.startsWith(updated.baseUrl));
        assert.ok(newCalls.length >= 2);
        assert.ok(newCalls.every(call => new Headers(call.init?.headers).get('Authorization') === 'Bearer new-key'));
        assert.strictEqual(await registry.readKey(connection.id), 'new-key');
    });

    test('API type conversions recreate adapters, retire old handles and retain the scoped template and spend', async () => {
        fetcher = async url => url.endsWith('/models') ? Response.json({ data: [{ id: 'anthropic/shared' }] })
            : url.includes('/presets?') ? Response.json({ data: [] }) : completed();
        let connection = await registry.add({ name: 'Converting', kind: 'openai-compatible',
            baseUrl: OPENROUTER_BASE_URL, settings: { hideUnavailableModels: false } }, 'same-key');
        let [model] = await models(connection);
        let child = router.getProvider(connection.id)!;
        await child.setTemplate('{"temperature":0.3}');
        await request(model, 'conversion-chat');
        for (const kind of ['gateway', 'openrouter', 'openai-compatible'] as const) {
            const obsolete = model;
            const previous = child;
            connection = await registry.update(connection.id, { kind });
            child = router.getProvider(connection.id)!;
            assert.notStrictEqual(child, previous);
            assert.deepStrictEqual(await child.getTemplate(), { temperature: 0.3 });
            await assert.rejects(request(obsolete), /changed|unavailable/);
            calls.length = 0;
            [model] = await models(connection);
            assert.deepStrictEqual(await child.getPresets(), []);
            assert.notStrictEqual(model.id, obsolete.id);
            assert.notStrictEqual(model.version, obsolete.version);
            await request(model, 'conversion-chat');
            const post = calls.find(call => call.init?.method === 'POST')!;
            const body = JSON.parse(String(post.init?.body));
            assert.strictEqual(body.temperature, 0.3);
            assert.strictEqual(body.session_id, kind === 'openai-compatible' ? undefined : 'copilot-chat:conversion-chat');
            assert.strictEqual(new Headers(post.init?.headers).has('HTTP-Referer'), kind === 'openrouter');
            assert.strictEqual(calls.some(call => call.url.includes('/presets?')), kind === 'openrouter');
            assert.ok(calls.every(call => new Headers(call.init?.headers).get('Authorization') === 'Bearer same-key'));
            assert.ok(calls.every(call => !/credits|auth\/key|models\/user/.test(call.url)));
        }
        const history = router.getSessionCosts(connection.id);
        assert.strictEqual(history.length, 1);
        assert.strictEqual(history[0].calls, 4);
        assert.strictEqual(history[0].paid, 1);
    });

    test('an obsolete Gateway catalog cannot publish models after conversion to a generic adapter', async () => {
        const connection = await gateway();
        let release!: (response: Response) => void;
        fetcher = async () => new Promise<Response>(resolve => { release = resolve; });
        const pending = models(connection);
        await tick();
        const converted = await registry.update(connection.id, { kind: 'openai-compatible' });
        release(Response.json({ data: [{ id: 'obsolete-gateway-model' }] }));
        assert.deepStrictEqual(await pending, []);
        fetcher = async () => new Response('unsupported', { status: 404 });
        await registry.update(connection.id, { models: [{ id: 'generic-manual' }] });
        const available = await models(converted);
        assert.deepStrictEqual(available.map(model => (model as { upstreamModelId?: string }).upstreamModelId),
            ['generic-manual']);
    });

    test('a turn already sent before API type conversion retains its captured endpoint and credential on retry', async () => {
        const connection = await registry.add({ name: 'Converting', kind: 'openai-compatible',
            baseUrl: 'https://old.test/v1' }, 'old-key');
        const [model] = await models(connection);
        let release!: (response: Response) => void;
        let posts = 0;
        fetcher = async url => url.endsWith('/models') ? Response.json({ data: [{ id: 'anthropic/shared' }] })
            : ++posts === 1 ? new Promise<Response>(resolve => { release = resolve; }) : completed();
        const pending = request(model, 'conversion-chat');
        await tick();
        const updated = await registry.update(connection.id, { kind: 'gateway', baseUrl: 'https://new.test/v1' }, 'new-key');
        const [fresh] = await models(updated);
        release(new Response('retry', { status: 429 }));
        await pending;
        const oldPosts = calls.filter(call => call.init?.method === 'POST');
        assert.strictEqual(oldPosts.length, 2);
        assert.ok(oldPosts.every(call => call.url === 'https://old.test/v1/chat/completions'));
        assert.ok(oldPosts.every(call => new Headers(call.init?.headers).get('Authorization') === 'Bearer old-key'));
        assert.ok(oldPosts.every(call => JSON.parse(String(call.init?.body)).session_id === undefined));
        await assert.rejects(request(model), /changed|unavailable/);
        await request(fresh, 'conversion-chat');
        const last = calls.at(-1)!;
        assert.strictEqual(last.url, 'https://new.test/v1/chat/completions');
        assert.strictEqual(new Headers(last.init?.headers).get('Authorization'), 'Bearer new-key');
        assert.strictEqual(JSON.parse(String(last.init?.body)).session_id, 'copilot-chat:conversion-chat');
        assert.strictEqual(router.getSessionCosts(connection.id)[0].calls, 2);
    });

    test('persisted OpenRouter keys cannot leave a proxy adapter through discovery, inference or preset paths', async () => {
        for (const kind of ['gateway', 'openai-compatible'] as const) {
            const secrets = memorySecrets();
            const state = memoryState();
            const saved = new ConnectionRegistry(state, secrets);
            await saved.initialize();
            const connection = await saved.add({ name: 'Legacy proxy', kind,
                baseUrl: 'https://proxy.test/v1' }, 'proxy-token');
            let local = new ConnectionChatProvider(saved, true);
            try {
                const [model] = await local.provideLanguageModelChatInformation({ silent: true,
                    configuration: { connectionId: connection.id } } as never, token);
                const slot = (await secrets.keys()).find(key => key.startsWith(`connection.${connection.id}.key.`))!;
                await secrets.store(slot, '  SK-OR-V1-LEGACY-TEST  ');
                local.dispose();
                local = new ConnectionChatProvider(saved, true);
                const child = local.getProvider(connection.id)!;
                calls.length = 0;
                await assert.rejects(local.provideLanguageModelChatInformation({ silent: true,
                    configuration: { connectionId: connection.id } } as never, token), /cannot be used with a proxy/);
                await assert.rejects(local.provideLanguageModelChatResponse(model, [], {
                    toolMode: vscode.LanguageModelChatToolMode.Auto,
                }, { report() {} }, token), /cannot be used with a proxy/);
                assert.deepStrictEqual(await child.getPresets(), []);
                assert.strictEqual(await child.getPresetConfig('test-preset'), undefined);
                assert.strictEqual(calls.length, 0);
                assert.strictEqual(await saved.readKey(connection.id), '  SK-OR-V1-LEGACY-TEST  ');
                await saved.clearKey(connection.id);
                assert.strictEqual(await saved.readKey(connection.id), undefined);
            } finally { local.dispose(); saved.dispose(); }
        }
    });

    test('proxy setters and cached credential reads reject OpenRouter key syntax without network or storage writes', async () => {
        for (const kind of ['gateway', 'openai-compatible'] as const) {
            const secrets = memorySecrets();
            await secrets.store('openrouterApiKey', 'proxy-token');
            const child = new OpenRouterChatProvider(secrets, memoryState(), { kind, baseUrl: 'https://proxy.test/v1' });
            try {
                await assert.rejects(child.setKey('sk-or-'), /cannot be used with a proxy/);
                assert.strictEqual(await secrets.get('openrouterApiKey'), 'proxy-token');
                assert.strictEqual(await child.getKey(true), 'proxy-token');
                (child as unknown as { key: string }).key = 'sk-or-v99-cache-test';
                await assert.rejects(child.getKey(true), /cannot be used with a proxy/);
                assert.strictEqual(calls.length, 0);
            } finally { child.dispose(); }
        }
        for (const kind of ['openrouter', undefined] as const) {
            const child = new OpenRouterChatProvider(memorySecrets(), memoryState(), { kind });
            try {
                await child.setKey('sk-or-v1-direct-test');
                assert.strictEqual(await child.getKey(true), 'sk-or-v1-direct-test');
            } finally { child.dispose(); }
        }
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
    test('keyless proxy discovery and inference omit Authorization and never borrow a direct connection key', async () => {
        await registry.storeKey(registry.list()[0].id, 'direct-key');
        const connection = await registry.add({ name: 'Gateway', kind: 'gateway', baseUrl: 'https://gateway.test/v1' });
        const [keylessModel] = await models(connection);
        await request(keylessModel, 'keyless-proxy-chat');
        assert.ok(calls.some(call => call.url.endsWith('/models')));
        assert.ok(calls.some(call => call.url.endsWith('/chat/completions')));
        assert.ok(calls.every(call => !new Headers(call.init?.headers).has('Authorization')));
        assert.strictEqual(JSON.parse(String(calls.find(call => call.init?.method === 'POST')!.init?.body)).session_id,
            'copilot-chat:keyless-proxy-chat');
        calls.length = 0;
        await registry.storeKey(connection.id, 'gateway-key');
        const [model] = await models(connection);
        await request(model);
        assert.ok(calls.every(call => new Headers(call.init?.headers).get('Authorization') === 'Bearer gateway-key'));
        assert.ok(calls.every(call => call.url.startsWith('https://gateway.test/v1/')));
        assert.ok(calls.every(call => call.init?.redirect === 'error'));
    });

    test('a keyless proxy that requires authentication fails closed instead of offering a manual fallback', async () => {
        const connection = await registry.add({ name: 'Protected proxy', kind: 'gateway',
            baseUrl: 'https://protected.test/v1' });
        fetcher = async () => new Response('Authentication required', { status: 401 });
        await assert.rejects(models(connection));
        const child = router.getProvider(connection.id)!;
        await assert.rejects(child.provideLanguageModelChatResponse({ id: 'unlisted' } as never, [], {
            toolMode: vscode.LanguageModelChatToolMode.Auto,
        }, { report() {} }, token));
        assert.ok(calls.length >= 2);
        assert.ok(calls.every(call => call.url === 'https://protected.test/v1/models'));
        assert.ok(calls.every(call => !new Headers(call.init?.headers).has('Authorization')));
        assert.strictEqual(await registry.readKey(connection.id), undefined);
    });

    test('direct OpenRouter discovery and inference remain key-gated', async () => {
        const connection = registry.list()[0];
        assert.deepStrictEqual(await models(connection), []);
        const child = router.getProvider(connection.id)!;
        await assert.rejects(child.provideLanguageModelChatResponse({ id: 'anthropic/shared' } as never, [], {
            toolMode: vscode.LanguageModelChatToolMode.Auto,
        }, { report() {} }, token), /OpenRouter key not configured/);
        assert.strictEqual(calls.length, 0);
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
        const current = registry.get(connection.id)!;
        await assert.rejects(request({ ...model, id: connectionModelId(connection.id, 'unlisted', current.routingRevision),
            version: JSON.stringify(['unlisted', current.revision]) }), /unavailable in the gateway catalog/);
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
        router.dispose(); router = new ConnectionChatProvider(registry, true);
        history = router.getSessionCosts(connection.id);
        assert.strictEqual(history.length, 2);
        const unknown = history.find(session => session.sessionId === 'copilot-chat:unknown-cost')!;
        const free = history.find(session => session.sessionId === 'copilot-chat:reported-free')!;
        assert.strictEqual(unknown.paid, 0.25); assert.strictEqual(unknown.costUnavailable, true);
        assert.strictEqual(unknown.promptTokens, 8); assert.strictEqual(free.paid, 0);
        assert.strictEqual(free.calls, 1); assert.strictEqual(free.costUnavailable, undefined);
    });
    test('independent profile windows merge spend and restore parent attribution only for the same workspace', async () => {
        const directory = await fs.mkdtemp(join(tmpdir(), 'openrouter-spend-'));
        const state = memoryState();
        const credentials = memorySecrets();
        const stores: ConnectionRegistry[] = [];
        const windows: ConnectionChatProvider[] = [];
        const connectionId = LEGACY_CONNECTION_ID;
        const legacySpend = {
            sessionId: 'copilot-chat:legacy-chat', paid: 0.125, calls: 1, updatedAt: Date.now(), routes: [],
        };
        await state.update('sessionCosts', [legacySpend]);
        await state.update('parentSession', { sessionId: 'copilot-chat:legacy-parent', at: Date.now() });
        fetcher = async (url) => {
            if (url.endsWith('/models')) { return Response.json({ data: [{ id: 'anthropic/shared' }] }); }
            if (url.endsWith('/presets')) { return Response.json({ data: [] }); }
            return completed();
        };
        async function openWorkspace(workspaceId: string) {
            const store = new ConnectionRegistry(state, credentials, directory);
            stores.push(store);
            await store.initialize({ hideUnavailableModels: false });
            const window = new ConnectionChatProvider(store, false, workspaceId);
            windows.push(window);
            return { store, window };
        }
        async function select(window: ConnectionChatProvider) {
            const [model] = await window.provideLanguageModelChatInformation({
                silent: true, configuration: { connectionId },
            } as never, token);
            return model;
        }
        function run(window: ConnectionChatProvider, model: vscode.LanguageModelChatInformation, id?: string) {
            const modelOptions = { _capturingTokenCorrelationId: 'marker', ...(id ? { _conversationId: id } : {}) };
            return window.provideLanguageModelChatResponse(model, [], {
                toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions,
            }, { report() {} }, token);
        }
        function lastPostedSession(): string | undefined {
            const post = calls.filter(call => call.init?.method === 'POST').at(-1);
            return post ? JSON.parse(String(post.init?.body)).session_id : undefined;
        }
        try {
            const a = await openWorkspace('workspace-a');
            await a.store.storeKey(connectionId, 'fixture-key');
            const b = await openWorkspace('workspace-b');
            const [modelA, modelB] = await Promise.all([select(a.window), select(b.window)]);
            await run(a.window, modelA);
            assert.strictEqual(lastPostedSession(), undefined, 'the old global parent has no workspace provenance');
            await Promise.all([run(a.window, modelA, 'shared'), run(b.window, modelB, 'shared')]);
            await Promise.all([run(a.window, modelA, 'chat-a'), run(b.window, modelB, 'chat-b')]);
            for (const window of [a.window, b.window]) {
                const history = new Map(window.getSessionCosts(connectionId).map(session => [session.sessionId, session]));
                assert.strictEqual(history.get('copilot-chat:legacy-chat')?.paid, 0.125);
                assert.strictEqual(history.get('copilot-chat:shared')?.paid, 0.5);
                assert.strictEqual(history.get('copilot-chat:chat-a')?.paid, 0.25);
                assert.strictEqual(history.get('copilot-chat:chat-b')?.paid, 0.25);
            }

            const c = await openWorkspace('workspace-c');
            const modelC = await select(c.window);
            await run(c.window, modelC);
            assert.strictEqual(lastPostedSession(), undefined, 'an unrelated workspace cannot inherit a parent');
            const reloadedA = await openWorkspace('workspace-a');
            const modelReloadedA = await select(reloadedA.window);
            await run(reloadedA.window, modelReloadedA);
            assert.strictEqual(lastPostedSession(), 'copilot-chat:chat-a');
            const history = reloadedA.window.getSessionCosts(connectionId);
            assert.strictEqual(history.find(session => session.sessionId === 'copilot-chat:chat-a')?.paid, 0.5);
            assert.strictEqual(history.find(session => session.sessionId === UNATTRIBUTED_SESSION_ID)?.paid, 0.5);

            for (let index = 0; index < MAX_TRACKED_SESSIONS; index++) {
                await run(index % 2 ? a.window : b.window, index % 2 ? modelA : modelB, `bounded-${index}`);
            }
            const bounded = reloadedA.window.getSessionCosts(connectionId);
            assert.strictEqual(bounded.length, MAX_TRACKED_SESSIONS);
            assert.ok(bounded.some(session => session.sessionId === UNATTRIBUTED_SESSION_ID));
            assert.strictEqual(bounded[0].sessionId, `copilot-chat:bounded-${MAX_TRACKED_SESSIONS - 1}`);
            assert.ok(!bounded.some(session => session.sessionId === 'copilot-chat:bounded-0'));

            let startRequest!: () => void;
            let finishRequest!: (response: Response) => void;
            const started = new Promise<void>(resolve => { startRequest = resolve; });
            const response = new Promise<Response>(resolve => { finishRequest = resolve; });
            const previousFetcher = fetcher;
            fetcher = async (url, init) => {
                if (init?.method !== 'POST') { return previousFetcher(url, init); }
                startRequest();
                return response;
            };
            const late = run(a.window, modelA, 'late-request');
            await started;
            try {
                await b.store.remove(connectionId);
            } finally {
                finishRequest(completed());
            }
            await late;
            assert.deepStrictEqual(reloadedA.window.getSessionCosts(connectionId), []);
            const disk = new ProfileStorage(directory);
            try {
                assert.ok(!disk.keys().some(key => key.startsWith(`connections.${connectionId}.`)));
            } finally {
                disk.dispose();
            }
        } finally {
            for (const window of windows) { window.dispose(); }
            for (const store of stores) { store.dispose(); }
            await tick();
            await fs.rm(directory, { recursive: true, force: true });
        }
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
        release(new Response('retry', { status: 429 })); await pending;
        const requests = calls.filter(call => call.init?.method === 'POST');
        assert.strictEqual(requests.length, 2);
        assert.ok(requests.every(call => new Headers(call.init?.headers).get('Authorization') === 'Bearer old-key'));
        assert.ok(requests.every(call => JSON.parse(String(call.init?.body)).temperature === 0.1));
        assert.strictEqual(router.getSessionCosts(connection.id)[0].paid, 0.25);
    });
});
