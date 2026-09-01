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

    test("assistant thinking parts are echoed back as reasoning on the outgoing message", () => {
        if (!runtimeThinkingPartCtor) {
            return;
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

    test("thinking-only assistant messages emit reasoning with content: null", () => {
        if (!runtimeThinkingPartCtor) {
            return;
        }
        const out = toOpenAI([
            msg(vscode.LanguageModelChatMessageRole.Assistant, [new (runtimeThinkingPartCtor as any)("chain")]),
        ]);
        assert.strictEqual(out.length, 1);
        assert.strictEqual((out[0] as { reasoning: string }).reasoning, "chain");
        assert.strictEqual((out[0] as { content: unknown }).content, null);
    });

    test("thinking part string arrays are joined into reasoning", () => {
        if (!runtimeThinkingPartCtor) {
            return;
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

    test("applies the quantization floor when the template has no provider", () => {
        const body = buildRequestBody({}, "m", [], undefined, undefined);
        assert.deepStrictEqual(body.provider, {
            quantizations: ["bf16", "fp16", "fp8", "mxfp8", "fp6", "unknown"],
        });
    });

    test("merges template provider pins over the quantization floor", () => {
        const body = buildRequestBody(
            { provider: { order: ["deepinfra"], allow_fallbacks: false } },
            "m",
            [],
            undefined,
            undefined
        );
        assert.deepStrictEqual(body.provider, {
            quantizations: ["bf16", "fp16", "fp8", "mxfp8", "fp6", "unknown"],
            order: ["deepinfra"],
            allow_fallbacks: false,
        });
    });

    test("a template provider.quantizations wins outright (floor dropped)", () => {
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

    test("non-Anthropic models never get an auto cache_control", () => {
        for (const id of ["deepseek/deepseek-v4-flash-0731", "openai/gpt-5.6-luna", "qwen/qwen3-coder-plus", "google/gemini-3.7-flash", "m"]) {
            const body = buildRequestBody({}, id, [], undefined, undefined);
            assert.ok(!("cache_control" in body), `${id} must not auto-cache`);
        }
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
