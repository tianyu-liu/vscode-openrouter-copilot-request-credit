import * as assert from "assert";
import * as vscode from "vscode";
import {
    accumulateSessionCost,
    baseUrl,
    buildRequestBody,
    buildUsagePart,
    flattenReasoningDetails,
    getLastStreamProvider,
    getLastStreamUsage,
    getSessionCost,
    getSessionCosts,
    hydrateSessionCosts,
    MAX_TRACKED_SESSIONS,
    resetParentAttributionForTesting,
    resetSessionCostsForTesting,
    resolveCostSession,
    mapResponseError,
    mapStreamedError,
    onTurnCost,
    OpenRouterChatProvider,
    sessionIdFor,
    setPostTimeoutForTesting,
    setRetryDelayForTesting,
    stripTemplateComments,
    toOpenAI,
    turnCostOf,
    routeCostCells,
    TurnCost,
} from "../../provider";

const runtimeThinkingPartCtor = (vscode as any).LanguageModelThinkingPart as
    | (new (value: string | string[]) => { value: string | string[] })
    | undefined;

function msg(
    role: vscode.LanguageModelChatMessageRole,
    content: readonly unknown[]
): vscode.LanguageModelChatRequestMessage {
    return { role, content } as unknown as vscode.LanguageModelChatRequestMessage;
}

function fakeSecrets(stored: string): vscode.SecretStorage {
    let value: string | undefined = stored;
    return {
        get: async () => value,
        store: async (_key: string, v: string) => {
            value = v;
        },
        delete: async () => {
            value = undefined;
        },
    } as unknown as vscode.SecretStorage;
}

function fakeState(initial: Record<string, unknown> = {}): vscode.Memento {
    const store: Record<string, unknown> = { ...initial };
    return {
        keys: () => Object.keys(store),
        get: <T>(key: string) => (key in store ? (store[key] as T) : undefined),
        update: async (key: string, value: unknown) => {
            store[key] = value;
        },
        setKeysForSync: () => {
        },
    } as unknown as vscode.Memento;
}

suite("toOpenAI", () => {
    test("text-only messages map to plain user/assistant strings", () => {
        const out = toOpenAI([
            msg(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart("hello")]),
            msg(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelTextPart("hi there")]),
        ]);
        assert.deepStrictEqual(out, [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi there" },
        ]);
    });

    test("empty assistant messages are skipped (never content: [])", () => {
        const out = toOpenAI([msg(vscode.LanguageModelChatMessageRole.Assistant, [])]);
        assert.deepStrictEqual(out, []);
    });

    test("empty-string text parts are dropped, never sent as content", () => {
        const out = toOpenAI([
            msg(vscode.LanguageModelChatMessageRole.Assistant, [new vscode.LanguageModelTextPart("")]),
        ]);
        assert.deepStrictEqual(out, []);
    });

    test("assistant tool calls with no text use content: null", () => {
        const out = toOpenAI([
            msg(vscode.LanguageModelChatMessageRole.Assistant, [
                new vscode.LanguageModelToolCallPart("call_1", "get_weather", { location: "Tokyo" }),
            ]),
        ]);
        assert.deepStrictEqual(out, [
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: "call_1",
                        type: "function",
                        function: { name: "get_weather", arguments: '{"location":"Tokyo"}' },
                    },
                ],
            },
        ]);
    });

    test("assistant tool calls with text keep the text", () => {
        const out = toOpenAI([
            msg(vscode.LanguageModelChatMessageRole.Assistant, [
                new vscode.LanguageModelTextPart("I'll check the weather."),
                new vscode.LanguageModelToolCallPart("call_1", "get_weather", {}),
            ]),
        ]);
        assert.strictEqual((out[0] as { content: string }).content, "I'll check the weather.");
        assert.ok(Array.isArray((out[0] as { tool_calls: unknown[] }).tool_calls));
    });

    test("tool results become standalone role:'tool' messages", () => {
        const out = toOpenAI([
            msg(vscode.LanguageModelChatMessageRole.User, [
                new vscode.LanguageModelToolResultPart("call_1", [new vscode.LanguageModelTextPart("Sunny, 22C")]),
            ]),
        ]);
        assert.deepStrictEqual(out, [{ role: "tool", tool_call_id: "call_1", content: "Sunny, 22C" }]);
    });

    test("user text plus a tool result emits the tool message and keeps the text in a user message", () => {
        const out = toOpenAI([
            msg(vscode.LanguageModelChatMessageRole.User, [
                new vscode.LanguageModelToolResultPart("call_1", ["23C"]),
                new vscode.LanguageModelTextPart("What about tomorrow?"),
            ]),
        ]);
        assert.deepStrictEqual(out, [
            { role: "tool", tool_call_id: "call_1", content: "23C" },
            { role: "user", content: "What about tomorrow?" },
        ]);
    });

    test("image data parts are sent as data-URL image_url content", () => {
        const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        const out = toOpenAI([
            msg(vscode.LanguageModelChatMessageRole.User, [vscode.LanguageModelDataPart.image(image, "image/png")]),
        ]);
        const content = (out[0] as { content: Array<{ type: string; image_url: { url: string } }> }).content;
        assert.ok(Array.isArray(content));
        assert.strictEqual(content[0].type, "image_url");
        assert.strictEqual(content[0].image_url.url, "data:image/png;base64,iVBORw==");
    });

    test("mixed text and image content uses multipart objects for every item", () => {
        const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        const out = toOpenAI([
            msg(vscode.LanguageModelChatMessageRole.User, [
                new vscode.LanguageModelTextPart("Describe this image."),
                vscode.LanguageModelDataPart.image(image, "image/png"),
            ]),
        ]);
        assert.deepStrictEqual((out[0] as { content: unknown[] }).content, [
            { type: "text", text: "Describe this image." },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw==" } },
        ]);
    });

    test("assistant thinking parts are echoed back as reasoning on the outgoing message", function () {
        if (!runtimeThinkingPartCtor) {
            this.skip();
        }
        const out = toOpenAI([
            msg(vscode.LanguageModelChatMessageRole.Assistant, [
                new (runtimeThinkingPartCtor as any)("internal chain"),
                new vscode.LanguageModelTextPart("answer text"),
            ]),
        ]);
        assert.strictEqual((out[0] as { reasoning: string }).reasoning, "internal chain");
        assert.strictEqual((out[0] as { content: string }).content, "answer text");
    });

    test("thinking-only assistant messages emit reasoning with content: null", function () {
        if (!runtimeThinkingPartCtor) {
            this.skip();
        }
        const out = toOpenAI([
            msg(vscode.LanguageModelChatMessageRole.Assistant, [new (runtimeThinkingPartCtor as any)("chain")]),
        ]);
        assert.strictEqual(out.length, 1);
        assert.strictEqual((out[0] as { reasoning: string }).reasoning, "chain");
        assert.strictEqual((out[0] as { content: unknown }).content, null);
    });

    test("thinking part string arrays are joined into reasoning", function () {
        if (!runtimeThinkingPartCtor) {
            this.skip();
        }
        const out = toOpenAI([
            msg(vscode.LanguageModelChatMessageRole.Assistant, [
                new (runtimeThinkingPartCtor as any)(["a", "b"]),
                new vscode.LanguageModelTextPart("done"),
            ]),
        ]);
        assert.strictEqual((out[0] as { reasoning: string }).reasoning, "a\nb");
    });
});

suite("buildRequestBody", () => {
    test("template reasoning keys survive a picker effort selection", () => {
        const body = buildRequestBody(
            { reasoning: { max_tokens: 8000, exclude: false } },
            "m",
            [],
            undefined,
            { reasoningEffort: "high" }
        );
        assert.deepStrictEqual(body.reasoning, { max_tokens: 8000, exclude: false, effort: "high" });
    });

    test("picker effort/enabled overwrite only their own reasoning keys", () => {
        const body = buildRequestBody(
            { reasoning: { max_tokens: 8000, effort: "low" } },
            "m",
            [],
            undefined,
            { reasoningEffort: "high", reasoningEnabled: "none" }
        );
        assert.deepStrictEqual(body.reasoning, { max_tokens: 8000, effort: "high", enabled: false });
    });

    test("a non-object template reasoning does not corrupt the body with a flattened key object", () => {
        const body = buildRequestBody(
            { reasoning: "high" },
            "m",
            [],
            undefined,
            { reasoningEffort: "medium" }
        );
        assert.deepStrictEqual(body.reasoning, { effort: "medium" });
    });

    test("adds no default provider object when the template has none", () => {
        const body = buildRequestBody({}, "m", [], undefined, undefined);
        assert.ok(!("provider" in body));
    });

    test("a template provider object is sent verbatim (no defaults merged)", () => {
        const body = buildRequestBody(
            { provider: { order: ["deepinfra"], allow_fallbacks: false } },
            "m",
            [],
            undefined,
            undefined
        );
        assert.deepStrictEqual(body.provider, { order: ["deepinfra"], allow_fallbacks: false });
    });

    test("a template provider.quantizations list is sent verbatim", () => {
        const body = buildRequestBody({ provider: { quantizations: ["fp8"] } }, "m", [], undefined, undefined);
        assert.deepStrictEqual(body.provider, { quantizations: ["fp8"] });
    });

    test("an explicit sessionId is sent verbatim", () => {
        const body = buildRequestBody({}, "m", [], undefined, undefined, undefined, "copilot-chat:abc-123");
        assert.strictEqual(body.session_id, "copilot-chat:abc-123");
    });

    test("strips template model/messages/tools and forces stream", () => {
        const body = buildRequestBody(
            { model: "other/model", messages: [{ role: "user", content: "old" }], tools: [], temperature: 0.2 },
            "live/model",
            [{ role: "user", content: "new" }],
            undefined,
            undefined
        );
        assert.strictEqual(body.model, "live/model");
        assert.deepStrictEqual(body.messages, [{ role: "user", content: "new" }]);
        assert.strictEqual(body.stream, true);
        assert.ok(!("session_id" in body), "no session_id without a known parent");
        assert.strictEqual(body.temperature, 0.2);
        assert.strictEqual(body.tools, undefined);
    });

    test("a pasted template session_id is dropped when there is no derived one", () => {
        const body = buildRequestBody({ session_id: "pasted" }, "m", [], undefined, undefined);
        assert.ok(!("session_id" in body), "the enforced rule wins even with no derived id");
    });

    test("anthropic-family models get a top-level ephemeral cache_control", () => {
        const body = buildRequestBody({}, "anthropic/claude-sonnet-4.5", [{ role: "user", content: "hi" }], undefined, undefined);
        assert.deepStrictEqual(body.cache_control, { type: "ephemeral" });
        assert.deepStrictEqual(body.messages, [{ role: "user", content: "hi" }]);
        assert.strictEqual(body.model, "anthropic/claude-sonnet-4.5");
    });

    test("~anthropic aliases and first-segment variants get the same treatment", () => {
        const alias = buildRequestBody({}, "~anthropic/claude-sonnet-latest", [], undefined, undefined);
        assert.deepStrictEqual(alias.cache_control, { type: "ephemeral" });
        const pinned = buildRequestBody({}, "anthropic/claude-opus-5", [], undefined, undefined);
        assert.deepStrictEqual(pinned.cache_control, { type: "ephemeral" });
    });

    test("a template cache_control wins over the anthropic auto ephemeral", () => {
        const body = buildRequestBody(
            { cache_control: { type: "ephemeral", ttl: "1h" } },
            "anthropic/claude-sonnet-4.5",
            [],
            undefined,
            undefined
        );
        assert.deepStrictEqual(body.cache_control, { type: "ephemeral", ttl: "1h" });
    });

    test("a template cache_control: null opts out of the anthropic auto caching", () => {
        const body = buildRequestBody({ cache_control: null }, "anthropic/claude-sonnet-4.5", [], undefined, undefined);
        assert.deepStrictEqual(body.cache_control, null);
    });

    test("a picker effort of none maps to reasoning.enabled false, not effort none", () => {
        const body = buildRequestBody({}, "m", [], undefined, { reasoningEffort: "none" });
        assert.deepStrictEqual(body.reasoning, { enabled: false });
        const listed = buildRequestBody({ reasoning: { exclude: true } }, "m", [], undefined, { reasoningEffort: "high" });
        assert.deepStrictEqual(listed.reasoning, { exclude: true, effort: "high" });
    });

    test("picker effort none drops a contradictory template effort without mutating the template", () => {
        const template = { reasoning: { effort: "high", max_tokens: 5 } };
        const body = buildRequestBody(template, "m", [], undefined, { reasoningEffort: "none" });
        assert.deepStrictEqual(body.reasoning, { max_tokens: 5, enabled: false });
        assert.ok(!("effort" in (body.reasoning as Record<string, unknown>)), "no contradictory effort survives");
        assert.deepStrictEqual(
            template,
            { reasoning: { effort: "high", max_tokens: 5 } },
            "the saved template object is never mutated"
        );
    });

    test("non-Anthropic models never get an auto cache_control", () => {
        for (const id of ["deepseek/deepseek-v4-flash-0731", "openai/gpt-5.6-luna", "qwen/qwen3-coder-plus", "google/gemini-3.7-flash", "m"]) {
            const body = buildRequestBody({}, id, [], undefined, undefined);
            assert.ok(!("cache_control" in body), `${id} must not auto-cache`);
        }
    });
});

suite("buildRequestBody preset references", () => {
    test("a @preset/ model gets no default provider object so the preset routing survives", () => {
        const body = buildRequestBody({}, "@preset/faster-glm-flash", [], undefined, undefined);
        assert.ok(!("provider" in body), "no provider object injected for preset references");
        assert.strictEqual(body.model, "@preset/faster-glm-flash");
        assert.strictEqual(body.stream, true);
        assert.ok(!("session_id" in body), "no session_id without a known parent");
    });

    test("the combined model@preset/slug form is treated as a preset reference too", () => {
        const body = buildRequestBody(
            {},
            "z-ai/glm-5.3-flash-20260826@preset/faster-glm-flash",
            [],
            undefined,
            undefined
        );
        assert.ok(!("provider" in body));
    });

    test("a template provider is sent verbatim for preset references", () => {
        const body = buildRequestBody(
            { provider: { order: ["baseten"], allow_fallbacks: true } },
            "@preset/faster-glm-flash",
            [],
            undefined,
            undefined
        );
        assert.deepStrictEqual(body.provider, { order: ["baseten"], allow_fallbacks: true });
    });

    test("a preset entry whose designated model is Anthropic gets the auto cache_control", () => {
        const body = buildRequestBody({}, "@preset/claude-fast", [], undefined, undefined, "anthropic/claude-sonnet-4.5");
        assert.deepStrictEqual(body.cache_control, { type: "ephemeral" });
        const nonAnthropic = buildRequestBody({}, "@preset/faster-glm-flash", [], undefined, undefined, "z-ai/glm-5.3-flash");
        assert.ok(!("cache_control" in nonAnthropic), "non-Anthropic designated models stay uncached");
        const resolved = buildRequestBody({}, "@preset/claude-fast", [], undefined, undefined);
        assert.ok(!("cache_control" in resolved), "no cache_control when the designated model is unknown");
    });

    test("a template preset reference is dropped when the picker entry is itself a preset (picker wins)", () => {
        const body = buildRequestBody(
            { preset: "other-preset", temperature: 0.2 },
            "@preset/faster-glm-flash",
            [],
            undefined,
            undefined
        );
        assert.ok(!("preset" in body), "the picker entry is the preset reference; a different template preset is dropped");
        assert.strictEqual(body.model, "@preset/faster-glm-flash");
        assert.strictEqual(body.temperature, 0.2, "other template fields still apply over the preset config");
        const combined = buildRequestBody(
            { preset: "other-preset" },
            "z-ai/glm-5.3-flash-20260826@preset/faster-glm-flash",
            [],
            undefined,
            undefined
        );
        assert.ok(!("preset" in combined), "the combined model@preset/slug form drops the template preset too");
    });

    test("a template preset reference survives for non-preset models (panel-dropdown form)", () => {
        const body = buildRequestBody({ preset: "faster-glm-flash" }, "deepseek/deepseek-v4-flash", [], undefined, undefined);
        assert.strictEqual(body.preset, "faster-glm-flash");
        assert.strictEqual(body.model, "deepseek/deepseek-v4-flash");
    });
});

suite("picker preset isolation", () => {
    test("with an empty custom request, a preset build leaves nothing behind for non-preset builds", () => {
        const presetBody = buildRequestBody(undefined, "@preset/faster-glm-flash", [], undefined, undefined, "z-ai/glm-5.3-flash");
        assert.strictEqual(presetBody.model, "@preset/faster-glm-flash");
        assert.ok(!("provider" in presetBody));
        assert.ok(!("preset" in presetBody));
        const plainBody = buildRequestBody(undefined, "deepseek/deepseek-v4-flash", [], undefined, undefined);
        assert.strictEqual(plainBody.model, "deepseek/deepseek-v4-flash");
        assert.ok(!("preset" in plainBody), "no preset key leaks into the non-preset request");
        assert.ok(!("provider" in plainBody), "no provider object leaks into the non-preset request");
        assert.ok(!("cache_control" in plainBody), "the preset's cache decision does not leak into the non-preset request");
        assert.deepStrictEqual(
            Object.keys(plainBody).sort(),
            ["messages", "model", "stream", "tools"],
            "the empty-template non-preset body carries only the enforced fields"
        );
    });

    test("a preset build never mutates the shared template object", () => {
        const template = { preset: "other-preset", reasoning: { max_tokens: 8000 }, provider: { order: ["baseten"] } };
        const snapshot = JSON.parse(JSON.stringify(template));
        buildRequestBody(template, "@preset/faster-glm-flash", [], undefined, { reasoningEffort: "high" });
        assert.deepStrictEqual(template, snapshot, "the template object is untouched by the preset build");
        const plainBody = buildRequestBody(template, "m", [], undefined, undefined);
        assert.strictEqual(plainBody.preset, "other-preset");
        assert.deepStrictEqual(plainBody.reasoning, { max_tokens: 8000 });
        assert.deepStrictEqual(plainBody.provider, { order: ["baseten"] });
    });
});

suite("flattenReasoningDetails", () => {
    test("maps reasoning/summary details to thinking and response details to text", () => {
        const { thinking, text } = flattenReasoningDetails([
            { type: "reasoning", text: "step 1" },
            { type: "reasoning.summary", summary: "summarized" },
            { type: "response.output_text", output_text: "visible" },
            { type: "response.text", text: "also visible" },
        ]);
        assert.strictEqual(thinking, "step 1\nsummarized");
        assert.strictEqual(text, "visible\nalso visible");
    });

    test("returns empty strings for non-array input and skips junk entries", () => {
        assert.deepStrictEqual(flattenReasoningDetails(undefined), { thinking: "", text: "" });
        assert.deepStrictEqual(flattenReasoningDetails("nope"), { thinking: "", text: "" });
        assert.deepStrictEqual(
            flattenReasoningDetails([null, "junk", { type: "summary", summary: "ok" }]),
            { thinking: "ok", text: "" }
        );
    });
});

suite("sessionIdFor", () => {
    test("namespaces a Copilot conversation id so one chat session is one OpenRouter session", () => {
        assert.strictEqual(sessionIdFor("9f1c4a2e-0d1b-4c33-9a77-2f4b6d8e0a11"), "copilot-chat:9f1c4a2e-0d1b-4c33-9a77-2f4b6d8e0a11");
    });

    test("is stable for the same conversation id and distinct across conversations", () => {
        assert.strictEqual(sessionIdFor("session-a"), sessionIdFor("session-a"));
        assert.notStrictEqual(sessionIdFor("session-a"), sessionIdFor("session-b"));
    });

    test("returns the per-window id when no conversation id is supplied", () => {
        const fallback = sessionIdFor(undefined);
        assert.strictEqual(fallback, sessionIdFor(null));
        assert.strictEqual(fallback, sessionIdFor(""));
        assert.strictEqual(fallback, sessionIdFor("   "));
        assert.strictEqual(fallback, sessionIdFor(42));
        assert.ok(!fallback.startsWith("copilot-chat:"), "the fallback is not namespaced");
    });

    test("buildRequestBody omits session_id unless one is supplied", () => {
        assert.ok(!("session_id" in buildRequestBody({}, "m", [], undefined, undefined)));
        assert.ok(!("session_id" in buildRequestBody({}, "m", [], undefined, undefined, undefined, "")));
        assert.strictEqual(
            buildRequestBody({}, "m", [], undefined, undefined, undefined, "copilot-chat:x").session_id,
            "copilot-chat:x"
        );
    });

    test("stays within OpenRouter's 256 character session_id limit", () => {
        const sessionId = sessionIdFor("x".repeat(400));
        assert.strictEqual(sessionId.length, 256);
        assert.ok(sessionId.startsWith("copilot-chat:"));
    });
});

suite("buildUsagePart", () => {
    test("maps OpenRouter usage to the payload Copilot consumes", () => {
        assert.deepStrictEqual(
            buildUsagePart({
                prompt_tokens: 194,
                completion_tokens: 2,
                total_tokens: 196,
                prompt_tokens_details: { cached_tokens: 12, cache_write_tokens: 3 },
                cost: 0.95,
            }),
            {
                prompt_tokens: 194,
                completion_tokens: 2,
                total_tokens: 196,
                prompt_tokens_details: { cached_tokens: 12, cache_write_tokens: 3 },
                copilot_usage: { total_nano_aiu: 950_000_000 },
            }
        );
    });

    test("omits the credit slot when OpenRouter reports no cost", () => {
        const part = buildUsagePart({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
        assert.ok(part);
        assert.ok(!("copilot_usage" in part), "no cost means no credit figure");
        assert.deepStrictEqual(part.prompt_tokens_details, { cached_tokens: 0 });
    });

    test("a zero cost (the BYOK case) carries no credit figure at all", () => {
        const part = buildUsagePart({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 });
        assert.ok(part, "tokens are still reported");
        assert.ok(!("copilot_usage" in part), "a zero charge must not surface as a 0.0 credit figure");
    });

    test("requires the three token counters and clamps negatives", () => {
        assert.strictEqual(buildUsagePart(undefined), undefined);
        assert.strictEqual(buildUsagePart(null), undefined);
        assert.strictEqual(buildUsagePart("nope"), undefined);
        assert.strictEqual(buildUsagePart([]), undefined);
        assert.strictEqual(buildUsagePart({ prompt_tokens: 1, completion_tokens: 1 }), undefined);
        assert.strictEqual(buildUsagePart({ prompt_tokens: 1, total_tokens: 2 }), undefined);
        assert.deepStrictEqual(
            buildUsagePart({
                prompt_tokens: -1,
                completion_tokens: -1,
                total_tokens: -1,
                prompt_tokens_details: { cached_tokens: -5 },
                cost: -0.5,
            }),
            {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
                prompt_tokens_details: { cached_tokens: 0 },
            }
        );
    });

    test("drops a non-numeric prompt_tokens_details.cached_tokens", () => {
        const part = buildUsagePart({
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
            prompt_tokens_details: { cached_tokens: "many" },
        });
        assert.deepStrictEqual(part?.prompt_tokens_details, { cached_tokens: 0 });
    });
});

suite("turnCostOf", () => {
    // Shape captured verbatim from a live Fireworks BYOK turn.
    const BYOK_USAGE = {
        prompt_tokens: 37,
        completion_tokens: 8,
        total_tokens: 45,
        cost: 0,
        is_byok: true,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        cost_details: {
            upstream_inference_cost: 1.342e-5,
            upstream_inference_prompt_cost: 8.14e-6,
            upstream_inference_completions_cost: 5.28e-6,
        },
    };

    test("a BYOK turn reports the upstream cost, not OpenRouter's zero", () => {
        const cost = turnCostOf(BYOK_USAGE, "Fireworks");
        assert.ok(cost);
        assert.strictEqual(cost!.openRouter, 0, "OpenRouter charges nothing on a BYOK route");
        assert.strictEqual(cost!.upstream, 1.342e-5, "the upstream cost is the payable figure");
        assert.strictEqual(cost!.isByok, true);
        assert.strictEqual(cost!.provider, "Fireworks");
        assert.strictEqual(cost!.promptTokens, 37);
        assert.strictEqual(cost!.completionTokens, 8);
    });

    test("a shared-pool turn reports OpenRouter's cost and no upstream figure", () => {
        const cost = turnCostOf(
            { prompt_tokens: 194, completion_tokens: 2, total_tokens: 196, cost: 0.0000291, cost_details: { upstream_inference_cost: 0 } },
            "Morph"
        );
        assert.ok(cost);
        assert.strictEqual(cost!.openRouter, 0.0000291);
        assert.strictEqual(cost!.upstream, undefined, "a zero upstream figure is not payable");
        assert.strictEqual(cost!.isByok, false);
        assert.strictEqual(cost!.provider, "Morph");
    });

    test("is_byok is inferred when only an upstream cost is present", () => {
        const cost = turnCostOf({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0, cost_details: { upstream_inference_cost: 0.001 } });
        assert.strictEqual(cost?.isByok, true);
        assert.strictEqual(cost?.upstream, 0.001);
    });

    test("a negative upstream figure is ignored rather than reported", () => {
        const cost = turnCostOf({ prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0, cost_details: { upstream_inference_cost: -5 } });
        assert.strictEqual(cost, undefined);
    });

    test("no payable cost anywhere reports nothing", () => {
        assert.strictEqual(turnCostOf({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, "X"), undefined);
        assert.strictEqual(turnCostOf({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0 }, "X"), undefined);
        assert.strictEqual(turnCostOf({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10, cost: 0, cost_details: { upstream_inference_cost: 0 } }, "X"), undefined);
        assert.strictEqual(turnCostOf(undefined, "X"), undefined);
        assert.strictEqual(turnCostOf([], "X"), undefined);
    });

    test("cache token counts are carried through", () => {
        const cost = turnCostOf(
            {
                prompt_tokens: 1000,
                completion_tokens: 12,
                total_tokens: 1012,
                cost: 0.002,
                prompt_tokens_details: { cached_tokens: 900 },
            },
            "DeepInfra"
        );
        assert.strictEqual(cost?.cachedTokens, 900);
    });

    test("missing or bogus cache fields fall back to zero, never NaN", () => {
        const noDetails = turnCostOf({ prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: 0.001 }, "X");
        assert.strictEqual(noDetails?.cachedTokens, 0);
        const junk = turnCostOf(
            { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: 0.001, prompt_tokens_details: { cached_tokens: "many" } },
            "X"
        );
        assert.strictEqual(junk?.cachedTokens, 0);
    });
});

suite("resolveCostSession", () => {
    const CHAT = "copilot-chat:9ad83b3e-bc0a-470c-ab01-5e4f110d455a";

    setup(() => {
        resetParentAttributionForTesting();
    });

    test("a chat turn becomes the current session", () => {
        assert.strictEqual(resolveCostSession(CHAT, true), CHAT);
    });

    test("an internal call is attributed to the chat that triggered it", () => {
        resolveCostSession(CHAT, true);
        assert.strictEqual(
            resolveCostSession("3f2a9c11-0000-4000-8000-000000000001", false),
            CHAT,
            "a sub-agent call folds into its parent chat, not a session of its own"
        );
    });

    test("a later chat turn moves the attribution target", () => {
        const second = "copilot-chat:11111111-2222-3333-4444-555555555555";
        resolveCostSession(CHAT, true);
        resolveCostSession(second, true);
        assert.strictEqual(resolveCostSession("unused", false), second, "the newest chat wins");
    });

    test("an internal call long after the last turn is not attributed", () => {
        const t0 = 1_000_000;
        resolveCostSession(CHAT, true, t0);
        assert.strictEqual(resolveCostSession("x", false, t0 + 60_000), CHAT, "within the window");
        assert.strictEqual(
            resolveCostSession("x", false, t0 + 11 * 60 * 1000),
            undefined,
            "a stale attribution is dropped rather than blamed on an old chat"
        );
    });

    test("with no chat yet, an internal call is dropped", () => {
        assert.strictEqual(resolveCostSession("x", false), undefined);
    });
});

suite("error mapping", () => {
    test("401/402/429/other produce friendly messages", () => {
        assert.match(mapResponseError(401, "{}").message, /invalid or expired/);
        assert.match(mapResponseError(402, "{}").message, /credits/);
        assert.match(mapResponseError(429, "{}").message, /rate limited/);
        assert.match(mapResponseError(503, "boom").message, /503/);
        assert.match(mapResponseError(503, "boom").message, /boom/);
    });

    test("generation id is appended when present", () => {
        assert.match(mapResponseError(500, "x", "gen-42").message, /gen-42/);
    });

    test("streamed errors include message, code and provider", () => {
        const err = mapStreamedError({
            error: { message: "Field required", code: "server_error", metadata: { provider_name: "deepinfra" } },
        });
        assert.ok(err);
        assert.match(err!.message, /Field required/);
        assert.match(err!.message, /server_error/);
        assert.match(err!.message, /deepinfra/);
    });

    test("non-error payloads return undefined", () => {
        assert.strictEqual(mapStreamedError({ choices: [] }), undefined);
        assert.strictEqual(mapStreamedError(undefined), undefined);
        assert.strictEqual(mapStreamedError(null), undefined);
    });
});

suite("baseUrl", () => {
    test("strips a trailing /chat/completions and trailing slashes", async () => {
        const cfg = vscode.workspace.getConfiguration("openrouterCopilot");
        const original = cfg.get<string>("baseUrl");
        try {
            await cfg.update(
                "baseUrl",
                "https://openrouter.ai/api/v1/chat/completions/",
                vscode.ConfigurationTarget.Global
            );
            assert.strictEqual(baseUrl(), "https://openrouter.ai/api/v1");
            await cfg.update("baseUrl", "https://proxy.example.com/v1", vscode.ConfigurationTarget.Global);
            assert.strictEqual(baseUrl(), "https://proxy.example.com/v1");
        } finally {
            await cfg.update("baseUrl", original, vscode.ConfigurationTarget.Global);
        }
    });

    test("falls back to the default for non-https or unparsable values", async () => {
        const cfg = vscode.workspace.getConfiguration("openrouterCopilot");
        const original = cfg.get<string>("baseUrl");
        const warning = vscode.window.showWarningMessage;
        let warnings = 0;
        (vscode.window as { showWarningMessage: unknown }).showWarningMessage = (() => {
            warnings++;
            return Promise.resolve(undefined);
        }) as typeof warning;
        try {
            await cfg.update("baseUrl", "http://insecure.example.com", vscode.ConfigurationTarget.Global);
            assert.strictEqual(baseUrl(), "https://openrouter.ai/api/v1");
            await cfg.update("baseUrl", "not a url", vscode.ConfigurationTarget.Global);
            assert.strictEqual(baseUrl(), "https://openrouter.ai/api/v1");
            assert.ok(warnings > 0, "a non-https baseUrl warns");
        } finally {
            (vscode.window as { showWarningMessage: unknown }).showWarningMessage = warning;
            await cfg.update("baseUrl", original, vscode.ConfigurationTarget.Global);
            baseUrl();
        }
    });
});

suite("provideLanguageModelChatResponse (stubbed stream)", () => {
    let originalFetch: typeof fetch;
    let nextResponses: Array<Response | (() => Response)>;
    let fetchCalls: Array<{ url: string; init?: RequestInit }>;
    let reported: unknown[];
    let progress: vscode.Progress<unknown>;

    const model = { id: "deepseek/deepseek-v4-flash-0731" } as unknown as vscode.LanguageModelChatInformation;
    const options = { tools: undefined, modelConfiguration: undefined } as unknown as vscode.ProvideLanguageModelChatResponseOptions;
    const token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => { } }),
    } as unknown as vscode.CancellationToken;

    function streamResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
        return new Response(body, {
            status,
            headers: { "content-type": "text/event-stream", ...headers },
        });
    }

    function sseBody(chunks: unknown[]): string {
        return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
    }

    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    function controlledSse(): {
        response: Response;
        push: (chunk: string) => void;
        close: () => void;
    } {
        const encoder = new TextEncoder();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
            },
        });
        return {
            response: new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
            push: (chunk: string) => controller.enqueue(encoder.encode(chunk)),
            close: () => controller.close(),
        };
    }

    suiteSetup(() => {
        originalFetch = globalThis.fetch;
        setRetryDelayForTesting(async () => { });
        globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
            fetchCalls.push({ url: String(input), init });
            const next = nextResponses.shift();
            if (!next) {
                throw new Error(`unexpected fetch: ${String(input)}`);
            }
            return typeof next === "function" ? next() : next;
        }) as typeof fetch;
    });

    suiteTeardown(() => {
        globalThis.fetch = originalFetch;
        setRetryDelayForTesting((ms) => new Promise((r) => setTimeout(r, ms)));
    });

    setup(() => {
        nextResponses = [];
        fetchCalls = [];
        reported = [];
        progress = { report: (p: unknown) => { reported.push(p); } };
    });

    async function run(): Promise<void> {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        await provider.provideLanguageModelChatResponse(model, [], options, progress as never, token as never);
    }

    async function runWith(requestOptions: unknown, provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState())): Promise<void> {
        await provider.provideLanguageModelChatResponse(model, [], requestOptions as never, progress as never, token as never);
    }

    function sentBody(index: number): Record<string, unknown> {
        const call = fetchCalls[index];
        assert.ok(call, `expected fetch call ${index}`);
        return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
    }

    function thinkingReported(): unknown[] {
        return runtimeThinkingPartCtor ? reported.filter((p) => p instanceof runtimeThinkingPartCtor) : [];
    }

    function textReported(): unknown[] {
        return reported.filter((p) => p instanceof vscode.LanguageModelTextPart);
    }

    function costLines(): string[] {
        return textReported()
            .map((p) => String((p as { value: string }).value))
            .filter((v) => /^\n\n\$[0-9]/.test(v));
    }

    function usageChunk(provider: string, prompt: number, completion: number, upstream: number, cached = 0) {
        return {
            provider,
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: {
                prompt_tokens: prompt,
                completion_tokens: completion,
                total_tokens: prompt + completion,
                cost: 0,
                is_byok: true,
                prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: 0 },
                cost_details: { upstream_inference_cost: upstream },
            },
        };
    }

    function usageParts(): vscode.LanguageModelDataPart[] {
        return reported.filter(
            (p): p is vscode.LanguageModelDataPart =>
                p instanceof vscode.LanguageModelDataPart && p.mimeType === "usage"
        );
    }

    function usagePayload(index = 0): Record<string, unknown> {
        const parts = usageParts();
        assert.strictEqual(parts.length, 1, "exactly one usage part per turn");
        return JSON.parse(new TextDecoder().decode(parts[index].data));
    }

    test("a request carrying the Copilot conversation id sends it as session_id", async () => {
        const okBody = () => sseBody([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 1 } }]);
        nextResponses.push(() => streamResponse(okBody()), () => streamResponse(okBody()));
        const options = { tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: "conv-42" } };
        await runWith(options);
        await runWith(options);
        assert.strictEqual(sentBody(0).session_id, "copilot-chat:conv-42");
        assert.strictEqual(sentBody(1).session_id, "copilot-chat:conv-42", "both turns share one OpenRouter session");
    });

    test("a fresh extension host keeps the same session_id for a restored conversation (window reload)", async () => {
        const okBody = sseBody([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 1 } }]);
        nextResponses.push(() => streamResponse(okBody), () => streamResponse(okBody));
        const conversationId = "3d1c9b0e-7c55-4a1f-9c22-8ab6f0d5e777";
        // Two separate providers stand in for the extension host before and after a reload.
        await runWith({ tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: conversationId } });
        const afterReload = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        await runWith(
            { tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: conversationId } },
            afterReload
        );
        assert.strictEqual(sentBody(0).session_id, sentBody(1).session_id);
    });

    test("a request with no known parent sends no session_id at all", async () => {
        // No chat has been seen yet, so there is no parent to inherit.
        resetParentAttributionForTesting();
        const okBody = sseBody([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 1 } }]);
        nextResponses.push(() => streamResponse(okBody), () => streamResponse(okBody));
        await runWith({ tools: undefined, modelConfiguration: undefined });
        await runWith({ tools: undefined, modelConfiguration: undefined, modelOptions: {} });
        assert.ok(!("session_id" in sentBody(0)), "an unattributed call never mints an orphan session");
        assert.ok(!("session_id" in sentBody(1)), "nor does a later one");
    });

    test("the last chat survives a reload so an internal call still joins its parent", async () => {
        resetParentAttributionForTesting();
        const state = fakeState();
        const okBody = () => sseBody([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 1 } }]);
        nextResponses.push(() => streamResponse(okBody()), () => streamResponse(okBody()));
        await runWith(
            { tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: "reload-parent" } },
            new OpenRouterChatProvider(fakeSecrets("sk-test"), state)
        );
        // A new provider instance stands in for the extension host after a reload,
        // sharing the same persisted state.
        const afterReload = new OpenRouterChatProvider(fakeSecrets("sk-test"), state);
        await runWith({ tools: undefined, modelConfiguration: undefined, modelOptions: {} }, afterReload);
        assert.strictEqual(
            sentBody(1).session_id,
            "copilot-chat:reload-parent",
            "the internal call rejoins its parent's OpenRouter session"
        );
    });

    test("with no chat before a reload, an internal call still sends no session_id", async () => {
        resetParentAttributionForTesting();
        const state = fakeState();
        const okBody = sseBody([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 1 } }]);
        nextResponses.push(() => streamResponse(okBody));
        const afterReload = new OpenRouterChatProvider(fakeSecrets("sk-test"), state);
        await runWith({ tools: undefined, modelConfiguration: undefined, modelOptions: {} }, afterReload);
        assert.ok(!("session_id" in sentBody(0)), "no orphan session is minted across a reload");
    });

    test("an internal call inherits the parent chat's session_id, not the window one", async () => {
        resetParentAttributionForTesting();
        const okBody = () => sseBody([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 1 } }]);
        nextResponses.push(() => streamResponse(okBody()), () => streamResponse(okBody()));
        await runWith({ tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: "parent-chat" } });
        // A sub-agent call: Copilot sends no `_conversationId`.
        await runWith({ tools: undefined, modelConfiguration: undefined, modelOptions: {} });
        assert.strictEqual(sentBody(0).session_id, "copilot-chat:parent-chat");
        assert.strictEqual(
            sentBody(1).session_id,
            "copilot-chat:parent-chat",
            "the internal call joins its parent's OpenRouter session instead of a separate one"
        );
    });

    test("a pasted template session_id never overrides the derived one", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        const okBody = sseBody([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 1 } }]);
        nextResponses.push(() => streamResponse(okBody));
        await provider.setTemplate('{ "session_id": "pasted", "temperature": 0.2 }');
        await runWith({ tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: "conv-1" } }, provider);
        assert.strictEqual(sentBody(0).session_id, "copilot-chat:conv-1");
        assert.strictEqual(sentBody(0).temperature, 0.2);
    });

    test("emits the turn cost with provider attribution and a portable payload", async () => {
        const events: TurnCost[] = [];
        const sub = onTurnCost((c) => events.push(c));
        try {
            const body = sseBody([
                { provider: "Fireworks", choices: [{ delta: { content: "hi" } }] },
                {
                    provider: "Fireworks",
                    choices: [{ delta: {}, finish_reason: "stop" }],
                    usage: {
                        prompt_tokens: 37,
                        completion_tokens: 8,
                        total_tokens: 45,
                        cost: 0,
                        is_byok: true,
                        prompt_tokens_details: { cached_tokens: 0 },
                        cost_details: { upstream_inference_cost: 1.342e-5 },
                    },
                },
            ]);
            nextResponses.push(() => streamResponse(body));
            await run();
            assert.strictEqual(events.length, 1, "one cost event per turn");
            assert.strictEqual(events[0].openRouter, 0);
            assert.strictEqual(events[0].upstream, 1.342e-5);
            assert.strictEqual(events[0].provider, "Fireworks", "the serving provider is captured from the stream");
            assert.strictEqual(getLastStreamProvider(), "Fireworks");
            // The usage part still goes to Copilot, but with no bogus credit slot for a $0 turn.
            assert.ok(!("copilot_usage" in usagePayload()), "OpenRouter charged nothing, so no credit figure");
        } finally {
            sub.dispose();
        }
    });

    test("a shared-pool turn emits OpenRouter's cost, not the upstream one", async () => {
        const events: TurnCost[] = [];
        const sub = onTurnCost((c) => events.push(c));
        try {
            const body = sseBody([
                {
                    provider: "Morph",
                    choices: [{ delta: {}, finish_reason: "stop" }],
                    usage: {
                        prompt_tokens: 194,
                        completion_tokens: 2,
                        total_tokens: 196,
                        cost: 0.0000291,
                        cost_details: { upstream_inference_cost: 0 },
                    },
                },
            ]);
            nextResponses.push(() => streamResponse(body));
            await run();
            assert.strictEqual(events.length, 1);
            assert.strictEqual(events[0].openRouter, 0.0000291);
            assert.strictEqual(events[0].upstream, undefined);
            assert.strictEqual(events[0].isByok, false);
            assert.strictEqual(events[0].provider, "Morph");
            assert.deepStrictEqual(usagePayload().copilot_usage, { total_nano_aiu: 29100 });
        } finally {
            sub.dispose();
        }
    });

    test("a turn with no cost data emits no cost event and resets the provider per request", async () => {
        const events: TurnCost[] = [];
        const sub = onTurnCost((c) => events.push(c));
        try {
            const withProvider = sseBody([
                { provider: "Fireworks", choices: [{ delta: { content: "a" } }] },
                { provider: "Fireworks", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0, cost_details: { upstream_inference_cost: 1e-6 } } },
            ]);
            nextResponses.push(() => streamResponse(withProvider));
            await run();
            assert.strictEqual(events.length, 1);

            const noCost = sseBody([
                { choices: [{ delta: { content: "b" } }] },
                { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
            ]);
            nextResponses.push(() => streamResponse(noCost));
            await run();
            assert.strictEqual(events.length, 1, "a turn with no payable cost emits nothing");
            assert.strictEqual(getLastStreamProvider(), undefined, "the provider is reset per request");
        } finally {
            sub.dispose();
        }
    });

    test("reports text and reasoning parts and tolerates the automatic usage chunk", async () => {
        const body = sseBody([
            { choices: [{ delta: { reasoning: "thinking hard" } }] },
            { choices: [{ delta: { content: "Hi there" } }] },
            {
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 50, completion_tokens: 73, total_tokens: 123 },
            },
        ]);
        nextResponses.push(() => streamResponse(body));
        await run();
        assert.deepStrictEqual(
            textReported().map((p) => (p as { value: string }).value),
            ["Hi there"]
        );
        assert.strictEqual(thinkingReported().length, 1, "reasoning reported as a thinking part");
        if (runtimeThinkingPartCtor) {
            assert.strictEqual((thinkingReported()[0] as { value: string }).value, "thinking hard");
        }
        assert.deepStrictEqual(getLastStreamUsage(), {
            prompt_tokens: 50,
            completion_tokens: 73,
            total_tokens: 123,
        });
    });

    test("tolerates a usage-only chunk with no content delta (P5 regression)", async () => {
        const body = sseBody([
            {
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            },
        ]);
        nextResponses.push(() => streamResponse(body));
        await run();
        assert.deepStrictEqual(textReported(), [], "no text parts for a usage-only chunk");
        assert.deepStrictEqual(getLastStreamUsage(), {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
        });
        assert.deepStrictEqual(usagePayload(), {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
            prompt_tokens_details: { cached_tokens: 0 },
        });
    });

    test("captures a usage chunk that carries an empty choices array", async () => {
        const body = sseBody([
            { choices: [{ delta: { content: "hi" } }] },
            {
                choices: [],
                usage: {
                    prompt_tokens: 11,
                    completion_tokens: 22,
                    total_tokens: 33,
                    prompt_tokens_details: { cached_tokens: 7 },
                    cost: 0.0042,
                },
            },
        ]);
        nextResponses.push(() => streamResponse(body));
        await run();
        assert.deepStrictEqual(usagePayload(), {
            prompt_tokens: 11,
            completion_tokens: 22,
            total_tokens: 33,
            prompt_tokens_details: { cached_tokens: 7 },
            copilot_usage: { total_nano_aiu: 4_200_000 },
        });
    });

    test("appends no cost line to the response any more (moved to the panel)", async () => {
        const body = sseBody([
            { provider: "Fireworks", choices: [{ delta: { content: "done" } }] },
            usageChunk("Fireworks", 41821, 12, 0.00308, 41200),
        ]);
        nextResponses.push(() => streamResponse(body));
        await run();
        assert.deepStrictEqual(costLines(), [], "the chat text carries no cost footer");
        assert.deepStrictEqual(
            textReported().map((p) => (p as { value: string }).value),
            ["done"],
            "only the model's own text"
        );
    });

    test("accumulates a tool-using turn across its separate model calls", async () => {
        // Copilot drives a tool-using turn as one call per tool round, so the same
        // session id arrives twice. Both must land in one session total.
        const opts = { tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: "conv-agg" } };
        const first = sseBody([
            { provider: "Fireworks", choices: [{ delta: { content: "calling" } }] },
            usageChunk("Fireworks", 1000, 50, 0.001, 900),
        ]);
        const second = sseBody([
            { provider: "Fireworks", choices: [{ delta: { content: "answer" } }] },
            usageChunk("Fireworks", 2000, 20, 0.002, 1900),
        ]);
        nextResponses.push(() => streamResponse(first), () => streamResponse(second));
        await runWith(opts);
        await runWith(opts);

        const session = getSessionCost("copilot-chat:conv-agg");
        assert.ok(session, "the session was tracked");
        assert.strictEqual(session!.calls, 2, "both model calls counted");
        assert.strictEqual(session!.paid, 0.003, "the two calls are summed");
        assert.strictEqual(session!.promptTokens, 3000);
        assert.strictEqual(session!.completionTokens, 70);
        assert.strictEqual(session!.cachedTokens, 2800);
    });

    test("keeps separate sessions apart and splits routes by provider and model", async () => {
        const a = { tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: "conv-a" } };
        const b = { tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: "conv-b" } };
        const byok = sseBody([{ provider: "Fireworks", choices: [{ delta: { content: "x" } }] }, usageChunk("Fireworks", 100, 5, 0.001, 0)]);
        const shared = sseBody([
            { provider: "Morph", choices: [{ delta: { content: "y" } }] },
            { provider: "Morph", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: 0.0005, prompt_tokens_details: { cached_tokens: 0 } } },
        ]);
        nextResponses.push(() => streamResponse(byok), () => streamResponse(shared), () => streamResponse(byok));
        await runWith(a);
        await runWith(a);
        await runWith(b);

        const sessionA = getSessionCost("copilot-chat:conv-a")!;
        const sessionB = getSessionCost("copilot-chat:conv-b")!;
        assert.strictEqual(sessionA.calls, 2);
        assert.strictEqual(sessionA.routes.length, 2, "a session can mix providers");
        assert.ok(sessionA.paid > sessionB.paid, "session B holds only the cheaper turn");
        assert.strictEqual(sessionB.calls, 1);
        // The mixed session must separate BYOK from OpenRouter spend.
        assert.ok(sessionA.byok, "the session used a BYOK route at some point");
        assert.ok(sessionA.openRouter > 0, "and an OpenRouter-charged route");
        assert.ok(sessionA.upstream > 0);
    });

    test("an internal call with no conversation id folds into the parent chat", async () => {
        resetSessionCostsForTesting();
        resetParentAttributionForTesting();
        const chat = { tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: "parent-chat" } };
        // What a sub-agent call looks like to a provider: no `_conversationId`.
        const subagent = { tools: undefined, modelConfiguration: undefined, modelOptions: {} };
        const body = sseBody([{ provider: "Fireworks", choices: [{ delta: { content: "x" } }] }, usageChunk("Fireworks", 100, 5, 0.001, 0)]);
        nextResponses.push(() => streamResponse(body), () => streamResponse(body));
        await runWith(chat);
        await runWith(subagent);

        const sessions = getSessionCosts();
        assert.strictEqual(sessions.length, 1, "no separate entry for the internal call");
        assert.strictEqual(sessions[0].sessionId, "copilot-chat:parent-chat");
        assert.strictEqual(sessions[0].calls, 2, "both calls counted on the parent");
        assert.strictEqual(sessions[0].paid, 0.002, "and both costs");
    });

    test("a call with no payable cost adds nothing to the session", async () => {
        const opts = { tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: "conv-free" } };
        const noCost = sseBody([
            { choices: [{ delta: { content: "hi" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
        ]);
        nextResponses.push(() => streamResponse(noCost));
        await runWith(opts);
        assert.strictEqual(getSessionCost("copilot-chat:conv-free"), undefined, "nothing is tracked for a costless turn");
    });

    test("getSessionCost returns a snapshot that cannot mutate the live session", () => {
        resetSessionCostsForTesting();
        accumulateSessionCost(
            "copilot-chat:snap",
            { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.001, prompt_tokens_details: { cached_tokens: 0 } },
            "Morph",
            "m"
        );
        const first = getSessionCost("copilot-chat:snap")!;
        first.routes.length = 0;
        first.paid = 999;
        const second = getSessionCost("copilot-chat:snap")!;
        assert.strictEqual(second.routes.length, 1, "clearing the returned routes array leaves the live one intact");
        assert.notStrictEqual(second.paid, 999, "writing the returned total does not reach the live session");
    });

    test("keeps only the 10 most recent sessions, newest first", async () => {
        resetSessionCostsForTesting();
        const paid = { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: 0, is_byok: true, prompt_tokens_details: { cached_tokens: 0 }, cost_details: { upstream_inference_cost: 0.001 } };
        for (let i = 1; i <= 15; i++) {
            accumulateSessionCost(`copilot-chat:s${i}`, paid, "Fireworks", "m");
        }
        const ids = getSessionCosts().map((s) => s.sessionId.replace("copilot-chat:", ""));
        assert.strictEqual(ids.length, MAX_TRACKED_SESSIONS, "the cap is enforced");
        assert.deepStrictEqual(ids, ["s15", "s14", "s13", "s12", "s11", "s10", "s9", "s8", "s7", "s6"]);
        assert.ok(!ids.includes("s1") && !ids.includes("s5"), "the oldest are the ones dropped");
    });

    test("the cap still keeps the newest when sessions share a millisecond", () => {
        resetSessionCostsForTesting();
        const paid = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0, is_byok: true, prompt_tokens_details: { cached_tokens: 0 }, cost_details: { upstream_inference_cost: 0.001 } };
        // Regression guard: with equal Date.now() values the ordering must still be
        // total, otherwise eviction keeps stale sessions and drops fresh ones.
        for (let i = 1; i <= 12; i++) {
            accumulateSessionCost(`copilot-chat:t${i}`, paid, "Fireworks", "m");
        }
        const ids = getSessionCosts().map((s) => s.sessionId);
        assert.ok(ids.includes("copilot-chat:t12"), "the newest survives");
        assert.ok(!ids.includes("copilot-chat:t1"), "the oldest is evicted");
    });

    test("hydration restores persisted sessions and later calls add to them", () => {
        resetSessionCostsForTesting();
        hydrateSessionCosts([
            { sessionId: "copilot-chat:restored", paid: 0.5, openRouter: 0.5, upstream: 0, promptTokens: 100, completionTokens: 10, cachedTokens: 0, calls: 2, byok: false, updatedAt: 1, routes: [] },
        ]);
        const restored = getSessionCost("copilot-chat:restored");
        assert.ok(restored, "the persisted session is back");
        assert.strictEqual(restored!.paid, 0.5);
        assert.strictEqual(restored!.calls, 2);
        accumulateSessionCost(
            "copilot-chat:restored",
            { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.25, prompt_tokens_details: { cached_tokens: 0 } },
            "Morph",
            "m"
        );
        assert.strictEqual(getSessionCost("copilot-chat:restored")!.paid, 0.75, "spend continues onto the restored total");
    });

    test("hydration ignores junk persisted entries", () => {
        resetSessionCostsForTesting();
        hydrateSessionCosts([
            null as never,
            { sessionId: "copilot-chat:ok", paid: 0.1, openRouter: 0.1, upstream: 0, promptTokens: 1, completionTokens: 1, cachedTokens: 0, calls: 1, byok: false, updatedAt: 1, routes: [] },
            { sessionId: 42 as never, paid: 0.1 } as never,
            { sessionId: "copilot-chat:bad", paid: Number.NaN } as never,
        ]);
        assert.deepStrictEqual(getSessionCosts().map((s) => s.sessionId), ["copilot-chat:ok"]);
    });

    test("hydration drops legacy entries for unidentified calls", () => {
        resetSessionCostsForTesting();
        hydrateSessionCosts([
            // A bare per-window UUID as an earlier revision persisted it.
            { sessionId: "e21ba4ca-bfcd-40f5-a5c5-02f19cd4a98d", paid: 0.0005, openRouter: 0, upstream: 0.0005, promptTokens: 1, completionTokens: 1, cachedTokens: 0, calls: 2, byok: true, updatedAt: 1, routes: [] },
            { sessionId: "copilot-chat:real", paid: 0.25, openRouter: 0, upstream: 0.25, promptTokens: 1, completionTokens: 1, cachedTokens: 0, calls: 3, byok: true, updatedAt: 2, routes: [] },
        ]);
        assert.deepStrictEqual(
            getSessionCosts().map((s) => s.sessionId),
            ["copilot-chat:real"],
            "stray non-chat entries are cleaned up on load"
        );
    });

    test("a costless turn appends nothing and tracks nothing", async () => {
        const body = sseBody([
            { choices: [{ delta: { content: "text only" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } },
        ]);
        nextResponses.push(() => streamResponse(body));
        await run();
        assert.deepStrictEqual(costLines(), [], "a costless turn appends nothing");
        assert.deepStrictEqual(
            textReported().map((p) => (p as { value: string }).value),
            ["text only"]
        );
    });

    test("a turn cancelled before any output appends neither a usage part nor a cost line", async () => {
        const body = sseBody([
            { provider: "Fireworks", choices: [{ delta: { content: "partial" } }] },
            {
                provider: "Fireworks",
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0, cost_details: { upstream_inference_cost: 1e-5 } },
            },
        ]);
        const cancelledToken = {
            isCancellationRequested: true,
            onCancellationRequested: () => ({ dispose: () => { } }),
        } as unknown as vscode.CancellationToken;
        nextResponses.push(() => streamResponse(body));
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        let threw = false;
        try {
            await provider.provideLanguageModelChatResponse(model, [], options, progress as never, cancelledToken as never);
        } catch {
            threw = true;
        }
        assert.ok(threw, "an already-cancelled request raises CancellationError");
        assert.deepStrictEqual(costLines(), [], "a cancelled turn shows no cost line");
        assert.deepStrictEqual(usageParts(), [], "and no usage part");
    });

    test("reports the usage part at the end of a turn", async () => {
        const body = sseBody([
            { choices: [{ delta: { content: "a" } }] },
            { choices: [{ delta: { content: "b" } }] },
            {
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11, cost: 0.5 },
            },
        ]);
        nextResponses.push(() => streamResponse(body));
        await run();
        assert.deepStrictEqual(
            textReported().map((p) => (p as { value: string }).value),
            ["a", "b"],
            "the response text is the model's own output only"
        );
        assert.strictEqual(usageParts().length, 1);
    });

    test("sends no usage part when the stream carried no recognizable usage chunk", async () => {
        const body = sseBody([{ choices: [{ delta: { content: "only text" } }] }]);
        nextResponses.push(() => streamResponse(body));
        await run();
        assert.deepStrictEqual(usageParts(), [], "no usage part without a usage chunk");
    });

    test("flattens delta.reasoning_details: summary to thinking, response.output_text to text", async () => {
        const body = sseBody([
            {
                choices: [
                    {
                        delta: {
                            reasoning_details: [
                                { type: "reasoning.summary", summary: "step one" },
                                { type: "response.output_text", output_text: "visible reply" },
                            ],
                        },
                    },
                ],
            },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 1 } },
        ]);
        nextResponses.push(() => streamResponse(body));
        await run();
        assert.deepStrictEqual(
            textReported().map((p) => (p as { value: string }).value),
            ["visible reply"]
        );
        assert.strictEqual(thinkingReported().length, 1);
        if (runtimeThinkingPartCtor) {
            assert.strictEqual((thinkingReported()[0] as { value: string }).value, "step one");
        }
    });

    test("a streamed error event rejects with a mapped error instead of an empty reply", async () => {
        const body = sseBody([
            { choices: [{ delta: { content: "partial" } }] },
            {
                error: {
                    message: "tools.13.custom.input_schema: Field required",
                    code: "server_error",
                    metadata: { provider_name: "deepinfra" },
                },
            },
        ]);
        nextResponses.push(() => streamResponse(body));
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        await assert.rejects(
            provider.provideLanguageModelChatResponse(model, [], options, progress as never, token as never),
            (err: Error) =>
                err.message.includes("tools.13.custom.input_schema") &&
                err.message.includes("server_error") &&
                err.message.includes("deepinfra")
        );
    });

    test("maps a pre-stream 401 to a friendly key error", async () => {
        nextResponses.push(() => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-bad"), fakeState());
        await assert.rejects(
            provider.provideLanguageModelChatResponse(model, [], options, progress as never, token as never),
            (err: Error) => err.message.includes("invalid or expired")
        );
    });

    test("retries 429 with backoff before succeeding", async () => {
        nextResponses.push(
            () => new Response("rate limited", { status: 429 }),
            () => new Response("rate limited", { status: 429 }),
            () => streamResponse(sseBody([{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 1 } }]))
        );
        await run();
        assert.strictEqual(fetchCalls.length, 3, "two retries then success");
        assert.deepStrictEqual(
            textReported().map((p) => (p as { value: string }).value),
            ["ok"]
        );
    });

    test("gives up after three retries on a persistent 503 and maps the error", async () => {
        for (let i = 0; i < 10; i++) {
            nextResponses.push(() => new Response("down", { status: 503 }));
        }
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        await assert.rejects(
            provider.provideLanguageModelChatResponse(model, [], options, progress as never, token as never),
            (err: Error) => err.message.includes("503")
        );
        assert.strictEqual(fetchCalls.length, 4, "initial + three retries");
    });

    test("a request cancelled up front makes no network calls", async () => {
        const cancelledToken = {
            isCancellationRequested: true,
            onCancellationRequested: () => ({ dispose: () => { } }),
        } as unknown as vscode.CancellationToken;
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        let calls = 0;
        const original = globalThis.fetch;
        globalThis.fetch = (async () => {
            calls++;
            throw new Error("aborted");
        }) as typeof fetch;
        try {
            await assert.rejects(
                provider.provideLanguageModelChatResponse(model, [], options, progress as never, cancelledToken as never)
            );
        } finally {
            globalThis.fetch = original;
        }
        assert.strictEqual(calls, 0, "no fetch for a request that was already cancelled");
    });

    test("catalog fetch does not retry when cancellation lands during backoff", async () => {
        const token = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => { } }),
        } as unknown as vscode.CancellationToken;
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        let calls = 0;
        const original = globalThis.fetch;
        globalThis.fetch = (async () => {
            calls++;
            return new Response("rate limited", { status: 429 });
        }) as typeof fetch;
        setRetryDelayForTesting(async () => {
            token.isCancellationRequested = true;
        });
        try {
            await assert.rejects(
                provider.provideLanguageModelChatInformation({ silent: true }, token as never)
            );
        } finally {
            globalThis.fetch = original;
            setRetryDelayForTesting(async () => { });
        }
        assert.strictEqual(calls, 1, "no retry after the token was cancelled during backoff");
    });

    test("a picker preset turn does not leak into a following plain-model turn (empty template)", async () => {
        const presetModel = { id: "@preset/faster-glm-flash" } as unknown as vscode.LanguageModelChatInformation;
        const okBody = sseBody([
            { choices: [{ delta: { content: "ok" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 1 } },
        ]);
        nextResponses.push(() => streamResponse(okBody), () => streamResponse(okBody));
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        await provider.provideLanguageModelChatResponse(presetModel, [], options, progress as never, token as never);
        await provider.provideLanguageModelChatResponse(model, [], options, progress as never, token as never);
        assert.strictEqual(fetchCalls.length, 2);
        const bodies = fetchCalls.map((c) => JSON.parse(String(c.init?.body)));
        assert.strictEqual(bodies[0].model, "@preset/faster-glm-flash");
        assert.ok(!("preset" in bodies[0]));
        assert.strictEqual(bodies[1].model, "deepseek/deepseek-v4-flash-0731");
        assert.ok(!("preset" in bodies[1]), "the preset reference stayed per-request");
        assert.ok(!("provider" in bodies[1]), "no provider object was injected for the plain model");
    });

    test("a combined model@preset id takes the cache decision from the preset's resolved model", async () => {
        const okBody = sseBody([{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 1 } }]);
        const presetBody = (model: string) =>
            new Response(JSON.stringify({ data: { slug: "p", designated_version: { config: { model } } } }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });

        const nonAnthropicPreset = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        nextResponses.push(() => presetBody("z-ai/glm-5.3-flash"));
        await nonAnthropicPreset.getPresetConfig("p");
        nextResponses.push(() => streamResponse(okBody));
        await nonAnthropicPreset.provideLanguageModelChatResponse(
            { id: "anthropic/claude-x@preset/p" } as unknown as vscode.LanguageModelChatInformation,
            [],
            options,
            progress as never,
            token as never
        );
        const nonAnthropicBody = JSON.parse(String(fetchCalls[1]?.init?.body));
        assert.strictEqual(nonAnthropicBody.model, "anthropic/claude-x@preset/p");
        assert.ok(
            !("cache_control" in nonAnthropicBody),
            "the preset's non-Anthropic model decides, not the combined id's family prefix"
        );

        const anthropicPreset = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        nextResponses.push(() => presetBody("anthropic/claude-sonnet-4.5"));
        await anthropicPreset.getPresetConfig("p");
        nextResponses.push(() => streamResponse(okBody));
        await anthropicPreset.provideLanguageModelChatResponse(
            { id: "z-ai/glm-5.3-flash@preset/p" } as unknown as vscode.LanguageModelChatInformation,
            [],
            options,
            progress as never,
            token as never
        );
        const anthropicBody = JSON.parse(String(fetchCalls[3]?.init?.body));
        assert.deepStrictEqual(anthropicBody.cache_control, { type: "ephemeral" }, "the preset's Anthropic model engages caching");
    });

    test("reassembles tool-call deltas and flushes them via progress", async () => {
        const body = sseBody([
            {
                choices: [
                    {
                        delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather", arguments: '{"loc' } }] },
                    },
                ],
            },
            {
                choices: [
                    {
                        delta: { tool_calls: [{ index: 0, function: { arguments: 'ation":"Tokyo"}' } }] },
                        finish_reason: "tool_calls",
                    },
                ],
            },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 1 } },
        ]);
        nextResponses.push(() => streamResponse(body));
        await run();
        const toolParts = reported.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
        assert.strictEqual(toolParts.length, 1);
        const call = toolParts[0] as vscode.LanguageModelToolCallPart;
        assert.strictEqual(call.callId, "call_1");
        assert.strictEqual(call.name, "get_weather");
        assert.deepStrictEqual(call.input, { location: "Tokyo" });
    });

    test("flushes pending tool calls when the stream ends at EOF without [DONE]", async () => {
        const body = `data: ${JSON.stringify({
            choices: [
                {
                    delta: { tool_calls: [{ index: 0, id: "call_7", function: { name: "get_info", arguments: '{"q":"x"}' } }] },
                },
            ],
        })}\n\n`;
        nextResponses.push(() => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
        await run();
        const toolParts = reported.filter((p) => p instanceof vscode.LanguageModelToolCallPart);
        assert.strictEqual(toolParts.length, 1, "tool call flushed even with no [DONE]");
        const call = toolParts[0] as vscode.LanguageModelToolCallPart;
        assert.strictEqual(call.callId, "call_7");
        assert.strictEqual(call.name, "get_info");
        assert.deepStrictEqual(call.input, { q: "x" });
    });

    test("two overlapping calls report their own usage and cost (per-call stream state)", async () => {
        resetSessionCostsForTesting();
        resetParentAttributionForTesting();
        const a = controlledSse();
        const b = controlledSse();
        nextResponses.push(() => a.response, () => b.response);
        const aParts: unknown[] = [];
        const bParts: unknown[] = [];
        const progressA = { report: (p: unknown) => { aParts.push(p); } };
        const progressB = { report: (p: unknown) => { bParts.push(p); } };
        const events: TurnCost[] = [];
        const sub = onTurnCost((c) => events.push(c));
        try {
            const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
            const optsA = { tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: "conv-a" } };
            const optsB = { tools: undefined, modelConfiguration: undefined, modelOptions: { _conversationId: "conv-b" } };
            const runA = provider.provideLanguageModelChatResponse(model, [], optsA as never, progressA as never, token as never);
            await tick();
            const runB = provider.provideLanguageModelChatResponse(model, [], optsB as never, progressB as never, token as never);
            let guard = 0;
            while (fetchCalls.length < 2 && guard++ < 100) {
                await tick();
            }
            assert.strictEqual(fetchCalls.length, 2, "both calls are in flight together");
            // B finishes first: with module-global state its usage would clobber A's report.
            b.push(`data: ${JSON.stringify({ provider: "Morph", choices: [{ delta: { content: "b" } }], usage: { prompt_tokens: 200, completion_tokens: 2, total_tokens: 202, cost: 0.002 } })}\n\n`);
            b.push("data: [DONE]\n\n");
            b.close();
            await runB;
            a.push(`data: ${JSON.stringify({ provider: "Fireworks", choices: [{ delta: { content: "a" } }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 1e-5 } } })}\n\n`);
            a.push("data: [DONE]\n\n");
            a.close();
            await runA;

            const usageOf = (parts: unknown[]): Record<string, unknown> =>
                JSON.parse(
                    new TextDecoder().decode(
                        (parts.filter(
                            (p): p is vscode.LanguageModelDataPart =>
                                p instanceof vscode.LanguageModelDataPart && p.mimeType === "usage"
                        )[0]).data
                    )
                );
            assert.strictEqual(usageOf(aParts).prompt_tokens, 10, "call A reports its own usage, not B's");
            assert.strictEqual(usageOf(bParts).prompt_tokens, 200, "call B reports its own usage");
            assert.strictEqual(getSessionCost("copilot-chat:conv-a")!.paid, 1e-5, "A's session gets A's provider cost");
            assert.strictEqual(getSessionCost("copilot-chat:conv-b")!.paid, 0.002);
            assert.deepStrictEqual(
                events.map((e) => e.provider).sort(),
                ["Fireworks", "Morph"],
                "each cost event carries its own serving provider"
            );
        } finally {
            sub.dispose();
            resetSessionCostsForTesting();
            resetParentAttributionForTesting();
        }
    });

    test("a POST that never responds times out with a friendly error and is attempted once", async () => {
        const original = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
            calls++;
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
        }) as typeof fetch;
        setPostTimeoutForTesting(20);
        try {
            const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
            await assert.rejects(
                provider.provideLanguageModelChatResponse(model, [], options, progress as never, token as never),
                (err: Error) => /did not respond within/.test(err.message)
            );
            assert.strictEqual(calls, 1, "a timeout abort is never retried");
        } finally {
            globalThis.fetch = original;
            setPostTimeoutForTesting(60_000);
        }
    });

    test("cancellation landing between reads rejects with CancellationError", async () => {
        const ctrl = controlledSse();
        nextResponses.push(() => ctrl.response);
        const mutableToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => { } }),
        };
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        const run = provider.provideLanguageModelChatResponse(
            model,
            [],
            options,
            progress as never,
            mutableToken as unknown as vscode.CancellationToken
        );
        let guard = 0;
        while (fetchCalls.length < 1 && guard++ < 100) {
            await tick();
        }
        ctrl.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "first" } }] })}\n\n`);
        await tick();
        mutableToken.isCancellationRequested = true;
        ctrl.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "second" } }] })}\n\n`);
        await assert.rejects(run, (err: unknown) => err instanceof vscode.CancellationError);
    });
});

suite("provideTokenCount", () => {
    const token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => { } }),
    } as unknown as vscode.CancellationToken;
    const model = { id: "m" } as unknown as vscode.LanguageModelChatInformation;

    test("estimates strings at one token per four characters", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        assert.strictEqual(await provider.provideTokenCount(model, "abcdefgh", token as never), 2);
        assert.strictEqual(await provider.provideTokenCount(model, "abc", token as never), 1);
        assert.strictEqual(await provider.provideTokenCount(model, "", token as never), 0);
    });

    test("counts text parts of a message and ignores other part kinds", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        const message = msg(vscode.LanguageModelChatMessageRole.User, [
            new vscode.LanguageModelTextPart("abcdefgh"),
            new vscode.LanguageModelToolCallPart("call_1", "get_weather", {}),
        ]);
        assert.strictEqual(await provider.provideTokenCount(model, message, token as never), 2);
    });
});

suite("preset model entries (catalog + presets)", () => {
    const token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => { } }),
    } as unknown as vscode.CancellationToken;

    function jsonResponse(body: unknown, status = 200): Response {
        return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }

    async function withFetch(handler: (url: string) => Response, fn: () => Promise<void>): Promise<void> {
        const original = globalThis.fetch;
        globalThis.fetch = (async (input: unknown) => handler(String(input))) as typeof fetch;
        try {
            await fn();
        } finally {
            globalThis.fetch = original;
        }
    }

    function presetRoutes(): (url: string) => Response {
        return (url: string) => {
            if (url.endsWith("/models")) {
                return jsonResponse({
                    data: [
                        {
                            id: "z-ai/glm-5.3-flash",
                            name: "GLM 5.3 Flash",
                            context_length: 131072,
                            pricing: { prompt: "0.000001", completion: "0.000003" },
                            architecture: { input_modalities: ["text", "image"] },
                            reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "high" },
                        },
                        { id: "deepseek/deepseek-v4-flash", context_length: 163840 },
                        { id: "deepseek/deepseek-v4-flash-0731", context_length: 163840 },
                    ],
                });
            }
            if (url.includes("/presets?")) {
                return jsonResponse({
                    data: [
                        { slug: "faster-glm-flash", name: "faster-glm-flash", status: "active" },
                        { slug: "faster-deepseek-flash", name: "faster-deepseek-flash", status: "active" },
                        { slug: "orphan-model", name: "orphan-model", status: "active" },
                        { slug: "profile-only", name: "profile-only", status: "active" },
                        { slug: "retired", name: "retired", status: "disabled" },
                    ],
                });
            }
            if (url.endsWith("/presets/faster-glm-flash")) {
                return jsonResponse({
                    data: {
                        slug: "faster-glm-flash",
                        designated_version: {
                            config: { model: "z-ai/glm-5.3-flash-20260826", provider: { order: ["baseten", "makora"] } },
                        },
                    },
                });
            }
            if (url.endsWith("/presets/faster-deepseek-flash")) {
                return jsonResponse({
                    data: {
                        slug: "faster-deepseek-flash",
                        designated_version: { config: { model: "deepseek/deepseek-v4-flash-20260731" } },
                    },
                });
            }
            if (url.endsWith("/presets/orphan-model")) {
                return jsonResponse({
                    data: {
                        slug: "orphan-model",
                        designated_version: { config: { model: "z-ai/glm-6.9-ultra-20770101" } },
                    },
                });
            }
            if (url.endsWith("/presets/profile-only")) {
                return jsonResponse({
                    data: { slug: "profile-only", designated_version: { config: { provider: { order: ["baseten"] } } } },
                });
            }
            throw new Error(`unexpected fetch: ${url}`);
        };
    }

    test("lists @preset/<slug> entries for model-pinned presets with resolved caps", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        await withFetch(presetRoutes(), async () => {
            const first = await provider.provideLanguageModelChatInformation({ silent: true } as never, token as never);
            assert.strictEqual(
                first.filter((m) => m.id.startsWith("@preset/")).length,
                0,
                "the picker gets the models immediately; presets attach when the sweep resolves"
            );
            await provider.getPresets();
            const info = await provider.provideLanguageModelChatInformation({ silent: true } as never, token as never);
            const presetEntries = info.filter((m) => m.id.startsWith("@preset/"));
            assert.deepStrictEqual(
                presetEntries.map((m) => m.id),
                ["@preset/faster-glm-flash", "@preset/faster-deepseek-flash", "@preset/orphan-model"],
                "model-pinned presets become picker entries; model-less and disabled ones do not"
            );
            const glm = presetEntries[0];
            assert.strictEqual(glm.version, "@preset/faster-glm-flash");
            assert.strictEqual(glm.family, "preset");
            assert.strictEqual(glm.name, "faster-glm-flash");
            assert.strictEqual(glm.maxInputTokens, 131072, "token caps resolved from the underlying catalog entry");
            assert.strictEqual(glm.capabilities.imageInput, true);
            assert.ok(
                (glm.configurationSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.reasoningEffort,
                "the datestamped preset model resolves via alias to the catalog entry and exposes the Thinking Effort selector"
            );
            assert.ok(info.some((m) => m.id === "z-ai/glm-5.3-flash"), "catalog entries still listed");
            assert.deepStrictEqual(
                (await provider.getPresets())!.map((p) => [p.slug, p.model]),
                [
                    ["faster-glm-flash", "z-ai/glm-5.3-flash-20260826"],
                    ["faster-deepseek-flash", "deepseek/deepseek-v4-flash-20260731"],
                    ["orphan-model", "z-ai/glm-6.9-ultra-20770101"],
                    ["profile-only", undefined],
                ],
                "model-less presets stay visible to the panel without a picker entry"
            );
        });
    });

    test("a failing presets fetch degrades to the plain catalog", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        await withFetch(
            (url) => {
                if (url.endsWith("/models")) {
                    return jsonResponse({ data: [{ id: "z-ai/glm-5.3-flash" }] });
                }
                return new Response("nope", { status: 404 });
            },
            async () => {
                const info = await provider.provideLanguageModelChatInformation({ silent: true } as never, token as never);
                assert.strictEqual(info.length, 1);
                assert.strictEqual(info[0].id, "z-ai/glm-5.3-flash");
                assert.strictEqual(
                    await provider.getPresets(),
                    undefined,
                    "a failed sweep reports undefined, not an empty list"
                );
            }
        );
    });

    test("getPresets fetches on demand, caches, and resolves datestamped models by alias", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        let modelRequests = 0;
        await withFetch(
            (url) => {
                if (url.endsWith("/models")) {
                    modelRequests++;
                    return jsonResponse({ data: [{ id: "z-ai/glm-5.3-flash", context_length: 131072 }] });
                }
                if (url.includes("/presets?")) {
                    return jsonResponse({ data: [{ slug: "faster-glm-flash", name: "faster-glm-flash", status: "active" }] });
                }
                if (url.endsWith("/presets/faster-glm-flash")) {
                    return jsonResponse({
                        data: { slug: "faster-glm-flash", designated_version: { config: { model: "z-ai/glm-5.3-flash-20260826" } } },
                    });
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
            async () => {
                const presets = (await provider.getPresets())!;
                assert.deepStrictEqual(presets.map((p) => p.slug), ["faster-glm-flash"]);
                const again = await provider.getPresets();
                assert.strictEqual(again, presets, "the second call reuses the cache");
                assert.strictEqual(modelRequests, 0, "getPresets never needs the catalog; only /presets");
                const info = await provider.provideLanguageModelChatInformation({ silent: true } as never, token as never);
                assert.strictEqual(info.filter((m) => m.id.startsWith("@preset/")).length, 1);
                assert.strictEqual(modelRequests, 1, "the picker fetches the catalog once and reuses the cached presets");
            }
        );
    });

    test("getPresetConfig returns the full designated config and caches per slug", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        let slugRequests = 0;
        const config = { model: "z-ai/glm-5.3-flash-20260826", provider: { order: ["baseten", "makora"] } };
        await withFetch(
            (url) => {
                if (url.includes("/presets?")) {
                    return jsonResponse({ data: [{ slug: "faster-glm-flash", name: "faster-glm-flash", status: "active" }] });
                }
                if (url.endsWith("/presets/faster-glm-flash")) {
                    slugRequests++;
                    return jsonResponse({ data: { slug: "faster-glm-flash", designated_version: { config } } });
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
            async () => {
                const first = await provider.getPresetConfig("faster-glm-flash");
                assert.deepStrictEqual(first, config);
                const second = await provider.getPresetConfig("faster-glm-flash");
                assert.strictEqual(second, first, "the second call reuses the cached config");
                assert.strictEqual(slugRequests, 1, "one network fetch per slug");
            }
        );
    });

    test("a -MMDD datestamped preset model resolves via the short-date alias", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        await withFetch(
            (url) => {
                if (url.endsWith("/models")) {
                    return jsonResponse({
                        data: [
                            {
                                id: "z-ai/glm-5.3-flash",
                                context_length: 131072,
                                reasoning: { supported_efforts: ["max", "high", "low"], default_effort: "high" },
                            },
                        ],
                    });
                }
                if (url.includes("/presets?")) {
                    return jsonResponse({ data: [{ slug: "short-date", name: "short-date", status: "active" }] });
                }
                if (url.endsWith("/presets/short-date")) {
                    return jsonResponse({
                        data: { slug: "short-date", designated_version: { config: { model: "z-ai/glm-5.3-flash-0731" } } },
                    });
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
            async () => {
                await provider.provideLanguageModelChatInformation({ silent: true } as never, token as never);
                await provider.getPresets();
                const info = await provider.provideLanguageModelChatInformation({ silent: true } as never, token as never);
                const entry = info.find((m) => m.id === "@preset/short-date");
                assert.ok(entry, "short-date preset listed");
                assert.strictEqual(entry!.maxInputTokens, 131072, "caps resolved through the -MMDD alias");
                assert.ok(
                    (entry!.configurationSchema as { properties?: Record<string, unknown> } | undefined)?.properties?.reasoningEffort,
                    "reasoning schema resolved through the -MMDD alias"
                );
            }
        );
    });

    test("a non-date four-digit suffix is not treated as a datestamp alias", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        await withFetch(
            (url) => {
                if (url.endsWith("/models")) {
                    return jsonResponse({ data: [{ id: "z-ai/glm-5.3-flash", context_length: 131072 }] });
                }
                if (url.includes("/presets?")) {
                    return jsonResponse({ data: [{ slug: "not-a-date", name: "not-a-date", status: "active" }] });
                }
                if (url.endsWith("/presets/not-a-date")) {
                    return jsonResponse({
                        data: { slug: "not-a-date", designated_version: { config: { model: "z-ai/glm-5.3-flash-1234" } } },
                    });
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
            async () => {
                await provider.provideLanguageModelChatInformation({ silent: true } as never, token as never);
                await provider.getPresets();
                const info = await provider.provideLanguageModelChatInformation({ silent: true } as never, token as never);
                const entry = info.find((m) => m.id === "@preset/not-a-date");
                assert.ok(entry, "unknown-model preset still listed");
                assert.strictEqual(entry!.maxInputTokens, 1_048_576, "assumed defaults for a truly unknown model");
                assert.strictEqual(entry!.configurationSchema, undefined, "no reasoning schema without a catalog match");
            }
        );
    });

    test("the 25-lookup cap limits picker entries but not the panel preset list", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        await withFetch(
            (url) => {
                if (url.endsWith("/models")) {
                    return jsonResponse({ data: [{ id: "z-ai/glm-5.3-flash", context_length: 131072 }] });
                }
                if (url.includes("/presets?")) {
                    return jsonResponse({
                        data: Array.from({ length: 30 }, (_, i) => ({ slug: `preset-${i}`, name: `preset-${i}`, status: "active" })),
                    });
                }
                const match = url.match(/\/presets\/(preset-\d+)$/);
                if (match) {
                    return jsonResponse({
                        data: { slug: match[1], designated_version: { config: { model: "z-ai/glm-5.3-flash" } } },
                    });
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
            async () => {
                const presets = (await provider.getPresets())!;
                assert.strictEqual(presets.length, 30, "all active presets stay visible to the panel");
                const info = await provider.provideLanguageModelChatInformation({ silent: true } as never, token as never);
                const entries = info.filter((m) => m.id.startsWith("@preset/"));
                assert.strictEqual(entries.length, 25, "picker entries stop at the 25-lookup cap");
                assert.ok(
                    presets.slice(0, 25).every((p) => p.model === "z-ai/glm-5.3-flash"),
                    "the first 25 presets got their designated model resolved"
                );
                assert.ok(
                    presets.slice(25).every((p) => p.model === undefined),
                    "presets beyond the cap keep no resolved model"
                );
                assert.ok(
                    presets.slice(25).every((p) => p.lookupSkipped === true),
                    "presets beyond the cap are flagged as lookup-skipped"
                );
                assert.ok(
                    presets.slice(0, 25).every((p) => p.lookupSkipped === undefined),
                    "resolved presets are never flagged lookup-skipped"
                );
                assert.ok(
                    presets.every((p) => !(p.lookupSkipped === true && p.model !== undefined)),
                    "a resolved preset is never also marked skipped"
                );
            }
        );
    });

    test("inactive presets no longer consume the lookup budget", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        const rows = [
            ...Array.from({ length: 30 }, (_, i) => ({ slug: `retired-${i}`, name: `retired-${i}`, status: "disabled" })),
            { slug: "live-preset", name: "live-preset", status: "active" },
        ];
        await withFetch(
            (url) => {
                if (url.endsWith("/models")) {
                    return jsonResponse({ data: [{ id: "z-ai/glm-5.3-flash" }] });
                }
                if (url.includes("/presets?")) {
                    return jsonResponse({ data: rows });
                }
                if (url.endsWith("/presets/live-preset")) {
                    return jsonResponse({
                        data: { slug: "live-preset", designated_version: { config: { model: "z-ai/glm-5.3-flash" } } },
                    });
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
            async () => {
                await provider.provideLanguageModelChatInformation({ silent: true } as never, token as never);
                await provider.getPresets();
                const info = await provider.provideLanguageModelChatInformation({ silent: true } as never, token as never);
                const entry = info.find((m) => m.id === "@preset/live-preset");
                assert.ok(entry, "the active preset after 30 inactive rows still gets a picker entry");
            }
        );
    });

    test("a transient presets failure is not cached as an empty list", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        let healthy = false;
        setRetryDelayForTesting(async () => { });
        await withFetch(
            (url) => {
                if (url.endsWith("/models")) {
                    return jsonResponse({ data: [{ id: "z-ai/glm-5.3-flash" }] });
                }
                if (!healthy) {
                    return new Response("boom", { status: 503 });
                }
                if (url.includes("/presets?")) {
                    return jsonResponse({ data: [{ slug: "faster-glm-flash", name: "faster-glm-flash", status: "active" }] });
                }
                if (url.endsWith("/presets/faster-glm-flash")) {
                    return jsonResponse({
                        data: { slug: "faster-glm-flash", designated_version: { config: { model: "z-ai/glm-5.3-flash" } } },
                    });
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
            async () => {
                try {
                    assert.strictEqual(
                        await provider.getPresets(),
                        undefined,
                        "the failed sweep reports undefined, not an empty list"
                    );
                    healthy = true;
                    const presets = await provider.getPresets();
                    assert.deepStrictEqual(presets!.map((p) => p.slug), ["faster-glm-flash"], "a later call retries and succeeds");
                } finally {
                    setRetryDelayForTesting((ms) => new Promise((r) => setTimeout(r, ms)));
                }
            }
        );
    });

    test("concurrent getPresets calls share one sweep", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        let listRequests = 0;
        await withFetch(
            (url) => {
                if (url.includes("/presets?")) {
                    listRequests++;
                    return jsonResponse({ data: [{ slug: "faster-glm-flash", name: "faster-glm-flash", status: "active" }] });
                }
                if (url.endsWith("/presets/faster-glm-flash")) {
                    return jsonResponse({
                        data: { slug: "faster-glm-flash", designated_version: { config: { model: "z-ai/glm-5.3-flash" } } },
                    });
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
            async () => {
                const [a, b] = await Promise.all([provider.getPresets(), provider.getPresets()]);
                assert.strictEqual(a, b, "both callers receive the same sweep result");
                assert.strictEqual(listRequests, 1, "the list request is not duplicated across concurrent callers");
            }
        );
    });

    test("concurrent catalog calls share one /models fetch", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        let modelRequests = 0;
        await withFetch(
            (url) => {
                if (url.endsWith("/models")) {
                    modelRequests++;
                    return jsonResponse({ data: [{ id: "z-ai/glm-5.3-flash" }] });
                }
                if (url.includes("/presets?")) {
                    return jsonResponse({ data: [] });
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
            async () => {
                const [a, b] = await Promise.all([
                    provider.provideLanguageModelChatInformation({ silent: true } as never, token as never),
                    provider.provideLanguageModelChatInformation({ silent: true } as never, token as never),
                ]);
                assert.strictEqual(modelRequests, 1, "concurrent callers share one in-flight catalog fetch");
                assert.deepStrictEqual(a.map((m) => m.id), ["z-ai/glm-5.3-flash"]);
                assert.deepStrictEqual(b.map((m) => m.id), ["z-ai/glm-5.3-flash"]);
            }
        );
    });

    test("a picker refresh after a panel render reuses the cached presets", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        let listRequests = 0;
        let modelRequests = 0;
        await withFetch(
            (url) => {
                if (url.endsWith("/models")) {
                    modelRequests++;
                    return jsonResponse({ data: [{ id: "z-ai/glm-5.3-flash", context_length: 131072 }] });
                }
                if (url.includes("/presets?")) {
                    listRequests++;
                    return jsonResponse({ data: [{ slug: "faster-glm-flash", name: "faster-glm-flash", status: "active" }] });
                }
                if (url.endsWith("/presets/faster-glm-flash")) {
                    return jsonResponse({
                        data: { slug: "faster-glm-flash", designated_version: { config: { model: "z-ai/glm-5.3-flash-20260826" } } },
                    });
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
            async () => {
                await provider.getPresets();
                const info = await provider.provideLanguageModelChatInformation({ silent: true } as never, token as never);
                assert.strictEqual(info.filter((m) => m.id.startsWith("@preset/")).length, 1);
                assert.strictEqual(listRequests, 1, "the warm preset cache is reused, not re-fetched");
                assert.strictEqual(modelRequests, 1);
            }
        );
    });
});

suite("stripTemplateComments and setTemplate", () => {
    test("strips full-line // comments and keeps everything else verbatim", () => {
        const raw = [
            "// header note",
            "//   \"model\": \"x\",",
            "{\"temperature\":0.2, \"url\": \"https://openrouter.ai/docs\"}",
        ].join("\n");
        assert.strictEqual(stripTemplateComments(raw), '{"temperature":0.2, "url": "https://openrouter.ai/docs"}');
    });

    test("a // inside a string value is never stripped (JSON strings cannot span raw lines)", () => {
        const raw = '{\n  "url": "https://openrouter.ai/docs",\n  "note": "// not a comment"\n}';
        assert.strictEqual(stripTemplateComments(raw), raw);
    });

    test("handles CRLF input", () => {
        assert.strictEqual(stripTemplateComments("// a\r\n{}\r\n// b"), "{}");
    });

    test("setTemplate strips comments before parsing and stores the clean template", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState());
        const result = await provider.setTemplate(
            '// {"model": "z-ai/glm-5.3-flash-20260826"}\n{"preset": "faster-glm-flash", "temperature": 0.2}'
        );
        assert.deepStrictEqual(result, { ok: true });
        assert.deepStrictEqual(await provider.getTemplate(), { preset: "faster-glm-flash", temperature: 0.2 });
    });

    test("a comments-only save clears the template; malformed JSON still errors", async () => {
        const provider = new OpenRouterChatProvider(fakeSecrets("sk-test"), fakeState({ requestTemplate: { temperature: 0.2 } }));
        const cleared = await provider.setTemplate("// just notes\n// nothing else");
        assert.deepStrictEqual(cleared, { ok: true });
        assert.strictEqual(await provider.getTemplate(), undefined);

        const bad = await provider.setTemplate('// {"a": 1}\nnot json');
        assert.deepStrictEqual(bad, { ok: false, error: "The pasted text is not valid JSON." });
    });
});

suite("routeCostCells", () => {
    const route = (over: Partial<Parameters<typeof routeCostCells>[0]> = {}) => ({
        provider: "Fireworks",
        model: "deepseek/deepseek-v4.1-flash",
        byok: true,
        paid: 0.4957,
        openRouter: 0,
        upstream: 0.4957,
        promptTokens: 10,
        completionTokens: 2,
        cachedTokens: 0,
        calls: 175,
        updatedAt: 1,
        ...over,
    });

    test("a BYOK route marks the provider cell, keeping the model in its own column", () => {
        assert.deepStrictEqual(routeCostCells(route()), {
            cost: "$0.4957",
            provider: "Fireworks (BYOK)",
            model: "deepseek/deepseek-v4.1-flash",
            calls: "175",
            cached: "0.0%",
        });
    });

    test("an OpenRouter-charged route carries no marker", () => {
        const cells = routeCostCells(route({ provider: "Morph", model: "z-ai/glm-5.3-flash", byok: false, paid: 0.0000291, openRouter: 0.0000291, upstream: 0, calls: 1 }));
        assert.strictEqual(cells.provider, "Morph");
        assert.ok(!cells.provider.includes("(BYOK)"), "no marker on a shared-pool route");
        assert.strictEqual(cells.cost, "$0.00002910");
        assert.strictEqual(cells.calls, "1");
    });

    test("a route with no model name leaves the model cell empty", () => {
        assert.strictEqual(routeCostCells(route({ model: "" })).model, undefined);
    });

    // The rate is per route, so hopping between models in one chat still shows
    // each endpoint's own cache behavior instead of a blended session figure.
    test("each route carries its own cache rate, one decimal place", () => {
        assert.strictEqual(routeCostCells(route({ promptTokens: 1000, cachedTokens: 823 })).cached, "82.3%");
        assert.strictEqual(routeCostCells(route({ provider: "Morph", promptTokens: 40, cachedTokens: 0 })).cached, "0.0%");
    });

    test("a route that reported no prompt tokens yields no rate rather than 0.0%", () => {
        assert.strictEqual(routeCostCells(route({ promptTokens: 0, cachedTokens: 0 })).cached, undefined);
    });
});
