import * as assert from "assert";
import * as vscode from "vscode";
import { handlePanelMessage, PanelDeps, renderPanelHtml } from "../../panel";
import { stripTemplateComments } from "../../provider";
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
        await handlePanelMessage({ type: "selectPreset", value: "lab.v1-router" }, s.deps);
        assert.deepStrictEqual(s.templates, ['{"preset":"lab.v1-router"}']);
        assert.strictEqual(s.errors.length, 0);
    });
});

suite("renderPanelHtml presets section", () => {
    const PRESETS = [
        { slug: "faster-glm-flash", name: "faster-glm-flash", model: "z-ai/glm-5.3-flash-20260826" },
        { slug: "lab-routing", name: "lab-routing" },
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
