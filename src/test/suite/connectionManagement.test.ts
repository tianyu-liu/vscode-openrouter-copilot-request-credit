import * as assert from 'assert';
import { ConnectionRegistry, type ConnectionDefinition, type ConnectionPatch } from '../../connections';
import * as vscode from 'vscode';
import { removeConnectionWithGroup, updateConnectionWithGroup } from '../../extension';

function fixture() {
    let connection: ConnectionDefinition = {
        id: 'local', name: 'Local', kind: 'openai-compatible', baseUrl: 'http://localhost:8000/v1',
        enabled: true, revision: 1,
        settings: { creditLimit: 0, creditResetPeriod: 'daily', creditIncludeByok: true, hideUnavailableModels: true },
        models: [{ id: 'model-a', contextLength: 8192 }],
    };
    const copy = (): ConnectionDefinition => JSON.parse(JSON.stringify(connection));
    const store = {
        get: (id: string) => id === connection.id ? copy() : undefined,
        update: async (id: string, patch: ConnectionPatch) => {
            assert.strictEqual(id, connection.id);
            connection = { ...connection, ...patch, settings: { ...connection.settings, ...patch.settings },
                revision: connection.revision + 1 };
            return copy();
        },
    };
    return { store, snapshot: copy };
}

suite('connection metadata and native group edits', () => {
    test('a failed rename restores the endpoint and all metadata from the same Save action', async () => {
        const { store, snapshot } = fixture();
        const before = snapshot();
        await assert.rejects(() => updateConnectionWithGroup(store, {
            update: async () => { throw new Error('Native configuration is dirty'); },
        }, before.id, {
            name: 'Renamed', baseUrl: 'http://localhost:9000/v1', enabled: false,
            settings: { creditLimit: 25 }, models: [{ id: 'model-b', contextLength: 16384 }],
        }), /Native configuration is dirty/);
        const after = snapshot();
        assert.deepStrictEqual({ ...after, revision: before.revision }, before);
        assert.strictEqual(after.revision, before.revision, 'a rejected native edit never changes the connection');
    });

    test('successful rename synchronizes the same permanent identity and retains endpoint edits', async () => {
        const { store, snapshot } = fixture();
        const groups: Array<{ id: string; name: string }> = [];
        const result = await updateConnectionWithGroup(store, {
            update: async connection => { groups.push({ id: connection.id, name: connection.name }); },
        }, 'local', { name: 'Renamed', baseUrl: 'http://localhost:9000/v1' });
        assert.deepStrictEqual(groups, [{ id: 'local', name: 'Renamed' }]);
        assert.strictEqual(result.baseUrl, 'http://localhost:9000/v1');
        assert.deepStrictEqual(result, snapshot());
    });

    test('non-name settings changes do not open native configuration', async () => {
        const { store } = fixture();
        const result = await updateConnectionWithGroup(store, {
            update: async () => { assert.fail('Native configuration must stay closed'); },
        }, 'local', { settings: { creditLimit: 12 } });
        assert.strictEqual(result.settings.creditLimit, 12);
    });

    test('rotating a key with the same connection name does not open the native configuration', async () => {
        const { store, snapshot } = fixture();
        const before = snapshot();
        await updateConnectionWithGroup({
            get: store.get,
            update: async (id, patch, key) => {
                assert.strictEqual(key, 'replacement-key');
                return store.update(id, patch);
            },
        }, {
            update: async () => { assert.fail('Native configuration must stay closed'); },
        }, before.id, { name: before.name }, 'replacement-key');
    });

    test('a native rename failure leaves the saved endpoint and credential untouched', async () => {
        const values = new Map<string, unknown>();
        const keys = new Map<string, string>();
        const registry = new ConnectionRegistry({
            keys: () => [...values.keys()],
            get: ((key: string) => values.get(key)) as vscode.Memento['get'],
            update: async (key, value) => { values.set(key, value); },
        }, {
            keys: async () => [...keys.keys()], get: async key => keys.get(key),
            store: async (key, value) => { keys.set(key, value); },
            delete: async key => { keys.delete(key); },
            onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
        });
        await registry.initialize();
        const connection = await registry.add({ name: 'Local', kind: 'openai-compatible',
            baseUrl: 'https://one.test/v1' }, 'old-key');
        for (const apiKey of ['new-key', null]) {
            await assert.rejects(updateConnectionWithGroup(registry, {
                update: async () => { throw new Error('Native configuration is dirty'); },
            }, connection.id, { name: 'Renamed', baseUrl: 'https://two.test/v1' }, apiKey), /dirty/);
            assert.deepStrictEqual(registry.get(connection.id), connection);
            assert.strictEqual(await registry.readKey(connection.id), 'old-key');
        }
        registry.dispose();
    });

    test('a registry save failure restores the previous native group name and forwards the key action', async () => {
        const { store, snapshot } = fixture();
        const names: string[] = [];
        await assert.rejects(updateConnectionWithGroup({
            get: store.get,
            update: async (_id, _patch, apiKey) => {
                assert.strictEqual(apiKey, 'replacement-key');
                throw new Error('Credential storage failed');
            },
        }, { update: async connection => { names.push(connection.name); } }, 'local',
        { name: ' Renamed ' }, 'replacement-key'), /Credential storage failed/);
        assert.deepStrictEqual(names, ['Renamed', snapshot().name]);
        assert.strictEqual(snapshot().revision, 1);
    });

    test('cleanup failure after a committed save keeps the matching native group name', async () => {
        const { store, snapshot } = fixture();
        const names: string[] = [];
        await assert.rejects(updateConnectionWithGroup({
            get: store.get,
            update: async (id, patch) => {
                await store.update(id, patch);
                throw new Error('Old credential cleanup failed');
            },
        }, { update: async connection => { names.push(connection.name); } }, 'local',
        { name: 'Renamed' }, null), /cleanup failed/);
        assert.deepStrictEqual(names, ['Renamed']);
        assert.strictEqual(snapshot().name, 'Renamed');
    });

    test('a registry removal failure restores the native group if the connection still exists', async () => {
        const { store, snapshot } = fixture();
        const before = snapshot();
        const events: string[] = [];
        await assert.rejects(removeConnectionWithGroup({
            get: store.get,
            remove: async () => { events.push('registry remove'); throw new Error('Storage failed'); },
        }, {
            remove: async id => {
                assert.strictEqual(id, before.id);
                events.push('native remove');
                return async () => { events.push('native restore'); };
            },
        }, before.id), /Storage failed/);
        assert.deepStrictEqual(events, ['native remove', 'registry remove', 'native restore']);
    });

    test('cleanup failure after committed removal leaves the native group deleted', async () => {
        const { snapshot } = fixture();
        const before = snapshot();
        let exists = true;
        await assert.rejects(removeConnectionWithGroup({
            get: () => exists ? before : undefined,
            remove: async () => { exists = false; throw new Error('Old credential cleanup failed'); },
        }, {
            remove: async () => async () => { assert.fail('A committed deletion must not restore the native group'); },
        }, before.id), /cleanup failed/);
        assert.strictEqual(exists, false);
    });
});
