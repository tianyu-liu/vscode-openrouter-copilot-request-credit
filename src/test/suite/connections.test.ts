import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    ConnectionRegistry, LEGACY_CONNECTION_ID, OPENROUTER_BASE_URL,
} from '../../connections';
import { clearStoredKey, readKey, storeKey } from '../../storage';

const REGISTRY = 'connectionRegistry.v1';
const LEGACY = 'openrouterCopilot.apiKey';
const CURRENT = 'openrouterApiKey';
const MIGRATED_KEYS = [
    'requestTemplate', 'contextCaps', 'contextCapsBase', 'contextMarginPercent', 'sessionCosts', 'parentSession',
];
function copy<T>(value: T): T { return value === undefined ? value : JSON.parse(JSON.stringify(value)); }

function fixture(legacyKey?: string, useOldAlias = false) {
    const values = new Map<string, unknown>();
    const credentials = new Map<string, string>();
    if (legacyKey !== undefined) credentials.set(useOldAlias ? LEGACY : CURRENT, legacyKey);
    const calls: string[] = [];
    const failure = { at: -1 };
    function operation(name: string): void {
        calls.push(name);
        if (calls.length === failure.at) throw new Error(`Injected failure: ${name}`);
    }
    const state: vscode.Memento = {
        keys: () => [...values.keys()],
        get: (<T>(key: string, fallback?: T) => {
            operation(`state.get:${key}`);
            return copy(values.has(key) ? values.get(key) as T : fallback);
        }) as vscode.Memento['get'],
        update: async (key, value) => {
            operation(`state.update:${key}`);
            if (value === undefined) values.delete(key);
            else values.set(key, copy(value));
        },
    };
    const changes = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
    const secrets: vscode.SecretStorage = {
        keys: async () => [...credentials.keys()],
        get: async key => { operation(`secret.get:${key}`); return credentials.get(key); },
        store: async (key, value) => {
            operation(`secret.store:${key}`);
            credentials.set(key, value);
            changes.fire({ key });
        },
        delete: async key => {
            operation(`secret.delete:${key}`);
            credentials.delete(key);
            changes.fire({ key });
        },
        onDidChange: changes.event,
    };
    return { state, secrets, values, credentials, calls, failure };
}
function populateLegacy(data: ReturnType<typeof fixture>): void {
    for (const [index, key] of MIGRATED_KEYS.entries()) data.values.set(key, { index, nested: [key] });
}

suite('connection registry', () => {
    test('migrates the existing key, preferences and history into only the default connection', async () => {
        const data = fixture('sk-existing');
        populateLegacy(data);
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await registry.initialize({ creditLimit: 7, creditResetPeriod: 'weekly' });
        assert.deepStrictEqual(registry.list().map(item => [item.id, item.name, item.baseUrl]), [
            [LEGACY_CONNECTION_ID, 'OpenRouter: RC', OPENROUTER_BASE_URL],
        ]);
        assert.strictEqual(registry.get(LEGACY_CONNECTION_ID)!.settings.creditLimit, 7);
        assert.strictEqual(registry.get(LEGACY_CONNECTION_ID)!.settings.creditResetPeriod, 'weekly');
        assert.strictEqual(await registry.readKey(LEGACY_CONNECTION_ID), 'sk-existing');
        for (const [index, key] of MIGRATED_KEYS.entries()) {
            assert.deepStrictEqual(registry.stateFor(LEGACY_CONNECTION_ID).get(key), { index, nested: [key] });
            assert.strictEqual(data.values.has(key), false);
        }
        assert.strictEqual(data.credentials.has(CURRENT), false);
        const second = await registry.add({ name: 'Second', kind: 'openrouter' });
        assert.strictEqual(await registry.readKey(second.id), undefined);
        assert.strictEqual(registry.stateFor(second.id).get('requestTemplate'), undefined);
        registry.dispose();
    });

    test('migrates the older secret alias and gives the primary alias precedence', async () => {
        for (const primary of [undefined, 'sk-primary']) {
            const data = fixture('sk-old', true);
            if (primary) data.credentials.set(CURRENT, primary);
            const registry = new ConnectionRegistry(data.state, data.secrets);
            await registry.initialize();
            assert.strictEqual(await registry.readKey(LEGACY_CONNECTION_ID), primary ?? 'sk-old');
            assert.ok(!data.credentials.has(LEGACY));
            registry.dispose();
        }
    });

    test('initializes without a key, remains idempotent, and never resurrects intentionally removed connections', async () => {
        const data = fixture();
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await Promise.all([registry.initialize(), registry.initialize()]);
        assert.strictEqual(registry.list().length, 1);
        assert.strictEqual(await registry.readKey(LEGACY_CONNECTION_ID), undefined);
        await registry.remove(LEGACY_CONNECTION_ID);
        await registry.initialize();
        assert.deepStrictEqual(registry.list(), []);
        registry.dispose();
        const restarted = new ConnectionRegistry(data.state, data.secrets);
        await restarted.initialize();
        assert.deepStrictEqual(restarted.list(), []);
        restarted.dispose();
    });

    test('each migration read, copy, commit and cleanup failure is retryable without losing legacy data', async () => {
        const baseline = fixture('sk-original', true);
        populateLegacy(baseline);
        const initial = new ConnectionRegistry(baseline.state, baseline.secrets);
        await initial.initialize();
        const operations = baseline.calls.length;
        initial.dispose();
        for (let failureAt = 1; failureAt <= operations; failureAt++) {
            const data = fixture('sk-original', true);
            populateLegacy(data);
            data.failure.at = failureAt;
            const interrupted = new ConnectionRegistry(data.state, data.secrets);
            await assert.rejects(interrupted.initialize(), /Injected failure/);
            if (!data.values.has(REGISTRY)) {
                assert.strictEqual(data.credentials.get(LEGACY), 'sk-original', `failure ${failureAt}`);
                for (const key of MIGRATED_KEYS) assert.ok(data.values.has(key), `failure ${failureAt}: ${key}`);
            }
            data.failure.at = -1;
            // Recover on the same object first, then reopen persisted state as a fresh extension activation.
            await interrupted.initialize();
            assert.strictEqual(await interrupted.readKey(LEGACY_CONNECTION_ID), 'sk-original');
            interrupted.dispose();
            const recovered = new ConnectionRegistry(data.state, data.secrets);
            await recovered.initialize();
            assert.strictEqual(recovered.list().length, 1, `failure ${failureAt}`);
            assert.strictEqual(await recovered.readKey(LEGACY_CONNECTION_ID), 'sk-original', `failure ${failureAt}`);
            for (const [index, key] of MIGRATED_KEYS.entries()) {
                assert.deepStrictEqual(recovered.stateFor(LEGACY_CONNECTION_ID).get(key), { index, nested: [key] });
            }
            assert.strictEqual(data.credentials.size, 1);
            recovered.dispose();
        }
    });

    test('a failed credential read cannot create a keyless migration marker', async () => {
        const data = fixture('sk-original');
        data.failure.at = 2; // registry get succeeded; primary key read fails.
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await assert.rejects(registry.initialize(), /Injected failure/);
        assert.strictEqual(data.values.has(REGISTRY), false);
        assert.strictEqual(data.credentials.get(CURRENT), 'sk-original');
        data.failure.at = -1;
        await registry.initialize();
        assert.strictEqual(await registry.readKey(LEGACY_CONNECTION_ID), 'sk-original');
        registry.dispose();
    });

    test('connection state and credentials stay isolated across rename, reload and storage helper aliases', async () => {
        const data = fixture('sk-first');
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await registry.initialize();
        const second = await registry.add({ name: 'Local', kind: 'openai-compatible', baseUrl: 'http://localhost:9000/v1/' });
        const firstState = registry.stateFor(LEGACY_CONNECTION_ID);
        const secondState = registry.stateFor(second.id);
        await firstState.update('sessionCosts', { chat: 1 });
        await secondState.update('sessionCosts', { chat: 2 });
        await storeKey(registry.secretsFor(second.id), 'sk-second');
        assert.strictEqual(await readKey(registry.secretsFor(LEGACY_CONNECTION_ID)), 'sk-first');
        assert.strictEqual(await readKey(registry.secretsFor(second.id)), 'sk-second');
        await registry.update(second.id, { name: 'Renamed' });
        assert.deepStrictEqual(secondState.get('sessionCosts'), { chat: 2 });
        assert.deepStrictEqual(firstState.get('sessionCosts'), { chat: 1 });
        assert.deepStrictEqual(secondState.keys(), ['sessionCosts']);
        registry.dispose();
        const restarted = new ConnectionRegistry(data.state, data.secrets);
        await restarted.initialize();
        assert.strictEqual(restarted.get(second.id)!.name, 'Renamed');
        assert.strictEqual(await restarted.readKey(second.id), 'sk-second');
        assert.deepStrictEqual(restarted.stateFor(second.id).get('sessionCosts'), { chat: 2 });
        await clearStoredKey(restarted.secretsFor(second.id));
        assert.strictEqual(await restarted.readKey(second.id), undefined);
        assert.strictEqual(await restarted.readKey(LEGACY_CONNECTION_ID), 'sk-first');
        restarted.dispose();
    });

    test('snapshots cannot mutate registry definitions or scoped values', async () => {
        const data = fixture();
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await registry.initialize();
        const added = await registry.add({ name: 'Custom', kind: 'openai-compatible', baseUrl: 'https://example.test/v1',
            models: [{ id: 'a', contextLength: 2048, toolCalling: false }] });
        added.settings.creditLimit = 100;
        registry.list()[1].models![0].id = 'mutated';
        assert.strictEqual(registry.get(added.id)!.settings.creditLimit, 0);
        assert.strictEqual(registry.get(added.id)!.models![0].id, 'a');
        const scoped = registry.stateFor(added.id);
        const source = { temperature: 0.5 };
        const writing = scoped.update('requestTemplate', source);
        source.temperature = 1;
        await writing;
        scoped.get<typeof source>('requestTemplate')!.temperature = 2;
        assert.strictEqual(scoped.get<typeof source>('requestTemplate')!.temperature, 0.5);
        registry.dispose();
    });

    test('definition and credential changes advance revisions; scoped history writes do not', async () => {
        const data = fixture();
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await registry.initialize();
        let events = 0;
        registry.onDidChange(() => events++);
        await registry.stateFor(LEGACY_CONNECTION_ID).update('sessionCosts', { x: 1 });
        assert.strictEqual(events, 0);
        assert.strictEqual(registry.get(LEGACY_CONNECTION_ID)!.revision, 1);
        await registry.update(LEGACY_CONNECTION_ID, { settings: { creditLimit: 5 } });
        await registry.storeKey(LEGACY_CONNECTION_ID, 'sk-new');
        await registry.clearKey(LEGACY_CONNECTION_ID);
        assert.strictEqual(registry.get(LEGACY_CONNECTION_ID)!.revision, 4);
        assert.strictEqual(events, 3);
        registry.dispose();
    });

    test('failed rotations preserve the previously committed key and reclaim staging slots on retry', async () => {
        // Rotation performs: staging metadata, secret store, final metadata, old secret delete, cleanup metadata.
        for (let step = 1; step <= 5; step++) {
            const data = fixture('sk-original');
            const registry = new ConnectionRegistry(data.state, data.secrets);
            await registry.initialize();
            data.failure.at = data.calls.length + step;
            await assert.rejects(registry.storeKey(LEGACY_CONNECTION_ID, 'sk-replacement'), /Injected failure/);
            data.failure.at = -1;
            assert.strictEqual(await registry.readKey(LEGACY_CONNECTION_ID), step <= 3 ? 'sk-original' : 'sk-replacement');
            await registry.initialize();
            assert.strictEqual(data.credentials.size, 1, `rotation step ${step}`);
            await registry.storeKey(LEGACY_CONNECTION_ID, 'sk-retry');
            assert.strictEqual(await registry.readKey(LEGACY_CONNECTION_ID), 'sk-retry');
            assert.strictEqual(data.credentials.size, 1);
            registry.dispose();
        }
    });

    test('queued deletion blocks stale scoped writes and credential reads without legacy fallback', async () => {
        const data = fixture('sk-existing');
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await registry.initialize();
        const scoped = registry.stateFor(LEGACY_CONNECTION_ID);
        const secrets = registry.secretsFor(LEGACY_CONNECTION_ID);
        await scoped.update('requestTemplate', { temperature: 0.5 });
        const deletion = registry.remove(LEGACY_CONNECTION_ID);
        const staleWrite = scoped.update('sessionCosts', { zombie: 1 });
        const staleStore = registry.storeKey(LEGACY_CONNECTION_ID, 'sk-zombie');
        await deletion;
        await assert.rejects(Promise.resolve(staleWrite), /no longer exists/);
        await assert.rejects(staleStore, /no longer exists/);
        await assert.rejects(Promise.resolve(secrets.get(CURRENT)), /no longer exists/);
        assert.strictEqual(scoped.get('requestTemplate'), undefined);
        assert.deepStrictEqual(scoped.keys(), []);
        assert.deepStrictEqual([...data.credentials], []);
        const replacement = await registry.add({ name: 'OpenRouter', kind: 'openrouter' });
        assert.notStrictEqual(replacement.id, LEGACY_CONNECTION_ID);
        assert.strictEqual(await registry.readKey(replacement.id), undefined);
        registry.dispose();
    });

    test('each deletion failure preserves a committed definition or a recoverable deletion', async () => {
        // Removal performs: metadata, secret deletion, scoped-state deletion, cleanup metadata.
        for (let step = 1; step <= 4; step++) {
            const data = fixture('sk-existing');
            const registry = new ConnectionRegistry(data.state, data.secrets);
            await registry.initialize();
            await registry.stateFor(LEGACY_CONNECTION_ID).update('sessionCosts', { chat: 1 });
            data.failure.at = data.calls.length + step;
            await assert.rejects(registry.remove(LEGACY_CONNECTION_ID), /Injected failure/);
            assert.strictEqual(registry.list().length, step === 1 ? 1 : 0);
            registry.dispose();
            data.failure.at = -1;
            const restarted = new ConnectionRegistry(data.state, data.secrets);
            await restarted.initialize();
            assert.strictEqual(restarted.list().length, step === 1 ? 1 : 0);
            assert.strictEqual(data.credentials.size, step === 1 ? 1 : 0);
            restarted.dispose();
        }
    });

    test('scoped credential failures reject and never fall back to a legacy key', async () => {
        const data = fixture('sk-existing');
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await registry.initialize();
        data.credentials.set(CURRENT, 'sk-other');
        data.credentials.set(LEGACY, 'sk-other-legacy');
        data.failure.at = data.calls.length + 1;
        await assert.rejects(registry.readKey(LEGACY_CONNECTION_ID), /Injected failure/);
        data.failure.at = -1;
        assert.strictEqual(await registry.readKey(LEGACY_CONNECTION_ID), 'sk-existing');
        await registry.clearKey(LEGACY_CONNECTION_ID);
        assert.strictEqual(await registry.readKey(LEGACY_CONNECTION_ID), undefined);
        registry.dispose();
    });

    test('invalid persisted registries fail without resetting connections or adopting legacy credentials', async () => {
        const data = fixture('sk-legacy');
        data.values.set(REGISTRY, { version: 99, connections: [] });
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await assert.rejects(registry.initialize(), /Invalid connection registry/);
        assert.deepStrictEqual(data.values.get(REGISTRY), { version: 99, connections: [] });
        assert.strictEqual(data.credentials.get(CURRENT), 'sk-legacy');
        registry.dispose();
    });

    test('failed mutations do not poison the queue or emit successful-change events', async () => {
        const data = fixture();
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await registry.initialize();
        let events = 0;
        registry.onDidChange(() => events++);
        data.failure.at = data.calls.length + 1;
        await assert.rejects(registry.add({ name: 'Failed', kind: 'openrouter' }), /Injected failure/);
        assert.strictEqual(events, 0);
        data.failure.at = -1;
        const added = await registry.add({ name: 'Success', kind: 'openrouter' });
        assert.strictEqual(events, 1);
        assert.ok(registry.get(added.id));
        registry.dispose();
    });

    test('validates names, endpoints, settings and manual metadata before persisting', async () => {
        const data = fixture();
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await registry.initialize();
        for (const name of ['', '   ', 'OPENROUTER: RC']) {
            await assert.rejects(registry.add({ name, kind: 'openrouter' }));
        }
        for (const baseUrl of [
            'http://example.test/v1', 'https://user:pass@example.test/v1',
            'https://example.test/v1?key=secret', 'https://example.test/v1#secret', 'file:///tmp/api',
        ]) await assert.rejects(registry.add({ name: 'Bad', kind: 'openai-compatible', baseUrl }));
        await assert.rejects(registry.add({ name: 'Bad', kind: 'openrouter', baseUrl: 'https://example.test/v1' }));
        await assert.rejects(registry.update(LEGACY_CONNECTION_ID, { settings: { creditLimit: -1 } }));
        await assert.rejects(registry.update(LEGACY_CONNECTION_ID, { settings: { creditLimit: Infinity } }));
        await assert.rejects(registry.update(LEGACY_CONNECTION_ID, {
            settings: { creditResetPeriod: 'hourly' as 'daily' },
        }));
        for (const models of [[{ id: '' }], [{ id: 'a' }, { id: ' a ' }], [{ id: 'a', contextLength: 0 }],
            [{ id: 'a', maxOutputTokens: 1.5 }], [{ id: 'a', toolCalling: 'yes' as unknown as boolean }]]) {
            await assert.rejects(registry.update(LEGACY_CONNECTION_ID, { models }));
        }
        assert.strictEqual(registry.list().length, 1);
        assert.strictEqual(registry.get(LEGACY_CONNECTION_ID)!.revision, 1);
        for (const baseUrl of ['http://localhost:8000/v1/', 'http://127.0.0.1:8000/v1/', 'http://[::1]:8000/v1/']) {
            const added = await registry.add({ name: baseUrl, kind: 'openai-compatible', baseUrl });
            assert.strictEqual(added.baseUrl, baseUrl.slice(0, -1));
        }
        registry.dispose();
    });

    test('gateway connections retain their own endpoint and credential and reject manual models', async () => {
        const data = fixture();
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await registry.initialize();
        const gateway = await registry.add({ name: 'Gateway', kind: 'gateway', baseUrl: 'https://gateway.test/v1/' });
        assert.strictEqual(gateway.baseUrl, 'https://gateway.test/v1');
        assert.strictEqual(gateway.kind, 'gateway');
        await registry.storeKey(LEGACY_CONNECTION_ID, 'direct-key');
        assert.strictEqual(await registry.readKey(gateway.id), undefined);
        await registry.storeKey(gateway.id, 'gateway-key');
        assert.strictEqual(await registry.readKey(LEGACY_CONNECTION_ID), 'direct-key');
        assert.strictEqual(await registry.readKey(gateway.id), 'gateway-key');
        await assert.rejects(registry.update(gateway.id, { models: [{ id: 'unlisted' }] }), /filtered catalog/);
        await assert.rejects(registry.update(gateway.id, { baseUrl: 'https://other.test/v1' }), /Clear.*credential/);
        await assert.rejects(registry.add({ name: 'Insecure', kind: 'gateway', baseUrl: 'http://gateway.test/v1' }));
        registry.dispose();
    });

    test('endpoint edits cannot forward an existing credential to a new origin', async () => {
        const data = fixture();
        const registry = new ConnectionRegistry(data.state, data.secrets);
        await registry.initialize();
        const custom = await registry.add({ name: 'Custom', kind: 'openai-compatible', baseUrl: 'https://one.test/v1' });
        await registry.storeKey(custom.id, 'sk-private');
        await assert.rejects(registry.update(custom.id, { baseUrl: 'https://two.test/v1' }), /Clear.*credential/);
        await assert.rejects(registry.update(custom.id, { kind: 'openrouter' }), /endpoint type/);
        await registry.clearKey(custom.id);
        await registry.update(custom.id, { baseUrl: 'https://two.test/v1' });
        assert.strictEqual(await registry.readKey(custom.id), undefined);
        registry.dispose();
    });
});
