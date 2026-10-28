import * as vscode from 'vscode';

const DEFAULT_VENDOR = 'openrouter-copilot-request-credit';
const CONFIGURATION_COMMAND = 'workbench.action.openLanguageModelsJson';

export interface NativeGroupConnection {
    readonly id: string;
    readonly name: string;
}

export interface NativeGroupEdit {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

export interface NativeGroupDocument {
    readonly version: number;
    readonly isDirty: boolean;
    getText(): string;
    save(): Thenable<boolean>;
}

export interface NativeGroupHost {
    openConfiguration(): Promise<NativeGroupDocument>;
    applyEdits(document: NativeGroupDocument, edits: readonly NativeGroupEdit[]): Promise<boolean>;
    addGroup(group: { vendor: string; name: string; connectionId: string }): Promise<void>;
}

const vscodeHost: NativeGroupHost = {
    async openConfiguration() {
        // This command resolves the UI client's active profile, including from a remote extension host.
        await vscode.commands.executeCommand(CONFIGURATION_COMMAND);
        const document = vscode.window.activeTextEditor?.document;
        if (!document || !document.uri.path.endsWith('/chatLanguageModels.json')) {
            throw new Error('VS Code did not open the active profile’s Language Models JSON.');
        }
        return document;
    },
    async applyEdits(document, edits) {
        const target = document as vscode.TextDocument;
        const edit = new vscode.WorkspaceEdit();
        for (const change of edits) {
            edit.replace(target.uri, new vscode.Range(target.positionAt(change.start), target.positionAt(change.end)),
                change.text);
        }
        return vscode.workspace.applyEdit(edit);
    },
    async addGroup(group) {
        if (vscode.workspace.textDocuments.some(document => document.isDirty &&
            document.uri.path.endsWith('/chatLanguageModels.json'))) {
            throw new Error('Save or discard your unsaved Language Models JSON edits before migrating connections.');
        }
        await vscode.commands.executeCommand('lm.addLanguageModelsProviderGroup', group);
    },
};

interface JsonNode {
    start: number;
    end: number;
    value: unknown;
    properties?: Map<string, JsonNode>;
    items?: JsonNode[];
}

/** JSONC syntax offsets let a metadata edit preserve native model settings and unrelated comments. */
class JsoncDocument {
    private offset = 0;
    readonly root: JsonNode;

    constructor(readonly text: string) {
        this.root = this.readValue();
        this.skipTrivia();
        if (this.offset !== text.length || !this.root.items) {
            throw new Error('Language Models JSON must contain a valid JSONC array.');
        }
    }

    skipTrivia(offset = this.offset): number {
        while (offset < this.text.length) {
            if (/\s/.test(this.text[offset])) { offset++; continue; }
            if (this.text.startsWith('//', offset)) {
                const end = this.text.indexOf('\n', offset + 2);
                offset = end < 0 ? this.text.length : end + 1;
                continue;
            }
            if (this.text.startsWith('/*', offset)) {
                const end = this.text.indexOf('*/', offset + 2);
                if (end < 0) { throw new Error('Unterminated comment in Language Models JSON.'); }
                offset = end + 2;
                continue;
            }
            break;
        }
        this.offset = offset;
        return offset;
    }

    private readValue(): JsonNode {
        this.skipTrivia();
        const start = this.offset;
        const first = this.text[this.offset++];
        if (first === '"') {
            while (this.offset < this.text.length) {
                const character = this.text[this.offset++];
                if (character === '\\') { this.offset++; }
                else if (character === '"') {
                    return { start, end: this.offset, value: JSON.parse(this.text.slice(start, this.offset)) };
                }
            }
        } else if (first === '[' || first === '{') {
            const endToken = first === '[' ? ']' : '}';
            const items: JsonNode[] = [];
            const properties = new Map<string, JsonNode>();
            this.skipTrivia();
            while (this.text[this.offset] !== endToken) {
                if (first === '{') {
                    const key = this.readValue();
                    if (typeof key.value !== 'string' || properties.has(key.value)) { this.invalid(); }
                    this.skipTrivia();
                    if (this.text[this.offset++] !== ':') { this.invalid(); }
                    properties.set(key.value as string, this.readValue());
                } else { items.push(this.readValue()); }
                this.skipTrivia();
                if (this.text[this.offset] === endToken) { break; }
                if (this.text[this.offset++] !== ',') { this.invalid(); }
                this.skipTrivia();
            }
            this.offset++;
            return first === '['
                ? { start, end: this.offset, value: items.map(item => item.value), items }
                : { start, end: this.offset, value: Object.fromEntries(
                    [...properties].map(([key, node]) => [key, node.value])), properties };
        } else {
            const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(start));
            if (match) {
                this.offset = start + match[0].length;
                return { start, end: this.offset, value: JSON.parse(match[0]) };
            }
        }
        return this.invalid();
    }

    private invalid(): never {
        throw new Error('Language Models JSON is invalid or has duplicate object properties; fix it before syncing.');
    }
}

function groupValue(node: JsonNode): Record<string, unknown> | undefined {
    return node.properties ? node.value as Record<string, unknown> : undefined;
}

function applyTextEdits(text: string, edits: readonly NativeGroupEdit[]): string {
    for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    }
    return text;
}

/** Native rename/remove have no public command. Explicit panel actions edit only the active client profile. */
export class NativeGroupManager {
    private pending: Promise<unknown> = Promise.resolve();

    constructor(private readonly host: NativeGroupHost = vscodeHost, private readonly vendor = DEFAULT_VENDOR) {}

    add(connection: NativeGroupConnection): Promise<void> { return this.update(connection); }

    update(connection: NativeGroupConnection): Promise<void> {
        return this.enqueue(async () => {
            const document = await this.openCleanDocument();
            const source = new JsoncDocument(document.getText());
            const items = source.root.items!;
            const own = items.filter(item => {
                const group = groupValue(item);
                return group?.vendor === this.vendor && group.connectionId === connection.id;
            });
            if (own.length > 1) { throw new Error('Several native groups use this connection ID; fix Language Models JSON.'); }
            if (items.some(item => {
                const group = groupValue(item);
                return group?.vendor === this.vendor && group.name === connection.name && item !== own[0];
            })) { throw new Error(`A native model group named “${connection.name}” already exists.`); }
            const name = own[0]?.properties?.get('name');
            if (own[0] && !name) { throw new Error('The native connection group has no name; fix Language Models JSON.'); }
            if (name?.value === connection.name) { return; }
            if (name) {
                await this.saveEdits(document, [{ start: name.start, end: name.end, text: JSON.stringify(connection.name) }]);
            } else {
                const last = items.at(-1);
                const hasComma = last && source.text[source.skipTrivia(last.end)] === ',';
                const eol = source.text.includes('\r\n') ? '\r\n' : '\n';
                const group = JSON.stringify({ vendor: this.vendor, name: connection.name, connectionId: connection.id });
                const edits: NativeGroupEdit[] = [{ start: source.root.end - 1, end: source.root.end - 1,
                    text: `${eol}\t${group}${eol}` }];
                if (last && !hasComma) { edits.push({ start: last.end, end: last.end, text: ',' }); }
                await this.saveEdits(document, edits);
            }
        });
    }

    remove(connectionId: string): Promise<void> {
        return this.enqueue(async () => {
            const document = await this.openCleanDocument();
            const source = new JsoncDocument(document.getText());
            const items = source.root.items!;
            const edits: NativeGroupEdit[] = [];
            for (let index = items.length - 1; index >= 0; index--) {
                const item = items[index];
                const group = groupValue(item);
                if (group?.vendor !== this.vendor || group.connectionId !== connectionId) { continue; }
                const commaAfter = source.skipTrivia(item.end);
                if (source.text[commaAfter] === ',') {
                    edits.push({ start: commaAfter, end: commaAfter + 1, text: '' });
                }
                // A preceding comma may become a valid JSONC trailing comma; leave adjacent comments intact.
                edits.push({ start: item.start, end: item.end, text: '' });
            }
            if (edits.length) { await this.saveEdits(document, edits); }
        });
    }

    /** One-time legacy migration only: the native command identifies duplicates by vendor/name, not connection ID. */
    ensureDefault(connection: NativeGroupConnection): Promise<'added' | 'exists'> {
        return this.enqueue(async () => {
            try {
                await this.host.addGroup({ vendor: this.vendor, name: connection.name, connectionId: connection.id });
                return 'added';
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (message === `Language model group with name ${connection.name} already exists for vendor ${this.vendor}`) {
                    return 'exists';
                }
                throw error;
            }
        });
    }

    private async openCleanDocument(): Promise<NativeGroupDocument> {
        const document = await this.host.openConfiguration();
        if (document.isDirty) {
            throw new Error('Save or discard your unsaved Language Models JSON edits before changing connections.');
        }
        return document;
    }

    private async saveEdits(document: NativeGroupDocument, edits: readonly NativeGroupEdit[]): Promise<void> {
        const version = document.version;
        const expected = applyTextEdits(document.getText(), edits);
        // Validate the complete result before applying an edit to the user's profile.
        new JsoncDocument(expected);
        if (document.isDirty || document.version !== version || !await this.host.applyEdits(document, edits)) {
            throw new Error('Language Models JSON changed during the connection update; retry the action.');
        }
        if (document.getText() !== expected) {
            throw new Error('Language Models JSON changed during the update. Review and save the file manually.');
        }
        if (!await document.save()) { throw new Error('Could not save Language Models JSON; review the open file.'); }
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.pending.then(operation);
        this.pending = next.catch(() => undefined);
        return next;
    }
}
