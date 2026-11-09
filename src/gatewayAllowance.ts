export interface GatewayBudget {
    limit: number | null;
    remaining: number | null;
    reset: string | null;
    usage: number | null;
    resets_at: string | null;
    include_byok: boolean | null;
}

export interface GatewayLaneAllowance extends GatewayBudget {
    status: "reported" | "unknown";
    effective_budget: GatewayBudget | null;
    applicable_budgets: GatewayBudget[];
    inherited_budgets: GatewayBudget[];
}

export interface GatewayAllowance {
    cheap: GatewayLaneAllowance;
    default: GatewayLaneAllowance;
    fetched_at: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function emptyBudget(): GatewayBudget {
    return { limit: null, remaining: null, reset: null, usage: null, resets_at: null, include_byok: null };
}

function unknownLane(): GatewayLaneAllowance {
    return {
        ...emptyBudget(),
        status: "unknown",
        effective_budget: null,
        applicable_budgets: [],
        inherited_budgets: [],
    };
}

function isTimestamp(value: unknown): value is string {
    if (typeof value !== "string") { return false; }
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!parts || !Number.isFinite(Date.parse(value))) { return false; }
    const [, year, month, day, hour, minute, second] = parts.map(Number);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth
        && hour <= 23 && minute <= 59 && second <= 59;
}

function parseBudget(value: unknown): GatewayBudget | undefined {
    if (!isRecord(value)) { return undefined; }
    const limit = value.limit ?? null;
    const remaining = value.remaining ?? null;
    const usage = value.usage ?? null;
    const reset = value.reset ?? null;
    const resetsAt = value.resets_at ?? null;
    const includeByok = value.include_byok ?? null;
    const numeric = (input: unknown, negative: boolean): input is number | null =>
        input === null || (typeof input === "number" && Number.isFinite(input) && (negative || input >= 0));
    if (!numeric(limit, false) || !numeric(remaining, true) || !numeric(usage, false)
        || !(reset === null || ["daily", "weekly", "monthly", "never"].includes(reset as string))
        || !(resetsAt === null || isTimestamp(resetsAt))
        || !(includeByok === null || typeof includeByok === "boolean")) {
        return undefined;
    }
    return {
        limit,
        remaining,
        reset: reset as string | null,
        usage,
        resets_at: resetsAt as string | null,
        include_byok: includeByok,
    };
}

function parseLane(value: unknown): GatewayLaneAllowance {
    if (!isRecord(value) || value.status !== "reported") { return unknownLane(); }
    const budget = parseBudget(value);
    const effective = value.effective_budget === null ? null : parseBudget(value.effective_budget);
    if (!budget || effective === undefined || !Array.isArray(value.applicable_budgets)
        || !Array.isArray(value.inherited_budgets)) {
        return unknownLane();
    }
    const applicable = value.applicable_budgets.map(parseBudget);
    const inherited = value.inherited_budgets.map(parseBudget);
    if (applicable.some(item => item === undefined) || inherited.some(item => item === undefined)) {
        return unknownLane();
    }
    return {
        ...budget,
        status: "reported",
        effective_budget: effective,
        applicable_budgets: applicable as GatewayBudget[],
        inherited_budgets: inherited as GatewayBudget[],
    };
}

/** Keep malformed or unavailable lanes unknown without hiding the other lane's reported counters. */
export function parseGatewayAllowance(value: unknown): GatewayAllowance {
    if (!isRecord(value) || !("cheap" in value || "default" in value)) {
        throw new Error("Invalid gateway allowance response.");
    }
    return {
        cheap: parseLane(value.cheap),
        default: parseLane(value.default),
        fetched_at: isTimestamp(value.fetched_at) ? value.fetched_at : null,
    };
}

export function gatewayAllowanceUrl(baseUrl: string): string {
    try {
        const base = new URL(baseUrl);
        if (base.protocol !== "https:" && base.protocol !== "http:") { throw new Error(); }
        return new URL("/lab/allowance", base.origin).href;
    } catch {
        throw new Error("Invalid gateway base URL.");
    }
}
