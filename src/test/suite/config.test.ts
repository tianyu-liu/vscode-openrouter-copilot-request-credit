import * as assert from "assert";
import * as vscode from "vscode";
import { apiBaseUrl, readConfig } from "../../extension";

/**
 * A minimal fake WorkspaceConfiguration. `readConfig`/`apiBaseUrl` read global
 * scope only (via inspect().globalValue), so the fake separates global and
 * workspace values to prove workspace overrides are ignored.
 */
function fakeCfg(
    globalValues: Record<string, unknown> = {},
    workspaceValues: Record<string, unknown> = {}
): vscode.WorkspaceConfiguration {
    const defaults: Record<string, unknown> = {
        creditLimit: 0,
        creditResetPeriod: "daily",
        creditIncludeByok: true,
        creditRefreshIntervalMinutes: 5,
        creditBaseUrl: "https://openrouter.ai",
    };
    const cfg = {
        get: (key: string, fallback?: unknown) =>
            key in globalValues ? globalValues[key] : key in defaults ? defaults[key] : fallback,
        inspect: <T>(key: string) => ({
            key,
            defaultValue: defaults[key] as T,
            globalValue: (key in globalValues ? globalValues[key] : undefined) as T | undefined,
            workspaceValue: (key in workspaceValues ? workspaceValues[key] : undefined) as T | undefined,
            workspaceFolderValue: undefined as T | undefined,
        }),
        update: () => Promise.resolve(),
    };
    return cfg as unknown as vscode.WorkspaceConfiguration;
}

suite("readConfig", () => {
    test("defaults apply when nothing is set", () => {
        assert.deepStrictEqual(readConfig(fakeCfg()), {
            limit: 0,
            resetPeriod: "daily",
            includeByok: true,
            refreshIntervalMinutes: 5,
        });
    });

    test("limit coercion: non-finite -> 0, negative -> 0, valid numbers pass", () => {
        assert.strictEqual(readConfig(fakeCfg({ creditLimit: NaN })).limit, 0);
        assert.strictEqual(readConfig(fakeCfg({ creditLimit: -5 })).limit, 0);
        assert.strictEqual(readConfig(fakeCfg({ creditLimit: 0 })).limit, 0);
        assert.strictEqual(readConfig(fakeCfg({ creditLimit: 25 })).limit, 25);
        assert.strictEqual(readConfig(fakeCfg({ creditLimit: "x" as unknown as number })).limit, 0);
    });

    test("resetPeriod: unknown values fall back to daily", () => {
        assert.strictEqual(readConfig(fakeCfg({ creditResetPeriod: "hourly" })).resetPeriod, "daily");
        assert.strictEqual(readConfig(fakeCfg({ creditResetPeriod: "never" })).resetPeriod, "never");
        assert.strictEqual(readConfig(fakeCfg({ creditResetPeriod: "monthly" })).resetPeriod, "monthly");
    });

    test("includeByok: non-boolean values fall back to true", () => {
        assert.strictEqual(readConfig(fakeCfg({ creditIncludeByok: "false" as unknown as boolean })).includeByok, true);
        assert.strictEqual(readConfig(fakeCfg({ creditIncludeByok: false })).includeByok, false);
        assert.strictEqual(readConfig(fakeCfg({ creditIncludeByok: true })).includeByok, true);
    });

    test("refreshIntervalMinutes: clamps to 1-1440 and falls back to 5", () => {
        assert.strictEqual(readConfig(fakeCfg({ creditRefreshIntervalMinutes: 0 })).refreshIntervalMinutes, 5);
        assert.strictEqual(readConfig(fakeCfg({ creditRefreshIntervalMinutes: 0.5 })).refreshIntervalMinutes, 1);
        assert.strictEqual(readConfig(fakeCfg({ creditRefreshIntervalMinutes: 2000 })).refreshIntervalMinutes, 1440);
        assert.strictEqual(readConfig(fakeCfg({ creditRefreshIntervalMinutes: NaN })).refreshIntervalMinutes, 5);
        assert.strictEqual(
            readConfig(fakeCfg({ creditRefreshIntervalMinutes: "abc" as unknown as number })).refreshIntervalMinutes,
            5
        );
        assert.strictEqual(readConfig(fakeCfg({ creditRefreshIntervalMinutes: 1440 })).refreshIntervalMinutes, 1440);
        assert.strictEqual(readConfig(fakeCfg({ creditRefreshIntervalMinutes: 1 })).refreshIntervalMinutes, 1);
    });

    test("workspace overrides are ignored (global scope only)", () => {
        const cfg = readConfig(fakeCfg({}, { creditLimit: 99, creditResetPeriod: "never", creditRefreshIntervalMinutes: 1 }));
        assert.strictEqual(cfg.limit, 0);
        assert.strictEqual(cfg.resetPeriod, "daily");
        assert.strictEqual(cfg.refreshIntervalMinutes, 5);
    });
});

suite("apiBaseUrl", () => {
    test("accepts a valid global https URL and strips trailing slashes", () => {
        assert.strictEqual(apiBaseUrl(fakeCfg({ creditBaseUrl: "https://api.example.com///" })), "https://api.example.com");
        assert.strictEqual(apiBaseUrl(fakeCfg({ creditBaseUrl: "https://openrouter.ai/api" })), "https://openrouter.ai/api");
    });

    test("falls back to the default for non-https or unparsable values", () => {
        assert.strictEqual(apiBaseUrl(fakeCfg({ creditBaseUrl: "http://insecure.example.com" })), "https://openrouter.ai");
        assert.strictEqual(apiBaseUrl(fakeCfg({ creditBaseUrl: "ftp://example.com" })), "https://openrouter.ai");
        assert.strictEqual(apiBaseUrl(fakeCfg({ creditBaseUrl: "not a url" })), "https://openrouter.ai");
        assert.strictEqual(apiBaseUrl(fakeCfg({ creditBaseUrl: "https://" })), "https://openrouter.ai");
    });

    test("workspace-scoped baseUrl values are ignored", () => {
        assert.strictEqual(
            apiBaseUrl(fakeCfg({}, { creditBaseUrl: "https://evil.example.com" })),
            "https://openrouter.ai"
        );
    });

    test("warns once per bad value, and warns again after a good value", () => {
        const original = vscode.window.showWarningMessage;
        let warnings = 0;
        (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (() => {
            warnings++;
            return Promise.resolve(undefined);
        }) as typeof original;
        try {
            // Reset the warn-once flag with a valid value first (module state
            // persists across tests).
            apiBaseUrl(fakeCfg({ creditBaseUrl: "https://openrouter.ai" }));
            assert.strictEqual(apiBaseUrl(fakeCfg({ creditBaseUrl: "http://bad.example.com" })), "https://openrouter.ai");
            assert.strictEqual(warnings, 1);
            // Same bad value again: no second warning (warn once).
            assert.strictEqual(apiBaseUrl(fakeCfg({ creditBaseUrl: "http://bad.example.com" })), "https://openrouter.ai");
            assert.strictEqual(warnings, 1);
            // A good value resets the flag, so a later bad value warns again.
            apiBaseUrl(fakeCfg({ creditBaseUrl: "https://openrouter.ai" }));
            assert.strictEqual(apiBaseUrl(fakeCfg({ creditBaseUrl: "http://bad.example.com" })), "https://openrouter.ai");
            assert.strictEqual(warnings, 2);
        } finally {
            (vscode.window as { showWarningMessage: unknown }).showWarningMessage = original;
            apiBaseUrl(fakeCfg({ creditBaseUrl: "https://openrouter.ai" }));
        }
    });
});
