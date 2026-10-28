import * as assert from 'assert';
import type { ConnectionDefinition, ConnectionPatch } from '../../connections';
import { updateConnectionWithGroup } from '../../extension';

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
        assert.ok(after.revision > before.revision, 'stale model selections remain invalidated');
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
});
