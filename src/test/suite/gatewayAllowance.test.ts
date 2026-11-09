import * as assert from "assert";
import {
    GatewayBudget,
    GatewayLaneAllowance,
    gatewayAllowanceUrl,
    parseGatewayAllowance,
} from "../../gatewayAllowance";

function budget(overrides: Partial<GatewayBudget> = {}): GatewayBudget {
    return {
        limit: 10,
        remaining: 7,
        reset: "daily",
        usage: 3,
        resets_at: "2026-10-29T00:00:00Z",
        include_byok: true,
        ...overrides,
    };
}

function lane(overrides: Partial<GatewayLaneAllowance> = {}): GatewayLaneAllowance {
    return {
        ...budget({ limit: null, remaining: null, reset: null, usage: 83, resets_at: null }),
        status: "reported",
        effective_budget: budget(),
        applicable_budgets: [budget(), budget({ limit: 40, remaining: 24, reset: "weekly", usage: 16 })],
        inherited_budgets: [budget()],
        ...overrides,
    };
}

function parseCheap(value: unknown): GatewayLaneAllowance {
    return parseGatewayAllowance({ cheap: value, default: lane(), fetched_at: "2026-10-28T12:34:56+00:00" }).cheap;
}

function assertUnknown(value: GatewayLaneAllowance): void {
    assert.deepStrictEqual(value, {
        limit: null,
        remaining: null,
        reset: null,
        usage: null,
        resets_at: null,
        include_byok: null,
        status: "unknown",
        effective_budget: null,
        applicable_budgets: [],
        inherited_budgets: [],
    });
}

suite("gateway allowance parsing", () => {
    test("retains each interval and cumulative key usage independently", () => {
        const cheap = lane();
        const standard = lane({ effective_budget: budget({ limit: 50, remaining: 30, usage: 20 }) });
        const response = { cheap, default: standard, fetched_at: "2026-10-28T12:34:56+00:00" };
        const parsed = parseGatewayAllowance(response);
        assert.deepStrictEqual(parsed, response);
        assert.strictEqual(parsed.cheap.limit, null);
        assert.strictEqual(parsed.cheap.usage, 83);
        assert.strictEqual(parsed.cheap.effective_budget!.usage, 3);
        assert.strictEqual(parsed.cheap.applicable_budgets[1].reset, "weekly");
    });

    test("explicit null values stay unknown and zero remains a reported value", () => {
        const unknownBudget = budget({
            limit: null, remaining: null, reset: null, usage: null, resets_at: null, include_byok: null,
        });
        const parsed = parseCheap(lane({
            ...unknownBudget,
            effective_budget: null,
            applicable_budgets: [unknownBudget, budget({ limit: 0, remaining: 0, usage: 0, include_byok: false })],
            inherited_budgets: [],
        }));
        assert.strictEqual(parsed.status, "reported");
        assert.strictEqual(parsed.usage, null);
        assert.strictEqual(parsed.effective_budget, null);
        assert.strictEqual(parsed.applicable_budgets[0].limit, null);
        assert.strictEqual(parsed.applicable_budgets[1].limit, 0);
        assert.strictEqual(parsed.applicable_budgets[1].include_byok, false);
    });

    test("negative remaining preserves reported overage", () => {
        const parsed = parseCheap(lane({ remaining: -2, effective_budget: budget({ remaining: -0.25 }) }));
        assert.strictEqual(parsed.remaining, -2);
        assert.strictEqual(parsed.effective_budget!.remaining, -0.25);
    });

    test("invalid numbers are never coerced or shown as zero", () => {
        for (const invalid of ["3", "", true, Number.NaN, Infinity, -Infinity]) {
            for (const field of ["limit", "remaining", "usage"]) {
                assertUnknown(parseCheap({ ...lane(), [field]: invalid }));
            }
        }
        assertUnknown(parseCheap(lane({ limit: -1 })));
        assertUnknown(parseCheap(lane({ usage: -1 })));
    });

    test("missing scalar fields remain unknown without discarding valid counters", () => {
        for (const field of ["limit", "remaining", "usage", "reset", "resets_at", "include_byok"] as const) {
            const input: Partial<GatewayLaneAllowance> = lane();
            delete input[field];
            const parsed = parseCheap(input);
            assert.strictEqual(parsed.status, "reported");
            assert.strictEqual(parsed[field], null);
            assert.deepStrictEqual(parsed.effective_budget, budget());
        }
    });

    test("an invalid lane leaves the other lane available", () => {
        for (const invalid of [undefined, null, [], "unavailable", {}, { ...lane(), status: "ok" }]) {
            const parsed = parseGatewayAllowance({ cheap: invalid, default: lane() });
            assertUnknown(parsed.cheap);
            assert.deepStrictEqual(parsed.default, lane());
        }
    });

    test("an upstream unknown lane discards contradictory supplied balances", () => {
        assertUnknown(parseCheap(lane({ status: "unknown" })));
        assertUnknown(parseCheap({ status: "unknown" }));
    });

    test("malformed effective and inherited counters invalidate only their lane", () => {
        for (const invalid of [
            { effective_budget: [] },
            { effective_budget: budget({ usage: -1 }) },
            { applicable_budgets: null },
            { applicable_budgets: [budget(), { ...budget(), remaining: "7" }] },
            { inherited_budgets: {} },
            { inherited_budgets: [null] },
        ]) {
            assertUnknown(parseCheap({ ...lane(), ...invalid }));
        }
    });

    test("reset metadata accepts normalized periods and rejects unrecognized values", () => {
        for (const reset of ["daily", "weekly", "monthly", "never", null]) {
            assert.strictEqual(parseCheap(lane({ reset })).reset, reset);
        }
        for (const reset of ["Daily", "hourly", "", 123, {}]) {
            assertUnknown(parseCheap({ ...lane(), reset }));
        }
        for (const include_byok of ["true", 0]) {
            assertUnknown(parseCheap({ ...lane(), include_byok }));
        }
    });

    test("validates timestamps without accepting calendar rollovers or ambiguous dates", () => {
        for (const timestamp of ["2026-10-28T12:34:56Z", "2028-02-29T00:00:00.123+09:00"]) {
            const parsed = parseGatewayAllowance({ cheap: lane({ resets_at: timestamp }), fetched_at: timestamp });
            assert.strictEqual(parsed.cheap.resets_at, timestamp);
            assert.strictEqual(parsed.fetched_at, timestamp);
        }
        for (const timestamp of [
            "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-10-28T24:00:00Z",
            "2026-10-28", "2026-10-28T12:00:00", "tomorrow", "", 1793188800000,
        ]) {
            const parsed = parseGatewayAllowance({ cheap: { ...lane(), resets_at: timestamp }, fetched_at: timestamp });
            assertUnknown(parsed.cheap);
            assert.strictEqual(parsed.fetched_at, null);
        }
    });

    test("ignores unrelated metadata rather than retaining unvalidated response content", () => {
        const parsed = parseCheap({
            ...lane(),
            private_key: "never retain this",
            effective_budget: { ...budget(), private_key: "never retain this" },
        });
        assert.deepStrictEqual(parsed, lane());
        assert.ok(!JSON.stringify(parsed).includes("never retain"));
    });

    test("top-level structural errors use a safe generic message", () => {
        const invalidResponses = [null, undefined, [], 12, "private server error", {}, { error: "secret upstream text" }];
        for (const invalid of invalidResponses) {
            assert.throws(() => parseGatewayAllowance(invalid), /^Error: Invalid gateway allowance response\.$/);
        }
    });

    test("missing lane and retrieval time remain unknown", () => {
        const parsed = parseGatewayAllowance({ cheap: lane() });
        assert.deepStrictEqual(parsed.cheap, lane());
        assertUnknown(parsed.default);
        assert.strictEqual(parsed.fetched_at, null);
    });

    test("parsed counters do not share mutable objects with the response", () => {
        const input = lane();
        const parsed = parseCheap(input);
        input.effective_budget!.remaining = 99;
        input.applicable_budgets[0].remaining = 98;
        assert.strictEqual(parsed.effective_budget!.remaining, 7);
        assert.strictEqual(parsed.applicable_budgets[0].remaining, 7);
    });
});

suite("gateway allowance URL", () => {
    test("uses the origin route rather than appending to the configured API path", () => {
        assert.strictEqual(gatewayAllowanceUrl("https://gateway.example/v1"), "https://gateway.example/lab/allowance");
        assert.strictEqual(gatewayAllowanceUrl("http://localhost:3000/api/v1/"), "http://localhost:3000/lab/allowance");
        assert.strictEqual(
            gatewayAllowanceUrl("https://gateway.example/v1?api_key=unused#fragment"),
            "https://gateway.example/lab/allowance",
        );
    });

    test("never copies embedded credentials into the allowance URL", () => {
        assert.strictEqual(
            gatewayAllowanceUrl("https://user:private@gateway.example/v1"),
            "https://gateway.example/lab/allowance",
        );
    });

    test("rejects invalid and unsupported base URLs without echoing their content", () => {
        for (const invalid of ["private-token", "/v1", "file:///private/v1", "ftp://gateway.example/v1"]) {
            assert.throws(() => gatewayAllowanceUrl(invalid), /^Error: Invalid gateway base URL\.$/);
        }
    });
});
