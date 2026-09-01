import * as assert from "assert";
import * as vscode from "vscode";
import { createPanelDeps, doRefresh, getStatusText, refresh } from "../../extension";
import { handlePanelMessage } from "../../panel";

const EXTENSION_ID = "tianyu-liu.openrouter-copilot-request-credit";
const KEY_STORAGE = "openrouterApiKey";

const KEY_DATA = {
    label: "sk-or-v1-test...test",
    limit: null,
    limit_reset: null,
    limit_remaining: null,
    usage: 1.23,
    usage_daily: 0.5,
    usage_weekly: 2,
    usage_monthly: 3,
    is_free_tier: false,
};

const CREDITS_DATA = { total_credits: 100, total_usage: 10 };

function stubProvider(secrets: vscode.SecretStorage) {
    return {
        setTemplate: async () => ({ ok: true }),
        clearTemplate: async () => {},
        setKey: async (value: string) => {
            await secrets.store(KEY_STORAGE, value);
        },
        clearKey: async () => {
            await secrets.delete(KEY_STORAGE);
        },
    };
}

let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let fetchMode: "auto" | "manual" = "auto";
let creditsShouldFail = false;
const pending: Array<{ url: string; resolve: (r: Response) => void; reject: (e: Error) => void }> = [];
let originalFetch: typeof fetch;

function canned(body: unknown, ok = true): Response {
    return new Response(JSON.stringify(body), { status: ok ? 200 : 404 });
}

function route(url: string): Response {
    if (url.includes("/api/v1/credits")) {
        if (creditsShouldFail) throw new Error("credits fetch failed");
        return canned({ data: CREDITS_DATA });
    }
    if (url.includes("/api/v1/key")) {
        return canned({ data: KEY_DATA });
    }
    return canned({ error: { message: "not found" } }, false);
}

function installFetchStub(): void {
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
        const url = String(input);
        fetchCalls.push({ url, init });
        if (fetchMode === "manual") {
            return new Promise<Response>((resolve, reject) => {
                pending.push({ url, resolve, reject });
            });
        }
        try {
            return Promise.resolve(route(url));
        } catch (err) {
            return Promise.reject(err as Error);
        }
    }) as typeof fetch;
}

function restoreFetch(): void {
    globalThis.fetch = originalFetch;
}

async function settle(): Promise<void> {
    for (let i = 0; i < 200; i++) {
        const queued = pending.splice(0);
        for (const p of queued) {
            try {
                p.resolve(route(p.url));
            } catch (err) {
                p.reject(err as Error);
            }
        }
        await new Promise((r) => setTimeout(r, 10));
        if (pending.length === 0) {
            await new Promise((r) => setTimeout(r, 10));
            return;
        }
    }
    throw new Error("fetch did not settle");
}

async function waitForPending(count = 1): Promise<void> {
    for (let i = 0; i < 200 && pending.length < count; i++) {
        await new Promise((r) => setTimeout(r, 10));
    }
    assert.strictEqual(pending.length, count, `expected ${count} pending fetch(es)`);
}

function fakeSecrets(stored?: string): vscode.SecretStorage {
    let value = stored;
    return {
        get: async () => value,
        store: async (_key: string, v: string) => {
            value = v;
        },
        delete: async () => {
            value = undefined;
        },
    } as unknown as vscode.SecretStorage;
}

suiteSetup(() => {
    installFetchStub();
});

suiteTeardown(() => {
    restoreFetch();
});

suite("extension manifest", () => {
    test("contributes the provider and its commands", async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `Extension '${EXTENSION_ID}' should be present`);
        const contributes = (ext!.packageJSON as any).contributes ?? {};
        const commands = (contributes.commands ?? []).map((c: { command: string }) => c.command);
        assert.ok(commands.includes("openrouterCopilot.manage"), "manage command contributed");
        assert.ok(commands.includes("openrouterCopilot.pasteTemplate"), "pasteTemplate command contributed");
        assert.ok(commands.includes("openrouterCopilot.clearTemplate"), "clearTemplate command contributed");
        const providers = contributes.languageModelChatProviders ?? [];
        assert.strictEqual(
            providers[0]?.vendor,
            "openrouter-copilot-request-credit",
            "Chat provider registered with the expected vendor id"
        );
    });

    test("Configuration defaults are present", () => {
        const cfg = vscode.workspace.getConfiguration("openrouterCopilot");
        assert.strictEqual(cfg.get<number>("creditLimit"), 0);
        assert.strictEqual(cfg.get<number>("creditRefreshIntervalMinutes"), 5);
        assert.strictEqual(cfg.get<string>("creditResetPeriod"), "daily");
        assert.strictEqual(cfg.get<boolean>("creditIncludeByok"), true);
        assert.strictEqual(cfg.get<string>("creditBaseUrl"), "https://openrouter.ai");
        const copilot = vscode.workspace.getConfiguration("openrouterCopilot");
        assert.strictEqual(copilot.get<string>("baseUrl"), "https://openrouter.ai/api/v1");
    });

    test("Manifest constraints match the documented ranges", () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `Extension '${EXTENSION_ID}' should be present`);
        const props = (ext!.packageJSON as any).contributes.configuration.reduce(
            (acc: Record<string, unknown>, block: { properties: Record<string, unknown> }) => {
                return { ...acc, ...block.properties };
            },
            {}
        );
        assert.strictEqual((props["openrouterCopilot.creditLimit"] as any).minimum, 0);
        assert.strictEqual((props["openrouterCopilot.creditRefreshIntervalMinutes"] as any).minimum, 1);
        assert.strictEqual((props["openrouterCopilot.creditRefreshIntervalMinutes"] as any).maximum, 1440);
        for (const key of [
            "openrouterCopilot.creditLimit",
            "openrouterCopilot.creditResetPeriod",
            "openrouterCopilot.creditIncludeByok",
            "openrouterCopilot.creditRefreshIntervalMinutes",
            "openrouterCopilot.creditBaseUrl",
        ]) {
            assert.strictEqual((props[key] as any).scope, "application", `${key} must be application-scoped`);
        }
    });
});

suite("extension behavior without a key", () => {
    test("activate completes without a key", async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `Extension '${EXTENSION_ID}' should be present`);
        if (ext && !ext.isActive) {
            await ext.activate();
        }
        assert.ok(ext!.isActive, "extension should be active");
    });
});

suite("network isolation (stubbed fetch)", () => {
    test("every API request is https and stays on openrouter.ai", async () => {
        await settle();
        const before = fetchCalls.length;
        await doRefresh(fakeSecrets("sk-isolation"));
        await settle();
        assert.ok(fetchCalls.length > before, "refresh made requests");
        for (const call of fetchCalls) {
            assert.ok(
                call.url.startsWith("https://openrouter.ai/api/v1/"),
                `request went to an unexpected host: ${call.url}`
            );
        }
    });

    test("a refresh with no stored key makes no network calls", async () => {
        await settle();
        const before = fetchCalls.length;
        await doRefresh(fakeSecrets(undefined));
        assert.strictEqual(fetchCalls.length, before, "no fetch without a key");
        assert.ok((getStatusText() ?? "").includes("no key"));
    });

    test("single-flight: concurrent refreshes share exactly one fetch", async () => {
        await settle();
        await new Promise((r) => setTimeout(r, 100));
        fetchCalls = [];
        fetchMode = "manual";
        try {
            const secrets = fakeSecrets("sk-single");
            const p1 = refresh(secrets);
            const p2 = refresh(secrets);
            await waitForPending(1);
            assert.strictEqual(fetchCalls.length, 1, "only one fetch for two concurrent callers");
            await settle();
            await Promise.all([p1, p2]);
        } finally {
            fetchMode = "auto";
            await settle();
        }
    });

    test("credits failure is non-fatal and the stale balance is cleared", async () => {
        await settle();
        await new Promise((r) => setTimeout(r, 150));
        const cfg = vscode.workspace.getConfiguration("openrouterCopilot");
        const secrets = fakeSecrets("sk-credits");
        await cfg.update("creditLimit", 0, vscode.ConfigurationTarget.Global);
        try {
            await settle();
            await new Promise((r) => setTimeout(r, 150));
            creditsShouldFail = true;
            await doRefresh(secrets);
            assert.strictEqual(getStatusText(), "OR n/a");
            creditsShouldFail = false;
            await doRefresh(secrets);
            assert.strictEqual(getStatusText(), "OR $90.00");
        } finally {
            creditsShouldFail = false;
            await cfg.update("creditLimit", 0, vscode.ConfigurationTarget.Global);
            await settle();
        }
    });

    test("clearKey invalidates an in-flight refresh (stale data is discarded)", async () => {
        await settle();
        await new Promise((r) => setTimeout(r, 100));
        fetchCalls = [];
        fetchMode = "manual";
        try {
            const secrets = fakeSecrets("sk-stale");
            const run = doRefresh(secrets);
            await waitForPending(1);
            const deps = createPanelDeps(secrets, stubProvider(secrets));
            await handlePanelMessage({ type: "clearKey" }, deps);
            assert.ok((getStatusText() ?? "").includes("no key"));
            await settle();
            await run;
            assert.ok(
                (getStatusText() ?? "").includes("no key"),
                "stale run must not resurrect the cleared key"
            );
        } finally {
            fetchMode = "auto";
            await settle();
        }
    });

    test("saveKey stores the trimmed key and refreshes with the Authorization header", async () => {
        await settle();
        await new Promise((r) => setTimeout(r, 100));
        fetchCalls = [];
        const cfg = vscode.workspace.getConfiguration("openrouterCopilot");
        const secrets = fakeSecrets(undefined);
        await cfg.update("creditLimit", 10, vscode.ConfigurationTarget.Global);
        try {
            await settle();
            const deps = createPanelDeps(secrets, stubProvider(secrets));
            await handlePanelMessage({ type: "saveKey", value: "  sk-or-v1-abc123  " }, deps);
            assert.strictEqual(await secrets.get(KEY_STORAGE), "sk-or-v1-abc123");
            const keyCall = fetchCalls.find((c) => c.url.includes("/api/v1/key"));
            assert.ok(keyCall, "a key fetch happened");
            const headers = (keyCall!.init?.headers ?? {}) as Record<string, string>;
            assert.strictEqual(headers.Authorization, "Bearer sk-or-v1-abc123");
            assert.strictEqual(getStatusText(), "OR $9.50/10");
        } finally {
            await cfg.update("creditLimit", 0, vscode.ConfigurationTarget.Global);
            await settle();
        }
    });
});
