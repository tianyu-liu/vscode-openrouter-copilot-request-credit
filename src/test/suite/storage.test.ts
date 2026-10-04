import * as assert from "assert";
import * as vscode from "vscode";
import { clearStoredKey, readKey, setSecretStorageForTesting, storeKey } from "../../storage";

const KEY_SECRET = "openrouterApiKey";
const LEGACY_SECRET = "openrouterCopilot.apiKey";

interface FakeSecrets extends vscode.SecretStorage {
    values: Map<string, string>;
    calls: string[];
}

function fakeSecrets(init: Record<string, string> = {}, failGet = false): FakeSecrets {
    const values = new Map(Object.entries(init));
    const calls: string[] = [];
    const secrets = {
        values,
        calls,
        get: async (key: string) => {
            calls.push(`get:${key}`);
            if (failGet) throw new Error("keychain unavailable");
            return values.get(key);
        },
        store: async (key: string, value: string) => {
            calls.push(`store:${key}`);
            values.set(key, value);
        },
        delete: async (key: string) => {
            calls.push(`delete:${key}`);
            values.delete(key);
        },
    };
    return secrets as unknown as FakeSecrets;
}

suite("storage key handling", () => {
    teardown(() => {
        setSecretStorageForTesting(undefined);
    });

    test("returns the primary secret without touching the legacy one", async () => {
        const secrets = fakeSecrets({ [KEY_SECRET]: "sk-primary", [LEGACY_SECRET]: "sk-legacy" });
        setSecretStorageForTesting(secrets);
        assert.strictEqual(await readKey(secrets), "sk-primary");
        assert.ok(!secrets.calls.some((c) => c.includes(LEGACY_SECRET)), secrets.calls.join(", "));
    });

    test("migrates a legacy secret only when the primary read succeeded and was absent", async () => {
        const secrets = fakeSecrets({ [LEGACY_SECRET]: "sk-legacy" });
        setSecretStorageForTesting(secrets);
        assert.strictEqual(await readKey(secrets), "sk-legacy");
        assert.ok(secrets.calls.includes(`store:${KEY_SECRET}`), "migrated into the primary slot");
        assert.ok(secrets.calls.includes(`delete:${LEGACY_SECRET}`), "legacy secret removed");
        assert.strictEqual(secrets.values.get(KEY_SECRET), "sk-legacy");
    });

    test("a failed primary read returns undefined without migrating or deleting", async () => {
        const secrets = fakeSecrets({ [KEY_SECRET]: "sk-primary", [LEGACY_SECRET]: "sk-legacy" }, true);
        setSecretStorageForTesting(secrets);
        assert.strictEqual(await readKey(secrets), undefined);
        assert.ok(
            !secrets.calls.some((c) => c.startsWith("store:") || c.startsWith("delete:")),
            secrets.calls.join(", ")
        );
    });

    test("a failed legacy read after an absent primary leaves the legacy secret alone", async () => {
        let primaryReads = 0;
        const secrets = {
            get: async (key: string) => {
                if (key === KEY_SECRET) {
                    primaryReads++;
                    return undefined;
                }
                throw new Error("keychain unavailable");
            },
            store: async () => { throw new Error("must not store"); },
            delete: async () => { throw new Error("must not delete"); },
        } as unknown as vscode.SecretStorage;
        setSecretStorageForTesting(secrets);
        assert.strictEqual(await readKey(secrets), undefined);
        assert.strictEqual(primaryReads, 1, "the primary slot was checked");
    });

    test("storeKey and clearStoredKey honor the test override", async () => {
        const override = fakeSecrets();
        const other = fakeSecrets();
        setSecretStorageForTesting(override);
        await storeKey(other, "sk-new");
        assert.ok(override.calls.includes(`store:${KEY_SECRET}`), "stored through the override");
        assert.ok(override.calls.includes(`delete:${LEGACY_SECRET}`), "legacy slot cleared through the override");
        assert.strictEqual(other.calls.length, 0, "the passed storage is ignored while an override is set");
        await clearStoredKey(other);
        assert.ok(override.calls.includes(`delete:${KEY_SECRET}`));
        assert.strictEqual(other.calls.length, 0);
    });

    test("without an override, all three operate on the passed storage", async () => {
        const secrets = fakeSecrets({ [KEY_SECRET]: "sk-plain" });
        assert.strictEqual(await readKey(secrets), "sk-plain");
        await storeKey(secrets, "sk-replaced");
        assert.strictEqual(secrets.values.get(KEY_SECRET), "sk-replaced");
        await clearStoredKey(secrets);
        assert.strictEqual(secrets.values.get(KEY_SECRET), undefined);
    });
});
