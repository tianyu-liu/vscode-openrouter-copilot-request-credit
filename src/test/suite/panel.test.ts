import * as assert from "assert";
import * as vscode from "vscode";
import { handlePanelMessage, PanelDeps, renderPanelHtml } from "../../panel";
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

suite("renderPanelHtml", () => {
    test("ships a per-render nonce CSP and escapes the masked key into the script", () => {
        const html = renderPanelHtml(BASE_INFO, 10, "daily", true, 5, undefined, `<img src=x onerror="alert(1)">`);
        assert.ok(html.includes("default-src 'none'"), "CSP default-src 'none' present");
        assert.match(html, /script-src 'nonce-[0-9a-f]{32}'/, "per-render nonce present");
        assert.ok(html.includes("\\u003cimg"), "masked key markup is escaped before embedding into the script");
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
    });

    test("footnotes surface the anthropic cache_control and the verbatim passthrough rules", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5);
        assert.ok(
            html.includes("Anthropic-family models (<code>anthropic/*</code>) get a top-level <code>cache_control</code>"),
            "anthropic auto cache_control footnote present"
        );
        assert.ok(html.includes("unless your template sets its own <code>cache_control</code>"), "template cache_control override documented");
        assert.ok(
            html.includes("Pasted <code>provider</code> fields merge over the built-in defaults; everything else you paste is sent verbatim"),
            "provider merge and verbatim passthrough footnote present"
        );
        assert.ok(html.includes("is sent verbatim to every request"), "passthrough rule wording present");
    });

    test("footnotes generalize provider routing without quantization-specific wording", () => {
        const html = renderPanelHtml(undefined, 10, "daily", true, 5);
        assert.ok(
            html.includes("Pasted <code>provider</code> fields merge over the built-in defaults"),
            "provider merge described generically"
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
            if (raw.trim().startsWith("{")) {
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

    test("clearTemplate clears the stored template", async () => {
        const s = spyDeps();
        await handlePanelMessage({ type: "clearTemplate" }, s.deps);
        assert.strictEqual(s.clearedTemplates, 1);
        assert.deepStrictEqual(s.infos, ["Custom request cleared."]);
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
});
