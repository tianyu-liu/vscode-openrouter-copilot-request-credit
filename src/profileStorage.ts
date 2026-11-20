import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type * as vscode from 'vscode';

const NAMESPACE_KEY = 'profileStorageNamespace.v1';
const PROBE_KEY = 'openrouterCopilot.profileCandidates';
const PROFILE_COMMAND = 'workbench.profiles.actions.profileEntry.';
const MANAGE_COMMAND = 'openrouterCopilot.manage';

/** The desktop host supplies the default globalStorageHome even in a named profile.
 * Command Palette visibility can resolve the workbench's currentProfile context on first use.
 * A profile Memento is machine-local and survives an intentional choice to share global state. */
export async function profileDirectory(
    directory: string, state: vscode.Memento, commands: Pick<typeof vscode.commands, 'getCommands' | 'executeCommand'>,
    machineId: string
): Promise<string> {
    const saved = state.get<string>(NAMESPACE_KEY);
    if (typeof saved === 'string' && /^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/.test(saved)) return join(directory, saved);
    const matches = async (profiles: string[]): Promise<boolean> => {
        await commands.executeCommand('setContext', PROBE_KEY, profiles);
        const entries = await commands.executeCommand<Array<{ command: string }>>('_getAllCommands', true);
        return Array.isArray(entries) && entries.some(({ command }) => command === MANAGE_COMMAND);
    };
    let namespace: string | undefined;
    try {
        let ids = (await commands.getCommands(true)).filter(id => id.startsWith(PROFILE_COMMAND))
            .map(id => id.slice(PROFILE_COMMAND.length));
        // Verify both directions before trusting an internal runtime capability.
        if (ids.length && !await matches([]) && await matches(ids)) {
            while (ids.length > 1) {
                const middle = Math.ceil(ids.length / 2);
                const first = ids.slice(0, middle);
                ids = await matches(first) ? first : ids.slice(middle);
            }
            namespace = createHash('sha256').update(JSON.stringify([machineId, ids[0]])).digest('hex');
        }
    } catch {
        // Clients without the profile commands use their own Memento identity.
    } finally {
        await commands.executeCommand('setContext', PROBE_KEY, undefined).then(undefined, () => undefined);
    }
    namespace ??= state.get<string>(NAMESPACE_KEY);
    if (!namespace || !/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/.test(namespace)) namespace = randomUUID();
    await state.update(NAMESPACE_KEY, namespace);
    return join(directory, namespace);
}

/** The data database commits each recovery step independently. A second SQLite writer lock
 * protects the entire operation, including SecretStorage awaits, and dies with the host process. */
export class ProfileStorage {
    private readonly lock: DatabaseSync;
    private readonly data: DatabaseSync;
    private readonly read: StatementSync;
    private readonly write: StatementSync;
    private readonly erase: StatementSync;
    private readonly changed: StatementSync;

    constructor(directory: string, coordinationDirectory = directory) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const open = (path: string) => {
            // Closing an independent file descriptor for an existing SQLite file
            // releases this process's POSIX locks on that inode.
            try { closeSync(openSync(path, 'ax', 0o600)); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            return new DatabaseSync(path);
        };
        // Legacy key aliases are application-wide. A common lock serializes their
        // migration even when two different profiles initialize at the same time.
        this.lock = open(join(coordinationDirectory, 'coordination.sqlite'));
        this.data = open(join(directory, 'connections.sqlite'));
        // Schema creation is synchronous and short. Never block the event loop waiting
        // for an extension host doing asynchronous keychain work.
        this.data.exec('PRAGMA busy_timeout=1500');
        this.data.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL)');
        this.read = this.data.prepare('SELECT value FROM state WHERE key = ?');
        this.write = this.data.prepare('INSERT INTO state VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET '
            + 'value = excluded.value, revision = revision + 1 RETURNING revision');
        this.erase = this.data.prepare('DELETE FROM state WHERE key = ?');
        this.changed = this.data.prepare('SELECT value, revision FROM state WHERE key = ? AND revision != ?');
    }

    async exclusive<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        for (;;) {
            signal?.throwIfAborted();
            try {
                this.lock.exec('BEGIN IMMEDIATE');
                break;
            } catch (error) {
                // SQLITE_BUSY (5) means another process owns the writer lock.
                if ((error as { errcode?: number }).errcode !== 5) throw error;
                await delay(25, undefined, { signal }).catch(error => {
                    signal?.throwIfAborted();
                    throw error;
                });
            }
        }
        try {
            signal?.throwIfAborted();
            return await operation();
        } finally {
            this.lock.exec('ROLLBACK');
        }
    }

    importMemento(source: vscode.Memento, registryKey: string): void {
        if (this.get('mementoImported')) return;
        this.data.exec('BEGIN IMMEDIATE');
        try {
            for (const key of source.keys()) {
                if (key === registryKey || key.startsWith('connections.')) this.update(key, source.get(key));
            }
            this.update('mementoImported', true);
            this.data.exec('COMMIT');
        } catch (error) {
            this.data.exec('ROLLBACK');
            throw error;
        }
    }

    async finishImport(source: vscode.Memento, registryKey: string): Promise<void> {
        if (this.get('mementoCleaned')) return;
        for (const key of source.keys()) {
            if (key === registryKey || key.startsWith('connections.')) await source.update(key, undefined);
        }
        this.update('mementoCleaned', true);
    }

    keys(): string[] {
        return this.data.prepare('SELECT key FROM state').all().map(row => row.key as string);
    }

    get<T>(key: string): T | undefined {
        const row = this.read.get(key);
        return row ? JSON.parse(row.value as string) as T : undefined;
    }

    getChanged<T>(key: string, revision: number): { value: T; revision: number } | undefined {
        const row = this.changed.get(key, revision);
        return row && { value: JSON.parse(row.value as string) as T, revision: Number(row.revision) };
    }

    update(key: string, value: unknown): number {
        if (value === undefined) {
            this.erase.run(key);
            return 0;
        }
        return Number(this.write.get(key, JSON.stringify(value))!.revision);
    }

    dispose(): void {
        this.data.close();
        this.lock.close();
    }
}
