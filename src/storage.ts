import * as vscode from 'vscode';

export const KEY_SECRET = 'openrouterApiKey';
const LEGACY_KEY_SECRET = 'openrouterCopilot.apiKey';
const SECRET_TIMEOUT_MS = 10000;

async function readSecret(secrets: vscode.SecretStorage, key: string): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const value = await Promise.race([
        secrets.get(key),
        new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), SECRET_TIMEOUT_MS);
        }),
    ]).catch(() => undefined);
    if (timer) clearTimeout(timer);
    return value;
}

export async function readKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
    const value = await readSecret(secrets, KEY_SECRET);
    if (value) {
        return value;
    }
    const legacy = await readSecret(secrets, LEGACY_KEY_SECRET);
    if (legacy) {
        await secrets.store(KEY_SECRET, legacy);
        await secrets.delete(LEGACY_KEY_SECRET);
    }
    return legacy;
}

export async function storeKey(secrets: vscode.SecretStorage, value: string): Promise<void> {
    await secrets.store(KEY_SECRET, value);
    await secrets.delete(LEGACY_KEY_SECRET);
}

export async function clearStoredKey(secrets: vscode.SecretStorage): Promise<void> {
    await secrets.delete(KEY_SECRET);
    await secrets.delete(LEGACY_KEY_SECRET);
}
