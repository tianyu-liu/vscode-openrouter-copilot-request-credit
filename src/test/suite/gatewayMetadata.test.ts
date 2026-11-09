import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildContextCapSchema, buildReasoningSchema, type ModelCatalogEntry } from '../../modelInfo';
import { OpenRouterChatProvider, type ProviderRuntimeConfig } from '../../provider';

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

function memoryState(): vscode.Memento {
    const values = new Map<string, unknown>();
    return {
        keys: () => [...values.keys()],
        get: ((key: string, fallback?: unknown) =>
            values.has(key) ? values.get(key) : fallback) as vscode.Memento['get'],
        update: async (key, value) => { values.set(key, value); },
    };
}

function unusedSecrets(): vscode.SecretStorage {
    const unexpected = async (): Promise<never> => { throw new Error('Unexpected credential storage access'); };
    return {
        keys: unexpected, get: unexpected, store: unexpected, delete: unexpected,
        onDidChange: () => ({ dispose() {} }),
    };
}

suite('gateway catalog metadata', () => {
    let originalFetch: typeof fetch;
    let provider: OpenRouterChatProvider;
    let catalog: unknown[];
    let calls: string[];

    setup(() => {
        originalFetch = globalThis.fetch;
        catalog = [{ id: 'vendor/bare' }];
        calls = [];
        globalThis.fetch = async (url, init) => {
            calls.push(String(url));
            assert.strictEqual(String(url), 'https://gateway.example/v1/models');
            assert.strictEqual(new Headers(init?.headers).get('Authorization'), 'Bearer private-gateway-key');
            assert.strictEqual(init?.redirect, 'error');
            return Response.json({ data: catalog });
        };
        provider = createProvider();
    });

    teardown(() => {
        provider.dispose();
        globalThis.fetch = originalFetch;
    });

    function createProvider(extra: Partial<ProviderRuntimeConfig> = {}): OpenRouterChatProvider {
        return new OpenRouterChatProvider(unusedSecrets(), memoryState(), {
            kind: 'gateway', baseUrl: 'https://gateway.example/v1', connectionId: 'metadata-test',
            readKey: async () => 'private-gateway-key', ...extra,
        });
    }

    async function models() {
        return provider.provideLanguageModelChatInformation({ silent: true }, token);
    }

    test('id-only entries use conservative budgets and capabilities with unknown pricing', async () => {
        const [model] = await models();
        assert.strictEqual(model.id, 'vendor/bare');
        assert.strictEqual(model.maxInputTokens + model.maxOutputTokens, 8192);
        assert.strictEqual(model.maxOutputTokens, 2048);
        assert.deepStrictEqual(model.capabilities, { toolCalling: false, imageInput: false });
        assert.match(model.detail ?? '', /unknown/i);
        assert.match(model.detail ?? '', /conservative defaults/);
        assert.match(String(model.tooltip), /Pricing: not listed by the endpoint/);
        assert.match(String(model.tooltip), /context window, maximum output tokens, tool calling, image input/);
        assert.doesNotMatch(String(model.tooltip), /Manual models|manual.*override/i);
        assert.deepStrictEqual(calls, ['https://gateway.example/v1/models']);
    });

    test('complete supplied metadata retains capabilities, context and reasoning picker schemas', async () => {
        const entry: ModelCatalogEntry = {
            id: 'vendor/complete', name: 'Gateway Complete', context_length: 1050000,
            top_provider: { max_completion_tokens: 64000 }, supported_parameters: ['tools', 'reasoning'],
            architecture: { input_modalities: ['text', 'image'] },
            pricing: {
                prompt: '0.00000125', completion: '0.00001',
                overrides: [{ min_prompt_tokens: 272000, prompt: '0.0000025', completion: '0.000015' }],
            },
            reasoning: { mandatory: true, supported_efforts: ['high', 'low'], default_effort: 'high' },
        };
        catalog = [entry];
        const [model] = await models();
        assert.strictEqual(model.name, 'Gateway Complete');
        assert.strictEqual(model.maxOutputTokens, 64000);
        assert.ok(model.maxInputTokens + model.maxOutputTokens <= entry.context_length!);
        assert.deepStrictEqual(model.capabilities, { toolCalling: true, imageInput: true });
        assert.doesNotMatch(model.detail ?? '', /conservative defaults|unknown/i);
        assert.doesNotMatch(String(model.tooltip), /Missing endpoint metadata/);
        assert.deepStrictEqual(model.configurationSchema?.properties.reasoningEffort,
            buildReasoningSchema(entry)!.properties.reasoningEffort);
        assert.deepStrictEqual(model.configurationSchema?.properties.contextSize,
            buildContextCapSchema(entry)!.properties.contextSize);
        assert.deepStrictEqual(calls, ['https://gateway.example/v1/models']);
    });

    test('absent or incomplete prices remain unknown instead of appearing free', async () => {
        for (const pricing of [undefined, {}, { prompt: '0' }, { completion: '0' },
            { prompt: '', completion: '0' }, { prompt: 'private-invalid-price', completion: '0' }]) {
            catalog = [{
                id: 'vendor/unpriced', context_length: 16384,
                top_provider: { max_completion_tokens: 2048 }, supported_parameters: [],
                architecture: { input_modalities: ['text'] }, pricing,
            }];
            provider.resetCatalogCache();
            const [model] = await models();
            assert.match(model.detail ?? '', /unknown/i);
            assert.match(String(model.tooltip), /Pricing: not listed by the endpoint/);
            assert.doesNotMatch(String(model.tooltip), /\$0\.000|private-invalid-price/);
            assert.doesNotMatch(model.detail ?? '', /conservative defaults/);
        }
    });

    test('explicit zero prices remain reported rather than being treated as missing', async () => {
        catalog = [{
            id: 'vendor/free', context_length: 16384, top_provider: { max_completion_tokens: 2048 },
            supported_parameters: [], architecture: { input_modalities: ['text'] },
            pricing: { prompt: '0', completion: '0' },
        }];
        const [model] = await models();
        assert.doesNotMatch(model.detail ?? '', /unknown/i);
        assert.doesNotMatch(String(model.tooltip), /not listed by the endpoint/);
    });

    test('zero token metadata on audio entries uses conservative context and output defaults', async () => {
        catalog = [{
            id: 'vendor/audio', context_length: 0,
            top_provider: { context_length: 0, max_completion_tokens: 0 },
            supported_parameters: [], architecture: { input_modalities: ['audio'] },
        }];
        const [model] = await models();
        assert.strictEqual(model.id, 'vendor/audio');
        assert.strictEqual(model.maxInputTokens + model.maxOutputTokens, 8192);
        assert.strictEqual(model.maxOutputTokens, 2048);
        assert.deepStrictEqual(model.capabilities, { toolCalling: false, imageInput: false });
        assert.match(model.detail ?? '', /conservative defaults/);
        assert.match(String(model.tooltip), /context window, maximum output tokens/);
        assert.deepStrictEqual(calls, ['https://gateway.example/v1/models']);
    });

    test('negative and wrongly typed token metadata still reject the filtered catalog', async () => {
        for (const invalid of [-1, '8192', true, {}, []]) {
            for (const entry of [
                { id: 'vendor/invalid', context_length: invalid },
                { id: 'vendor/invalid', top_provider: { context_length: invalid } },
                { id: 'vendor/invalid', top_provider: { max_completion_tokens: invalid } },
            ]) {
                catalog = [entry];
                provider.resetCatalogCache();
                await assert.rejects(models(), /Gateway \/models returned an invalid filtered catalog/);
            }
        }
        assert.strictEqual(calls.length, 15);
    });

    test('gateway runtime without an API base URL rejects before fetching', async () => {
        provider.dispose();
        provider = createProvider({ baseUrl: undefined });
        await assert.rejects(models(), /^Error: A gateway API base URL is required\.$/);
        assert.deepStrictEqual(calls, []);
    });

    test('runtime manual models cannot add unauthorized IDs or override gateway catalog metadata', async () => {
        provider.dispose();
        provider = createProvider({ manualModels: [
            { id: 'vendor/bare', contextLength: 1000000, maxOutputTokens: 64000, toolCalling: true, imageInput: true },
            { id: 'vendor/unauthorized', contextLength: 1000000, toolCalling: true },
        ] });
        const result = await models();
        assert.deepStrictEqual(result.map(model => model.id), ['vendor/bare']);
        assert.strictEqual(result[0].maxInputTokens + result[0].maxOutputTokens, 8192);
        assert.strictEqual(result[0].maxOutputTokens, 2048);
        assert.deepStrictEqual(result[0].capabilities, { toolCalling: false, imageInput: false });
        assert.match(result[0].detail ?? '', /conservative defaults/);
        assert.doesNotMatch(String(result[0].tooltip), /Manual models|manual.*override/i);
        provider.resetCatalogCache();
        catalog = [];
        assert.deepStrictEqual(await models(), []);
        assert.ok(calls.every(url => url === 'https://gateway.example/v1/models'));
    });
});
