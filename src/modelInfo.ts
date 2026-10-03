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
    supports_tool_parameters?: boolean;
    context_length?: number;
    architecture?: { input_modalities?: string[] };
    pricing?: ModelPricing;
    reasoning?: ModelReasoning;
    top_provider?: { context_length?: number; max_completion_tokens?: number; is_moderated?: boolean };
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
    return parsePrice(value) || fallback;
}

function trimZeros(value: string): string {
    return value.replace(/0+$/, '').replace(/\.$/, '');
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

export function formatUsd(value: number): string {
    if (value === 0) {
        return '$0.00';
    }
    if (value < 0.01) {
        return `$${trimZeros(value.toFixed(8))}`;
    }
    if (value < 1) {
        return `$${trimZeros(value.toFixed(4))}`;
    }
    return `$${value.toFixed(2)}`;
}

function formatThousands(n: number): string {
    return n.toLocaleString('en-US');
}

function formatTokenShort(n: number): string {
    return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

const EFFORT_DESCRIPTIONS: Record<string, string> = {
    none: 'No reasoning',
    minimal: 'Minimal reasoning',
    low: 'Fast responses with lighter reasoning',
    medium: 'Balanced speed and reasoning depth',
    high: 'Greater reasoning depth for complex problems',
    xhigh: 'Maximum reasoning effort',
    max: 'Deep reasoning for hard agent tasks',
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
                title,
                enum: efforts,
                enumItemLabels: labels.map(
                    (effort) => effort.charAt(0).toUpperCase() + effort.slice(1)
                ),
                enumDescriptions: efforts.map(
                    (effort) => EFFORT_DESCRIPTIONS[effort] ?? 'Reasoning effort level'
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
        const efforts = reasoning.mandatory
            ? FULL_EFFORTS.filter((e) => e !== 'none')
            : FULL_EFFORTS;
        return effortProperty(efforts, pickEffort(efforts, reasoning.default_effort, 'medium'));
    }
    if (reasoning.mandatory) {
        return undefined;
    }
    return {
        properties: {
            reasoningEnabled: {
                type: 'string',
                title: 'Reasoning',
                enum: ['none', 'enabled'],
                enumItemLabels: ['None', 'Enabled'],
                enumDescriptions: ['No reasoning', 'Reasoning at the default level'],
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
const MAX_OUTPUT_TOKENS = 16_384;
const ASSUMED_CONTEXT_TOKENS = 1_048_576;

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
 * The smallest prompt-token threshold at which the catalog raises this model's
 * price. Time-of-day overrides (`utc_*`, no `min_prompt_tokens`), thresholds at
 * or above the window, and pure discounts are all ignored.
 */
export function longContextTier(m: ModelCatalogEntry): LongContextTier | undefined {
    const overrides = m.pricing?.overrides;
    if (!Array.isArray(overrides) || overrides.length === 0) {
        return undefined;
    }
    const context = m.context_length ?? m.top_provider?.context_length;
    const basePrompt = parsePrice(m.pricing?.prompt);
    const baseCompletion = parsePrice(m.pricing?.completion);
    let best: LongContextTier | undefined;
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
        if (!best || threshold < best.threshold) {
            best = {
                threshold,
                prompt: prompt || basePrompt,
                completion: completion || baseCompletion,
                inputCacheRead: override.input_cache_read !== undefined ? parsePrice(override.input_cache_read) : undefined,
                inputCacheWrite: override.input_cache_write !== undefined ? parsePrice(override.input_cache_write) : undefined,
            };
        }
    }
    return best;
}

export type ContextWindowPolicy = 'auto' | 'full';
export const DEFAULT_CONTEXT_POLICY: ContextWindowPolicy = 'auto';
export const MAX_CONTEXT_MARGIN_PERCENT = 50;

export interface ContextBudgetOptions {
    /** `auto` caps a tier model at its cheapest threshold; `full` reports the whole window. */
    policy?: ContextWindowPolicy;
    /** A per-model Custom cap, already reduced by the saved safety margin. */
    overrideTokens?: number;
}

/**
 * The input budget Copilot packs prompts against: the accurate
 * `context_length - max_output_tokens`, or the long-context threshold on
 * `auto`. Per-model Custom caps are applied as stored. No percentage fudge by
 * default; Copilot's own auto-compaction acts on this number.
 */
export function effectiveMaxInputTokens(m: ModelCatalogEntry, opts: ContextBudgetOptions = {}): number {
    const hasContext = m.context_length != null || m.top_provider?.context_length != null;
    const context = m.context_length ?? m.top_provider?.context_length ?? ASSUMED_CONTEXT_TOKENS;
    const maxOutput = m.top_provider?.max_completion_tokens ?? MAX_OUTPUT_TOKENS;
    const raw = hasContext ? Math.max(1, context - maxOutput) : ASSUMED_CONTEXT_TOKENS;
    let budget = Math.max(1, Math.floor(raw));
    const policy = opts.policy ?? DEFAULT_CONTEXT_POLICY;
    const tier = longContextTier(m);
    if (policy === 'auto' && tier) {
        budget = Math.min(budget, tier.threshold);
    }
    const override = finitePositive(opts.overrideTokens);
    if (override !== undefined) {
        budget = Math.floor(override);
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

    const hasContextLength = m.context_length != null || m.top_provider?.context_length != null;
    const maxOutputTokens = m.top_provider?.max_completion_tokens ?? MAX_OUTPUT_TOKENS;
    const hasMaxOutputTokens = m.top_provider?.max_completion_tokens != null;
    const maxInputTokens = effectiveMaxInputTokens(m, opts);

    const components: Array<{ label: string; weight: number; price: number }> = [
        { label: 'uncached', weight: T_IN, price: pIn },
        { label: 'cache write', weight: T_CW, price: pCw },
        { label: 'cache read', weight: T_CR, price: pCr },
        { label: 'thinking', weight: T_THINK, price: pThink },
        { label: 'output', weight: T_OUT, price: pOut },
    ];
    const totalTokens = components.reduce((sum, c) => sum + c.weight, 0);
    const pAvgM = hasPricing
        ? (components.reduce((sum, c) => sum + c.weight * c.price, 0) / totalTokens) * 1_000_000
        : 0;

    const capabilities = [
        m.supports_tool_parameters !== false ? 'tool calling' : 'no tool calling',
        (m.architecture?.input_modalities ?? []).includes('image') ? 'image input' : 'text-only',
    ];

    const blocks: string[] = [];
    if (hasPricing) {
        blocks.push(`**~ ${formatPricePerM(pAvgM)} / 1M tokens (est.)**`);
        blocks.push(
            `per answer token: ${T_IN} uncached · ${T_CW} cache write · ${T_CR} cache read · ${T_THINK} thinking · ${T_OUT} output`
        );
        blocks.push(
            ['**Pricing per 1M tokens**', components.map((c) => `- ${c.label}: ${formatPerM(c.price)}`).join('\n')].join('\n\n')
        );
    } else {
        blocks.push('Pricing: not listed by OpenRouter');
    }
    const contextWindow = m.context_length ?? m.top_provider?.context_length;
    const windowLine =
        hasContextLength && contextWindow !== undefined && contextWindow !== maxInputTokens
            ? [`Context window: ${formatThousands(contextWindow)} tokens`]
            : [];
    const infoLines: string[] = [
        ...windowLine,
        `Max input context: ${hasContextLength ? `${formatThousands(maxInputTokens)} tokens` : `not listed (assuming ${formatThousands(maxInputTokens)} tokens)`}`,
        `Max output context: ${hasMaxOutputTokens ? `${formatThousands(maxOutputTokens)} tokens` : `not listed (assuming ${formatThousands(maxOutputTokens)} tokens)`}`,
        `Capabilities: ${capabilities.join(', ')}`,
    ];
    if (m.reasoning) {
        if (m.reasoning.mandatory) {
            infoLines.push('Reasoning: required');
        } else if (m.reasoning.default_effort) {
            const efforts = listedEfforts(m.reasoning);
            if (efforts) {
                const shown = withOptionalNone(efforts, m.reasoning.mandatory);
                infoLines.push(`Reasoning: optional (supported: ${shown.join(', ')}; default: ${m.reasoning.default_effort})`);
            } else {
                infoLines.push(`Reasoning: optional (default: ${m.reasoning.default_effort})`);
            }
        } else if (m.reasoning.supported_efforts === undefined) {
            infoLines.push('Reasoning: optional (on/off)');
        }
    }
    blocks.push(infoLines.join('\n\n'));

    const tier = longContextTier(m);
    const cappedToBase = tier !== undefined && maxInputTokens < tier.threshold;
    if (tier && hasPricing) {
        const tierAvgM =
            (T_IN * tier.prompt +
                T_CW * (tier.inputCacheWrite ?? tier.prompt) +
                T_CR * (tier.inputCacheRead ?? tier.prompt) +
                T_THINK * pThink +
                T_OUT * tier.completion) /
            totalTokens *
            1_000_000;
        const threshold = formatThousands(tier.threshold);
        blocks.push(
            [
                '**Long-context pricing**',
                `- up to ${threshold} prompt tokens: ~${formatPricePerM(pAvgM)} / 1M`,
                `- above ${threshold} prompt tokens: ~${formatPricePerM(tierAvgM)} / 1M`,
                cappedToBase
                    ? `- Input capped at ${formatThousands(maxInputTokens)} tokens to stay in the base tier. Change it in the panel's **Context limits**, or set \`openrouterCopilot.contextWindowPolicy\` to \`full\`.`
                    : '- Full window in use \u2014 the long-context surcharge applies above the threshold.',
            ].join('\n')
        );
    }

    const detail = hasPricing
        ? `~${formatPricePerM(pAvgM)}/1M${cappedToBase && tier ? ` \u00b7 \u2264${formatTokenShort(maxInputTokens)}` : ''}`
        : undefined;

    return { detail, tooltip: blocks.join('\n\n'), maxInputTokens, maxOutputTokens };
}
