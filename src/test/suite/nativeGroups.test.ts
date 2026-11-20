import * as assert from 'assert';
import * as vscode from 'vscode';
import { connectionModelId } from '../../connectionProvider';
import { DEFAULT_CONNECTION_NAME, LEGACY_CONNECTION_ID } from '../../connections';
import { NativeGroupDocument, NativeGroupEdit, NativeGroupHost, NativeGroupManager } from '../../nativeGroups';

const vendor = 'test-vendor';

class ConfigurationDocument implements NativeGroupDocument {
    version = 1;
    isDirty = false;
    isClosed = false;
    saves = 0;
    constructor(public text: string, readonly eol: vscode.EndOfLine) {}
    getText(): string { return this.text; }
    async save(): Promise<boolean> { this.saves++; this.isDirty = false; return true; }
}

function fixture(text: string, eol = text.includes('\r\n') ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF) {
    const document = new ConfigurationDocument(text, eol);
    const host: NativeGroupHost = {
        async openConfiguration() { return document; },
        async applyEdits(_document: NativeGroupDocument, edits: readonly NativeGroupEdit[]) {
            const eolText = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
            // VS Code preserves insertion order for edits at the same offset and normalizes their line endings.
            for (const edit of [...edits].reverse().sort((left, right) => right.start - left.start)) {
                const text = edit.text.replace(/\r?\n/g, eolText);
                document.text = document.text.slice(0, edit.start) + text + document.text.slice(edit.end);
            }
            document.version++;
            document.isDirty = true;
            return true;
        },
    };
    return { document, host, manager: new NativeGroupManager(host, vendor) };
}

suite('Native connection group synchronization', () => {
    test('rename edits only the group name and preserves comments, native settings, and other vendors', async () => {
        const initial = `// active client profile\r\n[\r\n` +
            ` {"vendor":"test-vendor", "name": "Old", "connectionId":"a",\r\n` +
            `  /* keep settings */ "settings":{"a::model":{"context":65536}},},\r\n` +
            ` {"vendor":"other", "name":"Other", "connectionId":"a"},\r\n]\r\n`;
        const { manager, document } = fixture(initial);
        await manager.update({ id: 'a', name: 'New "Work"' });
        assert.strictEqual(document.text, initial.replace('"Old"', '"New \\"Work\\""'));
        assert.strictEqual(document.saves, 1);
        await manager.update({ id: 'a', name: 'New "Work"' });
        assert.strictEqual(document.saves, 1, 'an already synchronized name does not save');
    });

    test('add and remove preserve unrelated JSONC text and never serialize connection secrets', async () => {
        const { manager, document } = fixture('[\n // Keep other vendor\n {"vendor":"other","name":"Other"}\n]');
        const connection = { id: 'a', name: 'Work', apiKey: 'do-not-copy', baseUrl: 'https://private.example' };
        await manager.add(connection);
        assert.ok(document.text.includes('// Keep other vendor'));
        assert.ok(document.text.includes('"connectionId":"a"'));
        assert.ok(!document.text.includes('do-not-copy'));
        assert.ok(!document.text.includes('private.example'));
        await manager.remove('a');
        assert.ok(document.text.includes('{"vendor":"other","name":"Other"}'));
        assert.ok(!document.text.includes('"connectionId":"a"'));
        const saves = document.saves;
        await manager.remove('missing');
        assert.strictEqual(document.saves, saves);
    });

    test('add places the comma before the new group in compact JSON', async () => {
        const original = [{ vendor: 'other', name: 'Other' }];
        const { manager, document } = fixture(JSON.stringify(original));
        await manager.add({ id: 'a', name: 'Work' });
        assert.deepStrictEqual(JSON.parse(document.text), [...original, { vendor, name: 'Work', connectionId: 'a' }]);
        assert.strictEqual(document.saves, 1);
    });

    test('add follows the editor line endings when the existing profile is on one line', async () => {
        const { manager, document } = fixture('[]', vscode.EndOfLine.CRLF);
        await manager.add({ id: 'a', name: 'Work' });
        assert.strictEqual(document.text, '[\r\n\t{"vendor":"test-vendor","name":"Work","connectionId":"a"}\r\n]');
        assert.strictEqual(document.saves, 1);
    });

    test('remove handles the first, last, only, and duplicated matching groups', async () => {
        const group = (id: string) => `{"vendor":"test-vendor","name":"${id}","connectionId":"${id}"}`;
        for (const groups of [group('a'), `${group('a')},${group('b')}`, `${group('b')},${group('a')}`,
            `${group('a')},${group('a')}`, `${group('b')},${group('a')},${group('a')},`]) {
            const { manager, document } = fixture(`[${groups}]`);
            await manager.remove('a');
            assert.ok(!document.text.includes('"connectionId":"a"'));
            if (groups.includes('"connectionId":"b"')) {
                assert.ok(document.text.includes('"connectionId":"b"'));
            }
        }
    });

    test('a deleted group can be restored with its exact settings and comments', async () => {
        const initial = '[\n // Keep\n {"vendor":"test-vendor","name":"Work","connectionId":"a",' +
            '"settings":{/* model preference */"model":{"effort":"high"}}},\n]';
        const { manager, document } = fixture(initial);
        const restore = await manager.remove('a');
        assert.ok(restore);
        assert.ok(!document.text.includes('model preference'));
        await restore();
        assert.strictEqual(document.text, initial);
        assert.strictEqual(document.saves, 2);
    });

    test('restoring a deleted group does not overwrite newer profile changes', async () => {
        const { manager, document } = fixture('[{"vendor":"test-vendor","name":"Work","connectionId":"a"}]');
        const restore = await manager.remove('a');
        assert.ok(restore);
        const edited = '// unrelated change\n' + document.text;
        document.text = edited;
        await assert.rejects(restore, /changed before.*could be restored/);
        assert.strictEqual(document.text, edited);
        assert.strictEqual(document.saves, 1);
    });

    test('restoring a deleted group does not overwrite a change saved during deletion', async () => {
        const initial = '[{"vendor":"test-vendor","name":"Work","connectionId":"a"},' +
            '{"vendor":"other","name":"Other"}]';
        const { manager, document } = fixture(initial);
        const save = document.save.bind(document);
        document.save = async () => {
            document.text = document.text.replace('"Other"', '"Renamed by user"');
            document.version++;
            return save();
        };
        const restore = await manager.remove('a');
        assert.ok(restore);
        assert.strictEqual(document.isDirty, false);
        await assert.rejects(restore, /changed before.*could be restored/);
        assert.deepStrictEqual(JSON.parse(document.text), [{ vendor: 'other', name: 'Renamed by user' }]);
        assert.strictEqual(document.saves, 1);
    });

    test('duplicate native names and connection identities fail without changing the profile', async () => {
        const original = '[{"vendor":"test-vendor","name":"Work","connectionId":"external"}]';
        const { manager, document } = fixture(original);
        await assert.rejects(manager.add({ id: 'a', name: 'Work' }), /already exists/);
        assert.strictEqual(document.text, original);
        assert.strictEqual(document.saves, 0);
        document.text = '[{"vendor":"test-vendor","name":"A","connectionId":"a"},' +
            '{"vendor":"test-vendor","name":"B","connectionId":"a"}]';
        await assert.rejects(manager.update({ id: 'a', name: 'Work' }), /Several native groups/);
    });

    test('unsaved changes and invalid JSONC are never overwritten or saved', async () => {
        const { manager, document } = fixture('[ // user editing\n');
        document.isDirty = true;
        await assert.rejects(manager.add({ id: 'a', name: 'Work' }), /unsaved/);
        document.isDirty = false;
        await assert.rejects(manager.add({ id: 'a', name: 'Work' }), /invalid/);
        assert.strictEqual(document.text, '[ // user editing\n');
        assert.strictEqual(document.saves, 0);
    });

    test('changed text after edit is left unsaved for review', async () => {
        const { manager, host, document } = fixture('[]');
        const apply = host.applyEdits;
        host.applyEdits = async (target, edits) => {
            await apply(target, edits);
            document.text += '\n// simultaneous user edit';
            return true;
        };
        await assert.rejects(manager.add({ id: 'a', name: 'Work' }), /Review the open file/);
        assert.strictEqual(document.saves, 0);
    });

    test('connection operations are serialized and recover after a rejected action', async () => {
        const { manager, document } = fixture('[]');
        await Promise.all([manager.add({ id: 'a', name: 'Personal' }), manager.add({ id: 'b', name: 'Work' })]);
        assert.ok(document.text.includes('"connectionId":"a"'));
        assert.ok(document.text.includes('"connectionId":"b"'));
        await assert.rejects(manager.add({ id: 'c', name: 'Work' }), /already exists/);
        await manager.update({ id: 'b', name: 'Office' });
        assert.ok(document.text.includes('"name":"Office"'));
    });

    test('initial setup adds its group without rewriting existing JSONC', async () => {
        const original = '[\n // Keep the other group\n {"vendor":"other", "name":"Other",},\n]';
        const { manager, document } = fixture(original);
        await manager.repair({ id: LEGACY_CONNECTION_ID, name: DEFAULT_CONNECTION_NAME });
        const added = JSON.stringify({ vendor, name: DEFAULT_CONNECTION_NAME, connectionId: LEGACY_CONNECTION_ID });
        assert.strictEqual(document.text, original.slice(0, -1) + `\n\t${added}\n]`);
    });

    test('explicit migration adopts the original group and preserves all existing JSONC', async () => {
        const modelId = 'provider/model';
        const modelSettings = '{/* keep value formatting */ "context": 65536}';
        const initial = '[\r\n  {\r\n    // Keep the original model settings\r\n' +
            `    "vendor": "${vendor}", "name": "${DEFAULT_CONNECTION_NAME}",\r\n` +
            `    "settings": {"${modelId}": ${modelSettings}},\r\n  },\r\n` +
            `  {"vendor": "other", "name": "${DEFAULT_CONNECTION_NAME}"},\r\n]\r\n`;
        const { manager, document } = fixture(initial);
        const connection = { id: LEGACY_CONNECTION_ID, name: DEFAULT_CONNECTION_NAME };
        await assert.rejects(manager.update(connection), /already exists/);
        await manager.repair(connection);
        const scopedId = connectionModelId(LEGACY_CONNECTION_ID, modelId);
        assert.strictEqual(document.text, initial
            .replace('  {\r\n', `  {\r\n    "connectionId": "${LEGACY_CONNECTION_ID}",\r\n`)
            .replace('"settings": {', `"settings": {"${scopedId}": ${modelSettings},`));
        await manager.repair(connection);
        assert.strictEqual(document.saves, 1);
    });

    test('explicit migration preserves previously configured scoped model settings', async () => {
        const modelId = 'provider/model';
        const scopedId = connectionModelId(LEGACY_CONNECTION_ID, modelId);
        const settings = { [modelId]: { context: 65536 }, [scopedId]: { context: 32768 } };
        const group = { vendor, name: DEFAULT_CONNECTION_NAME, settings };
        const { manager, document } = fixture(JSON.stringify([group]));
        await manager.repair({ id: LEGACY_CONNECTION_ID, name: DEFAULT_CONNECTION_NAME });
        assert.deepStrictEqual(JSON.parse(document.text), [{ ...group, connectionId: LEGACY_CONNECTION_ID }]);
    });

    test('explicit migration leaves ambiguous, already assigned, and nondefault groups untouched', async () => {
        const name = DEFAULT_CONNECTION_NAME;
        const group = () => ({ vendor, name });
        const connection = { id: LEGACY_CONNECTION_ID, name };
        for (const [target, groups] of [
            [connection, [group(), group()]],
            [connection, [{ ...group(), connectionId: 'proxy' }]],
            [connection, [{ ...group(), connectionId: null }]],
            [connection, [group(), { ...group(), name: 'Other', connectionId: LEGACY_CONNECTION_ID }]],
            [{ id: 'new', name }, [group()]],
        ] as const) {
            const initial = JSON.stringify(groups);
            const { manager, document } = fixture(initial);
            await assert.rejects(manager.repair(target), /already exists/);
            assert.strictEqual(document.text, initial);
            assert.strictEqual(document.saves, 0);
        }
    });
});
