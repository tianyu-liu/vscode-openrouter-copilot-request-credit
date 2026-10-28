import * as assert from 'assert';
import { NativeGroupDocument, NativeGroupEdit, NativeGroupHost, NativeGroupManager } from '../../nativeGroups';

const vendor = 'test-vendor';

class ConfigurationDocument implements NativeGroupDocument {
    version = 1;
    isDirty = false;
    saves = 0;
    constructor(public text: string) {}
    getText(): string { return this.text; }
    async save(): Promise<boolean> { this.saves++; this.isDirty = false; return true; }
}

function fixture(text: string) {
    const document = new ConfigurationDocument(text);
    const additions: unknown[] = [];
    const host: NativeGroupHost = {
        async openConfiguration() { return document; },
        async applyEdits(_document: NativeGroupDocument, edits: readonly NativeGroupEdit[]) {
            for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
                document.text = document.text.slice(0, edit.start) + edit.text + document.text.slice(edit.end);
            }
            document.version++;
            document.isDirty = true;
            return true;
        },
        async addGroup(group) { additions.push(group); },
    };
    return { document, host, additions, manager: new NativeGroupManager(host, vendor) };
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
        await assert.rejects(manager.add({ id: 'a', name: 'Work' }), /Review and save/);
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

    test('migration uses native add without opening a profile editor and only recognizes the exact duplicate error', async () => {
        const { manager, host, additions } = fixture('[]');
        host.openConfiguration = async () => { throw new Error('migration must not open the editor'); };
        assert.strictEqual(await manager.ensureDefault({ id: 'a', name: 'Personal' }), 'added');
        assert.deepStrictEqual(additions, [{ vendor, name: 'Personal', connectionId: 'a' }]);
        host.addGroup = async () => {
            throw new Error('Language model group with name Personal already exists for vendor test-vendor');
        };
        assert.strictEqual(await manager.ensureDefault({ id: 'a', name: 'Personal' }), 'exists');
        host.addGroup = async () => { throw new Error('Unsupported command'); };
        await assert.rejects(manager.ensureDefault({ id: 'a', name: 'Personal' }), /Unsupported command/);
    });
});
