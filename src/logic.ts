// Pure logic module for the OpenRouter extension.
//
// This module intentionally does NOT import `vscode` (or make any network calls)
// so that it can be unit-tested directly. All state formatting/derivation lives
// here; the vscode-specific bits (SecretStorage, ThemeColor, status bar, HTTP)
// stay in extension.ts.

export interface KeyInfo {
    label?: string | null;
    limit: number | null;
    limit_reset: string | null;
    limit_remaining: number | null;
    usage: number;
    usage_daily: number;
    usage_weekly: number;
    usage_monthly: number;
    is_free_tier: boolean;
    /** Bring-your-own-key usage (not counted against OpenRouter credit). */
    byok_usage?: number | null;
    byok_usage_daily?: number | null;
    byok_usage_weekly?: number | null;
    byok_usage_monthly?: number | null;
    /** Whether the key's own credit limit already includes BYOK usage. */
    include_byok_in_limit?: boolean;
}

/** Reset cadence for the manual guardrail, or "never" for a one-time cap. */
export type ResetPeriod = "daily" | "weekly" | "monthly" | "never";

/**
 * Account-wide credit balance from OpenRouter's `/api/v1/credits` endpoint
 * (total credits purchased vs used). Unlike `/api/v1/key`, a regular key can
 * read this, so it backs the "no per-key cap" (unlimited) view.
 */
export interface AccountCredits {
    total_credits: number;
    total_usage: number;
}

/** "Daily"/"Weekly"/"Monthly"/"All-time" label for a reset period. */
export function resetPeriodLabel(p: ResetPeriod): string {
    return p === "never" ? "All-time" : p.charAt(0).toUpperCase() + p.slice(1);
}

/**
 * Return a masked fragment of an API key so a user can confirm which key is in
 * use without exposing the full secret. Example: `sk-or-v1-12...1234`.
 * Falls back to a generic label when the key has no `label` field.
 */
export function maskKey(label: string | null | undefined): string {
    if (!label) return "unknown key";
    const len = label.length;
    if (len <= 4) return "****";
    // Reveal a small leading/trailing fragment only: at most ~1/4 of long keys
    // (capped at 12 + 3 characters), and at most 3 characters (2 + 1) for short
    // keys so the mask never reveals most of a short secret.
    const long = len >= 16;
    const head = long ? Math.min(12, Math.floor(len / 5)) : 2;
    const tail = long ? Math.min(3, Math.floor(len / 16)) : 1;
    return `${label.slice(0, head)}...${label.slice(-tail)}`;
}

/** The pure, render-ready result of deriving a status display for a key. */
export interface StatusView {
    /** Status bar text (may include codicon sequences like $(error)). */
    text: string;
    /** Markdown tooltip shown on hover (bold header, italic mode line). */
    tooltip: string;
    /** Which theme background to apply to the status bar item. */
    background: "default" | "error";
}

/** Coerce a possibly-malformed API value to a finite number (NaN otherwise).
 *  Handles string-typed numbers (a plausible API drift) and ±Infinity;
 *  null/undefined stay NaN, and so do booleans and empty strings (a blank or
 *  boolean API field must never render as a misleading 0). */
function toNum(v: unknown): number {
    if (typeof v === "number") return Number.isFinite(v) ? v : Number.NaN;
    if (typeof v === "string") {
        const s = v.trim();
        if (s === "") return Number.NaN;
        const n = Number(s);
        return Number.isFinite(n) ? n : Number.NaN;
    }
    return Number.NaN;
}

const HUGE_AMOUNT = 1e21;

function hugeAmountText(v: number, withUsd: boolean): string {
    const sign = v < 0 ? "-" : "";
    return `${sign}${withUsd ? "$" : ""}${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
}

/** Render a finite number as USD. `toFixed(2)` returns exponential notation
 *  ("1e+21") for very large values, so those render as a grouped integer. */
export function formatUsd(n: number): string {
    const v = toNum(n);
    if (!Number.isFinite(v)) return "n/a";
    if (Math.abs(v) >= HUGE_AMOUNT) return hugeAmountText(v, true);
    return `$${v.toFixed(2)}`;
}

/** Format a possibly-missing USD amount; returns "n/a" when null/undefined/NaN. */
export function formatUsdOrNa(n: number | null | undefined): string {
    if (n == null) return "n/a";
    return formatUsd(n);
}

/**
 * General ("g") style formatting with auto rounding: drops trailing zeros so
 * 10 → "10", 10.5 → "10.5", 10.1234 → "10.12". Used for compact figures like
 * the status bar's limit denominator. Non-finite input renders "n/a".
 */
export function formatCompact(n: number): string {
    const v = toNum(n);
    if (!Number.isFinite(v)) return "n/a";
    if (Math.abs(v) >= HUGE_AMOUNT) return hugeAmountText(v, false);
    return parseFloat(v.toFixed(2)).toString();
}

// Next daily usage reset, since /api/v1/key does not return a timestamp for the
// daily usage window (usage_daily resets at UTC midnight).
export function nextUtcMidnight(now: Date = new Date()): Date {
    return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
    );
}

export function formatReset(date: Date | string, withSeconds = false): string {
    const d = typeof date === "string" ? new Date(date) : date;
    // ISO-style date first (YYYY/MM/DD) then 24-hour time to the minute (hh:mm)
    // or second (hh:mm:ss), followed by the local timezone abbreviation
    // (e.g. "CST", "UTC").
    const two = (n: number) => String(n).padStart(2, "0");
    const y = d.getFullYear();
    const m = two(d.getMonth() + 1);
    const day = two(d.getDate());
    const h = two(d.getHours());
    const min = two(d.getMinutes());
    const sec = two(d.getSeconds());
    const tz = d.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
    }).split(" ").pop() ?? "";
    return `${y}/${m}/${day} ${h}:${min}${withSeconds ? `:${sec}` : ""} ${tz}`;
}

/** Next Monday 00:00 UTC (for weekly resets; ISO weekday 1 = Monday). */
export function nextUtcMonday(now: Date = new Date()): Date {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

/** First day of next month 00:00 UTC (for monthly resets). */
export function nextUtcMonthStart(now: Date = new Date()): Date {
    return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0)
    );
}

/** OR usage plus BYOK usage when counted (missing/NaN BYOK counts as 0). */
function sumUsage(or: number | null | undefined, byok: number | null | undefined, includeByok: boolean): number {
    const o = toNum(or ?? 0);
    const b = toNum(byok ?? 0);
    return (Number.isFinite(o) ? o : 0) + (includeByok && Number.isFinite(b) ? b : 0);
}

/** Daily spend (usage_daily + optional BYOK). */
export function usedDaily(info: KeyInfo, includeByok: boolean): number {
    return sumUsage(info.usage_daily, info.byok_usage_daily, includeByok);
}

/** Weekly spend (usage_weekly + optional BYOK). */
export function usedWeekly(info: KeyInfo, includeByok: boolean): number {
    return sumUsage(info.usage_weekly, info.byok_usage_weekly, includeByok);
}

/** Monthly spend (usage_monthly + optional BYOK). */
export function usedMonthly(info: KeyInfo, includeByok: boolean): number {
    return sumUsage(info.usage_monthly, info.byok_usage_monthly, includeByok);
}

function isManualKey(info: KeyInfo): boolean {
    return info.limit === null || info.limit === undefined;
}

/**
 * Whether BYOK usage should count toward the displayed usage figures.
 * In manual mode (key has no per-key credit limit) this is the user's
 * `includeByok` config; in auto mode (key has its own limit) it's the key's
 * authoritative `include_byok_in_limit` flag.
 */
export function effectiveIncludeByok(info: KeyInfo, includeByok: boolean): boolean {
    return isManualKey(info) ? includeByok : (info.include_byok_in_limit !== false);
}

/**
 * Total spend for the guardrail period (usage + optional BYOK).
 * Uses the matching usage field for the configured reset period; "never" uses
 * the all-time totals.
 */
function usedThisPeriod(info: KeyInfo, p: ResetPeriod, includeByok: boolean): number {
    switch (p) {
        case "weekly":
            return usedWeekly(info, includeByok);
        case "monthly":
            return usedMonthly(info, includeByok);
        case "never":
            return sumUsage(info.usage, info.byok_usage, includeByok);
        default:
            return usedDaily(info, includeByok);
    }
}

/** Boundary Date for a configured reset period (next midnight / Monday / month start). */
export function resetBoundary(p: ResetPeriod, now: Date = new Date()): Date {
    if (p === "never") return new Date(Number.NaN);
    if (p === "weekly") return nextUtcMonday(now);
    if (p === "monthly") return nextUtcMonthStart(now);
    return nextUtcMidnight(now);
}

/**
 * Map OpenRouter's `limit_reset` value (a reset TYPE string: "daily",
 * "weekly", "monthly", "never", or null) to a recurring reset cadence, or
 * "never" when the limit does not refresh.
 */
function limitResetPeriod(limit_reset: string | null | undefined): ResetPeriod {
    return limit_reset === "daily" || limit_reset === "weekly" || limit_reset === "monthly"
        ? limit_reset
        : "never";
}

/**
 * Given OpenRouter's `limit_reset` value, return a human-friendly label for
 * when the limit refreshes. For recurring types we surface the exact next
 * UTC boundary; a "never"/null type reports no reset instead.
 */
export function describeReset(limit_reset: string | null | undefined): string {
    const period = limitResetPeriod(limit_reset);
    return period === "never" ? "No reset" : `${formatReset(resetBoundary(period))} (${resetPeriodLabel(period)})`;
}

/** A single usage row: label plus OpenRouter-only, BYOK-only, and combined values. */
export interface DetailRow {
    label: string;
    /** OpenRouter-only value (usage fields), e.g. "$1.00" or "n/a". */
    orValue: string;
    /** BYOK-only value (byok_usage_* fields), e.g. "$0.50" or "n/a". */
    byokValue: string;
    /** Combined OR + BYOK value, e.g. "$1.50" (BYOK missing counts as 0). */
    sumValue: string;
}

/** Which usage-table cell corresponds to the guardrail's remaining figure. */
export interface DetailHighlight {
    /** Index into `Detail.rows` (0 = Daily, 1 = Weekly, 2 = Monthly, 3 = All-time). */
    row: number;
    /** Value column to highlight: OpenRouter-only or the combined sum. */
    col: "or" | "sum";
}

/** Render-ready detail data for the click-to-open panel. */
export interface Detail {
    rows: DetailRow[];
    /** Remaining credit string (guardrail remaining or key limit_remaining). */
    remaining: string;
    /** Free-tier status: "yes"/"no"/"n/a". */
    freeTier: string;
    background: "default" | "error";
    /** Masked key fragment shown near the key field, e.g. "sk-or-v1-b17...a682". */
    keyLabel: string;
    /** Source of the effective limit: "manual" (user limit) or "auto" (key's own limit). */
    limitSource: "manual" | "auto";
    /** Effective limit value, e.g. "$10.00". */
    limitValue: string;
    /** The same limit as a number (null when unformattable), for numeric inputs. */
    limitNum: number | null;
    /** Reset cadence (daily/weekly/monthly/never), shown next to the limit. */
    resetPeriod: string;
    /** Exact next reset date/time, shown separately, e.g. "2026/08/28 00:00". */
    resetDate: string;
    /** Derivation mode shared with the status bar: unlimited/manual/auto. */
    mode: ViewMode;
    /** Longer, self-explanatory mode line shown in the panel. */
    modeText: string;
    /**
     * Which usage-table cell corresponds to the displayed remaining figure
     * (the period row for the effective reset cadence, using the sum column
     * when BYOK counts). Null when there is no periodic reset to tie it to.
     */
    highlight: DetailHighlight | null;
}

/** Usage-table row index for each reset cadence (0 = Daily … 3 = All-time). */
const HIGHLIGHT_ROW: Record<ResetPeriod, number> = {
    daily: 0,
    weekly: 1,
    monthly: 2,
    never: 3,
};

/**
 * Cell to highlight for a reset cadence and BYOK inclusion. A "never" reset
 * (no periodic refresh) ties the remaining figure to the all-time row.
 */
function highlightCell(resetPeriod: ResetPeriod, includeByok: boolean): DetailHighlight {
    return { row: HIGHLIGHT_ROW[resetPeriod], col: includeByok ? "sum" : "or" };
}

/** How the remaining figure is derived; shared by the status bar and panel. */
export type ViewMode = "unlimited" | "manual" | "auto";

/** Short (status tooltip, italic) and long (panel, explained) mode labels. */
const MODE_TEXT: Record<ViewMode, { short: string; long: string }> = {
    unlimited: {
        short: "No limit",
        long: "No limit — this key shows no limit; showing your account-wide balance.",
    },
    manual: {
        short: "Local-set limit",
        long: "Local-set limit — this key shows no limit; the limit is set locally to help track usage.",
    },
    auto: {
        short: "Key limit",
        long: "Key limit — limit is detected from key.",
    },
};

/**
 * The numeric state shared by `buildStatus` and `buildDetail`: mode, remaining
 * figure, guardrail-period spend, effective reset cadence, BYOK inclusion,
 * limit denominator, exhausted flag, reset date and usage-table highlight.
 * Rendering (tooltip text, rows, labels) stays in the two builders.
 */
export interface CoreView {
    mode: ViewMode;
    /** Remaining figure; NaN when unknown (renders "n/a", never $0.00). */
    remainingNum: number;
    /** Guardrail-period spend (manual mode only; NaN otherwise). */
    used: number;
    /** Effective cadence: manual → config resetPeriod; auto → limit_reset. */
    effectivePeriod: ResetPeriod;
    /** Effective BYOK inclusion for the remaining math. */
    includeByok: boolean;
    /** Denominator figure (limit / key limit / total credits); NaN when unknown. */
    limitNum: number;
    /** Exhausted (remaining <= 0); always false in unlimited mode. */
    exhausted: boolean;
    /** "No reset" or the formatted next reset boundary. */
    resetDate: string;
    /** Usage-table cell tied to the remaining figure (null when unlimited). */
    highlight: DetailHighlight | null;
}

/**
 * Derive the numeric view state once, so the status bar and the panel can
 * never disagree about the remaining figure, reset cadence, or error state.
 * - unlimited (manual mode + limit <= 0): account credits balance, no cap.
 * - manual: limit − period usage, clamped to [0, limit].
 * - auto: the key's own limit_remaining (missing → NaN → "n/a").
 */
export function coreView(
    info: KeyInfo,
    limit: number,
    resetPeriod: ResetPeriod = "daily",
    includeByok = true,
    accountCredits?: AccountCredits
): CoreView {
    const isManual = isManualKey(info);
    const includeByokEffective = effectiveIncludeByok(info, includeByok);
    // A non-positive limit in manual mode disables the guardrail: the remaining
    // figure is the account-wide credits balance instead of a per-period limit.
    const unlimited = isManual && limit <= 0;

    // In manual mode the guardrail period is the user's configured reset; in
    // auto mode it's the key's own limit_reset type ("never" -> no reset).
    const effectivePeriod: ResetPeriod = isManual
        ? resetPeriod
        : limitResetPeriod(info.limit_reset);
    const highlight = unlimited ? null : highlightCell(effectivePeriod, includeByokEffective);
    const resetDate =
        unlimited || effectivePeriod === "never"
            ? "No reset"
            : formatReset(resetBoundary(effectivePeriod));

    let mode: ViewMode;
    let remainingNum: number;
    let used: number;
    let limitNum: number;

    if (unlimited) {
        mode = "unlimited";
        const credits = toNum(accountCredits?.total_credits);
        const creditUsage = toNum(accountCredits?.total_usage);
        remainingNum = Math.max(credits - creditUsage, 0);
        used = Number.NaN;
        limitNum = credits;
    } else if (isManual) {
        mode = "manual";
        used = usedThisPeriod(info, resetPeriod, includeByokEffective);
        // Clamp to [0, limit]: negative (malformed) usage must not inflate the
        // remaining figure above the limit itself.
        remainingNum = Math.min(limit, Math.max(limit - used, 0));
        limitNum = limit;
    } else {
        mode = "auto";
        used = Number.NaN;
        remainingNum =
            info.limit_remaining != null
                ? Math.max(toNum(info.limit_remaining), 0)
                : Number.NaN;
        limitNum = toNum(info.limit);
    }

    return {
        mode,
        remainingNum,
        used,
        effectivePeriod,
        includeByok: includeByokEffective,
        limitNum,
        exhausted:
            mode !== "unlimited" && Number.isFinite(remainingNum) && remainingNum <= 0,
        resetDate,
        highlight,
    };
}

/**
 * Build the detail rows shown in the webview panel. Unlike the compact status
 * bar tooltip, this surfaces the exact next reset time via describeReset() and
 * includes the fuller usage breakdown.
 */
export function buildDetail(
    info: KeyInfo,
    limit: number,
    resetPeriod: ResetPeriod = "daily",
    includeByok = true,
    accountCredits?: AccountCredits
): Detail {
    const view = coreView(info, limit, resetPeriod, includeByok, accountCredits);

    // Two-column usage table: OpenRouter-only vs BYOK, side by side, plus a
    // combined total. Missing BYOK values count as 0 in the sum; when BOTH
    // figures are missing the sum renders "n/a" rather than a misleading $0.00.
    const row = (label: string, or: number | null | undefined, byok: number | null | undefined): DetailRow => {
        const o = toNum(or);
        const b = toNum(byok);
        return {
            label,
            orValue: formatUsdOrNa(or),
            byokValue: formatUsdOrNa(byok),
            sumValue:
                !Number.isFinite(o) && !Number.isFinite(b)
                    ? "n/a"
                    : formatUsdOrNa(sumUsage(or, byok, true)),
        };
    };
    const rows: DetailRow[] = [
        row("Daily", info.usage_daily, info.byok_usage_daily),
        row("Weekly", info.usage_weekly, info.byok_usage_weekly),
        row("Monthly", info.usage_monthly, info.byok_usage_monthly),
        row("All-time", info.usage, info.byok_usage),
    ];

    const freeTierStr = info.is_free_tier == null ? "n/a" : info.is_free_tier ? "yes" : "no";
    const keyLabel = info.label || "unknown key";
    const limitValue =
        view.mode === "unlimited" && !accountCredits
            ? "No cap"
            : formatUsd(view.limitNum);

    return {
        rows,
        remaining: formatUsdOrNa(view.remainingNum),
        freeTier: freeTierStr,
        background: view.exhausted ? "error" : "default",
        keyLabel,
        limitSource: view.mode === "auto" ? "auto" : "manual",
        limitValue,
        limitNum: Number.isFinite(view.limitNum) ? view.limitNum : null,
        resetPeriod: view.effectivePeriod,
        resetDate: view.resetDate,
        mode: view.mode,
        modeText: MODE_TEXT[view.mode].long,
        highlight: view.highlight,
    };
}

/**
 * Render the status bar text, tooltip and background from the shared numeric
 * view. The derivation itself lives in `coreView`, so this only formats.
 * All three modes share one tooltip layout:
 *
 *     **OpenRouter key credits**   (bold)
 *     *<mode>*                     (italic, short)
 *     <period> limit: $<limit>
 *     <period> usage: $<usage>
 *     <period> remaining: $<remaining>
 *     Resets: <reset date>
 */
export function buildStatus(
    info: KeyInfo,
    limit: number,
    resetPeriod: ResetPeriod = "daily",
    includeByok = true,
    accountCredits?: AccountCredits
): StatusView {
    const view = coreView(info, limit, resetPeriod, includeByok, accountCredits);
    const periodLabel = view.mode === "unlimited" ? "All-time" : resetPeriodLabel(view.effectivePeriod);
    const usage =
        view.mode === "manual"
            ? view.used
            : view.mode === "auto"
              ? usedThisPeriod(info, view.effectivePeriod, view.includeByok)
              : toNum(accountCredits?.total_usage);
    const resetLine =
        view.mode === "manual"
            ? view.resetDate
            : view.mode === "auto"
              ? describeReset(info.limit_reset)
              : "No reset";

    // Status bar: keep the $ on the remaining figure, omit it on the
    // denominator (general format, auto rounding). Only the manual guardrail
    // prefixes $(error); the other modes rely on the error background.
    const text =
        view.mode === "unlimited"
            ? `OR ${formatUsdOrNa(view.remainingNum)}`
            : view.mode === "manual"
              ? `${view.exhausted ? "$(error) " : ""}OR ${formatUsd(view.remainingNum)}/${formatCompact(view.limitNum)}`
              : `OR ${formatUsdOrNa(view.remainingNum)}/${formatCompact(view.limitNum)}`;

    return {
        text,
        tooltip: [
            "**OpenRouter key credits**",
            `*${MODE_TEXT[view.mode].short}*`,
            `${periodLabel} limit: ${formatUsd(view.limitNum)}`,
            `${periodLabel} usage: ${formatUsd(usage)}`,
            `${periodLabel} remaining: ${formatUsdOrNa(view.remainingNum)}`,
            `Resets: ${resetLine}`,
            ...(view.mode === "auto" && info.is_free_tier ? ["Free tier: yes"] : []),
            // Hard breaks (two trailing spaces) — the status-bar hover markdown
            // renderer collapses soft newlines, so a bare "\n" would join lines.
        ].join("  \n"),
        background: view.exhausted ? "error" : "default",
    };
}
