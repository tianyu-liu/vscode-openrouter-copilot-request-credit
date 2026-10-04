import * as vscode from 'vscode';

export const KEY_SECRET = 'openrouterApiKey';
const LEGACY_KEY_SECRET = 'openrouterCopilot.apiKey';
const SECRET_TIMEOUT_MS = 10000;

let overrideSecrets: vscode.SecretStorage | undefined;

export function setSecretStorageForTesting(s: vscode.SecretStorage | undefined): void {
    overrideSecrets = s;
}

const READ_TIMED_OUT = Symbol('secretReadTimedOut');

type SecretRead = { value: string | undefined } | 'failed';

async function readSecret(secrets: vscode.SecretStorage, key: string): Promise<SecretRead> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const outcome = await Promise.race([
            secrets.get(key),
            new Promise<typeof READ_TIMED_OUT>((resolve) => {
                timer = setTimeout(() => resolve(READ_TIMED_OUT), SECRET_TIMEOUT_MS);
            }),
        ]);
        if (outcome === READ_TIMED_OUT) return 'failed';
        return { value: typeof outcome === 'string' && outcome !== '' ? outcome : undefined };
    } catch {
        return 'failed';
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function readKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
    const store = overrideSecrets ?? secrets;
    const primary = await readSecret(store, KEY_SECRET);
    if (primary === 'failed') return undefined;
    if (primary.value !== undefined) return primary.value;
    const legacy = await readSecret(store, LEGACY_KEY_SECRET);
    if (legacy === 'failed') return undefined;
    if (legacy.value !== undefined) {
        await store.store(KEY_SECRET, legacy.value);
        await store.delete(LEGACY_KEY_SECRET);
    }
    return legacy.value;
}

export async function storeKey(secrets: vscode.SecretStorage, value: string): Promise<void> {
    const store = overrideSecrets ?? secrets;
    await store.store(KEY_SECRET, value);
    await store.delete(LEGACY_KEY_SECRET);
}

export async function clearStoredKey(secrets: vscode.SecretStorage): Promise<void> {
    const store = overrideSecrets ?? secrets;
    await store.delete(KEY_SECRET);
    await store.delete(LEGACY_KEY_SECRET);
}
