import * as assert from "assert";
import * as vscode from "vscode";
import { handlePanelMessage, PanelDeps, renderPanelHtml, renderSessionCosts } from "../../panel";
import { SessionCost, stripTemplateComments } from "../../provider";
import { KEY_SECRET } from "../../storage";
import { KeyInfo } from "../../logic";

const BASE_INFO: KeyInfo = {
    label: "sk-or-v1-test...test",
    limit: null,
    limit_reset: null,
    limit_remaining: null,
    usage: 3.42,
    usage_daily: 3.42,
    usage_weekly: 12,
    usage_monthly: 40,
    is_free_tier: false,
};

function sessionFixture(over: Partial<SessionCost> = {}): SessionCost {
    return {
        sessionId: "copilot-chat:aaaaaaaa-1111-2222-3333-444444444444",
        paid: 0.001,
        openRouter: 0,
        upstream: 0.001,
        promptTokens: 1000,
        completionTokens: 10,
        cachedTokens: 900,
        calls: 2,
        byok: true,
        updatedAt: 1,
        routes: [
            {
                provider: "Fireworks",
                model: "deepseek/deepseek-v4.1-flash",
                byok: true,
                paid: 0.001,
                openRouter: 0,
                upstream: 0.001,
                promptTokens: 1000,
                completionTokens: 10,
                cachedTokens: 900,
                calls: 2,
                updatedAt: 1,
            },
        ],
        ...over,
    };
}

suite("renderSessionCosts", () => {
    test("empty state explains that no spend has been recorded", () => {
        const html = renderSessionCosts(undefined);
        assert.ok(html.includes("No OpenRouter spend recorded yet"), html);
        assert.ok(!html.includes("<details"), "no collapsible rows when there is nothing to show");
    });

    test("the footer says up to 10 sessions are kept, and that they persist", () => {
        const html = renderSessionCosts([sessionFixture()]);
        assert.ok(html.includes("up to the 10 most recent"), html);
        assert.ok(html.includes("kept across window reloads"), html);
    });

    test("one collapsible row per session, with the newest expanded", () => {
        const html = renderSessionCosts([
            sessionFixture({ sessionId: "copilot-chat:new-session", paid: 0.002 }),
            sessionFixture({ sessionId: "copilot-chat:old-session", paid: 0.001 }),
        ]);
        assert.strictEqual((html.match(/<details/g) ?? []).length, 2, "one details per session");
        assert.strictEqual((html.match(/\bopen\b/g) ?? []).length, 1, "only the first is expanded");
        const firstDetails = html.slice(html.indexOf("<details"));
        assert.ok(firstDetails.includes("new-session") || firstDetails.includes("new…"), "the newest session is expanded");
    });

    test("a session lists its provider/model routes", () => {
        const html = renderSessionCosts([
            sessionFixture({
                routes: [
                    { provider: "Fireworks", model: "deepseek/deepseek-v4.1-flash", byok: true, paid: 0.0016, openRouter: 0, upstream: 0.0016, promptTokens: 1, completionTokens: 1, cachedTokens: 0, calls: 3, updatedAt: 1 },
                    { provider: "Morph", model: "z-ai/glm-5.3-flash", byok: false, paid: 0.00003, openRouter: 0.00003, upstream: 0, promptTokens: 1, completionTokens: 1, cachedTokens: 0, calls: 1, updatedAt: 2 },
                ],
            }),
        ]);
        assert.ok(html.includes("<table class=\"routes\">"), "routes render as a table");
        assert.match(html, /<tr><th>Cost<\/th><th>Provider<\/th><th>Model<\/th><th>Calls<\/th><th>Cached<\/th><\/tr>/, "header row");
        assert.ok(html.includes("Fireworks (BYOK)"), "the BYOK host is named once, with a marker");
        assert.ok(html.includes("deepseek/deepseek-v4.1-flash"), "model named in its own cell");
        assert.ok(html.includes("Morph"), "the second provider named");
        assert.ok(!html.includes("Morph (BYOK)"), "an OpenRouter-charged route never carries the BYOK marker");
        assert.strictEqual((html.match(/<tbody>/g) ?? []).length, 1, "a single table body");
        assert.strictEqual((html.match(/<tr>\s*<td/g) ?? []).length, 2, "one row per route");
        assert.ok(!html.includes("<tfoot>"), "no separate footer row");
    });

    // The blended session rate stays in the summary line (never a 0.0% when the
    // session reported no prompt tokens).
    test("the summary line carries the session-blended cache rate", () => {
        const html = renderSessionCosts([sessionFixture({ promptTokens: 1000, cachedTokens: 823 })]);
        assert.ok(html.includes("2 call(s) \u00b7 82.3% cached"), html);
        const summary = (s: SessionCost) => renderSessionCosts([s]).match(/<span class="muted">([^<]*)<\/span>/)![1];
        assert.ok(!summary(sessionFixture({ promptTokens: 0, cachedTokens: 0 })).includes("cached"), "no rate at all");
    });

    // Session hopping: one chat, two models — each route's cache figure is its own.
    test("a session that hopped models shows a separate cache rate per route", () => {
        const route = (over: Partial<SessionCost["routes"][number]>) => ({
            provider: "Fireworks",
            model: "deepseek/deepseek-v4.1-flash",
            byok: true,
            paid: 0.001,
            openRouter: 0,
            upstream: 0.001,
            promptTokens: 1000,
            completionTokens: 10,
            cachedTokens: 0,
            calls: 1,
            updatedAt: 1,
            ...over,
        });
        const html = renderSessionCosts([
            sessionFixture({
                routes: [
                    route({ cachedTokens: 823, paid: 0.002 }),
                    route({ provider: "Morph", model: "z-ai/glm-5.3-flash", byok: false, openRouter: 0.001, upstream: 0, cachedTokens: 12, paid: 0.001 }),
                ],
            }),
        ]);
        assert.ok(html.includes(">82.3%<"), html);
        assert.ok(html.includes(">1.2%<"), html);
    });

    test("the session body leaves no stray gap after the session id line", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5);
        assert.match(html, /\.sessionbody p \{ margin: 0; \}/, "the trailing paragraph margin is zeroed");
    });

    test("shows no window total, just the per-session rows", () => {
        const html = renderSessionCosts([
            sessionFixture({ sessionId: "a", paid: 0.002 }),
            sessionFixture({ sessionId: "b", paid: 0.003 }),
        ]);
        assert.ok(!/across \d+ session/.test(html), "no 'across N session(s)' summary line");
        assert.ok(!html.includes("$0.005000"), "no summed window total");
        assert.ok(html.includes("$0.002000") && html.includes("$0.003000"), "each session's own total is shown");
    });

    test("sessions without spend are omitted", () => {
        const html = renderSessionCosts([
            sessionFixture({ sessionId: "with-spend", paid: 0.001 }),
            sessionFixture({ sessionId: "no-spend", paid: 0, upstream: 0, openRouter: 0 }),
        ]);
        assert.strictEqual((html.match(/<details/g) ?? []).length, 1, "only the spending session is listed");
        assert.ok(!html.includes("no-spend"), "a zero-spend session is not shown");
    });

    test("escapes session ids and titles into the HTML", () => {
        const html = renderSessionCosts([
            sessionFixture({ sessionId: "copilot-chat:<script>alert(1)</script>", paid: 0.001 }),
        ]);
        assert.ok(!html.includes("<script>alert(1)"), "a hostile session id cannot inject markup");
        assert.ok(html.includes("&lt;script&gt;"), "it is escaped instead");
    });

    test("uses the chat title as the session label when known", () => {
        const html = renderSessionCosts([sessionFixture({ title: "Confirm work transfer to Windows" })]);
        assert.ok(html.includes("Confirm work transfer to Windows"), "the title labels the row");
    });

    test("a hostile chat title is escaped, never injected", () => {
        const html = renderSessionCosts([sessionFixture({ title: "<img src=x onerror=alert(1)>" })]);
        assert.ok(!html.includes("<img src=x"), "the title cannot inject markup");
        assert.ok(html.includes("&lt;img src=x"), "it is escaped instead");
    });

    test("shows the last-update time when the stamp is a real clock value", () => {
        const when = new Date(2026, 8, 22, 1, 30, 5).getTime();
        const html = renderSessionCosts([sessionFixture({ updatedAt: when })]);
        assert.ok(html.includes("sessiontime"), "the timestamp is rendered");
        assert.match(html, /2026\/09\/22 01:30:05/, html);
    });

    test("omits the timestamp when updatedAt is not a plausible clock value", () => {
        const html = renderSessionCosts([sessionFixture({ updatedAt: 1 })]);
        assert.ok(!html.includes("sessiontime"), "no bogus 1970 stamp");
    });
});

suite("renderPanelHtml", () => {
    test("ships a per-render nonce CSP and escapes the masked key into the script", () => {
        const html = renderPanelHtml(BASE_INFO, 10, "daily", true, 5, undefined, `<img src=x onerror="alert(1)">`);
        assert.ok(html.includes("default-src 'none'"), "CSP default-src 'none' present");
        assert.match(html, /script-src 'nonce-[0-9a-f]{32}'/, "per-render nonce present");
        assert.ok(html.includes("\\u003cimg"), "masked key markup is escaped before embedding into the script");
    });

    test("the webview script posts currentKeyMasked for the saveKey no-op guard", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5, undefined, "sk-or-v1-12…456");
        const payload = html.match(/vsc\.postMessage\(\{[^}]*type:\s*'saveKey'[^}]*\}\)/);
        assert.ok(payload, "the Save Key button posts a saveKey message");
        assert.match(
            payload![0],
            /currentKeyMasked:\s*currentKeyMask/,
            "the script must post currentKeyMasked (the handler's guard key) or the mask overwrites the real key"
        );
    });

    test("marks the remaining figure as exhausted for an exhausted guardrail", () => {
        const exhausted: KeyInfo = { ...BASE_INFO, usage_daily: 10 };
        const html = renderPanelHtml(exhausted, 10, "daily", true, 5);
        assert.ok(html.includes('class="remainingline exhausted"'));
        const ok = renderPanelHtml(BASE_INFO, 10, "daily", true, 5);
        assert.ok(!ok.includes('remainingline exhausted"'));
    });

    test("renders an error banner only when an error message is supplied", () => {
        const withErr = renderPanelHtml(BASE_INFO, 10, "daily", true, 5, undefined, "sk...", undefined, "Refresh failed: boom");
        assert.ok(withErr.includes('<div class="errbanner">Refresh failed: boom</div>'));
        const withoutErr = renderPanelHtml(BASE_INFO, 10, "daily", true, 5);
        assert.ok(!withoutErr.includes('<div class="errbanner">'));
    });

    test("disables reset period and BYOK controls when the guardrail is disabled", () => {
        const disabled = renderPanelHtml(BASE_INFO, 0, "daily", true, 5);
        assert.ok(disabled.includes('<select id="resetPeriod" disabled>'));
        assert.ok(disabled.includes('<input type="checkbox" id="includeByok" checked disabled'));
        const enabled = renderPanelHtml(BASE_INFO, 10, "daily", true, 5);
        assert.ok(!enabled.includes('<select id="resetPeriod" disabled>'));
        assert.ok(!enabled.includes('id="includeByok" checked disabled'));
    });

    test("shows the no-key placeholder when there is no info", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5);
        assert.ok(html.includes("No key info yet."));
        assert.ok(html.includes("No API key set"));
    });

    test("renders the custom request section, pre-filled from the saved template", () => {
        const template = { temperature: 0.2, provider: { quantizations: ["fp8"] } };
        const html = renderPanelHtml(undefined, 10, "daily", true, 5, undefined, undefined, undefined, undefined, template);
        assert.ok(html.includes(">Custom Request</div>"), "custom request section present");
        assert.ok(html.includes('id="saveTemplate">Save request</button>'), "Save request button present");
        assert.ok(!html.includes('id="clearTemplate"'), "Clear button removed");
        const prefill = html.match(/templateEl\.value = (.*);/);
        assert.ok(prefill, "template textarea is populated via script");
        assert.ok(JSON.parse(prefill![1]).includes('"quantizations"'), "saved template JSON is pre-filled");
    });

    test("renders the auto-refresh input merged with the updated line and no save button", () => {
        const html = renderPanelHtml(BASE_INFO, 10, "daily", true, 5, new Date());
        assert.ok(html.includes('id="refreshInterval"'), "auto-refresh interval input present");
        assert.ok(!html.includes('id="saveRefreshInterval"'), "save refresh interval button removed");
        assert.ok(/<div class="keyline updatedline">/.test(html), "interval and updated line share one row");
        assert.ok(html.includes("<span class=\"muted\">Updated "), "updated time present");
    });

    test("escapes the template value before embedding into the script", () => {
        const evil = { note: "</textarea><script>alert(1)</script>" };
        const html = renderPanelHtml(undefined, 10, "daily", true, 5, undefined, undefined, undefined, undefined, evil);
        assert.ok(!html.includes("</textarea><script>"), "raw script markup must not leak into the HTML");
        assert.ok(html.includes("\\u003c/textarea"), "dangerous characters are JSON-escaped in the textarea value");
        assert.ok(html.includes("\\u003c/script"), "script close tags are JSON-escaped too");
        assert.ok(html.includes("\\u003cscript"), "script open tags are JSON-escaped too");
        assert.ok(!html.includes("</script>alert(1)"), "the injected script body cannot terminate the page script");
    });

    test("renders the enforced-options footnote block with numbered anchors", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5);
        assert.ok(html.includes("How your pasted request is applied"), "footnote block title present");
        assert.ok(html.includes('class="footnotes"'), "footnote block wrapper present");
        assert.ok(html.includes('id="fn-1"'), "stream footnote anchor present");
        assert.ok(html.includes('id="fn-2"'), "session_id footnote anchor present");
        assert.ok(html.includes('id="fn-3"'), "application semantics footnote anchor present");
        assert.ok(html.includes('id="fn-4"'), "reasoning precedence footnote anchor present");
        assert.ok(html.includes('id="fn-5"'), "provider merge/passthrough footnote anchor present");
        assert.ok(html.includes('id="fn-6"'), "usage accounting footnote anchor present");
        assert.ok(html.includes('id="fn-7"'), "key storage footnote anchor present");
        assert.ok(html.includes('id="fn-8"'), "anthropic cache_control footnote anchor present");
        assert.ok(html.includes('id="fn-10"'), "per-turn usage footnote anchor present");
        assert.ok(html.includes("Session spend"), "the session-spend section is rendered");
    });

    test("footnote fn-2 states the real session_id behavior (no per-window random ID)", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5);
        assert.ok(html.includes("there is no per-window random ID"), "the no-random-id rule is documented");
        assert.ok(
            !html.includes("does a per-window random ID apply"),
            "the stale per-window-random-ID claim is removed"
        );
        assert.ok(
            html.includes("the most recently active chat\u2019s id is used instead"),
            "parent-chat attribution for internal calls is documented"
        );
    });

    test("footnote fn-10 documents the per-turn token and cost readout honestly", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5);
        assert.ok(html.includes('id="fn-10"'), "per-turn usage footnote anchor present");
        assert.ok(
            html.includes("forwards OpenRouter\u2019s own <code>usage</code> chunk"),
            "usage passthrough to Copilot documented"
        );
        assert.ok(html.includes("the context-usage ring shows used / max tokens"), "context ring documented");
        assert.ok(
            html.includes("Session spend"),
            "the real cost surface is named"
        );
        assert.ok(
            html.includes("cost_details.upstream_inference_cost"),
            "the BYOK cost fallback is documented"
        );
        assert.ok(
            !html.includes("response footer shows the turn"),
            "must not claim a footer cost that Copilot cannot render for this provider"
        );
        assert.ok(
            html.includes("never written into the chat transcript"),
            "must not imply cost is injected into the conversation"
        );
    });

    test("footnotes surface the anthropic cache_control and the verbatim passthrough rules", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5);
        assert.ok(
            html.includes("Anthropic-family models (<code>anthropic/*</code>) get a top-level <code>cache_control</code>"),
            "anthropic auto cache_control footnote present"
        );
        assert.ok(html.includes("unless your template sets its own <code>cache_control</code>"), "template cache_control override documented");
        assert.ok(
            html.includes("No built-in defaults"),
            "no-defaults footnote wording present"
        );
        assert.ok(
            html.includes("including a <code>provider</code> object, is sent verbatim to every request"),
            "verbatim passthrough footnote wording present"
        );
        assert.ok(html.includes("is sent verbatim to every request"), "passthrough rule wording present");
    });

    test("footnotes describe verbatim provider passthrough without quantization wording", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5);
        assert.ok(
            html.includes("including a <code>provider</code> object, is sent verbatim"),
            "verbatim provider passthrough described without routing defaults"
        );
        assert.ok(!html.includes("quantizations"), "no quantization-specific mention in the footnotes");
        assert.ok(!html.includes('<sup><a href="#'), "no standalone sup markers outside the list");
        assert.ok(
            !html.includes("always-applied quality floor"),
            "floor-specific provider-merge hint removed"
        );
    });
});

function fakeSecrets(initial?: string): vscode.SecretStorage & { stored: string | undefined } {
    const secrets = {
        stored: initial,
        get: async () => secrets.stored,
        store: async (_key: string, value: string) => {
            secrets.stored = value;
        },
        delete: async () => {
            secrets.stored = undefined;
        },
    };
    return secrets as unknown as vscode.SecretStorage & { stored: string | undefined };
}

function spyDeps(): {
    deps: PanelDeps;
    secrets: ReturnType<typeof fakeSecrets>;
    updates: Array<[string, unknown]>;
    errors: string[];
    infos: string[];
    refreshes: number;
    templates: string[];
    clearedTemplates: number;
    setKeys: string[];
    clearedKeys: number;
    syncedPresets: Array<string | undefined>;
} {
    const secrets = fakeSecrets();
    const state = {
        updates: [] as Array<[string, unknown]>,
        errors: [] as string[],
        infos: [] as string[],
        refreshes: 0,
        templates: [] as string[],
        clearedTemplates: 0,
        setKeys: [] as string[],
        clearedKeys: 0,
        syncedPresets: [] as Array<string | undefined>,
    };
    const deps: PanelDeps = {
        updateConfig: async (key, value) => {
            state.updates.push([key, value]);
        },
        error: (message) => {
            state.errors.push(message);
        },
        info: (message) => {
            state.infos.push(message);
        },
        doRefresh: async () => {
            state.refreshes++;
        },
        refresh: async () => {
            state.refreshes++;
        },
        saveTemplate: async (raw) => {
            state.templates.push(raw);
            if (stripTemplateComments(raw).trim().startsWith("{")) {
                return { ok: true };
            }
            return { ok: false, error: "The pasted text is not valid JSON." };
        },
        clearTemplate: async () => {
            state.clearedTemplates++;
        },
        setKey: async (value: string) => {
            state.setKeys.push(value);
            await secrets.store(KEY_SECRET, value);
        },
        clearKey: async () => {
            state.clearedKeys++;
            await secrets.delete(KEY_SECRET);
        },
        syncPresetSelection: (slug) => {
            state.syncedPresets.push(slug);
        },
    };
    return {
        deps,
        secrets,
        updates: state.updates,
        errors: state.errors,
        infos: state.infos,
        templates: state.templates,
        setKeys: state.setKeys,
        get refreshes() {
            return state.refreshes;
        },
        get clearedTemplates() {
            return state.clearedTemplates;
        },
        get clearedKeys() {
            return state.clearedKeys;
        },
        get syncedPresets() {
            return state.syncedPresets;
        },
    };
}

suite("handlePanelMessage", () => {
    test("saveKey with an empty field clears the key; otherwise trims/stores", async () => {
        const cleared = spyDeps();
        cleared.secrets.stored = "sk-old";
        await handlePanelMessage({ type: "saveKey", value: "   " }, cleared.deps);
        assert.strictEqual(cleared.secrets.stored, undefined);
        assert.deepStrictEqual(cleared.infos, ["API key cleared."]);
        assert.strictEqual(cleared.refreshes, 1);
        assert.strictEqual(cleared.errors.length, 0);
        assert.strictEqual(cleared.clearedKeys, 1);
        assert.deepStrictEqual(cleared.setKeys, []);

        const unchanged = spyDeps();
        unchanged.secrets.stored = "sk-old";
        await handlePanelMessage(
            { type: "saveKey", value: "sk-or-v1-123...456", currentKeyMasked: "sk-or-v1-123...456" },
            unchanged.deps
        );
        assert.strictEqual(unchanged.secrets.stored, "sk-old", "unchanged masked display must not overwrite the secret");
        assert.strictEqual(unchanged.refreshes, 0);
        assert.strictEqual(unchanged.clearedKeys, 0);
        assert.deepStrictEqual(unchanged.setKeys, []);

        const ok = spyDeps();
        await handlePanelMessage({ type: "saveKey", value: "  sk-or-v1-abc123  " }, ok.deps);
        assert.strictEqual(ok.secrets.stored, "sk-or-v1-abc123");
        assert.strictEqual(ok.refreshes, 1);
        assert.strictEqual(ok.errors.length, 0);
        assert.deepStrictEqual(ok.setKeys, ["sk-or-v1-abc123"]);
        assert.strictEqual(ok.clearedKeys, 0);
    });

    test("saveLimit rejects empty (would silently mean 0), negative, and non-numeric input", async () => {
        for (const value of ["", "   ", "-1", "abc"]) {
            const s = spyDeps();
            await handlePanelMessage({ type: "saveLimit", value }, s.deps);
            assert.deepStrictEqual(s.errors, ["invalid limit"], `value ${JSON.stringify(value)}`);
            assert.strictEqual(s.updates.length, 0);
            assert.strictEqual(s.refreshes, 0);
        }
        const ok = spyDeps();
        await handlePanelMessage({ type: "saveLimit", value: "25" }, ok.deps);
        assert.deepStrictEqual(ok.updates, [["creditLimit", 25]]);
        assert.strictEqual(ok.refreshes, 1);
    });

    test("saveResetPeriod rejects unknown cadences", async () => {
        const bad = spyDeps();
        await handlePanelMessage({ type: "saveResetPeriod", value: "hourly" }, bad.deps);
        assert.deepStrictEqual(bad.errors, ["invalid reset period"]);
        assert.strictEqual(bad.updates.length, 0);
        const ok = spyDeps();
        await handlePanelMessage({ type: "saveResetPeriod", value: "weekly" }, ok.deps);
        assert.deepStrictEqual(ok.updates, [["creditResetPeriod", "weekly"]]);
    });

    test("saveIncludeByok requires an actual boolean", async () => {
        const bad = spyDeps();
        await handlePanelMessage({ type: "saveIncludeByok", value: "false" }, bad.deps);
        assert.deepStrictEqual(bad.errors, ["invalid BYOK flag"]);
        assert.strictEqual(bad.updates.length, 0);
        const ok = spyDeps();
        await handlePanelMessage({ type: "saveIncludeByok", value: false }, ok.deps);
        assert.deepStrictEqual(ok.updates, [["creditIncludeByok", false]]);
    });

    test("saveRefreshInterval enforces the 1-1440 range", async () => {
        for (const value of ["0", "1441", "abc"]) {
            const s = spyDeps();
            await handlePanelMessage({ type: "saveRefreshInterval", value }, s.deps);
            assert.strictEqual(s.errors.length, 1, `value ${value}`);
            assert.match(s.errors[0], /invalid refresh interval/);
            assert.strictEqual(s.updates.length, 0);
        }
        const ok = spyDeps();
        await handlePanelMessage({ type: "saveRefreshInterval", value: "1440" }, ok.deps);
        assert.deepStrictEqual(ok.updates, [["creditRefreshIntervalMinutes", 1440]]);
    });

    test("clearKey deletes the secret and re-renders via the no-key refresh path", async () => {
        const s = spyDeps();
        s.secrets.stored = "sk-old";
        await handlePanelMessage({ type: "clearKey" }, s.deps);
        assert.strictEqual(s.secrets.stored, undefined);
        assert.deepStrictEqual(s.infos, ["API key cleared."]);
        assert.strictEqual(s.refreshes, 1);
        assert.strictEqual(s.clearedKeys, 1);
        assert.deepStrictEqual(s.setKeys, []);
    });

    test("saveTemplate passes the pasted JSON to the provider and confirms on success", async () => {
        const s = spyDeps();
        await handlePanelMessage({ type: "saveTemplate", value: '{"temperature":0.2}' }, s.deps);
        assert.deepStrictEqual(s.templates, ['{"temperature":0.2}']);
        assert.deepStrictEqual(s.infos, ["Custom request saved."]);
        assert.strictEqual(s.errors.length, 0);
        assert.strictEqual(s.clearedTemplates, 0);
        assert.deepStrictEqual(s.syncedPresets, [undefined], "no preset field to sync");
    });

    test("saveTemplate re-renders so the resolved preset comment block is refreshed", async () => {
        const s = spyDeps();
        await handlePanelMessage({ type: "saveTemplate", value: '{"preset":"faster-glm-flash"}' }, s.deps);
        assert.strictEqual(s.refreshes, 1, "a successful save triggers the same re-render path the loadPreset flow uses");
    });

    test("saveTemplate syncs the dropdown with the template's preset field", async () => {
        const s = spyDeps();
        await handlePanelMessage({ type: "saveTemplate", value: '{"preset":"faster-glm-flash","temperature":0.2}' }, s.deps);
        assert.deepStrictEqual(s.syncedPresets, ["faster-glm-flash"]);
    });

    test("saveTemplate with commented text still syncs the preset field", async () => {
        const s = spyDeps();
        await handlePanelMessage(
            { type: "saveTemplate", value: '// {"model": "z-ai/glm-5.3-flash-20260826"}\n{"preset":"faster-glm-flash"}' },
            s.deps
        );
        assert.deepStrictEqual(s.syncedPresets, ["faster-glm-flash"]);
        assert.deepStrictEqual(s.templates, ['// {"model": "z-ai/glm-5.3-flash-20260826"}\n{"preset":"faster-glm-flash"}']);
    });

    test("saveTemplate syncs a whitespace-only preset field as unloaded", async () => {
        const s = spyDeps();
        await handlePanelMessage({ type: "saveTemplate", value: '{"preset":" "}' }, s.deps);
        assert.deepStrictEqual(s.syncedPresets, [undefined], "a whitespace slug is not a preset reference");
    });

    test("saveTemplate surfaces the validation error and never saves bad input", async () => {
        const s = spyDeps();
        await handlePanelMessage({ type: "saveTemplate", value: "not json" }, s.deps);
        assert.deepStrictEqual(s.errors, ["The pasted text is not valid JSON."]);
        assert.deepStrictEqual(s.infos, []);
    });

    test("saveTemplate with an empty field behaves like Clear, never an error", async () => {
        const s = spyDeps();
        await handlePanelMessage({ type: "saveTemplate", value: "" }, s.deps);
        assert.strictEqual(s.clearedTemplates, 1);
        assert.deepStrictEqual(s.infos, ["Custom request cleared."]);
        assert.strictEqual(s.templates.length, 0);
        assert.strictEqual(s.errors.length, 0);
    });

    test("clearTemplate clears the stored template and unsyncs the dropdown", async () => {
        const s = spyDeps();
        await handlePanelMessage({ type: "clearTemplate" }, s.deps);
        assert.strictEqual(s.clearedTemplates, 1);
        assert.deepStrictEqual(s.infos, ["Custom request cleared."]);
        assert.deepStrictEqual(s.syncedPresets, [undefined]);
    });

    test("refresh and unknown messages do not mutate config", async () => {
        const s = spyDeps();
        await handlePanelMessage({ type: "refresh" }, s.deps);
        assert.strictEqual(s.refreshes, 1);
        const u = spyDeps();
        await handlePanelMessage({ type: "whatever", value: "x" }, u.deps);
        assert.strictEqual(u.refreshes, 0);
        assert.strictEqual(u.updates.length, 0);
        assert.strictEqual(u.errors.length, 0);
    });

    test("loadPreset saves the slug as a preset template and re-renders", async () => {
        const s = spyDeps();
        await handlePanelMessage({ type: "selectPreset", value: "@preset/faster-glm-flash" }, s.deps);
        assert.deepStrictEqual(s.templates, ['{"preset":"faster-glm-flash"}']);
        assert.deepStrictEqual(s.infos, ['Preset "faster-glm-flash" loaded as the request template.']);
        assert.strictEqual(s.refreshes, 1, "panel re-rendered via doRefresh so the textarea shows the template");
        assert.strictEqual(s.errors.length, 0);
        assert.strictEqual(s.clearedTemplates, 0);
    });

    test("selectPreset with the empty option unloads the preset and clears the custom request", async () => {
        for (const value of ["", "   ", "@preset/"]) {
            const s = spyDeps();
            await handlePanelMessage({ type: "selectPreset", value }, s.deps);
            assert.strictEqual(s.clearedTemplates, 1, `value ${JSON.stringify(value)}`);
            assert.deepStrictEqual(s.infos, ["Preset unloaded; custom request cleared."]);
            assert.strictEqual(s.templates.length, 0);
            assert.strictEqual(s.refreshes, 1);
            assert.strictEqual(s.errors.length, 0);
        }
    });

    test("selectPreset rejects path-like and spaced slugs", async () => {
        for (const value of ["../etc", "a b", "x/y", "{}"]) {
            const s = spyDeps();
            await handlePanelMessage({ type: "selectPreset", value }, s.deps);
            assert.deepStrictEqual(s.errors, ["invalid preset"], `value ${JSON.stringify(value)}`);
            assert.strictEqual(s.templates.length, 0);
            assert.strictEqual(s.clearedTemplates, 0);
            assert.strictEqual(s.refreshes, 0);
        }
    });

    test("selectPreset accepts slugs containing dots", async () => {
        const s = spyDeps();
        await handlePanelMessage({ type: "selectPreset", value: "custom.v1-router" }, s.deps);
        assert.deepStrictEqual(s.templates, ['{"preset":"custom.v1-router"}']);
        assert.strictEqual(s.errors.length, 0);
    });
});

suite("renderPanelHtml presets section", () => {
    const PRESETS = [
        { slug: "faster-glm-flash", name: "faster-glm-flash", model: "z-ai/glm-5.3-flash-20260826" },
        { slug: "custom-routing", name: "custom-routing" },
    ];

    test("renders a preset dropdown whose default option loads no preset", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5, undefined, undefined, undefined, undefined, undefined, PRESETS);
        assert.ok(html.includes(">Presets</div>"), "section title is just Presets");
        assert.ok(html.includes('id="presetSelect"'), "dropdown present");
        assert.ok(html.includes("<option value=\"\" selected>No preset loaded</option>"), "no-preset default selected");
        assert.ok(html.includes('value="faster-glm-flash"'), "model preset option present");
        assert.ok(html.includes("z-ai/glm-5.3-flash-20260826"), "model shown in the option label");
        assert.ok(html.includes("(routing profile)"), "model-less presets labelled");
        assert.ok(!html.includes('id="loadPresets"'), "no separate load button; the list loads with the panel");
    });

    test("pre-selects the preset referenced by the saved template", () => {
        const html = renderPanelHtml(
            undefined, 10, "daily", true, 5,
            undefined, undefined, undefined, undefined,
            { preset: "faster-glm-flash" },
            PRESETS
        );
        assert.ok(html.includes('<option value="faster-glm-flash" selected>'), "loaded preset selected");
        assert.ok(!html.includes('<option value="" selected>'), "default option not selected");
    });

    test("keeps a template preset that is missing from the list selectable", () => {
        const html = renderPanelHtml(
            undefined, 10, "daily", true, 5,
            undefined, undefined, undefined, undefined,
            { preset: "gone-preset" },
            PRESETS
        );
        assert.ok(html.includes('<option value="gone-preset" selected>gone-preset (not in list)</option>'));
    });

    test("an empty preset list says so; no presets never renders options", () => {
        const empty = renderPanelHtml(undefined, 10, "daily", true, 5, undefined, undefined, undefined, undefined, undefined, []);
        assert.ok(empty.includes("No presets found for this key."));
        assert.ok(!empty.includes('value="faster-glm-flash"'));
        const none = renderPanelHtml(undefined, 10, "daily", true, 5);
        assert.ok(!none.includes("No presets found for this key."));
        assert.ok(!none.includes('value="faster-glm-flash"'));
    });

    test("distinguishes a failed presets fetch from a legitimately empty list", () => {
        const failed = renderPanelHtml(undefined, 10, "daily", true, 5, undefined, undefined, undefined, undefined, undefined, undefined);
        assert.ok(failed.includes("Presets could not be loaded for this key."), "a failed fetch says so");
        assert.ok(!failed.includes("No presets found for this key."), "a failed fetch is not reported as an empty key");
        const empty = renderPanelHtml(undefined, 10, "daily", true, 5, undefined, undefined, undefined, undefined, undefined, []);
        assert.ok(empty.includes("No presets found for this key."), "an empty list keeps the empty wording");
        assert.ok(!empty.includes("Presets could not be loaded for this key."));
        const listed = renderPanelHtml(undefined, 10, "daily", true, 5, undefined, undefined, undefined, undefined, undefined, PRESETS);
        assert.ok(!listed.includes("Presets could not be loaded for this key."), "a list renders no failure hint");
        assert.ok(!listed.includes("No presets found for this key."), "a list renders no empty hint");
    });

    test("labels lookup-skipped presets apart from model-less routing profiles", () => {
        const presets = [
            { slug: "pinned", name: "pinned", model: "z-ai/glm-5.3-flash" },
            { slug: "skipped", name: "skipped", lookupSkipped: true },
            { slug: "no-model", name: "no-model" },
        ];
        const html = renderPanelHtml(undefined, 10, "daily", true, 5, undefined, undefined, undefined, undefined, undefined, presets);
        assert.ok(html.includes("skipped (lookup skipped)"), "a lookup-skipped preset is labelled distinctly");
        assert.ok(html.includes("no-model (routing profile)"), "a genuinely model-less preset keeps the routing-profile label");
        assert.ok(!html.includes("skipped (routing profile)"), "a skipped lookup is not mislabelled as a routing profile");
    });

    test("prefills the textarea with the JSON first and the resolved preset config as comments after it", () => {
        const config = { model: "z-ai/glm-5.3-flash-20260826", provider: { order: ["baseten", "makora"] } };
        const html = renderPanelHtml(
            undefined, 10, "daily", true, 5,
            undefined, undefined, undefined, undefined,
            { preset: "faster-glm-flash" },
            PRESETS,
            config
        );
        const prefill = html.match(/templateEl\.value = (.*);/);
        assert.ok(prefill, "template textarea is populated via script");
        const value = JSON.parse(prefill![1]) as string;
        const lines = value.split("\n");
        assert.deepStrictEqual(
            lines.slice(0, 3),
            ["{", '  "preset": "faster-glm-flash"', "}"],
            "the live template JSON comes first"
        );
        assert.ok(
            lines.some((l) => l === `//   "model": "z-ai/glm-5.3-flash-20260826",`),
            "the resolved config follows as commented JSON"
        );
        assert.strictEqual(JSON.parse(stripTemplateComments(value)).preset, "faster-glm-flash", "the live template survives comment stripping");
    });

    test("no comment block without a preset reference or without a resolved config", () => {
        const plain = renderPanelHtml(
            undefined, 10, "daily", true, 5,
            undefined, undefined, undefined, undefined,
            { temperature: 0.2 },
            PRESETS,
            { model: "x" }
        );
        const plainValue = JSON.parse(plain.match(/templateEl\.value = (.*);/)![1]) as string;
        assert.ok(!plainValue.includes("//"), "no comments when the template has no preset reference");
        const unresolved = renderPanelHtml(
            undefined, 10, "daily", true, 5,
            undefined, undefined, undefined, undefined,
            { preset: "faster-glm-flash" },
            PRESETS
        );
        const unresolvedValue = JSON.parse(unresolved.match(/templateEl\.value = (.*);/)![1]) as string;
        assert.ok(!unresolvedValue.includes("//"), "no comments when the preset config could not be resolved");
        assert.strictEqual(JSON.parse(unresolvedValue).preset, "faster-glm-flash");
    });

    test("a whitespace-only template preset is not treated as a loaded preset", () => {
        const html = renderPanelHtml(
            undefined, 10, "daily", true, 5,
            undefined, undefined, undefined, undefined,
            { preset: " " },
            PRESETS
        );
        assert.ok(html.includes('<option value="" selected>'), "the dropdown stays on the no-preset default");
        assert.ok(!html.includes('value=" "'), "no option is rendered for the whitespace slug");
    });

    test("the sync script adds a missing preset option so a saved preset is never silently unselected", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5);
        assert.ok(html.includes("appendChild(option)"), "the presetSelection handler appends a not-in-list option");
    });

    test("footnote fn-9 documents preset application without overriding the preset routing", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5);
        assert.ok(html.includes('id="fn-9"'), "preset footnote anchor present");
        assert.ok(html.includes('<code>"preset": "&lt;slug&gt;"</code>'), "preset template field documented");
        assert.ok(html.includes("<code>@preset/&lt;slug&gt;</code>"), "picker entry form documented");
        assert.ok(html.includes("other models are untouched while the custom request is empty"), "picker isolation documented");
        assert.ok(html.includes("the picker entry wins as the preset reference"), "picker-over-template preset precedence documented");
        assert.ok(html.includes("a pasted <code>provider</code> overrides it"), "template provider precedence documented");
    });
});
