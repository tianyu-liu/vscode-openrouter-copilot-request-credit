import { t } from './i18n';

export interface PricingOverride {
    min_prompt_tokens?: number;
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
    utc_start?: number;
    utc_end?: number;
    utc_days?: number;
}

export interface ModelPricing {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
    internal_reasoning?: string;
    request?: string;
    image?: string;
    web_search?: string;
    overrides?: PricingOverride[];
}

export interface ModelReasoning {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[] | null;
    default_effort?: string;
}

export interface ModelCatalogEntry {
    id: string;
    name?: string;
    supported_parameters?: string[];
    supports_tool_parameters?: boolean;
    context_length?: number;
    architecture?: { input_modalities?: string[]; output_modalities?: string[] };
    pricing?: ModelPricing;
    reasoning?: ModelReasoning;
    top_provider?: { context_length?: number; max_completion_tokens?: number; is_moderated?: boolean };
}

/**
 * Whether the catalog says a model can take tools. OpenRouter now publishes the
 * `supported_parameters` array (with `"tools"` for tool-capable models) and no
 * longer sends `supports_tool_parameters`; the boolean is kept as a fallback for
 * older catalogs and fixtures, where absence means "assume capable".
 */
export function supportsToolCalling(m: ModelCatalogEntry): boolean {
    if (Array.isArray(m.supported_parameters)) {
        return m.supported_parameters.includes('tools');
    }
    return m.supports_tool_parameters !== false;
}

export interface ModelInfo {
    detail?: string;
    tooltip: string;
    maxInputTokens: number;
    maxOutputTokens: number;
}

export function parsePrice(value: string | undefined): number {
    const n = Number.parseFloat(value ?? '');
    return Number.isFinite(n) ? n : 0;
}

function priceOr(value: string | undefined, fallback: number): number {
    if (value === undefined) {
        return fallback;
    }
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
}

export function formatPerM(perToken: number): string {
    return formatPricePerM(perToken * 1_000_000);
}

export function formatPricePerM(usdPerM: number): string {
    if (usdPerM === 0) {
        return '$0.000';
    }
    return `$${usdPerM.toFixed(3)}`;
}

const EFFORT_DESCRIPTIONS: Record<string, string> = {
    none: 'No reasoning',
    minimal: 'Minimal reasoning',
    low: 'Fast responses with lighter reasoning',
    medium: 'Balanced speed and reasoning depth',
    high: 'Greater reasoning depth for complex problems',
    xhigh: 'Extra-high reasoning effort',
    max: 'Maximum reasoning effort',
};

const FULL_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];

function effortProperty(
    efforts: string[],
    defaultValue: string,
    labels: string[] = efforts,
    title = 'Thinking Effort'
): { properties: Record<string, unknown> } {
    return {
        properties: {
            reasoningEffort: {
                type: 'string',
                title: t(title),
                enum: efforts,
                enumItemLabels: labels.map((effort) => effortLabel(effort)),
                enumDescriptions: efforts.map(
                    (effort) => t(EFFORT_DESCRIPTIONS[effort] ?? 'Reasoning effort level')
                ),
                default: defaultValue,
                group: 'navigation',
            },
        },
    };
}

function listedEfforts(reasoning: ModelReasoning): string[] | undefined {
    const listed = reasoning.supported_efforts?.filter((e) => e.length > 0);
    return listed && listed.length > 0 ? listed : undefined;
}

function withOptionalNone(efforts: string[], mandatory: boolean | undefined): string[] {
    if (mandatory || efforts.includes('none')) {
        return efforts;
    }
    return [...efforts, 'none'];
}

function pickEffort(
    efforts: string[],
    defaultEffort: string | undefined,
    fallback: string
): string {
    return defaultEffort && efforts.includes(defaultEffort) ? defaultEffort : fallback;
}

/**
 * The picker selector for models with a catalog `reasoning` object: an effort
 * list when the catalog publishes one (an explicit `null` allowlist means all
 * efforts are accepted), else a None/Enabled toggle. `default_enabled: false`
 * pre-selects the off choice wherever one exists; `mandatory` never offers
 * `none` and wins over the off default.
 */
export function buildReasoningSchema(
    m: ModelCatalogEntry
): { properties: Record<string, unknown> } | undefined {
    const reasoning = m.reasoning;
    if (!reasoning) {
        return undefined;
    }
    const listed = listedEfforts(reasoning);
    if (listed) {
        const efforts = withOptionalNone(listed, reasoning.mandatory);
        return effortProperty(efforts, pickEffort(efforts, reasoning.default_effort, efforts[0]));
    }
    if (reasoning.supported_efforts === null) {
        const mandatory = reasoning.mandatory === true;
        const efforts = mandatory ? FULL_EFFORTS.filter((e) => e !== 'none') : FULL_EFFORTS;
        const fallback = !mandatory && reasoning.default_enabled === false ? 'none' : 'medium';
        return effortProperty(efforts, pickEffort(efforts, reasoning.default_effort, fallback));
    }
    if (reasoning.mandatory) {
        return undefined;
    }
    return {
        properties: {
            reasoningEnabled: {
                type: 'string',
                title: t('Reasoning'),
                enum: ['none', 'enabled'],
                enumItemLabels: [t('None'), t('Enabled')],
                enumDescriptions: [t('No reasoning'), t('Reasoning at the default level')],
                default: reasoning.default_enabled === false ? 'none' : 'enabled',
                group: 'navigation',
            },
        },
    };
}

export function enabledFromModelConfiguration(
    modelConfiguration: { readonly [key: string]: unknown } | undefined
): boolean | undefined {
    const value = modelConfiguration?.reasoningEnabled;
    if (value === 'enabled') {
        return true;
    }
    if (value === 'none') {
        return false;
    }
    return undefined;
}

export function effortFromModelConfiguration(
    modelConfiguration: { readonly [key: string]: unknown } | undefined
): string | undefined {
    const value = modelConfiguration?.reasoningEffort;
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

const T_CR = 85;
const T_CW = 6;
const T_IN = 3;
const T_THINK = 5;
const T_OUT = 1;
export const ASSUMED_CONTEXT_TOKENS = 1_048_576;

/** A stepped price that begins at `min_prompt_tokens` (OpenRouter `pricing.overrides`). */
export interface LongContextTier {
    threshold: number;
    prompt: number;
    completion: number;
    inputCacheRead?: number;
    inputCacheWrite?: number;
}

function finitePositive(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The window that will actually be served. The catalog's model-level
 * `context_length` is a catalog-wide maximum and can exceed the window the
 * serving provider accepts (`top_provider.context_length`), so the smaller of
 * the two is the truthful one. `undefined` when the catalog lists neither.
 */
export function effectiveContextLength(m: ModelCatalogEntry): number | undefined {
    const model = finitePositive(m.context_length);
    const provider = finitePositive(m.top_provider?.context_length);
    if (model === undefined) {
        return provider;
    }
    if (provider === undefined) {
        return model;
    }
    return Math.min(model, provider);
}

/**
 * Every prompt-token threshold at which the catalog raises this model's price,
 * ascending. Time-of-day overrides (`utc_*`, no `min_prompt_tokens`), thresholds
 * at or above the window, and pure discounts are all ignored.
 */
export function longContextTiers(m: ModelCatalogEntry): LongContextTier[] {
    const overrides = m.pricing?.overrides;
    if (!Array.isArray(overrides) || overrides.length === 0) {
        return [];
    }
    const context = effectiveContextLength(m);
    const basePrompt = parsePrice(m.pricing?.prompt);
    const baseCompletion = parsePrice(m.pricing?.completion);
    const tiers: LongContextTier[] = [];
    for (const override of overrides) {
        const threshold = finitePositive(override.min_prompt_tokens);
        if (threshold === undefined) {
            continue;
        }
        if (context !== undefined && threshold >= context) {
            continue;
        }
        const prompt = parsePrice(override.prompt);
        const completion = parsePrice(override.completion);
        if (prompt <= basePrompt && completion <= baseCompletion) {
            continue;
        }
        tiers.push({
            threshold,
            prompt: prompt || basePrompt,
            completion: completion || baseCompletion,
            inputCacheRead: override.input_cache_read !== undefined ? parsePrice(override.input_cache_read) : undefined,
            inputCacheWrite: override.input_cache_write !== undefined ? parsePrice(override.input_cache_write) : undefined,
        });
    }
    return tiers.sort((a, b) => a.threshold - b.threshold);
}

/** The smallest threshold at which the catalog raises this model's price. */
export function longContextTier(m: ModelCatalogEntry): LongContextTier | undefined {
    return longContextTiers(m)[0];
}

/** A model-picker Context size choice: a string enum value with its display label and optional warning. */
export interface ContextCapOption {
    value: string;
    label: string;
    description?: string;
}

/** A warning icon and its explanation for a context size too small to be useful. */
export interface SizeAdvisory {
    icon: string;
    text: string;
}

/** `\u26a0` (warning) for a tight prompt budget, `\u26d4` (stop sign) for an unusable one. */
const WARN_ICON = '\u26a0\ufe0f';
const STOP_ICON = '\u26d4';
/** The prompt budget a default (unchosen) stepped model aims for, before choosing a step. */
const DEFAULT_CONTEXT_TARGET = 256_000;
/** A step below this is too small to default to; the whole window is used instead. */
const DEFAULT_CONTEXT_FLOOR = 196_000;

/**
 * A warning for a prompt budget too small to be useful, or `undefined` when it is
 * comfortable. Thresholds are about the **prompt budget** the picker value and the
 * Copilot context ring both express (a "say hi" agent turn already spends ~50K on
 * the system prompt and the ~86 tool definitions), not the total window.
 */
export function sizeAdvisory(promptTokens: number): SizeAdvisory | undefined {
    if (promptTokens < 64_000) {
        return {
            icon: STOP_ICON,
            text: t('Too small \u2014 the system prompt and tool definitions alone can exceed this.'),
        };
    }
    if (promptTokens <= 128_000) {
        return {
            icon: WARN_ICON,
            text: t('Tight \u2014 some models need more than 128K with reasoning or agent mode.'),
        };
    }
    return undefined;
}

/**
 * A human size label: `400K`, `1.05M` (at most two decimals, trailing zeros
 * trimmed). Used for the picker's Context size options.
 */
export function formatSize(n: number): string {
    if (n >= 1_000_000) {
        return `${parseFloat((n / 1_000_000).toFixed(2))}M`;
    }
    if (n >= 1000) {
        return `${Math.round(n / 1000)}K`;
    }
    return String(n);
}

/** The note under a comfortable Context size entry, mirroring Copilot's native wording. */
function contextSizeNote(value: string, defaultValue: string): string {
    return value === defaultValue ? t('Default recommended context size') : t('Longer sessions');
}

/**
 * The step the picker defaults to when nothing is chosen: the threshold closest to
 * {@link DEFAULT_CONTEXT_TARGET} (256K) among steps at or above
 * {@link DEFAULT_CONTEXT_FLOOR} (196K) that still fit inside the effective prompt
 * budget (`window - output reserve`, so a step no longer reachable at the current
 * reserve is never defaulted to). Steps below the floor are ignored so an
 * unusably small step is never the default; a model with no such step (or no step
 * at all, or a window below the floor) falls back to the whole window.
 */
export function defaultContextCap(m: ModelCatalogEntry, policy?: OutputReservePolicy): number | 'full' {
    const promptBudget = effectiveMaxInputTokens(m, { outputReserve: policy });
    const eligible = longContextTiers(m)
        .map((tier) => tier.threshold)
        .filter((threshold) => threshold >= DEFAULT_CONTEXT_FLOOR && threshold < promptBudget);
    if (eligible.length === 0) {
        return 'full';
    }
    return eligible.reduce((best, threshold) =>
        Math.abs(threshold - DEFAULT_CONTEXT_TARGET) < Math.abs(best - DEFAULT_CONTEXT_TARGET) ? threshold : best
    );
}

/**
 * The model picker's Context size choices for a stepped model: one entry per price
 * step and one for the whole window. Each value is the **prompt budget** (the size
 * Copilot packs against and the context ring shows); the output reserve is added on
 * top by Copilot, so no reserve arithmetic is done here or on the request path.
 * A step at or above the effective prompt budget is omitted, because choosing it
 * could not be honored (`effectiveMaxInputTokens` clamps the override the same way).
 * Descriptions mirror Copilot's native provider — the dropdown's default step reads
 * "Default recommended context size", larger sizes "Longer sessions" — and a
 * too-small step instead carries a warning/stop advisory. There is no Auto and no
 * Custom: only fixed sizes.
 */
export function contextCapOptions(m: ModelCatalogEntry, policy?: OutputReservePolicy): ContextCapOption[] {
    const promptBudget = effectiveMaxInputTokens(m, { outputReserve: policy });
    const fallback = defaultContextCap(m, policy);
    const defaultValue = fallback === 'full' ? 'full' : String(fallback);
    const sized = (prompt: number, value: string): ContextCapOption => {
        const advisory = sizeAdvisory(prompt);
        if (advisory) {
            return { value, label: `${advisory.icon} ${formatSize(prompt)}`, description: advisory.text };
        }
        return { value, label: formatSize(prompt), description: contextSizeNote(value, defaultValue) };
    };
    const options: ContextCapOption[] = longContextTiers(m)
        .map((tier) => tier.threshold)
        .filter((threshold) => threshold < promptBudget)
        .map((threshold) => sized(threshold, String(threshold)));
    options.push(sized(promptBudget, 'full'));
    return options;
}

/**
 * The picker value that reflects a saved prompt budget; `full` when nothing is
 * saved. Values are prompt budgets, so no reserve is added.
 */
export function contextCapSelection(stored?: number | 'full'): string {
    if (stored === 'full') {
        return 'full';
    }
    if (typeof stored === 'number') {
        return String(stored);
    }
    return 'full';
}

/** Parse a picker Context size value (a prompt budget) back to a number; `full` for the whole window. */
export function contextCapFromPicker(value: unknown): number | 'full' | undefined {
    if (value === 'full') {
        return 'full';
    }
    if (value === undefined || value === null) {
        return undefined;
    }
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/**
 * The picker's `configurationSchema` for a stepped model's Context size menu.
 * `undefined` for a model with no price step, so the menu is offered only where a
 * step size is meaningful. The default selection is the saved choice when it is
 * still inside the effective prompt budget, else the step closest to 256K
 * (`defaultContextCap`). Values are prompt budgets.
 */
export function buildContextCapSchema(
    m: ModelCatalogEntry,
    stored?: number | 'full',
    policy?: OutputReservePolicy
): { properties: Record<string, unknown> } | undefined {
    const tiers = longContextTiers(m);
    if (tiers.length === 0) {
        return undefined;
    }
    const options = contextCapOptions(m, policy);
    const validStored =
        typeof stored === 'number' && options.some((option) => option.value === String(stored));
    const fallback = validStored || stored === 'full' ? stored : defaultContextCap(m, policy);
    const selected = contextCapSelection(fallback);
    return {
        properties: {
            contextSize: {
                type: 'string',
                title: 'Context size',
                enum: options.map((option) => option.value),
                enumItemLabels: options.map((option) => option.label),
                enumDescriptions: options.map((option) => option.description ?? ''),
                default: selected,
                group: 'tokens',
            },
        },
    };
}

function blendedOf(pIn: number, pCw: number, pCr: number, pThink: number, pOut: number): number {
    const totalTokens = T_CR + T_CW + T_IN + T_THINK + T_OUT;
    return ((T_IN * pIn + T_CW * pCw + T_CR * pCr + T_THINK * pThink + T_OUT * pOut) / totalTokens) * 1_000_000;
}

const EFFORT_LABELS: Record<string, string> = {
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'X-High',
    max: 'Max',
    enabled: 'Enabled',
};

function effortLabel(effort: string): string {
    return t(EFFORT_LABELS[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1));
}

/** `Default/Effort/List` with the default bolded; optional models list None first. */
function renderEffortList(
    efforts: string[],
    defaultEffort: string | undefined,
    mandatory: boolean,
    fallback?: string
): string {
    const chosen = pickEffort(efforts, defaultEffort, fallback ?? efforts[0]);
    const ordered = !mandatory && efforts.includes('none')
        ? ['none', ...efforts.filter((e) => e !== 'none')]
        : efforts;
    const rendered = ordered.map((e) => (e === chosen ? `**${effortLabel(e)}**` : effortLabel(e))).join('/');
    return `${rendered}${mandatory ? t(' (required)') : ''}`;
}

/** One-line reasoning summary, e.g. `None/Low/Medium/High` with the default bolded. */
function reasoningSummary(reasoning: ModelReasoning): string {
    const listed = listedEfforts(reasoning);
    if (listed) {
        return renderEffortList(
            withOptionalNone(listed, reasoning.mandatory),
            reasoning.default_effort,
            reasoning.mandatory === true
        );
    }
    if (reasoning.supported_efforts === null) {
        const mandatory = reasoning.mandatory === true;
        const efforts = mandatory ? FULL_EFFORTS.filter((e) => e !== 'none') : FULL_EFFORTS;
        const fallback = !mandatory && reasoning.default_enabled === false ? 'none' : 'medium';
        return renderEffortList(efforts, reasoning.default_effort, mandatory, fallback);
    }
    if (reasoning.mandatory) {
        return t('required');
    }
    if (reasoning.default_effort) {
        return `**${effortLabel(reasoning.default_effort)}**`;
    }
    const chosen = reasoning.default_enabled === false ? 'none' : 'enabled';
    return ['none', 'enabled'].map((e) => (e === chosen ? `**${effortLabel(e)}**` : effortLabel(e))).join('/');
}

const MEDIA_MODALITIES: Array<[string, string]> = [
    ['Image', 'image'],
    ['Video', 'video'],
    ['Audio', 'audio'],
];

function tick(available: boolean): string {
    return available ? '\u2713' : '\u2717';
}

/** Capability lines, each shown with a tick/cross so absent ones are explicit too. */
function capabilityLines(m: ModelCatalogEntry): string[] {
    const input = m.architecture?.input_modalities ?? [];
    const output = m.architecture?.output_modalities ?? [];
    const lines = [t('Tools: {0}', tick(supportsToolCalling(m)))];
    for (const [label, modality] of MEDIA_MODALITIES) {
        lines.push(
            t(
                '{0}: input {1} / output {2}',
                t(label),
                tick(input.includes(modality)),
                tick(output.includes(modality))
            )
        );
    }
    return lines;
}

interface PriceRow {
    pIn: number;
    pCw: number;
    pCr: number;
    pThink: number;
    pOut: number;
}

interface PriceColumn extends PriceRow {
    header: string;
}

/**
 * One price column per pricing segment: `≤ <threshold>` for each step bound and a
 * final `> <threshold>` for the top segment (mirrors the panel table). A model
 * with no steps gets the single `$/1M` column.
 */
function priceColumns(m: ModelCatalogEntry, base: PriceRow): PriceColumn[] {
    const tiers = longContextTiers(m);
    if (tiers.length === 0) {
        return [{ header: t('$Mtok'), ...base }];
    }
    const columns: PriceColumn[] = [{ header: `\u2264${formatSize(tiers[0].threshold)}`, ...base }];
    tiers.forEach((tier, index) => {
        const pIn = tier.prompt;
        const isLast = index === tiers.length - 1;
        columns.push({
            header: isLast
                ? `>${formatSize(tier.threshold)}`
                : `\u2264${formatSize(tiers[index + 1].threshold)}`,
            pIn,
            pCw: tier.inputCacheWrite ?? pIn,
            pCr: tier.inputCacheRead ?? pIn,
            pThink: base.pThink,
            pOut: tier.completion,
        });
    });
    return columns;
}

function pricingTableMarkdown(columns: PriceColumn[]): string {
    const rows: Array<[number, string, (c: PriceColumn) => number]> = [
        [T_IN, 'Uncached', (c) => c.pIn],
        [T_CW, 'Cache write', (c) => c.pCw],
        [T_CR, 'Cache read', (c) => c.pCr],
        [T_THINK, 'Thinking', (c) => c.pThink],
        [T_OUT, 'Output', (c) => c.pOut],
    ];
    const header = `| ${t('%')} | ${t('Type')} | ${columns.map((c) => c.header).join(' | ')} |`;
    const divider = `| --- | --- | ${columns.map(() => '---').join(' | ')} |`;
    const body = rows.map(
        ([ratio, label, pick]) => `| ${ratio} | ${t(label)} | ${columns.map((c) => formatPerM(pick(c))).join(' | ')} |`
    );
    const totalWeight = rows.reduce((sum, [ratio]) => sum + ratio, 0);
    const total = `| **${totalWeight}** | **${t('Blended')}** | ${columns
        .map((c) => `**${formatPricePerM(blendedOf(c.pIn, c.pCw, c.pCr, c.pThink, c.pOut))}**`)
        .join(' | ')} |`;
    return [header, divider, ...body, total].join('\n');
}

/**
 * The global output-reserve policy (settings `openrouterCopilot.outputReserve*`):
 * a target share of the served window, bounded below and above by fixed token
 * limits. The ratio scales the reserve with the window (12.5% ≈ 131K on a
 * 1M-token window), the lower limit keeps tiny windows sane and the upper limit
 * stops huge windows from reserving an absurd share. Token sizes are decimal
 * (1K = 1000, 1M = 1,000,000), like every other size in this module. The upper
 * default (262144 ≈ 256Ki) is high enough that a current-generation model's real
 * output cap is honored rather than clipped.
 */
export interface OutputReservePolicy {
    /** The share of the window targeted for the reserve, in percent (1-50). */
    percent: number;
    /** Lower bound on the reserve, in tokens. */
    minTokens: number;
    /** Upper bound on the reserve, in tokens. */
    maxTokens: number;
}

export const DEFAULT_OUTPUT_RESERVE_PERCENT = 12.5;
export const DEFAULT_OUTPUT_RESERVE_MIN_TOKENS = 16_384;
export const DEFAULT_OUTPUT_RESERVE_MAX_TOKENS = 262_144;
export const OUTPUT_RESERVE_PERCENT_MIN = 1;
export const OUTPUT_RESERVE_PERCENT_MAX = 50;
export const DEFAULT_OUTPUT_RESERVE_POLICY: OutputReservePolicy = {
    percent: DEFAULT_OUTPUT_RESERVE_PERCENT,
    minTokens: DEFAULT_OUTPUT_RESERVE_MIN_TOKENS,
    maxTokens: DEFAULT_OUTPUT_RESERVE_MAX_TOKENS,
};

/**
 * Coerce the three settings into a policy: a non-numeric, non-positive or
 * out-of-range number (percent: 1-50) falls back to its default, so a
 * hand-edited settings.json cannot skew the reserve. The two limits are applied
 * in ascending order, so a lower limit above the upper limit still yields the
 * same interval.
 */
export function normalizeOutputReservePolicy(
    percent: unknown,
    minTokens: unknown,
    maxTokens: unknown
): OutputReservePolicy {
    const percentNumber = typeof percent === 'number' ? percent : Number(percent);
    const minNumber = typeof minTokens === 'number' ? minTokens : Number(minTokens);
    const maxNumber = typeof maxTokens === 'number' ? maxTokens : Number(maxTokens);
    return {
        percent:
            Number.isFinite(percentNumber) &&
            percentNumber >= OUTPUT_RESERVE_PERCENT_MIN &&
            percentNumber <= OUTPUT_RESERVE_PERCENT_MAX
                ? percentNumber
                : DEFAULT_OUTPUT_RESERVE_PERCENT,
        minTokens:
            Number.isFinite(minNumber) && minNumber >= 1 ? Math.round(minNumber) : DEFAULT_OUTPUT_RESERVE_MIN_TOKENS,
        maxTokens:
            Number.isFinite(maxNumber) && maxNumber >= 1 ? Math.round(maxNumber) : DEFAULT_OUTPUT_RESERVE_MAX_TOKENS,
    };
}

/**
 * Sizing overrides for `effectiveMaxInputTokens` and `buildModelInfo`: the
 * per-model prompt budget chosen in the model picker's **Context size** menu
 * and the global output-reserve policy.
 */
export interface ContextBudgetOptions {
    /** A per-model prompt budget chosen in the model picker. */
    overrideTokens?: number;
    /** The global reserve policy; the default when omitted. */
    outputReserve?: OutputReservePolicy;
}

/**
 * The provider's genuine reply ceiling, when it has one and is not clamped. A
 * value above half the window is not returned: Copilot's native OpenRouter
 * provider caps `maxOutputTokens` at `floor(window / 2)`, and OpenRouter's
 * synthetic `max_completion_tokens` (a round share of the window such as
 * `floor(ctx*0.9)`) is exactly what that clamp exists for. `undefined` when the
 * catalog lists no cap, or lists one above half the window.
 */
export function declaredOutputCap(m: ModelCatalogEntry): number | undefined {
    const cap = finitePositive(m.top_provider?.max_completion_tokens);
    if (cap === undefined) {
        return undefined;
    }
    const context = effectiveContextLength(m);
    if (context === undefined) {
        return cap;
    }
    return cap <= Math.floor(context / 2) ? cap : undefined;
}

/**
 * How many output tokens to reserve out of the served window under a policy.
 * A published cap at or below half the window is trusted: it is reserved as-is
 * unless the upper limit is smaller, and it is never inflated up to the lower
 * limit (reserving more than the model can emit only wastes input). An absent
 * cap or a synthetic `0.9 × window` placeholder is not trusted: the reserve is
 * `window × percent`, bounded by `[minTokens, maxTokens]`. With no window at
 * all, the upper limit applies. The result is clamped to
 * `[1, floor(window / 2)]`, keeping `maxInputTokens + maxOutputTokens` equal to
 * the served window.
 */
export function effectiveOutputReserve(
    m: ModelCatalogEntry,
    policy: OutputReservePolicy = DEFAULT_OUTPUT_RESERVE_POLICY
): number {
    const context = effectiveContextLength(m);
    const trusted = declaredOutputCap(m);
    const percent = finitePositive(policy.percent) ?? DEFAULT_OUTPUT_RESERVE_PERCENT;
    const minBound = finitePositive(policy.minTokens) ?? DEFAULT_OUTPUT_RESERVE_MIN_TOKENS;
    const maxBound = finitePositive(policy.maxTokens) ?? DEFAULT_OUTPUT_RESERVE_MAX_TOKENS;
    const lower = Math.min(minBound, maxBound);
    const upper = Math.max(minBound, maxBound);
    let reserve: number;
    if (trusted !== undefined) {
        reserve = Math.min(trusted, upper);
    } else if (context !== undefined) {
        const share = Math.max(1, Math.floor((context * percent) / 100));
        reserve = Math.min(Math.max(share, lower), upper);
    } else {
        reserve = upper;
    }
    if (context === undefined) {
        return Math.max(1, reserve);
    }
    return Math.max(1, Math.min(reserve, Math.floor(context / 2)));
}

/**
 * The input budget Copilot packs prompts against: the accurate
 * `<effective window> - <output reserve>`, overridden by a per-model picker
 * choice when one is saved. The effective window is the smaller of the catalog's
 * model-level `context_length` and the serving provider's
 * `top_provider.context_length`, so the budget never claims window a provider
 * will not serve. The output reserve follows `effectiveOutputReserve` (the
 * global policy): a trusted cap is reserved as-is up to the upper limit, while
 * synthetic placeholders and absent caps get the bounded ratio. A saved override
 * is clamped to that same budget, so a choice made under an older reserve policy
 * can never advertise more prompt than the window actually holds. No percentage
 * fudge; Copilot's own auto-compaction acts on this number.
 */
export function effectiveMaxInputTokens(m: ModelCatalogEntry, opts: ContextBudgetOptions = {}): number {
    const context = effectiveContextLength(m);
    const reserve = effectiveOutputReserve(m, opts.outputReserve);
    const raw = context !== undefined ? Math.max(1, context - reserve) : ASSUMED_CONTEXT_TOKENS;
    let budget = Math.max(1, Math.floor(raw));
    const override = finitePositive(opts.overrideTokens);
    if (override !== undefined) {
        budget = Math.max(1, Math.min(budget, Math.floor(override)));
    }
    return budget;
}

export function buildModelInfo(m: ModelCatalogEntry, opts: ContextBudgetOptions = {}): ModelInfo {
    const pricing = m.pricing ?? {};
    const pIn = parsePrice(pricing.prompt);
    const pOut = parsePrice(pricing.completion);
    const pCr = priceOr(pricing.input_cache_read, pIn);
    const pCw = priceOr(pricing.input_cache_write, pIn);
    const pThink = priceOr(pricing.internal_reasoning, pOut);
    const hasPricing = pricing.prompt !== undefined || pricing.completion !== undefined || pIn > 0 || pOut > 0;

    const contextWindow = effectiveContextLength(m);
    const hasContextLength = contextWindow !== undefined;
    const maxOutputTokens = effectiveOutputReserve(m, opts.outputReserve);
    const listedCap = finitePositive(m.top_provider?.max_completion_tokens);
    const maxInputTokens = effectiveMaxInputTokens(m, opts);

    const basePrices: PriceRow = { pIn, pCw, pCr, pThink, pOut };
    const pAvgM = hasPricing ? blendedOf(pIn, pCw, pCr, pThink, pOut) : 0;

    const blocks: string[] = [];
    if (hasPricing) {
        blocks.push(pricingTableMarkdown(priceColumns(m, basePrices)));
    } else {
        blocks.push(t('Pricing: not listed by OpenRouter'));
    }
    const infoLines: string[] = [];
    if (hasContextLength && contextWindow !== undefined) {
        infoLines.push(t('Context window: {0}', formatSize(contextWindow)));
    }
    infoLines.push(
        t(
            'Effective prompt cap: {0}',
            hasContextLength
                ? formatSize(maxInputTokens)
                : t('not listed (assuming {0})', formatSize(maxInputTokens))
        )
    );
    infoLines.push(t('Effective completion cap: {0}', formatSize(maxOutputTokens)));
    infoLines.push(t('Max completion: {0}', listedCap !== undefined ? formatSize(listedCap) : t('not listed')));
    infoLines.push(...capabilityLines(m));
    if (m.reasoning) {
        infoLines.push(t('Reasoning: {0}', reasoningSummary(m.reasoning)));
    }
    blocks.push(infoLines.join('\n\n'));

    const tier = longContextTier(m);
    const uncappedBudget = hasContextLength
        ? Math.max(1, Math.floor((contextWindow ?? ASSUMED_CONTEXT_TOKENS) - maxOutputTokens))
        : maxInputTokens;
    const cappedToBase = tier !== undefined && maxInputTokens <= tier.threshold && maxInputTokens < uncappedBudget;

    const detail = hasPricing
        ? `${t('~{0}/1M', formatPricePerM(pAvgM))}${cappedToBase && tier ? ` \u00b7 \u2264${formatSize(maxInputTokens)}` : ''}`
        : undefined;

    return { detail, tooltip: blocks.join('\n\n'), maxInputTokens, maxOutputTokens };
}
