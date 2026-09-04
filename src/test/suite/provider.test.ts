import * as assert from "assert";
import * as vscode from "vscode";
import {
    baseUrl,
    buildRequestBody,
    flattenReasoningDetails,
    getLastStreamUsage,
    mapResponseError,
    mapStreamedError,
    OpenRouterChatProvider,
    setRetryDelayForTesting,
    stripTemplateComments,
    toOpenAI,
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

    test("strips template model/messages/tools and forces stream and session_id", () => {
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
        assert.strictEqual(typeof body.session_id, "string");
        assert.strictEqual(body.temperature, 0.2);
        assert.strictEqual(body.tools, undefined);
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
        assert.strictEqual(typeof body.session_id, "string");
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
            ["messages", "model", "session_id", "stream", "tools"],
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
        onCancellationRequested: () => ({ dispose: () => {} }),
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

    suiteSetup(() => {
        originalFetch = globalThis.fetch;
        setRetryDelayForTesting(async () => {});
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

    function thinkingReported(): unknown[] {
        return runtimeThinkingPartCtor ? reported.filter((p) => p instanceof runtimeThinkingPartCtor) : [];
    }

    function textReported(): unknown[] {
        return reported.filter((p) => p instanceof vscode.LanguageModelTextPart);
    }

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
        assert.strictEqual(reported.length, 0, "no parts for a usage-only chunk");
        assert.deepStrictEqual(getLastStreamUsage(), {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
        });
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
            onCancellationRequested: () => ({ dispose: () => {} }),
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
            onCancellationRequested: () => ({ dispose: () => {} }),
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
            setRetryDelayForTesting(async () => {});
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
});

suite("provideTokenCount", () => {
    const token = {
        isCancellationRequested: false,
        onCancellationRequested: () => ({ dispose: () => {} }),
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
        onCancellationRequested: () => ({ dispose: () => {} }),
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
                (await provider.getPresets()).map((p) => [p.slug, p.model]),
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
                assert.deepStrictEqual(await provider.getPresets(), []);
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
                const presets = await provider.getPresets();
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
                const presets = await provider.getPresets();
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
        setRetryDelayForTesting(async () => {});
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
                    assert.deepStrictEqual(await provider.getPresets(), [], "the failed sweep reports no presets");
                    healthy = true;
                    const presets = await provider.getPresets();
                    assert.deepStrictEqual(presets.map((p) => p.slug), ["faster-glm-flash"], "a later call retries and succeeds");
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
