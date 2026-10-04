import * as assert from "assert";
import * as vscode from "vscode";
import { readConfig } from "../../extension";

/**
 * A minimal fake WorkspaceConfiguration. `readConfig` reads global scope only
 * (via inspect().globalValue), so workspace overrides can be shown to be ignored.
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
        sanitizeBase64Content: true,
        hideUnavailableModels: true,
        outputReservePercent: 12.5,
        outputReserveMinTokens: 16384,
        outputReserveMaxTokens: 262144,
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
            sanitizeBase64Content: true,
            hideUnavailableModels: true,
            outputReservePercent: 12.5,
            outputReserveMinTokens: 16384,
            outputReserveMaxTokens: 262144,
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

    test("hideUnavailableModels: non-boolean values fall back to true", () => {
        assert.strictEqual(
            readConfig(fakeCfg({ hideUnavailableModels: "false" as unknown as boolean })).hideUnavailableModels,
            true
        );
        assert.strictEqual(readConfig(fakeCfg({ hideUnavailableModels: false })).hideUnavailableModels, false);
        assert.strictEqual(readConfig(fakeCfg({ hideUnavailableModels: true })).hideUnavailableModels, true);
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

    test("output reserve settings: invalid values fall back to the defaults", () => {
        const cfg = readConfig(
            fakeCfg({ outputReservePercent: 80, outputReserveMinTokens: 0, outputReserveMaxTokens: -1 })
        );
        assert.strictEqual(cfg.outputReservePercent, 12.5);
        assert.strictEqual(cfg.outputReserveMinTokens, 16384);
        assert.strictEqual(cfg.outputReserveMaxTokens, 262144);
        const set = readConfig(fakeCfg({ outputReservePercent: 25, outputReserveMinTokens: 65536, outputReserveMaxTokens: 262144 }));
        assert.strictEqual(set.outputReservePercent, 25);
        assert.strictEqual(set.outputReserveMinTokens, 65536);
        assert.strictEqual(set.outputReserveMaxTokens, 262144);
    });

    test("workspace overrides are ignored (global scope only)", () => {
        const cfg = readConfig(fakeCfg({}, { creditLimit: 99, creditResetPeriod: "never", creditRefreshIntervalMinutes: 1 }));
        assert.strictEqual(cfg.limit, 0);
        assert.strictEqual(cfg.resetPeriod, "daily");
        assert.strictEqual(cfg.refreshIntervalMinutes, 5);
    });
});

