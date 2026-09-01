import * as assert from "assert";
import {
    buildDetail,
    buildStatus,
    describeReset,
    Detail,
    effectiveIncludeByok,
    formatCompact,
    formatReset,
    formatUsd,
    formatUsdOrNa,
    KeyInfo,
    maskKey,
    nextUtcMidnight,
    nextUtcMonday,
    nextUtcMonthStart,
    resetBoundary,
    resetPeriodLabel,
    usedDaily,
    usedWeekly,
    usedMonthly,
} from "../../logic";

suite("logic.buildStatus", () => {
    test("key has a configured limit -> shows remaining from limit_remaining", () => {
        const info: KeyInfo = {
            limit: 10,
            limit_reset: "daily",
            limit_remaining: 3.42,
            usage: 6.58,
            usage_daily: 1.5,
            usage_weekly: 4,
            usage_monthly: 6.58,
            is_free_tier: false,
        };
        const view = buildStatus(info, 10);
        assert.strictEqual(view.text, "OR $3.42/10");
        assert.match(view.tooltip, /Daily limit: \$10\.00/);
        assert.match(view.tooltip, /Daily remaining: \$3\.42/);
        assert.match(view.tooltip, /Daily usage: \$1\.50/);
        // limit_reset is a reset TYPE string (daily/weekly/monthly/never), not a date.
        assert.match(view.tooltip, /Resets: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} \S+ \(Daily\)/);
        assert.strictEqual(view.background, "default");
    });

    test("limit without a reset time -> shows 'No reset'", () => {
        const info: KeyInfo = {
            limit: 50,
            limit_reset: null,
            limit_remaining: 20,
            usage: 30,
            usage_daily: 2,
            usage_weekly: 10,
            usage_monthly: 30,
            is_free_tier: false,
        };
        const view = buildStatus(info, 10);
        assert.match(view.tooltip, /Resets: No reset/);
    });

    test("limit branch clamps remaining at 0", () => {
        const info: KeyInfo = {
            limit: 5,
            limit_reset: null,
            limit_remaining: -2,
            usage: 7,
            usage_daily: 7,
            usage_weekly: 7,
            usage_monthly: 7,
            is_free_tier: false,
        };
        const view = buildStatus(info, 10);
        assert.strictEqual(view.text, "OR $0.00/5");
    });

    test("limit branch with missing limit_remaining shows 'n/a' (not $0.00)", () => {
        const info: KeyInfo = {
            limit: 5,
            limit_reset: null,
            limit_remaining: null,
            usage: 1,
            usage_daily: 1,
            usage_weekly: 1,
            usage_monthly: 1,
            is_free_tier: false,
        };
        const view = buildStatus(info, 10);
        assert.strictEqual(view.text, "OR n/a/5");
        assert.match(view.tooltip, /All-time remaining: n\/a/);
        // Absence is not exhaustion: a null figure must not trigger error state.
        assert.strictEqual(view.background, "default");
    });

    test("limit branch marks an exhausted key with the error background", () => {
        const info: KeyInfo = {
            limit: 5,
            limit_reset: null,
            limit_remaining: 0,
            usage: 5,
            usage_daily: 5,
            usage_weekly: 5,
            usage_monthly: 5,
            is_free_tier: false,
        };
        const view = buildStatus(info, 10);
        assert.strictEqual(view.text, "OR $0.00/5");
        assert.strictEqual(view.background, "error");
    });

    test("No limit -> falls back to guardrail (limit - usage)", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 3.42,
            usage_daily: 3.42,
            usage_weekly: 12,
            usage_monthly: 40,
            is_free_tier: false,
        };
        const view = buildStatus(info, 10);
        assert.strictEqual(view.text, "OR $6.58/10");
        assert.match(view.tooltip, /Daily limit: \$10\.00/);
        assert.match(view.tooltip, /Daily usage: \$3\.42/);
        assert.match(view.tooltip, /Daily remaining: \$6\.58/);
        assert.match(view.tooltip, /Resets: /);
        assert.strictEqual(view.background, "default");
    });

    test("No limit + BYOK -> guardrail counts BYOK spend too (includeByok=true)", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 3.42,
            usage_daily: 3.42,
            usage_weekly: 12,
            usage_monthly: 40,
            is_free_tier: false,
            byok_usage_daily: 1.0,
        };
        // used = 3.42 + 1.0 = 4.42; remaining = 10 - 4.42 = 5.58
        const view = buildStatus(info, 10, "daily", true);
        assert.strictEqual(view.text, "OR $5.58/10");
    });

    test("No limit + BYOK excluded (includeByok=false) -> only non-BYOK spend counts", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 3.42,
            usage_daily: 3.42,
            usage_weekly: 12,
            usage_monthly: 40,
            is_free_tier: false,
            byok_usage_daily: 1.0,
        };
        // used = 3.42 (BYOK ignored); remaining = 10 - 3.42 = 6.58
        const view = buildStatus(info, 10, "daily", false);
        assert.strictEqual(view.text, "OR $6.58/10");
    });

    test("guardrail respects a weekly reset period", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 3.42,
            usage_daily: 3.42,
            usage_weekly: 3.42,
            usage_monthly: 40,
            is_free_tier: false,
        };
        const view = buildStatus(info, 10, "weekly");
        assert.strictEqual(view.text, "OR $6.58/10");
        assert.match(view.tooltip, /Weekly limit: \$10\.00/);
        assert.match(view.tooltip, /Weekly usage: \$3\.42/);
        assert.match(view.tooltip, /Resets: \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} \S+/);
    });

    test("guardrail branch: zero/over limit shows $(error) and error background", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 12,
            usage_daily: 12,
            usage_weekly: 30,
            usage_monthly: 90,
            is_free_tier: false,
        };
        const view = buildStatus(info, 10);
        assert.strictEqual(view.text, "$(error) OR $0.00/10");
        assert.strictEqual(view.background, "error");
    });

    test("guardrail branch: exactly at limit boundary", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 10,
            usage_daily: 10,
            usage_weekly: 10,
            usage_monthly: 10,
            is_free_tier: false,
        };
        const view = buildStatus(info, 10);
        assert.strictEqual(view.text, "$(error) OR $0.00/10");
        assert.strictEqual(view.background, "error");
    });

    test("free tier flag is appended in the limit branch", () => {
        const info: KeyInfo = {
            limit: 100,
            limit_reset: null,
            limit_remaining: 99,
            usage: 1,
            usage_daily: 1,
            usage_weekly: 1,
            usage_monthly: 1,
            is_free_tier: true,
        };
        const view = buildStatus(info, 10);
        assert.match(view.tooltip, /Free tier: yes/);
    });
});

suite("logic.formatUsd", () => {
    test("formats to two decimals", () => {
        assert.strictEqual(formatUsd(3.4), "$3.40");
        assert.strictEqual(formatUsd(0), "$0.00");
        assert.strictEqual(formatUsd(1234.5), "$1234.50");
    });
    test("sanitizes malformed numbers instead of rendering NaN", () => {
        assert.strictEqual(formatUsd(NaN), "n/a");
        assert.strictEqual(formatUsd(Infinity), "n/a");
        // String-typed numbers (a plausible API drift) are coerced.
        assert.strictEqual(formatUsd("5" as unknown as number), "$5.00");
        assert.strictEqual(formatUsdOrNa(null), "n/a");
        assert.strictEqual(formatUsdOrNa(undefined), "n/a");
    });
    test("blank strings and booleans never render a misleading $0.00", () => {
        assert.strictEqual(formatUsd("" as unknown as number), "n/a");
        assert.strictEqual(formatUsd("  " as unknown as number), "n/a");
        assert.strictEqual(formatUsd(true as unknown as number), "n/a");
        assert.strictEqual(formatUsd(false as unknown as number), "n/a");
    });
    test("huge amounts never leak exponential notation", () => {
        assert.strictEqual(formatUsd(1e21), "$1,000,000,000,000,000,000,000");
        assert.strictEqual(formatUsd(-1e21), "-$1,000,000,000,000,000,000,000");
        assert.strictEqual(formatUsd(1e15), "$1000000000000000.00");
    });
});

suite("logic.formatCompact", () => {
    test("drops trailing zeros and rounds to two decimals", () => {
        assert.strictEqual(formatCompact(10), "10");
        assert.strictEqual(formatCompact(10.5), "10.5");
        assert.strictEqual(formatCompact(10.1234), "10.12");
        assert.strictEqual(formatCompact(1000), "1000");
    });
    test("sanitizes malformed numbers", () => {
        assert.strictEqual(formatCompact(NaN), "n/a");
        assert.strictEqual(formatCompact(Infinity), "n/a");
        assert.strictEqual(formatCompact("" as unknown as number), "n/a");
        assert.strictEqual(formatCompact(true as unknown as number), "n/a");
    });
    test("huge amounts never leak exponential notation", () => {
        assert.strictEqual(formatCompact(1e21), "1,000,000,000,000,000,000,000");
        assert.strictEqual(formatCompact(1e15), "1000000000000000");
    });
});

suite("logic.nextUtcMidnight", () => {
    test("returns the next 00:00:00.000 UTC strictly after the given time", () => {
        const cases: Array<[string, string]> = [
            ["2026-08-27T12:34:56Z", "2026-08-28T00:00:00.000Z"],
            ["2026-08-27T23:59:59Z", "2026-08-28T00:00:00.000Z"],
            // Exactly at midnight rolls to the next day.
            ["2026-08-28T00:00:00.000Z", "2026-08-29T00:00:00.000Z"],
            // Month boundary.
            ["2026-09-30T05:00:00.000Z", "2026-10-01T00:00:00.000Z"],
            // Year boundary.
            ["2026-12-31T15:30:00.000Z", "2027-01-01T00:00:00.000Z"],
            // Leap year.
            ["2028-02-28T09:00:00.000Z", "2028-02-29T00:00:00.000Z"],
            ["2028-02-29T09:00:00.000Z", "2028-03-01T00:00:00.000Z"],
        ];
        for (const [input, expected] of cases) {
            const reset = nextUtcMidnight(new Date(input));
            assert.strictEqual(reset.toISOString(), expected, `for input ${input}`);
            assert.ok(reset > new Date(input), `should be strictly later for ${input}`);
        }
    });
});

suite("logic.formatReset", () => {
    test("parses an ISO string and returns a non-empty localized string", () => {
        const str = formatReset("2026-08-30T00:00:00.000Z");
        assert.strictEqual(typeof str, "string");
        assert.ok(str.length > 0);
        const date = formatReset(new Date("2026-08-30T00:00:00.000Z"));
        assert.ok(date.length > 0);
    });
    test("string and Date inputs render identically", () => {
        assert.strictEqual(
            formatReset("2026-08-30T00:00:00.000Z"),
            formatReset(new Date("2026-08-30T00:00:00.000Z"))
        );
    });
    // Exact pins: the Date constructor arguments below are LOCAL wall time, so
    // the expected YYYY/MM/DD HH:MM prefix is the same in every timezone. A
    // constant-string or UTC/local-mixup regression fails these.
    test("renders local date parts exactly (YYYY/MM/DD HH:MM TZ)", () => {
        assert.match(formatReset(new Date(2026, 0, 2, 3, 4)), /^2026\/01\/02 03:04 \S+$/);
        assert.match(formatReset(new Date(2026, 8, 9, 5, 6)), /^2026\/09\/09 05:06 \S+$/);
        assert.match(formatReset(new Date(2026, 11, 31, 23, 59)), /^2026\/12\/31 23:59 \S+$/);
        assert.match(formatReset(new Date(2026, 0, 2, 0, 0)), /^2026\/01\/02 00:00 \S+$/);
    });
    test("an invalid date is visibly invalid, never silently 'valid'", () => {
        assert.match(formatReset(new Date("garbage")), /NaN/);
    });
});

suite("logic.nextUtcMonday", () => {
    test("returns the next Monday 00:00:00.000 UTC", () => {
        const cases: Array<[string, string]> = [
            // Sunday -> next day.
            ["2026-08-23T10:00:00Z", "2026-08-24T00:00:00.000Z"],
            // Exactly Monday 00:00 -> the Monday a week later.
            ["2026-08-24T00:00:00.000Z", "2026-08-31T00:00:00.000Z"],
            // Tuesday.
            ["2026-08-25T12:00:00Z", "2026-08-31T00:00:00.000Z"],
            // Saturday, late evening.
            ["2026-08-29T23:59:59Z", "2026-08-31T00:00:00.000Z"],
        ];
        for (const [input, expected] of cases) {
            assert.strictEqual(nextUtcMonday(new Date(input)).toISOString(), expected, `for input ${input}`);
        }
    });
});

suite("logic.nextUtcMonthStart", () => {
    test("returns the first day of the next month 00:00 UTC", () => {
        const cases: Array<[string, string]> = [
            // Year rollover.
            ["2026-12-15T10:00:00Z", "2027-01-01T00:00:00.000Z"],
            // Leap-year February.
            ["2028-02-15T00:00:00Z", "2028-03-01T00:00:00.000Z"],
            // Non-leap January -> February.
            ["2026-01-31T23:00:00Z", "2026-02-01T00:00:00.000Z"],
            // 30-day month.
            ["2026-04-30T12:00:00Z", "2026-05-01T00:00:00.000Z"],
        ];
        for (const [input, expected] of cases) {
            assert.strictEqual(nextUtcMonthStart(new Date(input)).toISOString(), expected, `for input ${input}`);
        }
    });
});

suite("logic.resetBoundary", () => {
    test("'never' yields an invalid date; recurring periods yield the matching boundary", () => {
        assert.ok(Number.isNaN(resetBoundary("never").getTime()));
        assert.strictEqual(resetBoundary("weekly").toISOString(), nextUtcMonday().toISOString());
        assert.strictEqual(resetBoundary("monthly").toISOString(), nextUtcMonthStart().toISOString());
        assert.strictEqual(resetBoundary("daily").toISOString(), nextUtcMidnight().toISOString());
    });
});

suite("logic.effectiveIncludeByok", () => {
    const mk = (limit: number | null, include_byok_in_limit?: boolean): KeyInfo => ({
        limit,
        limit_reset: null,
        limit_remaining: null,
        usage: 1,
        usage_daily: 1,
        usage_weekly: 1,
        usage_monthly: 1,
        is_free_tier: false,
        include_byok_in_limit,
    });
    test("manual mode uses the user config; auto mode uses the key flag", () => {
        assert.strictEqual(effectiveIncludeByok(mk(null), true), true);
        assert.strictEqual(effectiveIncludeByok(mk(null), false), false);
        // Absent flag defaults to true (matches the OpenRouter API).
        assert.strictEqual(effectiveIncludeByok(mk(10), true), true);
        assert.strictEqual(effectiveIncludeByok(mk(10, false), true), false);
        assert.strictEqual(effectiveIncludeByok(mk(10, true), false), true);
    });
});

suite("logic.buildDetail", () => {
    test("limit branch separates reset period from reset date", () => {
        const info: KeyInfo = {
            limit: 10,
            limit_reset: "daily",
            limit_remaining: 5,
            usage: 5,
            usage_daily: 5,
            usage_weekly: 5,
            usage_monthly: 10,
            is_free_tier: false,
        };
        const detail = buildDetail(info, 10);
        assert.strictEqual(detail.limitSource, "auto");
        assert.strictEqual(detail.limitValue, "$10.00");
        assert.strictEqual(detail.resetPeriod, "daily");
        assert.strictEqual(detail.resetDate, formatReset(nextUtcMidnight()));
        // The date has no "(daily)" suffix — the period is a separate field.
        assert.ok(!/\(daily\)/.test(detail.resetDate));
    });

    test("limit branch weekly/monthly/never periods", () => {
        const mk = (limit_reset: string | null): Detail => {
            const info: KeyInfo = {
                limit: 10,
                limit_reset,
                limit_remaining: 5,
                usage: 5,
                usage_daily: 5,
                usage_weekly: 5,
                usage_monthly: 10,
                is_free_tier: false,
            };
            return buildDetail(info, 10);
        };
        assert.strictEqual(mk("weekly").resetPeriod, "weekly");
        assert.strictEqual(mk("weekly").resetDate, formatReset(nextUtcMonday()));
        assert.strictEqual(mk("monthly").resetPeriod, "monthly");
        assert.strictEqual(mk("monthly").resetDate, formatReset(nextUtcMonthStart()));
        assert.strictEqual(mk(null).resetPeriod, "never");
        assert.strictEqual(mk(null).resetDate, "No reset");
    });

    test("guardrail branch uses 'Manual limit' label and next UTC midnight reset", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 3.42,
            usage_daily: 3.42,
            usage_weekly: 12,
            usage_monthly: 40,
            is_free_tier: false,
        };
        const detail = buildDetail(info, 10);
        assert.strictEqual(detail.limitSource, "manual");
        assert.strictEqual(detail.limitValue, "$10.00");
        assert.strictEqual(detail.resetPeriod, "daily");
        assert.strictEqual(detail.resetDate, formatReset(nextUtcMidnight()));
    });

    test("guardrail branch weekly reset period uses Monday boundary", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 1,
            usage_daily: 1,
            usage_weekly: 1,
            usage_monthly: 1,
            is_free_tier: false,
        };
        const detail = buildDetail(info, 10, "weekly");
        assert.strictEqual(detail.resetPeriod, "weekly");
        assert.strictEqual(detail.resetDate, formatReset(nextUtcMonday()));
    });

    test("auto branch computes the reset time locally from the limit_reset type", () => {
        const info: KeyInfo = {
            limit: 10,
            limit_reset: "weekly",
            limit_remaining: 5,
            usage: 5,
            usage_daily: 5,
            usage_weekly: 5,
            usage_monthly: 10,
            is_free_tier: false,
        };
        const detail = buildDetail(info, 10);
        assert.strictEqual(detail.limitSource, "auto");
    });

    test("keyLabel passes through the API label as-is (no double-masking)", () => {
        // OpenRouter returns label already masked, e.g. "sk-or-v1-test...test".
        // buildDetail must NOT re-run maskKey on it.
        const info: KeyInfo = {
            label: "sk-or-v1-test...test",
            limit: 10,
            limit_reset: "daily",
            limit_remaining: 5,
            usage: 5,
            usage_daily: 5,
            usage_weekly: 5,
            usage_monthly: 10,
            is_free_tier: false,
        };
        const detail = buildDetail(info, 10);
        assert.strictEqual(detail.keyLabel, "sk-or-v1-test...test");
    });

    test("keyLabel falls back to 'unknown key' when label is null", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 1,
            usage_daily: 1,
            usage_weekly: 1,
            usage_monthly: 1,
            is_free_tier: false,
        };
        const detail = buildDetail(info, 10);
        assert.strictEqual(detail.keyLabel, "unknown key");
    });

    test("manual and auto modes share an identical 4-row table", () => {
        const labels = (d: Detail) => d.rows.map((r) => r.label);
        const manualInfo: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 3,
            usage_daily: 1,
            usage_weekly: 2,
            usage_monthly: 3,
            is_free_tier: false,
        };
        const autoInfo: KeyInfo = {
            limit: 10,
            limit_reset: "daily",
            limit_remaining: 5,
            usage: 3,
            usage_daily: 1,
            usage_weekly: 2,
            usage_monthly: 3,
            is_free_tier: false,
        };
        const expected = [
            "Daily",
            "Weekly",
            "Monthly",
            "All-time",
        ];
        assert.deepStrictEqual(labels(buildDetail(manualInfo, 10)), expected);
        assert.deepStrictEqual(labels(buildDetail(autoInfo, 10)), expected);
    });

    test("usage rows split OpenRouter-only vs BYOK into two columns plus a sum", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 30,
            usage_daily: 1,
            usage_weekly: 2,
            usage_monthly: 3,
            is_free_tier: false,
            byok_usage: 9,
            byok_usage_daily: 0.5,
            byok_usage_weekly: 1.5,
            byok_usage_monthly: 2.5,
        };
        const detail = buildDetail(info, 10, "daily", true);
        const row = (label: string) => detail.rows.find((r) => r.label === label)!;
        assert.strictEqual(row("Daily").orValue, "$1.00");
        assert.strictEqual(row("Daily").byokValue, "$0.50");
        assert.strictEqual(row("Daily").sumValue, "$1.50");
        assert.strictEqual(row("Weekly").orValue, "$2.00");
        assert.strictEqual(row("Weekly").byokValue, "$1.50");
        assert.strictEqual(row("Weekly").sumValue, "$3.50");
        assert.strictEqual(row("Monthly").orValue, "$3.00");
        assert.strictEqual(row("Monthly").byokValue, "$2.50");
        assert.strictEqual(row("Monthly").sumValue, "$5.50");
        assert.strictEqual(row("All-time").orValue, "$30.00");
        assert.strictEqual(row("All-time").byokValue, "$9.00");
        assert.strictEqual(row("All-time").sumValue, "$39.00");
    });

    test("missing BYOK values render as 'n/a' but sum still equals OpenRouter-only", () => {
        const info: KeyInfo = {
            limit: 100,
            limit_reset: "monthly",
            limit_remaining: 40,
            usage: 10,
            usage_daily: 1,
            usage_weekly: 2,
            usage_monthly: 3,
            is_free_tier: false,
            // No BYOK fields provided -> all byokValue columns are "n/a".
        };
        const detail = buildDetail(info, 10, "daily", false);
        assert.ok(detail.rows.every((r) => r.byokValue === "n/a"));
        const total = detail.rows.find((r) => r.label === "All-time")!;
        assert.strictEqual(total.orValue, "$10.00");
        assert.strictEqual(total.sumValue, "$10.00");
    });

    test("missing remaining renders as 'n/a'", () => {
        const info: KeyInfo = {
            limit: 10,
            limit_reset: "daily",
            limit_remaining: null,
            usage: 3,
            usage_daily: 1,
            usage_weekly: 2,
            usage_monthly: 3,
            is_free_tier: false,
        };
        const detail = buildDetail(info, 10);
        assert.strictEqual(detail.remaining, "n/a");
        assert.strictEqual(detail.freeTier, "no");
    });

    test("highlight follows the reset period and BYOK inclusion (manual mode)", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 3,
            usage_daily: 1,
            usage_weekly: 2,
            usage_monthly: 3,
            is_free_tier: false,
        };
        // monthly reset + BYOK included -> the Monthly sum cell.
        assert.deepStrictEqual(buildDetail(info, 10, "monthly", true).highlight, { row: 2, col: "sum" });
        // daily reset + BYOK excluded -> the Daily OpenRouter-only cell.
        assert.deepStrictEqual(buildDetail(info, 10, "daily", false).highlight, { row: 0, col: "or" });
        // weekly reset + BYOK included -> the Weekly sum cell.
        assert.deepStrictEqual(buildDetail(info, 10, "weekly", true).highlight, { row: 1, col: "sum" });
    });

    test("highlight uses the key's own reset period in auto mode", () => {
        const info: KeyInfo = {
            limit: 10,
            limit_reset: "monthly",
            limit_remaining: 5,
            usage: 3,
            usage_daily: 1,
            usage_weekly: 2,
            usage_monthly: 3,
            is_free_tier: false,
        };
        assert.deepStrictEqual(buildDetail(info, 10).highlight, { row: 2, col: "sum" });
        const weekly: KeyInfo = { ...info, limit_reset: "weekly" };
        assert.deepStrictEqual(buildDetail(weekly, 10).highlight, { row: 1, col: "sum" });
        // A key whose limit never resets highlights the All-time row.
        const noReset: KeyInfo = { ...info, limit_reset: null };
        assert.deepStrictEqual(buildDetail(noReset, 10).highlight, { row: 3, col: "sum" });
    });

    test("auto mode with include_byok_in_limit=false excludes BYOK from used figure and highlight", () => {
        const info: KeyInfo = {
            limit: 10,
            limit_reset: "daily",
            limit_remaining: 5,
            usage: 5,
            usage_daily: 1,
            usage_weekly: 2,
            usage_monthly: 3,
            is_free_tier: false,
            byok_usage_daily: 0.5,
            include_byok_in_limit: false,
        };
        const detail = buildDetail(info, 10, "daily", true);
        assert.deepStrictEqual(detail.highlight, { row: 0, col: "or" });
        const status = buildStatus(info, 10, "daily", true);
        assert.match(status.tooltip, /Daily usage: \$1\.00/);
    });

    test("manual monthly guardrail uses monthly usage in status and detail", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 30,
            usage_daily: 1,
            usage_weekly: 2,
            usage_monthly: 3.5,
            is_free_tier: false,
        };
        const status = buildStatus(info, 10, "monthly");
        assert.strictEqual(status.text, "OR $6.50/10");
        const detail = buildDetail(info, 10, "monthly");
        assert.strictEqual(detail.remaining, "$6.50");
    });

    test("negative usage never inflates remaining above the limit", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: -5,
            usage_daily: -5,
            usage_weekly: -5,
            usage_monthly: -5,
            is_free_tier: false,
        };
        const status = buildStatus(info, 10);
        assert.strictEqual(status.text, "OR $10.00/10");
        const detail = buildDetail(info, 10);
        assert.strictEqual(detail.remaining, "$10.00");
    });

    test("malformed account credits render as n/a, not $0.00", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 1,
            usage_daily: 1,
            usage_weekly: 1,
            usage_monthly: 1,
            is_free_tier: false,
        };
        const credits = { total_credits: null as unknown as number, total_usage: 1 };
        const status = buildStatus(info, 0, "daily", true, credits);
        assert.strictEqual(status.text, "OR n/a");
        assert.match(status.tooltip, /All-time remaining: n\/a/);
        const detail = buildDetail(info, 0, "daily", true, credits);
        assert.strictEqual(detail.remaining, "n/a");
    });

    test("auto branch marks an exhausted key with the error background", () => {
        const info: KeyInfo = {
            limit: 5,
            limit_reset: null,
            limit_remaining: 0,
            usage: 5,
            usage_daily: 5,
            usage_weekly: 5,
            usage_monthly: 5,
            is_free_tier: false,
        };
        assert.strictEqual(buildDetail(info, 10).background, "error");
    });

    test("auto mode with a limit but no reset uses the key's remaining, not account credits", () => {
        // A key has a per-key limit that never resets: once spent it stays spent.
        // This is distinct from the no-limit account-credits view — the remaining
        // comes from limit_remaining and is independent of the account balance.
        const info: KeyInfo = {
            limit: 10,
            limit_reset: "never",
            limit_remaining: 4.5,
            usage: 5.5,
            usage_daily: 1,
            usage_weekly: 2,
            usage_monthly: 3,
            is_free_tier: false,
        };
        const credits = { total_credits: 1000, total_usage: 0.526233832 };
        const detail = buildDetail(info, 0, "daily", true, credits);
        assert.strictEqual(detail.limitSource, "auto");
        assert.strictEqual(detail.limitValue, "$10.00");
        assert.strictEqual(detail.remaining, "$4.50");
        assert.strictEqual(detail.resetPeriod, "never");
        assert.strictEqual(detail.resetDate, "No reset");
        assert.strictEqual(detail.highlight!.row, 3);
        assert.strictEqual(detail.background, "default");
        const status = buildStatus(info, 0, "daily", true, credits);
        assert.ok(!status.text.includes("/1000"));
    });

    test("a non-positive limit disables the manual guardrail (no cap, no reset)", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 30,
            usage_daily: 3.42,
            usage_weekly: 12,
            usage_monthly: 40,
            is_free_tier: false,
        };
        const detail = buildDetail(info, 0);
        assert.strictEqual(detail.limitSource, "manual");
        assert.strictEqual(detail.limitValue, "No cap");
        assert.strictEqual(detail.remaining, "n/a");
        assert.strictEqual(detail.resetDate, "No reset");
        assert.strictEqual(detail.highlight, null);
        assert.strictEqual(detail.background, "default");
        const status = buildStatus(info, 0);
        assert.strictEqual(status.background, "default");
    });

    test("non-positive limit with account credits shows the balance", () => {
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 30,
            usage_daily: 3.42,
            usage_weekly: 12,
            usage_monthly: 40,
            is_free_tier: false,
        };
        const credits = { total_credits: 1000, total_usage: 0.526233832 };
        const detail = buildDetail(info, 0, "daily", true, credits);
        assert.strictEqual(detail.remaining, "$999.47");
        assert.strictEqual(detail.limitValue, "$1000.00");
        assert.strictEqual(detail.resetDate, "No reset");
        assert.strictEqual(detail.highlight, null);
        assert.strictEqual(detail.background, "default");
        const status = buildStatus(info, 0, "daily", true, credits);
        assert.strictEqual(status.text, "OR $999.47");
        assert.strictEqual(status.background, "default");
    });

    test("manual guardrail with 'never' reset uses all-time usage, no reset", () => {
        // A user-set limit (not exposed via the API) with no reset: the cap is
        // all-time, so remaining = limit − total usage and there's no reset.
        const info: KeyInfo = {
            limit: null,
            limit_reset: null,
            limit_remaining: null,
            usage: 3.42,
            usage_daily: 1,
            usage_weekly: 2,
            usage_monthly: 3,
            is_free_tier: false,
        };
        const detail = buildDetail(info, 10, "never", true);
        assert.strictEqual(detail.limitSource, "manual");
        assert.strictEqual(detail.limitValue, "$10.00");
        assert.strictEqual(detail.remaining, "$6.58"); // 10 − 3.42 (all-time usage)
        assert.strictEqual(detail.resetPeriod, "never");
        assert.strictEqual(detail.resetDate, "No reset");
        assert.deepStrictEqual(detail.highlight, { row: 3, col: "sum" });
        assert.strictEqual(detail.background, "default");
        const status = buildStatus(info, 10, "never", true);
        assert.strictEqual(status.background, "default");
        assert.ok(status.tooltip.includes("All-time usage"));
        assert.ok(status.tooltip.includes("Resets: No reset"));
    });

    test("a row with both OR and BYOK missing renders the sum as 'n/a', not $0.00", () => {
        const info: KeyInfo = {
            limit: 10,
            limit_reset: "daily",
            limit_remaining: 5,
            usage: null as unknown as number,
            usage_daily: null as unknown as number,
            usage_weekly: 2,
            usage_monthly: 3,
            is_free_tier: false,
        };
        const detail = buildDetail(info, 10);
        const daily = detail.rows.find((r) => r.label === "Daily")!;
        assert.strictEqual(daily.orValue, "n/a");
        assert.strictEqual(daily.byokValue, "n/a");
        assert.strictEqual(daily.sumValue, "n/a");
        const allTime = detail.rows.find((r) => r.label === "All-time")!;
        assert.strictEqual(allTime.sumValue, "n/a");
    });

    test("a missing free-tier flag renders 'n/a'", () => {
        const info: KeyInfo = {
            limit: 10,
            limit_reset: "daily",
            limit_remaining: 5,
            usage: 5,
            usage_daily: 5,
            usage_weekly: 5,
            usage_monthly: 10,
            is_free_tier: null as unknown as boolean,
        };
        assert.strictEqual(buildDetail(info, 10).freeTier, "n/a");
    });
});

suite("logic.describeReset", () => {
    test("daily/weekly/monthly produce an exact next time; never/null report no reset", () => {
        assert.match(describeReset("daily"), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2} \S+ \(Daily\)$/);
        assert.match(describeReset("weekly"), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2} \S+ \(Weekly\)$/);
        assert.match(describeReset("monthly"), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2} \S+ \(Monthly\)$/);
        assert.strictEqual(describeReset(null), "No reset");
        assert.strictEqual(describeReset("never"), "No reset");
    });
    test("unknown reset types report no reset", () => {
        assert.strictEqual(describeReset("hourly"), "No reset");
        assert.strictEqual(describeReset("Weekly"), "No reset");
        assert.strictEqual(describeReset(undefined), "No reset");
    });
});

suite("logic.resetPeriodLabel", () => {
    test("maps each cadence to its display label", () => {
        assert.strictEqual(resetPeriodLabel("daily"), "Daily");
        assert.strictEqual(resetPeriodLabel("weekly"), "Weekly");
        assert.strictEqual(resetPeriodLabel("monthly"), "Monthly");
        assert.strictEqual(resetPeriodLabel("never"), "All-time");
    });
});

suite("logic.used* helpers", () => {
    const mk = (overrides: Partial<KeyInfo>): KeyInfo => ({
        limit: null,
        limit_reset: null,
        limit_remaining: null,
        usage: 10,
        usage_daily: 1,
        usage_weekly: 2,
        usage_monthly: 3,
        is_free_tier: false,
        ...overrides,
    });
    test("string-typed usage values are coerced; missing/NaN counts as 0", () => {
        const info = mk({ usage_daily: "1.5" as unknown as number });
        assert.strictEqual(usedDaily(info, false), 1.5);
        const missing: KeyInfo = mk({ usage_weekly: undefined as unknown as number });
        assert.strictEqual(usedWeekly(missing, true), 0);
        const nan: KeyInfo = mk({ usage_monthly: NaN });
        assert.strictEqual(usedMonthly(nan, true), 0);
    });
    test("BYOK is only added when included", () => {
        const info = mk({ usage_daily: 1, byok_usage_daily: 0.5 });
        assert.strictEqual(usedDaily(info, true), 1.5);
        assert.strictEqual(usedDaily(info, false), 1);
    });
});

suite("logic.maskKey", () => {
    test("masks the middle, keeping a small leading and trailing fragment", () => {
        assert.strictEqual(maskKey("sk-or-v1-" + "0".repeat(51) + "1234"),
            "sk-or-v1-000...234");
    });
    test("scales the mask down for short secrets", () => {
        assert.strictEqual(maskKey("abcd1234"), "ab...4");
        assert.strictEqual(maskKey("abcdef"), "ab...f");
        assert.strictEqual(maskKey("abcde"), "ab...e");
    });
    test("never reveals very short secrets", () => {
        assert.strictEqual(maskKey("abcd"), "****");
        assert.strictEqual(maskKey("ab"), "****");
    });
    test("revealed characters stay bounded for every length", () => {
        for (const len of [5, 6, 7, 8, 9, 11, 12, 15, 16, 23, 24, 31, 32, 40, 72, 73, 100, 200]) {
            const masked = maskKey("a".repeat(len));
            assert.match(masked, /^a+\.\.\.a+$/);
            const visible = masked.replace(/\./g, "").length;
            if (len < 16) {
                assert.ok(visible <= 3, `short key len ${len} reveals ${visible} chars`);
            } else {
                assert.ok(visible / len <= 0.25, `key len ${len} reveals ${visible}/${len}`);
            }
        }
    });
    test("falls back for missing label", () => {
        assert.strictEqual(maskKey(null), "unknown key");
        assert.strictEqual(maskKey(undefined), "unknown key");
    });
});