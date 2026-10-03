import * as assert from "assert";
import {
    buildModelInfo,
    buildReasoningSchema,
    effectiveMaxInputTokens,
    effortFromModelConfiguration,
    enabledFromModelConfiguration,
    formatPerM,
    formatPricePerM,
    formatUsd,
    longContextTier,
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

    test("reports context minus output, capped at the tier on auto", () => {
        assert.strictEqual(effectiveMaxInputTokens(OPENAI_LONG_CONTEXT), 272000);
    });

    test("full policy reports the whole input budget", () => {
        assert.strictEqual(effectiveMaxInputTokens(OPENAI_LONG_CONTEXT, { policy: "full" }), 922000);
    });

    test("a saved per-model Custom cap wins over policy", () => {
        assert.strictEqual(effectiveMaxInputTokens(OPENAI_LONG_CONTEXT, { overrideTokens: 200000 }), 200000);
        assert.strictEqual(
            effectiveMaxInputTokens(OPENAI_LONG_CONTEXT, { policy: "full", overrideTokens: 180000 }),
            180000
        );
    });

    test("a model without a tier reports its accurate input budget", () => {
        const info = buildModelInfo({ id: "x/y", context_length: 131072, top_provider: { max_completion_tokens: 16384 } });
        assert.strictEqual(info.maxInputTokens, 114688);
    });

    test("the auto cap is described as a cap and marked on the detail line", () => {
        const info = buildModelInfo(OPENAI_LONG_CONTEXT);
        assert.ok(
            info.tooltip.includes("Input capped at 272,000 tokens to stay in the base tier"),
            "the cap in effect is stated"
        );
        assert.ok(!info.tooltip.includes("Full window in use"), "not described as the full window");
        assert.match(info.detail ?? "", / \u00b7 \u2264272K$/, "cap marker on the detail line");
    });

    test("full policy states the rate boundary instead of a cap", () => {
        const info = buildModelInfo(OPENAI_LONG_CONTEXT, { policy: "full" });
        assert.ok(
            info.tooltip.includes(
                "Full window in use \u2014 above 272,000 prompt tokens the long-context rate applies."
            )
        );
        assert.ok(!info.tooltip.includes("Input capped at"));
        assert.ok(!(info.detail ?? "").includes("\u2264"));
    });

    test("a Custom cap above the threshold states the boundary without claiming the full window", () => {
        const info = buildModelInfo(OPENAI_LONG_CONTEXT, { overrideTokens: 500000 });
        assert.ok(info.tooltip.includes("- Above 272,000 prompt tokens the long-context rate applies."));
        assert.ok(!info.tooltip.includes("Full window in use"));
        assert.ok(!(info.detail ?? "").includes("\u2264"));
    });

    test("a budget already below the threshold says the step is out of reach", () => {
        const m: ModelCatalogEntry = {
            id: "x-ai/grok-4.5",
            context_length: 500_000,
            pricing: {
                prompt: "0.0000002",
                completion: "0.0000006",
                overrides: [{ min_prompt_tokens: 200000, prompt: "0.0000004", completion: "0.0000012" }],
            },
            top_provider: { max_completion_tokens: 450_000 },
        };
        const info = buildModelInfo(m);
        assert.strictEqual(info.maxInputTokens, 50_000);
        assert.ok(
            info.tooltip.includes(
                "The long-context rate starts above 200,000 prompt tokens, past this model's reported 50,000-token input budget."
            )
        );
        assert.ok(!info.tooltip.includes("Input capped at"));
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

    test("formatUsd keeps small estimates readable", () => {
        assert.strictEqual(formatUsd(0), "$0.00");
        assert.strictEqual(formatUsd(0.00022), "$0.00022");
        assert.strictEqual(formatUsd(0.0123), "$0.0123");
        assert.strictEqual(formatUsd(1.5), "$1.50");
    });

    test("blended estimate reproduces the worked example (DeepSeek V4 Flash)", () => {
        const m: ModelCatalogEntry = {
            id: "deepseek/deepseek-v4-flash-0731",
            pricing: { prompt: "0.000000045", completion: "0.00000009", input_cache_read: "0.000000009" },
        };
        const info = buildModelInfo(m);
        assert.match(info.tooltip, /^\*\*~ \$0\.017 /);
        assert.ok(info.tooltip.includes("per answer token: 3 uncached · 6 cache write · 85 cache read · 5 thinking · 1 output"));
        assert.ok(info.tooltip.includes("- cache read: $0.009"), "cache-read row");
        assert.ok(info.tooltip.includes("- cache write: $0.045"), "cache-write falls back to input");
        assert.ok(info.tooltip.includes("- uncached: $0.045"), "uncached falls back to input");
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
        assert.match(info.tooltip, /^\*\*~ \$2\.450 /);
        assert.ok(info.tooltip.includes("- cache read: $0.500"), "cache-read row");
        assert.ok(info.tooltip.includes("- cache write: $6.250"), "cache-write row");
        assert.ok(info.tooltip.includes("- uncached: $5.000"), "uncached priced at prompt");
        assert.ok(!info.tooltip.includes("$10"), "1h ephemeral price no longer used");
    });

    test("explicitly free models show a $0 estimate instead of the not-listed fallback", () => {
        const m: ModelCatalogEntry = {
            id: "deepseek/deepseek-v4-flash:free",
            pricing: { prompt: "0", completion: "0", input_cache_read: "0", input_cache_write: "0" },
        };
        const info = buildModelInfo(m);
        assert.match(info.tooltip, /^\*\*~ \$0\.000 \/ 1M tokens \(est\.\)\*\*/);
        assert.strictEqual(info.detail, "~$0.000/1M");
        assert.ok(!info.tooltip.includes("not listed by OpenRouter"));
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
        assert.match(info.tooltip, /^\*\*~ \$0\.314 /);
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
        assert.ok(info.tooltip.includes("1,310,720 tokens"), "context window listed");
        assert.ok(info.tooltip.includes("367,002 tokens"), "input budget is context minus output");
        assert.ok(info.tooltip.includes("943,718 tokens"), "max output read from top_provider");
        assert.ok(info.tooltip.includes("tool calling"));
        assert.ok(info.tooltip.includes("text-only"));
        assert.ok(info.tooltip.includes("Reasoning: optional (supported: low, high, max, none; default: high)"));
        assert.strictEqual(info.maxInputTokens, 367002, "input budget = context minus max output");
        assert.strictEqual(info.maxOutputTokens, 943718);
    });

    test("missing pricing yields a friendly fallback", () => {
        const info = buildModelInfo({ id: "x/y" });
        assert.strictEqual(info.detail, undefined);
        assert.ok(info.tooltip.includes("Pricing: not listed by OpenRouter"));
        assert.ok(info.tooltip.includes("Max input context: not listed (assuming 1,048,576 tokens)"), "unknown context emphasized");
        assert.ok(info.tooltip.includes("Max output context: not listed (assuming 16,384 tokens)"), "unknown max output emphasized");
        assert.strictEqual(info.maxInputTokens, 1048576);
        assert.strictEqual(info.maxOutputTokens, 16384);
    });

    test("tooltip is block-level markdown without trailing-space hard breaks", () => {
        const m: ModelCatalogEntry = {
            id: "x/y",
            pricing: { prompt: "0.000000065", completion: "0.00000018" },
        };
        const info = buildModelInfo(m);
        assert.match(info.tooltip, /^\*\*~ \$0\.072 \/ 1M tokens \(est\.\)\*\*/);
        assert.ok(!info.tooltip.includes("  \n"), "no markdown hard breaks");
        assert.ok(info.tooltip.includes("\n\n"), "blocks separated by blank lines");
        assert.ok(info.tooltip.includes("**Pricing per 1M tokens**"), "pricing heading");
        const lines = info.tooltip.split("\n");
        assert.ok(lines.some((l) => l.startsWith("Max input context:")), "context line present");
        assert.ok(lines.some((l) => l.startsWith("Max output context:")), "max output line present");
        assert.ok(lines.some((l) => l.startsWith("Capabilities:")), "capabilities line present");
        assert.ok(lines.some((l) => l.startsWith("- uncached:")), "uncached row is a bullet");
    });

    test("reasoning is required when marked mandatory", () => {
        const m: ModelCatalogEntry = { id: "x/y", reasoning: { mandatory: true } };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("Reasoning: required"));
    });

    test("reasoning shows just the default when no supported efforts are listed", () => {
        const m: ModelCatalogEntry = { id: "x/y", reasoning: { mandatory: false, default_effort: "medium" } };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("Reasoning: optional (default: medium)"));
    });

    test("vision models report image input", () => {
        const m: ModelCatalogEntry = {
            id: "o/vision",
            supports_tool_parameters: false,
            architecture: { input_modalities: ["text", "image"] },
        };
        const info = buildModelInfo(m);
        assert.ok(info.tooltip.includes("image input"));
        assert.ok(info.tooltip.includes("no tool calling"));
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
        assert.ok(noTools.tooltip.includes("no tool calling"), "a model without 'tools' is marked text-tool-less");
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
