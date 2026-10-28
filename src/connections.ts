import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { KEY_SECRET } from './storage';

export type ConnectionKind = 'openrouter' | 'openai-compatible';
export interface ConnectionSettings {
    creditLimit: number;
    creditResetPeriod: 'daily' | 'weekly' | 'monthly' | 'never';
    creditIncludeByok: boolean;
    hideUnavailableModels: boolean;
}
export interface ManualModel {
    id: string;
    name?: string;
    contextLength?: number;
    maxOutputTokens?: number;
    toolCalling?: boolean;
    imageInput?: boolean;
}
export interface ConnectionDefinition {
    id: string;
    name: string;
    kind: ConnectionKind;
    baseUrl: string;
    enabled: boolean;
    revision: number;
    settings: ConnectionSettings;
    models?: ManualModel[];
}
export interface ConnectionInput {
    name: string;
    kind: ConnectionKind;
    baseUrl?: string;
    enabled?: boolean;
    settings?: Partial<ConnectionSettings>;
    models?: ManualModel[];
}
export type ConnectionPatch = Partial<ConnectionInput>;
export const LEGACY_CONNECTION_ID = 'default-openrouter';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_CONNECTION_SETTINGS: Readonly<ConnectionSettings> = Object.freeze({
    creditLimit: 0,
    creditResetPeriod: 'daily',
    creditIncludeByok: true,
    hideUnavailableModels: true,
});

const REGISTRY_KEY = 'connectionRegistry.v1';
const LEGACY_SECRET = 'openrouterCopilot.apiKey';
const LEGACY_STATE_KEYS = [
    'requestTemplate', 'contextCaps', 'contextCapsBase', 'contextMarginPercent', 'sessionCosts', 'parentSession',
];
interface RegistryData {
    version: 1;
    connections: ConnectionDefinition[];
    credentials: Record<string, string>;
    garbageSecrets: string[];
    garbageConnections: string[];
    legacyCleanup: boolean;
}

function clone<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}
function prefix(id: string): string { return `connections.${id}.`; }
function secretSlot(id: string): string { return `connection.${id}.key.${randomUUID()}`; }
function normalizeBaseUrl(kind: ConnectionKind, value?: string): string {
    if (kind === 'openrouter') {
        if (value !== undefined && value.replace(/\/+$/, '') !== OPENROUTER_BASE_URL) {
            throw new Error('Direct OpenRouter connections must use the OpenRouter API endpoint.');
        }
        return OPENROUTER_BASE_URL;
    }
    if (typeof value !== 'string' || !value.trim()) throw new Error('An API base URL is required.');
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new Error('Invalid API base URL.'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new Error('API endpoints require HTTPS, except HTTP on loopback hosts.');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error('API base URLs cannot contain credentials, query parameters, or fragments.');
    }
    return url.toString().replace(/\/+$/, '');
}
function settings(input?: Partial<ConnectionSettings>): ConnectionSettings {
    const result = { ...DEFAULT_CONNECTION_SETTINGS, ...input };
    if (typeof result.creditLimit !== 'number' || !Number.isFinite(result.creditLimit) || result.creditLimit < 0) {
        throw new Error('Credit limit must be a finite nonnegative number.');
    }
    if (!['daily', 'weekly', 'monthly', 'never'].includes(result.creditResetPeriod)) {
        throw new Error('Invalid credit reset period.');
    }
    if (typeof result.creditIncludeByok !== 'boolean' || typeof result.hideUnavailableModels !== 'boolean') {
        throw new Error('Connection settings must use boolean values.');
    }
    return result;
}
function manualModels(input?: ManualModel[]): ManualModel[] | undefined {
    if (input === undefined) return undefined;
    if (!Array.isArray(input)) throw new Error('Models must be an array.');
    const seen = new Set<string>();
    return input.map(model => {
        if (!model || typeof model.id !== 'string' || !model.id.trim() || seen.has(model.id.trim())) {
            throw new Error('Manual model IDs must be nonempty and unique.');
        }
        const result: ManualModel = { id: model.id.trim() };
        seen.add(result.id);
        if (model.name !== undefined) {
            if (typeof model.name !== 'string' || !model.name.trim()) throw new Error('Invalid model name.');
            result.name = model.name.trim();
        }
        for (const key of ['contextLength', 'maxOutputTokens'] as const) {
            const value = model[key];
            if (value !== undefined) {
                if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Model token limits must be positive integers.');
                result[key] = value;
            }
        }
        for (const key of ['toolCalling', 'imageInput'] as const) {
            const value = model[key];
            if (value !== undefined) {
                if (typeof value !== 'boolean') throw new Error('Model capability values must be boolean.');
                result[key] = value;
            }
        }
        return result;
    });
}
function definition(input: ConnectionInput, id: string, revision: number): ConnectionDefinition {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('A connection name is required.');
    if (!['openrouter', 'openai-compatible'].includes(input.kind)) throw new Error('Invalid connection type.');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('Invalid enabled state.');
    return {
        id, revision, name: input.name.trim(), kind: input.kind,
        baseUrl: normalizeBaseUrl(input.kind, input.baseUrl), enabled: input.enabled ?? true,
        settings: settings(input.settings), models: manualModels(input.models),
    };
}

export class ConnectionRegistry implements vscode.Disposable {
    private data: RegistryData | undefined;
    private ready = false;
    private disposed = false;
    private queue: Promise<unknown> = Promise.resolve();
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;

    constructor(private readonly state: vscode.Memento, private readonly secrets: vscode.SecretStorage) { }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(() => {
            if (this.disposed) throw new Error('Connection registry is disposed.');
            return operation();
        });
        this.queue = result.catch(() => undefined);
        return result;
    }

    private require(id?: string): RegistryData {
        if (!this.ready || !this.data) throw new Error('Connection registry is not initialized.');
        if (id !== undefined && !this.data.connections.some(item => item.id === id)) {
            throw new Error('Connection no longer exists.');
        }
        return this.data;
    }

    private async persist(next: RegistryData): Promise<void> {
        await this.state.update(REGISTRY_KEY, clone(next));
        this.data = next;
    }

    private async strictSecret(key: string): Promise<string | undefined> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                this.secrets.get(key),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Credential storage read timed out.')), 10000);
                }),
            ]);
            return result === '' ? undefined : result;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private async cleanup(): Promise<void> {
        const current = this.data!;
        if (current.legacyCleanup) {
            for (const key of [KEY_SECRET, LEGACY_SECRET]) await this.secrets.delete(key);
            for (const key of LEGACY_STATE_KEYS) await this.state.update(key, undefined);
        }
        for (const slot of current.garbageSecrets) await this.secrets.delete(slot);
        for (const id of current.garbageConnections) {
            for (const key of this.state.keys().filter(key => key.startsWith(prefix(id)))) {
                await this.state.update(key, undefined);
            }
        }
        if (current.legacyCleanup || current.garbageSecrets.length || current.garbageConnections.length) {
            await this.persist({ ...current, legacyCleanup: false, garbageSecrets: [], garbageConnections: [] });
        }
    }

    initialize(legacySettings?: Partial<ConnectionSettings>): Promise<void> {
        return this.enqueue(async () => {
            if (this.ready) { await this.cleanup(); return; }
            const saved = this.state.get<RegistryData>(REGISTRY_KEY);
            if (saved !== undefined) {
                if (saved.version !== 1 || !Array.isArray(saved.connections)
                    || !saved.credentials || !Array.isArray(saved.garbageSecrets)
                    || !Array.isArray(saved.garbageConnections) || typeof saved.legacyCleanup !== 'boolean') {
                    throw new Error('Invalid connection registry data.');
                }
                const ids = new Set<string>();
                const names = new Set<string>();
                for (const item of saved.connections) {
                    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(item.id)
                        || ids.has(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 1) {
                        throw new Error('Invalid saved connection.');
                    }
                    definition(item, item.id, item.revision);
                    if (names.has(item.name.toLowerCase())) throw new Error('Duplicate saved connection names.');
                    ids.add(item.id);
                    names.add(item.name.toLowerCase());
                }
                for (const [id, slot] of Object.entries(saved.credentials)) {
                    if (!ids.has(id) || typeof slot !== 'string' || !slot.startsWith(`connection.${id}.key.`)) {
                        throw new Error('Invalid saved connection credential reference.');
                    }
                }
                if (saved.garbageSecrets.some(slot => typeof slot !== 'string' || !slot.startsWith('connection.'))
                    || saved.garbageConnections.some(id => typeof id !== 'string'
                        || !/^[a-zA-Z0-9-]+$/.test(id) || ids.has(id))) {
                    throw new Error('Invalid saved connection cleanup data.');
                }
                this.data = clone(saved);
            } else {
                const primary = await this.strictSecret(KEY_SECRET);
                const credential = primary ?? await this.strictSecret(LEGACY_SECRET);
                const initial = definition({ name: 'OpenRouter', kind: 'openrouter', settings: legacySettings },
                    LEGACY_CONNECTION_ID, 1);
                const slot = `connection.${LEGACY_CONNECTION_ID}.key.migration`;
                for (const key of LEGACY_STATE_KEYS) {
                    await this.state.update(prefix(initial.id) + key, clone(this.state.get(key)));
                }
                if (credential !== undefined) await this.secrets.store(slot, credential);
                await this.persist({
                    version: 1, connections: [initial], credentials: credential === undefined ? {} : { [initial.id]: slot },
                    legacyCleanup: true, garbageSecrets: [], garbageConnections: [],
                });
            }
            await this.cleanup();
            this.ready = true;
        });
    }

    list(): ConnectionDefinition[] { return clone(this.require().connections); }
    get(id: string): ConnectionDefinition | undefined {
        return clone(this.require().connections.find(item => item.id === id));
    }

    private uniqueName(next: ConnectionDefinition): void {
        if (this.data!.connections.some(item => item.id !== next.id && item.name.toLowerCase() === next.name.toLowerCase())) {
            throw new Error('Connection names must be unique.');
        }
    }

    add(input: ConnectionInput): Promise<ConnectionDefinition> {
        const snapshot = clone(input);
        return this.enqueue(async () => {
            const current = this.require();
            const next = definition(snapshot, randomUUID(), 1);
            this.uniqueName(next);
            await this.persist({ ...current, connections: [...current.connections, next] });
            this.changed.fire();
            return clone(next);
        });
    }

    update(id: string, patch: ConnectionPatch): Promise<ConnectionDefinition> {
        const snapshot = clone(patch);
        return this.enqueue(async () => {
            const current = this.require(id);
            const previous = current.connections.find(item => item.id === id)!;
            if (snapshot.kind !== undefined && snapshot.kind !== previous.kind) {
                throw new Error('Create a new connection to change its endpoint type.');
            }
            if (snapshot.baseUrl !== undefined && normalizeBaseUrl(previous.kind, snapshot.baseUrl) !== previous.baseUrl
                && current.credentials[id]) {
                throw new Error('Clear the connection credential before changing its endpoint.');
            }
            const next = definition({ ...previous, ...snapshot, settings: { ...previous.settings, ...snapshot.settings } },
                id, previous.revision + 1);
            this.uniqueName(next);
            await this.persist({ ...current, connections: current.connections.map(item => item.id === id ? next : item) });
            this.changed.fire();
            return clone(next);
        });
    }

    remove(id: string): Promise<void> {
        return this.enqueue(async () => {
            const current = this.require(id);
            const credentials = { ...current.credentials };
            const slot = credentials[id];
            delete credentials[id];
            await this.persist({
                ...current, credentials, connections: current.connections.filter(item => item.id !== id),
                garbageSecrets: [...current.garbageSecrets, ...(slot ? [slot] : [])],
                garbageConnections: [...current.garbageConnections, id],
            });
            this.changed.fire();
            await this.cleanup();
        });
    }

    readKey(id: string): Promise<string | undefined> {
        return this.enqueue(async () => {
            const slot = this.require(id).credentials[id];
            return slot ? this.strictSecret(slot) : undefined;
        });
    }

    storeKey(id: string, value: string): Promise<void> {
        return this.enqueue(async () => {
            this.require(id);
            if (typeof value !== 'string' || !value.trim()) throw new Error('A nonempty API key is required.');
            await this.cleanup();
            const current = this.require(id);
            const slot = secretSlot(id);
            // Persist the staging slot before writing it, so every interrupted rotation is reclaimable.
            await this.persist({ ...current, garbageSecrets: [...current.garbageSecrets, slot] });
            await this.secrets.store(slot, value.trim());
            const staged = this.data!;
            const oldSlot = staged.credentials[id];
            await this.persist({
                ...staged, credentials: { ...staged.credentials, [id]: slot },
                connections: staged.connections.map(item => item.id === id ? { ...item, revision: item.revision + 1 } : item),
                garbageSecrets: [...staged.garbageSecrets.filter(item => item !== slot), ...(oldSlot ? [oldSlot] : [])],
            });
            this.changed.fire();
            await this.cleanup();
        });
    }

    clearKey(id: string): Promise<void> {
        return this.enqueue(async () => {
            const current = this.require(id);
            const credentials = { ...current.credentials };
            const slot = credentials[id];
            delete credentials[id];
            await this.persist({
                ...current, credentials,
                connections: current.connections.map(item => item.id === id ? { ...item, revision: item.revision + 1 } : item),
                garbageSecrets: [...current.garbageSecrets, ...(slot ? [slot] : [])],
            });
            this.changed.fire();
            await this.cleanup();
        });
    }

    stateFor(id: string): vscode.Memento {
        this.require(id);
        const active = () => this.ready && !this.disposed && this.data!.connections.some(item => item.id === id);
        return {
            keys: () => active() ? this.state.keys().filter(key => key.startsWith(prefix(id)))
                .map(key => key.slice(prefix(id).length)) : [],
            get: (<T>(key: string, fallback?: T): T | undefined => active()
                ? clone(this.state.get<T>(prefix(id) + key) ?? fallback) : fallback) as vscode.Memento['get'],
            update: (key: string, value: unknown) => {
                const snapshot = clone(value);
                return this.enqueue(async () => {
                    this.require(id);
                    await this.state.update(prefix(id) + key, snapshot);
                });
            },
        };
    }

    secretsFor(id: string): vscode.SecretStorage {
        this.require(id);
        const validate = (key: string) => {
            if (key !== KEY_SECRET && key !== LEGACY_SECRET) throw new Error('Unsupported connection secret.');
        };
        return {
            keys: async () => { this.require(id); return await this.readKey(id) === undefined ? [] : [KEY_SECRET]; },
            get: async key => { validate(key); this.require(id); return key === KEY_SECRET ? this.readKey(id) : undefined; },
            store: async (key, value) => { validate(key); await this.storeKey(id, value); },
            delete: async key => { validate(key); this.require(id); if (key === KEY_SECRET) await this.clearKey(id); },
            onDidChange: (listener, thisArgs, disposables) => this.onDidChange(() => {
                listener.call(thisArgs, { key: KEY_SECRET });
            }, undefined, disposables),
        };
    }

    dispose(): void { this.disposed = true; this.changed.dispose(); }
}
