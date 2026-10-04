import * as assert from "assert";
import {
    buildContextCapSchema,
    buildModelInfo,
    buildReasoningSchema,
    contextCapFromPicker,
    contextCapOptions,
    contextCapSelection,
    defaultContextCap,
    effectiveContextLength,
    effectiveMaxInputTokens,
    effortFromModelConfiguration,
    enabledFromModelConfiguration,
    formatPerM,
    formatPricePerM,
    longContextTier,
    longContextTiers,
    normalizeOutputReservePolicy,
    parsePrice,
    supportsToolCalling,
    type ModelCatalogEntry,
} from "../../modelInfo";

const OPENAI_LONG_CONTEXT: ModelCatalogEntry = {
    id: "openai/gpt-5.6-luna-pro",
    context_length: 1_050_000,
    pricing: {
        prompt: "0.0000002",
        completion: "0.0000012",
        input_cache_read: "0.00000002",
        input_cache_write: "0.00000025",
        overrides: [
            {
                min_prompt_tokens: 272000,
                prompt: "0.0000004",
                completion: "0.0000018",
                input_cache_read: "0.00000004",
                input_cache_write: "0.0000005",
            },
        ],
    },
    top_provider: { max_completion_tokens: 128_000 },
};

suite("long-context pricing", () => {
    test("detects the smallest surcharge threshold and its stepped prices", () => {
        const tier = longContextTier(OPENAI_LONG_CONTEXT);
        assert.ok(tier);
        assert.strictEqual(tier!.threshold, 272000);
        assert.strictEqual(tier!.prompt, 0.0000004);
        assert.strictEqual(tier!.completion, 0.0000018);
        assert.strictEqual(tier!.inputCacheRead, 0.00000004);
        assert.strictEqual(tier!.inputCacheWrite, 0.0000005);
    });

    test("ignores time-of-day overrides without a token threshold", () => {
        const tier = longContextTier({
            id: "tencent/hy4-preview",
            context_length: 200000,
            pricing: { prompt: "0.0000008", overrides: [{ utc_start: 0, utc_end: 1600, prompt: "0.000001" }] },
        });
        assert.strictEqual(tier, undefined);
    });

    test("ignores a discount and a threshold at or above the window", () => {
        assert.strictEqual(
            longContextTier({
                id: "x/discount",
                context_length: 200000,
                pricing: { prompt: "0.000001", overrides: [{ min_prompt_tokens: 100000, prompt: "0.0000005" }] },
            }),
            undefined
        );
        assert.strictEqual(
            longContextTier({
                id: "x/quirk",
                context_length: 200000,
                pricing: { prompt: "0.000001", overrides: [{ min_prompt_tokens: 200000, prompt: "0.000002" }] },
            }),
            undefined
        );
    });

    test("picks the cheapest of several surcharge thresholds", () => {
        const tier = longContextTier({
            id: "qwen/qwen3.7-flash",
            context_length: 400000,
            pricing: {
                prompt: "0.0000005",
                completion: "0.000001",
                overrides: [
                    { min_prompt_tokens: 256000, prompt: "0.0000015", completion: "0.000003" },
                    { min_prompt_tokens: 32000, prompt: "0.0000008", completion: "0.0000016" },
                ],
            },
        });
        assert.strictEqual(tier?.threshold, 32000);
    });

    test("lists every surcharge threshold ascending", () => {
        const tiers = longContextTiers({
            id: "qwen/qwen3.7-flash",
            context_length: 400000,
            pricing: {
                prompt: "0.0000005",
                completion: "0.000001",
                overrides: [
                    { min_prompt_tokens: 256000, prompt: "0.0000015", completion: "0.000003" },
                    { min_prompt_tokens: 32000, prompt: "0.0000008", completion: "0.0000016" },
                ],
            },
        });
        assert.deepStrictEqual(
            tiers.map((t) => t.threshold),
            [32000, 256000]
        );
        assert.strictEqual(tiers[0].prompt, 0.0000008);
        assert.strictEqual(tiers[1].prompt, 0.0000015);
    });

    test("reports context minus output with no global cap", () => {
        assert.strictEqual(effectiveMaxInputTokens(OPENAI_LONG_CONTEXT), 922000);
    });

    test("a saved per-model Context size choice overrides the budget", () => {
        assert.strictEqual(effectiveMaxInputTokens(OPENAI_LONG_CONTEXT, { overrideTokens: 200000 }), 200000);
    });

    test("a model without a tier reports its accurate input budget", () => {
        const info = buildModelInfo({ id: "x/y", context_length: 131072, top_provider: { max_completion_tokens: 16384 } });
        assert.strictEqual(info.maxInputTokens, 114688);
    });

    test("the full window budget is used when no per-model size is saved", () => {
        const info = buildModelInfo(OPENAI_LONG_CONTEXT);
        assert.strictEqual(info.maxInputTokens, 922000);
        assert.ok(!(info.detail ?? "").includes("\u2264"));
    });

    test("a saved size below the threshold is marked on the detail line", () => {
        const info = buildModelInfo(OPENAI_LONG_CONTEXT, { overrideTokens: 200000 });
        assert.strictEqual(info.maxInputTokens, 200000);
        assert.ok(
            info.tooltip.includes("Effective prompt cap: 200K"),
            "the tooltip reports the effective prompt budget after the selected step"
        );
        assert.match(info.detail ?? "", / \u00b7 \u2264200K$/, "cap marker on the detail line");
    });

    test("a cap above the threshold is not marked on the detail line", () => {
        const info = buildModelInfo(OPENAI_LONG_CONTEXT, { overrideTokens: 500000 });
        assert.strictEqual(info.maxInputTokens, 500000);
        assert.ok(!(info.detail ?? "").includes("\u2264"));
    });

    test("a budget already below the threshold is not marked as capped", () => {
        const m: ModelCatalogEntry = {
            id: "x-ai/grok-4.5",
            context_length: 300_000,
            pricing: {
                prompt: "0.0000002",
                completion: "0.0000006",
                overrides: [{ min_prompt_tokens: 200000, prompt: "0.0000004", completion: "0.0000012" }],
            },
            top_provider: { max_completion_tokens: 140_000 },
        };
        const info = buildModelInfo(m);
        assert.strictEqual(info.maxInputTokens, 160000, "a trusted cap below the default upper limit is honored");
        assert.ok(!(info.detail ?? "").includes("\u2264"));
    });
});

suite("model info", () => {
    test("parsePrice handles missing and non-numeric values", () => {
        assert.strictEqual(parsePrice(undefined), 0);
        assert.strictEqual(parsePrice(""), 0);
        assert.strictEqual(parsePrice("abc"), 0);
        assert.strictEqual(parsePrice("0.000000065"), 6.5e-8);
    });

    test("formatPerM converts per-token values to per-1M display", () => {
        assert.strictEqual(formatPerM(0), "$0.000");
        assert.strictEqual(formatPerM(0.000000065), "$0.065");
        assert.strictEqual(formatPerM(0.00000018), "$0.180");
        assert.strictEqual(formatPerM(0.000000001), "$0.001");
    });

    test("formatPricePerM formats blended per-1M estimates", () => {
        assert.strictEqual(formatPricePerM(0), "$0.000");
        assert.strictEqual(formatPricePerM(0.02848), "$0.028");
        assert.strictEqual(formatPricePerM(2.3929), "$2.393");
    });

    test("blended estimate reproduces the worked example (DeepSeek V4 Flash)", () => {
        const m: ModelCatalogEntry = {
            id: "deepseek/deepseek-v4-flash-0731",
            pricing: { prompt: "0.000000045", completion: "0.00000009", input_cache_read: "0.000000009" },
        };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("| % | Type | $Mtok |"), "pricing header");
        assert.ok(info.tooltip.includes("| **100** | **Blended** | **$0.017** |"), "weighted total row");
        assert.strictEqual(info.detail, "~$0.017/1M");
        assert.ok(info.tooltip.includes("| 85 | Cache read | $0.009 |"), "cache-read row");
        assert.ok(info.tooltip.includes("| 6 | Cache write | $0.045 |"), "cache-write falls back to input");
        assert.ok(info.tooltip.includes("| 3 | Uncached | $0.045 |"), "uncached falls back to input");
        assert.strictEqual(info.tooltip.split("$0.09").length - 1, 2, "output and thinking rows");
    });

    test("cache-write and uncached prices are used when listed", () => {
        const m: ModelCatalogEntry = {
            id: "anthropic/claude-opus-5",
            pricing: {
                prompt: "0.000005",
                completion: "0.000025",
                input_cache_read: "0.0000005",
                input_cache_write: "0.00000625",
            },
        };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("| **100** | **Blended** | **$2.450** |"), "weighted total row");
        assert.ok(info.tooltip.includes("| 85 | Cache read | $0.500 |"), "cache-read row");
        assert.ok(info.tooltip.includes("| 6 | Cache write | $6.250 |"), "cache-write row");
        assert.ok(info.tooltip.includes("| 3 | Uncached | $5.000 |"), "uncached priced at prompt");
        assert.ok(!info.tooltip.includes("$10"), "1h ephemeral price no longer used");
    });

    test("explicitly free models show a $0 estimate instead of the not-listed fallback", () => {
        const m: ModelCatalogEntry = {
            id: "deepseek/deepseek-v4-flash:free",
            pricing: { prompt: "0", completion: "0", input_cache_read: "0", input_cache_write: "0" },
        };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("| **100** | **Blended** | **$0.000** |"), "weighted total row");
        assert.strictEqual(info.detail, "~$0.000/1M");
        assert.ok(!info.tooltip.includes("not listed by OpenRouter"));
    });

    test("an explicit zero cache or reasoning price is not replaced by the fallback", () => {
        const m: ModelCatalogEntry = {
            id: "x/mixed-zero",
            pricing: {
                prompt: "0.000001",
                completion: "0.000002",
                input_cache_read: "0",
                input_cache_write: "0",
                internal_reasoning: "0",
            },
        };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("| 85 | Cache read | $0.000 |"), "a free cache read stays free");
        assert.ok(info.tooltip.includes("| 6 | Cache write | $0.000 |"), "a free cache write stays free");
        assert.ok(info.tooltip.includes("| 5 | Thinking | $0.000 |"), "a free thinking rate stays free");
    });

    test("internal_reasoning supplies the thinking price when present", () => {
        const m: ModelCatalogEntry = {
            id: "google/gemini-3.7-flash",
            pricing: {
                prompt: "0.00000075",
                completion: "0.00000375",
                internal_reasoning: "0.00000375",
                input_cache_read: "0.000000075",
                input_cache_write: "0.0000000416666666666667",
            },
        };
        const info = buildModelInfo(m);
        assert.strictEqual(info.tooltip.split("$3.75").length - 1, 2, "output and thinking both $3.75");
        assert.ok(info.tooltip.includes("| **100** | **Blended** | **$0.314** |"), "weighted total row");
    });

    test("context, max output and capabilities are still listed", () => {
        const m: ModelCatalogEntry = {
            id: "deepseek/deepseek-v4-flash-0731",
            context_length: 1310720,
            supports_tool_parameters: true,
            architecture: { input_modalities: ["text"] },
            pricing: { prompt: "0.000000065", completion: "0.00000018", input_cache_read: "0.000000016" },
            top_provider: { max_completion_tokens: 943718 },
            reasoning: { mandatory: false, supported_efforts: ["low", "high", "max"], default_effort: "high" },
        };
        const info = buildModelInfo(m);
        assert.strictEqual(info.detail, "~$0.030/1M");
        assert.ok(info.tooltip.includes("Context window: 1.31M"), "context window listed");
        assert.ok(
            info.tooltip.includes("Effective prompt cap: 1.15M"),
            "effective prompt budget follows the default reserve"
        );
        assert.ok(
            info.tooltip.includes("Max completion: 944K") && info.tooltip.includes("Effective completion cap: 164K"),
            "the model max and the effective completion cap are both listed"
        );
        assert.ok(info.tooltip.includes("Tools: \u2713"));
        assert.ok(info.tooltip.includes("Image: input \u2717 / output \u2717"));
        assert.ok(info.tooltip.includes("Reasoning: None/Low/**High**/Max"));
        assert.strictEqual(info.maxInputTokens, 1146880, "input budget = window minus the default reserve");
        assert.strictEqual(info.maxOutputTokens, 163840);
    });

    test("a synthetic placeholder output cap gets the default reserve (DeepSeek V4.1 Flash)", () => {
        const m: ModelCatalogEntry = {
            id: "deepseek/deepseek-v4.1-flash",
            context_length: 1048576,
            top_provider: { context_length: 1048576, max_completion_tokens: 943718 },
        };
        const info = buildModelInfo(m);
        assert.strictEqual(info.maxInputTokens, 917504, "the 0.9x placeholder is replaced by the 128K default");
        assert.strictEqual(info.maxOutputTokens, 131072);
        assert.strictEqual(info.maxInputTokens + info.maxOutputTokens, 1048576, "input plus output equal the window");
    });

    test("the default reserve targets about one eighth of the window", () => {
        const at = (window: number) =>
            buildModelInfo({
                id: "x/y",
                context_length: window,
                top_provider: { max_completion_tokens: Math.floor(window * 0.9) },
            });
        assert.strictEqual(at(1_048_576).maxOutputTokens, 131_072, "1M window reserves 131K");
        assert.strictEqual(at(524_288).maxOutputTokens, 65_536, "512K window reserves 66K");
        assert.strictEqual(at(262_144).maxOutputTokens, 32_768, "256K window reserves 33K");
    });

    test("lower and upper limits keep tiny and huge windows sane", () => {
        const at = (window: number, policy?: { percent: number; minTokens: number; maxTokens: number }) =>
            buildModelInfo(
                { id: "x/y", context_length: window, top_provider: { max_completion_tokens: Math.floor(window * 0.9) } },
                policy ? { outputReserve: policy } : undefined
            );
        assert.strictEqual(at(32_768).maxOutputTokens, 16_384, "the lower limit then the half-window clamp floor a tiny window");
        assert.strictEqual(at(8_192).maxOutputTokens, 4_096, "a sub-32K window is still split half and half");
        assert.strictEqual(at(4_194_304).maxOutputTokens, 262_144, "a huge window is capped at the upper limit");
        const custom = at(1_048_576, { percent: 25, minTokens: 32_768, maxTokens: 65_536 });
        assert.strictEqual(custom.maxOutputTokens, 65_536, "custom bounds clamp the ratio");
    });

    test("a trusted cap is honored up to the upper limit and never inflated by the lower", () => {
        const big = buildModelInfo({
            id: "x/y",
            context_length: 1_048_576,
            top_provider: { max_completion_tokens: 300_000 },
        });
        assert.strictEqual(big.maxOutputTokens, 262_144, "a real cap above the upper limit is capped");
        const honored = buildModelInfo({
            id: "x/y",
            context_length: 1_048_576,
            top_provider: { max_completion_tokens: 262_144 },
        });
        assert.strictEqual(honored.maxOutputTokens, 262_144, "a real 256K cap is reserved in full");
        const small = buildModelInfo({
            id: "x/y",
            context_length: 200_000,
            top_provider: { max_completion_tokens: 8_000 },
        });
        assert.strictEqual(small.maxOutputTokens, 8_000, "a real cap below the lower limit stays verbatim");
    });

    test("output reserve settings are normalized", () => {
        assert.deepStrictEqual(normalizeOutputReservePolicy("12.5", "65536", 131_072), {
            percent: 12.5,
            minTokens: 65536,
            maxTokens: 131072,
        });
        assert.deepStrictEqual(normalizeOutputReservePolicy("bogus", 0, -1), {
            percent: 12.5,
            minTokens: 16384,
            maxTokens: 262144,
        });
        assert.deepStrictEqual(normalizeOutputReservePolicy(80, 1.6, 2), {
            percent: 12.5,
            minTokens: 2,
            maxTokens: 2,
        });
    });

    test("declared output caps are still reserved verbatim", () => {
        const m: ModelCatalogEntry = {
            id: "anthropic/claude-x",
            context_length: 200000,
            top_provider: { max_completion_tokens: 64000 },
        };
        const info = buildModelInfo(m);
        assert.strictEqual(info.maxOutputTokens, 64000);
        assert.strictEqual(info.maxInputTokens, 136000);
        assert.ok(info.tooltip.includes("Max completion: 64K"), "a real cap is listed as the model max");
        assert.ok(info.tooltip.includes("Effective completion cap: 64K"), "the effective cap is listed too");
        assert.ok(info.tooltip.includes("Effective prompt cap: 136K"), "the effective prompt budget follows");
    });

    test("the served window is the smaller of the model and provider context lengths", () => {
        const m: ModelCatalogEntry = {
            id: "google/gemini-3-pro-image",
            context_length: 131072,
            top_provider: { context_length: 65536, max_completion_tokens: 16384 },
            pricing: { prompt: "0.000001", completion: "0.000002" },
        };
        const info = buildModelInfo(m);
        assert.strictEqual(effectiveContextLength(m), 65536, "provider window wins when smaller");
        assert.strictEqual(info.maxInputTokens, 49152, "input budget uses the served window");
        assert.ok(info.tooltip.includes("Context window: 66K"), "window line is the served window");
        assert.ok(!info.tooltip.includes("131,072"), "the catalog-wide maximum is not advertised");
    });

    test("a provider context length alone supplies the window", () => {
        const m: ModelCatalogEntry = {
            id: "x/y",
            top_provider: { context_length: 100000, max_completion_tokens: 10000 },
        };
        assert.strictEqual(effectiveContextLength(m), 100000);
        assert.strictEqual(buildModelInfo(m).maxInputTokens, 90000);
        assert.strictEqual(effectiveContextLength({ id: "x/y" }), undefined, "no window listed");
    });

    test("missing pricing yields a friendly fallback", () => {
        const info = buildModelInfo({ id: "x/y" });
        assert.strictEqual(info.detail, undefined);
        assert.ok(info.tooltip.includes("Pricing: not listed by OpenRouter"));
        assert.ok(info.tooltip.includes("Max completion: not listed"), "unknown model cap emphasized");
        assert.ok(info.tooltip.includes("Effective completion cap: 262K"), "the default effective cap is shown");
        assert.ok(info.tooltip.includes("Effective prompt cap: not listed (assuming 1.05M)"), "unknown context emphasized");
        assert.strictEqual(info.maxInputTokens, 1048576);
        assert.strictEqual(info.maxOutputTokens, 262144);
    });

    test("tooltip is block-level markdown without trailing-space hard breaks", () => {
        const m: ModelCatalogEntry = {
            id: "x/y",
            pricing: { prompt: "0.000000065", completion: "0.00000018" },
        };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("| % | Type | $Mtok |"), "pricing header");
        assert.ok(!info.tooltip.includes("  \n"), "no markdown hard breaks");
        assert.ok(info.tooltip.includes("\n\n"), "blocks separated by blank lines");
        const lines = info.tooltip.split("\n");
        assert.ok(lines.some((l) => l.startsWith("Effective prompt cap:")), "effective prompt cap line present");
        assert.ok(lines.some((l) => l.startsWith("Max completion:")), "max completion line present");
        assert.ok(lines.some((l) => l === "Tools: \u2713"), "capability line present");
        assert.ok(lines.some((l) => l.startsWith("| 3 | Uncached |")), "uncached row is a table row");
    });

    test("reasoning is required when marked mandatory", () => {
        const m: ModelCatalogEntry = { id: "x/y", reasoning: { mandatory: true } };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("Reasoning: required"));
    });

    test("reasoning shows just the default when no supported efforts are listed", () => {
        const m: ModelCatalogEntry = { id: "x/y", reasoning: { mandatory: false, default_effort: "medium" } };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("Reasoning: **Medium**"));
    });

    test("mandatory reasoning appends (required) after the effort list", () => {
        const m: ModelCatalogEntry = {
            id: "x/y",
            reasoning: { mandatory: true, supported_efforts: ["low", "medium", "high"], default_effort: "medium" },
        };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("Reasoning: Low/**Medium**/High (required)"));
        assert.ok(!info.tooltip.includes("None"), "a required model does not offer None");
    });

    test("vision models report image input", () => {
        const m: ModelCatalogEntry = {
            id: "o/vision",
            supports_tool_parameters: false,
            architecture: { input_modalities: ["text", "image"] },
        };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("Image: input \u2713 / output \u2717"));
        assert.ok(info.tooltip.includes("Tools: \u2717"));
    });

    test("capabilities list every modality with a tick or cross", () => {
        const m: ModelCatalogEntry = {
            id: "o/all",
            architecture: { input_modalities: ["text", "image", "audio"], output_modalities: ["text", "image"] },
        };
        const info = buildModelInfo(m);
        for (const line of [
            "Tools: \u2713",
            "Image: input \u2713 / output \u2713",
            "Video: input \u2717 / output \u2717",
            "Audio: input \u2713 / output \u2717",
        ]) {
            assert.ok(info.tooltip.includes(line), `${line} present`);
        }
    });

    test("a tiered model renders a price table with one column per segment", () => {
        const m: ModelCatalogEntry = {
            id: "openai/gpt-5.6",
            context_length: 1050000,
            pricing: {
                prompt: "0.00000125",
                completion: "0.00001",
                input_cache_read: "0.000000125",
                overrides: [
                    { min_prompt_tokens: 272000, prompt: "0.0000025", completion: "0.000015", input_cache_read: "0.00000025" },
                ],
            },
            top_provider: { max_completion_tokens: 943718 },
        };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("| % | Type | \u2264272K | >272K |"), "tiered column headers");
        assert.ok(info.tooltip.includes("| 3 | Uncached | $1.250 | $2.500 |"), "uncached row spans both tiers");
        assert.ok(info.tooltip.includes("| 1 | Output | $10.000 | $15.000 |"), "output row spans both tiers");
        assert.ok(info.tooltip.includes("| **100** | **Blended** | **$0.819** |"), "weighted total row");
        assert.ok(!info.tooltip.includes("up to 272,000 prompt tokens:"), "the old bullet price list is gone");
    });

    const STEPPED: ModelCatalogEntry = {
        id: "openai/gpt-5.6",
        context_length: 1050000,
        pricing: {
            prompt: "0.00000125",
            completion: "0.00001",
            overrides: [{ min_prompt_tokens: 272000, prompt: "0.0000025", completion: "0.000015" }],
        },
    };

    test("context size options list each step and the whole window as prompt budgets", () => {
        const options = contextCapOptions(STEPPED);
        assert.deepStrictEqual(options.map((o) => o.value), ["272000", "full"]);
        assert.deepStrictEqual(options.map((o) => o.label), ["272K", "919K"]);
        assert.strictEqual(options[0].description, "Default recommended context size", "the default step reads like Copilot's");
        assert.strictEqual(options[1].description, "Longer sessions", "larger sizes read like Copilot's");
        const none = contextCapOptions({ id: "x/y" });
        assert.deepStrictEqual(none.map((o) => o.value), ["full"]);
        assert.strictEqual(none[0].label, "1.05M");
    });

    test("steps and saved choices are bounded by the effective prompt budget", () => {
        const bounded: ModelCatalogEntry = {
            id: "x-ai/grok-4.5",
            context_length: 300_000,
            pricing: {
                prompt: "0.0000002",
                completion: "0.0000006",
                overrides: [{ min_prompt_tokens: 200000, prompt: "0.0000004", completion: "0.0000012" }],
            },
            top_provider: { max_completion_tokens: 140_000 },
        };
        assert.strictEqual(
            effectiveMaxInputTokens(bounded, { overrideTokens: 200000 }),
            160000,
            "a saved step is clamped to window minus reserve"
        );
        assert.deepStrictEqual(contextCapOptions(bounded).map((o) => o.value), ["full"], "a step above the budget is not offered");
        assert.strictEqual(contextCapOptions(bounded)[0].label, "160K");
        assert.strictEqual(defaultContextCap(bounded), "full", "no reachable step defaults to the whole window");
        const schema = buildContextCapSchema(bounded, 200000)!.properties.contextSize as Record<string, unknown>;
        assert.deepStrictEqual(schema.enum, ["full"], "a stale saved step is not in the menu");
        assert.strictEqual(schema.default, "full", "a stale saved step falls back to the full budget");
    });

    test("a small step carries a stop sign and a tight step a warning", () => {
        const small: ModelCatalogEntry = {
            id: "qwen/qwen3.7-flash",
            context_length: 1_000_000,
            top_provider: { max_completion_tokens: 16000 },
            pricing: {
                prompt: "0.0000005",
                overrides: [{ min_prompt_tokens: 32000, prompt: "0.0000008", completion: "0.0000016" }],
            },
        };
        const options = contextCapOptions(small);
        assert.strictEqual(options[0].value, "32000");
        assert.strictEqual(options[0].label, "\u26d4 32K", "an unusable prompt budget gets a stop sign");
        assert.match(options[0].description ?? "", /Too small/);
        const last = options[options.length - 1];
        assert.strictEqual(last.value, "full");
        assert.strictEqual(last.label, "984K");
        assert.strictEqual(last.description, "Default recommended context size", "the fallback default is the full window");

        const tight: ModelCatalogEntry = {
            id: "q/tight",
            context_length: 1_000_000,
            top_provider: { max_completion_tokens: 16000 },
            pricing: { prompt: "0.0000005", overrides: [{ min_prompt_tokens: 100000, prompt: "0.0000008" }] },
        };
        assert.strictEqual(contextCapOptions(tight)[0].label, "\u26a0\ufe0f 100K", "a tight budget gets a warning");
    });

    test("the default picker step is the one closest to 256K at or above a 196K floor", () => {
        assert.strictEqual(defaultContextCap(STEPPED), 272000);
        const twoTiers: ModelCatalogEntry = {
            id: "qwen/qwen3.7-flash",
            context_length: 1_000_000,
            pricing: {
                prompt: "0.0000005",
                overrides: [
                    { min_prompt_tokens: 32000, prompt: "0.0000008" },
                    { min_prompt_tokens: 256000, prompt: "0.0000014" },
                ],
            },
        };
        assert.strictEqual(defaultContextCap(twoTiers), 256000, "the small step is skipped");
        const atFloor: ModelCatalogEntry = {
            id: "q/at-floor",
            context_length: 1_000_000,
            pricing: {
                prompt: "0.0000005",
                overrides: [
                    { min_prompt_tokens: 196000, prompt: "0.0000008" },
                    { min_prompt_tokens: 400000, prompt: "0.0000014" },
                ],
            },
        };
        assert.strictEqual(defaultContextCap(atFloor), 196000, "a step exactly at the floor qualifies");
        const tinyOnly: ModelCatalogEntry = {
            id: "q/tiny",
            context_length: 1_000_000,
            pricing: { prompt: "0.0000005", overrides: [{ min_prompt_tokens: 32000, prompt: "0.0000008" }] },
        };
        assert.strictEqual(defaultContextCap(tinyOnly), "full", "a step below the 196K floor is never the default");
        assert.strictEqual(defaultContextCap({ id: "x/y" }), "full", "a model with no step has no default cap");
    });

    test("context size selection and picker parsing round-trip a saved size", () => {
        assert.strictEqual(contextCapSelection(undefined), "full");
        assert.strictEqual(contextCapSelection("full"), "full");
        assert.strictEqual(contextCapSelection(272000), "272000");
        assert.strictEqual(contextCapFromPicker(undefined), undefined);
        assert.strictEqual(contextCapFromPicker("full"), "full");
        assert.strictEqual(contextCapFromPicker("272000"), 272000);
        assert.strictEqual(contextCapFromPicker(200000), 200000);
        assert.strictEqual(contextCapFromPicker("nonsense"), undefined);
        assert.strictEqual(contextCapFromPicker("-5"), undefined);
    });

    test("the context size schema is offered only for stepped models and reflects the saved size", () => {
        assert.strictEqual(buildContextCapSchema({ id: "x/y", pricing: { prompt: "0.000001" } }), undefined);
        const defaulted = buildContextCapSchema(STEPPED)!.properties.contextSize as Record<string, unknown>;
        assert.deepStrictEqual(defaulted.enum, ["272000", "full"]);
        assert.strictEqual(defaulted.default, "272000", "an unchosen model defaults to the closest step to 256K");
        assert.strictEqual(defaulted.title, "Context size");
        assert.strictEqual(defaulted.group, "tokens");
        const schema = buildContextCapSchema(STEPPED, "full")!.properties.contextSize as Record<string, unknown>;
        assert.strictEqual(schema.default, "full");
        const step = buildContextCapSchema(STEPPED, 272000)!.properties.contextSize as Record<string, unknown>;
        assert.strictEqual(step.default, "272000");
        const retired = buildContextCapSchema(STEPPED, 200000)!.properties.contextSize as Record<string, unknown>;
        assert.deepStrictEqual(retired.enum, ["272000", "full"]);
        assert.strictEqual(retired.default, "272000", "a retired Custom value falls back to the default step");
    });

    test("tool calling follows the live supported_parameters array", () => {
        assert.strictEqual(
            supportsToolCalling({ id: "a/tools", supported_parameters: ["tools", "temperature"] }),
            true
        );
        assert.strictEqual(
            supportsToolCalling({ id: "a/no-tools", supported_parameters: ["temperature"] }),
            false
        );
        const noTools = buildModelInfo({
            id: "a/no-tools",
            supported_parameters: ["temperature"],
            architecture: { input_modalities: ["text"] },
        });
        assert.ok(noTools.tooltip.includes("Tools: \u2717"), "a model without 'tools' is marked tool-less");
    });

    test("tool calling falls back to the legacy boolean when supported_parameters is absent", () => {
        assert.strictEqual(supportsToolCalling({ id: "a/legacy-yes", supports_tool_parameters: true }), true);
        assert.strictEqual(supportsToolCalling({ id: "a/legacy-no", supports_tool_parameters: false }), false);
        assert.strictEqual(supportsToolCalling({ id: "a/unknown" }), true, "absence means assume capable");
    });

    test("buildReasoningSchema emits a navigation-grouped Thinking Effort property", () => {
        const m: ModelCatalogEntry = {
            id: "deepseek/deepseek-v4-flash-0731",
            reasoning: { mandatory: false, supported_efforts: ["max", "high", "low"], default_effort: "high" },
        };
        const schema = buildReasoningSchema(m);
        assert.ok(schema, "schema present when supported_efforts exist");
        const property = schema!.properties["reasoningEffort"] as Record<string, unknown>;
        assert.strictEqual(property["group"], "navigation", "navigation group shows the picker submenu");
        assert.strictEqual(property["title"], "Thinking Effort");
        assert.deepStrictEqual(property["enum"], ["max", "high", "low", "none"], "none appended so reasoning can be turned off");
        assert.deepStrictEqual(property["enumItemLabels"], ["Max", "High", "Low", "None"]);
        assert.strictEqual(property["default"], "high", "model default_effort wins when supported");
    });

    test("buildReasoningSchema does not append 'none' for mandatory reasoning with listed efforts", () => {
        const m: ModelCatalogEntry = {
            id: "qwen/qwen3.8-max",
            reasoning: { mandatory: true, supported_efforts: ["xhigh", "high", "medium", "low", "minimal"], default_effort: "xhigh" },
        };
        const schema = buildReasoningSchema(m);
        assert.ok(schema);
        const property = schema!.properties["reasoningEffort"] as Record<string, unknown>;
        assert.deepStrictEqual(property["enum"], ["xhigh", "high", "medium", "low", "minimal"]);
        assert.strictEqual(property["default"], "xhigh");
    });

    test("buildReasoningSchema falls back to the first effort and omits models without reasoning", () => {
        const noDefault: ModelCatalogEntry = { id: "x/y", reasoning: { mandatory: false, supported_efforts: ["low"] } };
        const schema = buildReasoningSchema(noDefault);
        assert.strictEqual((schema!.properties["reasoningEffort"] as Record<string, unknown>)["default"], "low");
        assert.strictEqual(buildReasoningSchema({ id: "x/y" }), undefined);
    });

    test("buildReasoningSchema emits a None/Enabled submenu when supported_efforts is omitted", () => {
        const schema = buildReasoningSchema({ id: "qwen/qwen3.8-flash", reasoning: { mandatory: false, default_enabled: true } });
        assert.ok(schema, "reasoning object present without supported_efforts still gets a selector");
        const property = schema!.properties["reasoningEnabled"] as Record<string, unknown>;
        assert.strictEqual(property["type"], "string");
        assert.strictEqual(property["title"], "Reasoning");
        assert.strictEqual(property["group"], "navigation");
        assert.deepStrictEqual(property["enum"], ["none", "enabled"]);
        assert.deepStrictEqual(property["enumItemLabels"], ["None", "Enabled"]);
        assert.strictEqual(property["default"], "enabled", "default_enabled true -> Enabled");
    });

    test("buildReasoningSchema defaults the None/Enabled submenu to None when default_enabled is false", () => {
        const schema = buildReasoningSchema({ id: "x/y", reasoning: { default_enabled: false } });
        assert.ok(schema);
        const property = schema!.properties["reasoningEnabled"] as Record<string, unknown>;
        assert.strictEqual(property["default"], "none");
    });

    test("buildReasoningSchema omits the selector for mandatory reasoning without efforts", () => {
        assert.strictEqual(buildReasoningSchema({ id: "deepseek/deepseek-r1", reasoning: { mandatory: true } }), undefined);
    });

    test("null supported_efforts accepts the full effort set at the OpenRouter default (medium)", () => {
        const schema = buildReasoningSchema({ id: "x/y", reasoning: { supported_efforts: null } });
        assert.ok(schema);
        const property = schema!.properties["reasoningEffort"] as Record<string, unknown>;
        assert.deepStrictEqual(property["enum"], ["max", "xhigh", "high", "medium", "low", "minimal", "none"]);
        assert.strictEqual(property["default"], "medium");
    });

    test("null supported_efforts honors default_effort when present", () => {
        const schema = buildReasoningSchema({ id: "x/y", reasoning: { supported_efforts: null, default_effort: "low" } });
        assert.ok(schema);
        const property = schema!.properties["reasoningEffort"] as Record<string, unknown>;
        assert.deepStrictEqual(property["enum"], ["max", "xhigh", "high", "medium", "low", "minimal", "none"]);
        assert.strictEqual(property["default"], "low");
    });

    test("null supported_efforts with default_enabled false pre-selects none", () => {
        const model: ModelCatalogEntry = { id: "x/y", reasoning: { supported_efforts: null, default_enabled: false } };
        const property = buildReasoningSchema(model)!.properties["reasoningEffort"] as Record<string, unknown>;
        assert.strictEqual(property["default"], "none", "off by default until the user turns reasoning on");
        assert.ok(
            buildModelInfo(model).tooltip.includes("**None**/Max/"),
            "the tooltip summary bolds the same off default"
        );
    });

    test("null supported_efforts with mandatory reasoning ignores default_enabled false", () => {
        const schema = buildReasoningSchema({
            id: "x/y",
            reasoning: { supported_efforts: null, default_enabled: false, mandatory: true },
        });
        assert.ok(schema);
        const property = schema!.properties["reasoningEffort"] as Record<string, unknown>;
        assert.deepStrictEqual(property["enum"], ["max", "xhigh", "high", "medium", "low", "minimal"]);
        assert.strictEqual(property["default"], "medium", "mandatory reasoning cannot default to none");
    });

    test("null supported_efforts with mandatory reasoning drops 'none'", () => {
        const schema = buildReasoningSchema({ id: "x/y", reasoning: { supported_efforts: null, mandatory: true } });
        assert.ok(schema);
        const property = schema!.properties["reasoningEffort"] as Record<string, unknown>;
        assert.deepStrictEqual(property["enum"], ["max", "xhigh", "high", "medium", "low", "minimal"]);
        assert.strictEqual(property["default"], "medium");
    });

    test("enabledFromModelConfiguration maps the None/Enabled pick to a boolean", () => {
        assert.strictEqual(enabledFromModelConfiguration({ reasoningEnabled: "enabled" }), true);
        assert.strictEqual(enabledFromModelConfiguration({ reasoningEnabled: "none" }), false);
        assert.strictEqual(enabledFromModelConfiguration({ reasoningEnabled: "high" }), undefined);
        assert.strictEqual(enabledFromModelConfiguration(undefined), undefined);
        assert.strictEqual(enabledFromModelConfiguration({}), undefined);
    });

    test("effortFromModelConfiguration extracts the reasoning effort the user picked", () => {
        assert.strictEqual(effortFromModelConfiguration({ reasoningEffort: "high" }), "high");
        assert.strictEqual(effortFromModelConfiguration({ reasoningEffort: "" }), undefined);
        assert.strictEqual(effortFromModelConfiguration(undefined), undefined);
        assert.strictEqual(effortFromModelConfiguration({}), undefined);
    });
});
