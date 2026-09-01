import * as assert from "assert";
import {
    buildModelInfo,
    buildReasoningSchema,
    effortFromModelConfiguration,
    enabledFromModelConfiguration,
    formatPerM,
    formatPricePerM,
    formatUsd,
    parsePrice,
    type ModelCatalogEntry,
} from "../../modelInfo";

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
                input_cache_write_1h: "0.00001",
            },
        };
        const info = buildModelInfo(m);
        assert.match(info.tooltip, /^\*\*~ \$2\.450 /);
        assert.ok(info.tooltip.includes("- cache read: $0.500"), "cache-read row");
        assert.ok(info.tooltip.includes("- cache write: $6.250"), "cache-write row");
        assert.ok(info.tooltip.includes("- uncached: $5.000"), "uncached priced at prompt");
        assert.ok(!info.tooltip.includes("$10"), "1h ephemeral price no longer used");
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
        assert.ok(info.tooltip.includes("1,310,720 tokens"), "context listed");
        assert.ok(info.tooltip.includes("943,718 tokens"), "max output read from top_provider");
        assert.ok(info.tooltip.includes("tool calling"));
        assert.ok(info.tooltip.includes("text-only"));
        assert.ok(info.tooltip.includes("Reasoning: optional (supported: low, high, max, none; default: high)"));
        assert.strictEqual(info.maxInputTokens, 1310720);
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
