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
            contextPolicy: "auto",
            contextMarginPercent: 0,
            sanitizeBase64Content: true,
        });
    });

    test("contextPolicy: only 'full' opts out; anything else is auto", () => {
        assert.strictEqual(readConfig(fakeCfg({ contextWindowPolicy: "full" })).contextPolicy, "full");
        assert.strictEqual(readConfig(fakeCfg({ contextWindowPolicy: "AUTO" })).contextPolicy, "auto");
        assert.strictEqual(readConfig(fakeCfg()).contextPolicy, "auto");
    });

    test("contextMarginPercent: clamps to 0-50 and falls back to 0", () => {
        assert.strictEqual(readConfig(fakeCfg({ contextSafetyMarginPercent: -1 })).contextMarginPercent, 0);
        assert.strictEqual(readConfig(fakeCfg({ contextSafetyMarginPercent: 200 })).contextMarginPercent, 50);
        assert.strictEqual(readConfig(fakeCfg({ contextSafetyMarginPercent: 10 })).contextMarginPercent, 10);
        assert.strictEqual(readConfig(fakeCfg({ contextSafetyMarginPercent: NaN })).contextMarginPercent, 0);
        assert.strictEqual(
            readConfig(fakeCfg({ contextSafetyMarginPercent: "x" as unknown as number })).contextMarginPercent,
            0
        );
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

