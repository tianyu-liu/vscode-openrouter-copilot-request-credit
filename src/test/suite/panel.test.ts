import * as assert from "assert";
import * as vscode from "vscode";
import { runInNewContext } from "vm";
import type { ConnectionDefinition } from "../../connections";
import type { GatewayAllowance, GatewayLaneAllowance } from "../../gatewayAllowance";
import { handlePanelMessage, PanelDeps, PanelRenderOptions, renderPanelHtml, renderSessionCosts } from "../../panel";
import { SessionCost, stripTemplateComments, UNATTRIBUTED_SESSION_ID } from "../../provider";
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

function render(overrides: Partial<PanelRenderOptions> = {}): string {
    return renderPanelHtml({
        limit: 10,
        resetPeriod: "daily",
        includeByok: true,
        refreshIntervalMinutes: 5,
        ...overrides,
    });
}

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
        assert.ok(html.includes("2 calls \u00b7 82.3% cached"), html);
        const summary = (s: SessionCost) => renderSessionCosts([s]).match(/<span class="muted">([^<]*)<\/span>/)![1];
        assert.ok(!summary(sessionFixture({ promptTokens: 0, cachedTokens: 0 })).includes("cached"), "no rate at all");
    });

    test("call counts pluralize", () => {
        const one = renderSessionCosts([sessionFixture({ calls: 1 })]);
        assert.ok(one.includes("1 call \u00b7"), one);
        const many = renderSessionCosts([sessionFixture({ calls: 3 })]);
        assert.ok(many.includes("3 calls \u00b7"), many);
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
        const html = render();
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

    test("a chat-only list is unchanged: no unattributed entry or note", () => {
        const html = renderSessionCosts([sessionFixture(), sessionFixture({ sessionId: "copilot-chat:b", paid: 0.002 })]);
        assert.ok(!html.includes("Unattributed"), "no bucket row for harness-owned spend");
        assert.ok(!html.includes("carried no chat identifier"), "and no bucket note in the footer");
    });

    test("spend with no chat id renders as a labelled Unattributed entry", () => {
        const html = renderSessionCosts([
            sessionFixture({ sessionId: UNATTRIBUTED_SESSION_ID, byok: true }),
            sessionFixture({ sessionId: "copilot-chat:chat", paid: 0.002 }),
        ]);
        assert.strictEqual((html.match(/<details/g) ?? []).length, 2, "one row per chat plus the bucket");
        assert.ok(html.includes("Unattributed (no chat id)"), "the bucket is labelled");
        assert.ok(!html.includes("OpenRouter session <code>unattributed"), "the bucket is not described as an OpenRouter session");
        assert.ok(html.includes("Spend that reached OpenRouter with no Copilot chat identifier"), "the bucket explains itself");
        assert.ok(html.includes("no <code>session_id</code> is sent for it"), "the bucket notes no session id is sent");
    });

    test("the bucket is expanded when it is the only entry", () => {
        const html = renderSessionCosts([sessionFixture({ sessionId: UNATTRIBUTED_SESSION_ID })]);
        assert.strictEqual((html.match(/\bopen\b/g) ?? []).length, 1, "the lone entry is expanded");
        assert.ok(html.includes("Unattributed (no chat id)"), html);
    });

    test("a chat keeps the expansion when a bucket is also present", () => {
        const html = renderSessionCosts([
            sessionFixture({ sessionId: UNATTRIBUTED_SESSION_ID }),
            sessionFixture({ sessionId: "copilot-chat:chat", paid: 0.002 }),
        ]);
        const bucketAt = html.indexOf("Unattributed (no chat id)");
        const chatAt = html.indexOf("copilot-chat:chat");
        assert.ok(bucketAt > chatAt, "the bucket is listed last");
        assert.strictEqual((html.match(/\bopen\b/g) ?? []).length, 1, "only the newest chat is expanded");
        assert.ok(html.slice(0, bucketAt).includes(" open"), "the chat carries the expansion, not the bucket");
    });

    test("the empty state mentions the unattributed bucket", () => {
        const html = renderSessionCosts([]);
        assert.ok(html.includes("No OpenRouter spend recorded yet"), html);
        assert.ok(html.includes("<strong>Unattributed</strong>"), "so a byok agent-host session is not a mystery");
    });

    test("a zero-spend bucket is omitted like any other session", () => {
        const html = renderSessionCosts([sessionFixture({ sessionId: UNATTRIBUTED_SESSION_ID, paid: 0, upstream: 0, openRouter: 0 })]);
        assert.ok(!html.includes("<details"), "nothing was spent, so no entry is rendered");
        assert.ok(!html.includes("Unattributed (no chat id)"), "not even a labelled one");
        assert.ok(html.includes("No OpenRouter spend recorded yet"), "the list falls back to the empty state");
    });
});

suite("renderPanelHtml", () => {
    test("renders Settings followed by accessible named connection tabs", () => {
        const html = render();
        assert.match(html, /id="tab-settings" role="tab" aria-selected="true" aria-controls="panel-settings" tabindex="0">Settings<\/button>/);
        assert.match(html, /id="tab-connection-default" data-connection-id="default" role="tab" aria-selected="false" aria-controls="panel-connection" tabindex="-1">OpenRouter: RC<\/button>/);
        const settings = html.slice(html.indexOf('id="panel-settings"'), html.indexOf('id="panel-connection"'));
        const connection = html.slice(html.indexOf('id="panel-connection"'), html.indexOf('<script nonce='));
        assert.ok(settings.includes('id="key"') && settings.includes('id="connectionForm"'));
        assert.ok(settings.includes('id="outputReservePercent"') && settings.includes('id="refreshInterval"'));
        for (const text of ['Credit usage', 'Session spend', 'Custom request']) assert.ok(connection.includes(text));
        assert.ok(!connection.includes('id="key"') && !connection.includes('id="outputReservePercent"'));
    });

    test("restores the active tab from VS Code webview state, falling back to the first tab", () => {
        const html = render();
        assert.match(html, /const initialTab = tabs\.find\(\(tab\) => tab\.id === draft\.activeTab\) \|\| tabs\[0\]/);
        assert.match(html, /draft\.activeTab = tab\.id/);
        assert.match(html, /vsc\.setState\(\{/);
    });

    test("ships a per-render nonce CSP and escapes the masked key into the script", () => {
        const html = render({ info: BASE_INFO, maskedKey: `<img src=x onerror="alert(1)">` });
        assert.ok(html.includes("default-src 'none'"), "CSP default-src 'none' present");
        assert.match(html, /script-src 'nonce-[0-9a-f]{32}'/, "per-render nonce present");
        assert.ok(html.includes("\\u003cimg"), "masked key markup is escaped before embedding into the script");
    });

    test("the webview script posts currentKeyMasked for the saveKey no-op guard", () => {
        const html = render({ maskedKey: "sk-or-v1-12…456" });
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
        const html = render({ info: exhausted });
        assert.ok(html.includes('class="remainingline exhausted"'));
        const ok = render({ info: BASE_INFO });
        assert.ok(!ok.includes('remainingline exhausted"'));
    });

    test("renders an error banner only when an error message is supplied", () => {
        const withErr = render({ info: BASE_INFO, maskedKey: "sk...", errorMessage: "Refresh failed: boom" });
        assert.ok(withErr.includes('<div class="errbanner">Refresh failed: boom</div>'));
        const withoutErr = render({ info: BASE_INFO });
        assert.ok(!withoutErr.includes('<div class="errbanner">'));
    });

    test("keeps reset period and BYOK controls editable when the guardrail is disabled", () => {
        const disabled = render({ info: BASE_INFO, limit: 0 });
        assert.ok(disabled.includes('<select id="resetPeriod" aria-label="Spending limit reset period"'));
        assert.ok(disabled.includes('<input type="checkbox" id="includeByok" checked title='));
        const enabled = render({ info: BASE_INFO });
        assert.ok(enabled.includes('<select id="resetPeriod" aria-label="Spending limit reset period"'));
        assert.ok(enabled.includes('id="includeByok" checked title='));
    });

    test("auto mode disables the ignored local controls and seeds the key's own limit", () => {
        const autoInfo: KeyInfo = {
            ...BASE_INFO,
            limit: 25,
            limit_reset: "daily",
            limit_remaining: 17,
            include_byok_in_limit: false,
        };
        const html = render({ info: autoInfo, maskedKey: "sk...", limit: 10 });
        assert.ok(html.includes('id="limit" min="0" step="0.01" value="25" disabled'), html);
        assert.ok(
            html.includes('<select id="resetPeriod" aria-label="Spending limit reset period" title="How often the local spending limit resets" disabled>'),
            "the local reset period is disabled"
        );
        assert.match(html, /id="includeByok"\s+disabled/, "the checkbox is read-only");
        assert.ok(!html.includes('id="includeByok" checked'), "the key's include_byok_in_limit=false is shown honestly");
        assert.ok(html.includes("Include BYOK usage (set on the key)"));
        assert.ok(html.includes("The key has its own server-side limit; these local controls apply only when it has none."));
        const included: KeyInfo = { ...autoInfo, include_byok_in_limit: true };
        assert.ok(render({ info: included }).includes('id="includeByok" checked '), "the key's true flag renders checked");
    });

    test("weekly guardrail labels its trailing window instead of a Monday reset", () => {
        const html = render({ info: BASE_INFO, resetPeriod: "weekly" });
        assert.ok(html.includes("Rolling 7-day window"), html);
        assert.ok(!html.includes("Next reset:"), "no fictional Monday reset date");
    });

    test("offers a Clear key action wired to the clearKey message only when a key is set", () => {
        const withKey = render({ maskedKey: "sk-or-v1-12\u2026456" });
        assert.ok(withKey.includes('<button id="clearKey">Clear key</button>'));
        assert.ok(withKey.includes("post('clearKey')"));
        assert.ok(!render().includes('id="clearKey"'), "nothing to clear without a stored key");
    });

    test("persists unsaved drafts through webview state, debounced, and restores them", () => {
        const html = render();
        for (const field of ["connectionDrafts", "sharedDraft", "templateBase", "presetBase", "reservePercent", "reserveMin", "reserveMax"]) {
            assert.ok(html.includes(field), `${field} is persisted`);
        }
        assert.ok(!html.includes("draftKey"), "the unsaved key is never persisted into webview state");
        assert.match(html, /setTimeout\(persistState, 250\)/, "draft persistence is debounced");
        assert.ok(html.includes("templateEl.value = draft.template"), "the template draft is restored");
        assert.ok(html.includes("restorePreset(draft.preset)"), "the preset draft is restored");
        assert.ok(html.includes("el.value = draft[prop]"), "reserve drafts are restored");
        assert.ok(html.includes("m.type === 'templateCleared'"), "the clear-template command clears the textarea draft");
    });

    test("the output-reserve row uses a well-formed class attribute", () => {
        const html = render();
        const reserveStart = html.indexOf("Output reserve");
        const reserve = html.slice(reserveStart, html.indexOf("Prompt safeguard", reserveStart));
        assert.ok(reserve.includes('<div class="keyline">'), "the reserve row uses the keyline class");
        assert.ok(!html.includes('class="keyline\''), "no stray quote inside the class attribute");
        assert.ok(!/<div class="[^"]*'/.test(html), "every div class attribute is closed with a double quote");
    });

    test("shows the no-key placeholder when there is no info", () => {
        const html = render();
        assert.ok(html.includes("No usage information yet."));
        assert.ok(html.includes("No API key set"));
    });

    test("renders editable controls for all contributed settings without key details", () => {
        const html = render();
        for (const id of [
            "limit",
            "resetPeriod",
            "includeByok",
            "refreshInterval",
            "sanitizeBase64",
            "hideUnavailableModels",
            "outputReservePercent",
            "outputReserveMinTokens",
            "outputReserveMaxTokens",
        ]) {
            assert.ok(html.includes(`id="${id}"`), `${id} control is rendered`);
        }
        assert.ok(!html.includes('id="limit" min="0" step="0.01" value="10" disabled'));
        assert.ok(html.includes('id="sanitizeBase64" checked'));
        assert.ok(html.includes('id="hideUnavailableModels" checked'), "hide-unavailable defaults on");
        assert.ok(html.includes('id="outputReservePercent" min="1" max="50" step="0.5" aria-label="Output reserve as percent of window" value="12.5"'));
        assert.ok(html.includes('id="outputReserveMinTokens" min="0.5" step="0.5" aria-label="Lower bound on the output reserve in K" value="16.384"'));
        assert.ok(html.includes('id="outputReserveMaxTokens" min="0.5" step="0.5" aria-label="Upper bound on the output reserve in K" value="262.144"'));
        assert.ok(html.includes('input[type=number]::-webkit-inner-spin-button'), "number inputs hide the step buttons");
        assert.ok(html.includes('for="outputReservePercent">Target:</label>'), "ratio field is labelled Target");
        assert.ok(html.includes('for="outputReserveMinTokens">Lower limit:</label>'));
        assert.ok(html.includes('for="outputReserveMaxTokens">Upper limit:</label>'));
        assert.ok(html.includes('title="Refresh usage data every 1 to 1440 minutes"'));
        assert.ok(html.includes('aria-label="Spending limit reset period"'));
    });

    test("renders the custom request section, pre-filled from the saved template", () => {
        const template = { temperature: 0.2, provider: { quantizations: ["fp8"] } };
        const html = render({ template });
        assert.ok(html.includes(">Custom request</div>"), "custom request section present");
        assert.ok(html.includes('id="saveTemplate">Save request</button>'), "Save request button present");
        assert.ok(!html.includes('id="clearTemplate"'), "Clear button removed");
        const prefill = html.match(/templateEl\.value = (.*);/);
        assert.ok(prefill, "template textarea is populated via script");
        assert.ok(JSON.parse(prefill![1]).includes('"quantizations"'), "saved template JSON is pre-filled");
    });

    test("renders the auto-refresh input merged with the updated line and no save button", () => {
        const html = render({ info: BASE_INFO, fetchedAt: new Date() });
        assert.ok(html.includes('id="refreshInterval"'), "auto-refresh interval input present");
        assert.ok(!html.includes('id="saveRefreshInterval"'), "save refresh interval button removed");
        assert.ok(/<div class="keyline updatedline">/.test(html), "interval and updated line share one row");
        assert.ok(html.includes("<span class=\"muted\">Updated "), "updated time present");
    });

    test("escapes the template value before embedding into the script", () => {
        const evil = { note: "</textarea><script>alert(1)</script>" };
        const html = render({ template: evil });
        assert.ok(!html.includes("</textarea><script>"), "raw script markup must not leak into the HTML");
        assert.ok(html.includes("\\u003c/textarea"), "dangerous characters are JSON-escaped in the textarea value");
        assert.ok(html.includes("\\u003c/script"), "script close tags are JSON-escaped too");
        assert.ok(html.includes("\\u003cscript"), "script open tags are JSON-escaped too");
        assert.ok(!html.includes("</script>alert(1)"), "the injected script body cannot terminate the page script");
    });

    test("escapes the template preset before embedding it into the script", () => {
        const html = render({ template: { preset: "</script><img src=x onerror=1>" } });
        assert.ok(html.includes('preset: "\\u003c/script>'), "the preset channel is escaped");
        assert.ok(!html.includes('preset: "</script>'), "raw preset markup cannot close the page script");
    });

    test("places concise guidance with the relevant panel sections", () => {
        const html = render();
        const settingsStart = html.indexOf('<section class="tab-panel" id="panel-settings"');
        const connectionStart = html.indexOf('<section class="tab-panel" id="panel-connection"');
        const scriptStart = html.indexOf('<script nonce=');
        const settings = html.slice(settingsStart, connectionStart);
        const request = html.slice(connectionStart, scriptStart);
        assert.ok(settings.includes("SecretStorage"), "key storage note stays with key controls");
        assert.ok(settings.includes('id="outputReservePercent"'), "reserve controls live in Settings");
        assert.ok(settings.includes('class="fieldgroup"'), "reserve fields are grouped");
        assert.strictEqual(settings.match(/<span class="sep">\.<\/span>/g)?.length, 2);
        assert.ok(request.includes("BYOK routes:</strong> When OpenRouter reports zero"));
        assert.ok(request.includes("Responses stream automatically"));
        assert.ok(request.includes("No routing is added automatically"));
        assert.ok(html.includes('aria-label="OpenRouter API key"'), "key input has an accessible name");
        assert.ok(html.includes('aria-label="Custom request JSON"'), "request editor has an accessible name");
        assert.ok(!html.includes("id=\"fn-"), "numbered internal footnote anchors are removed");
        assert.ok(!html.includes('id="panel-context"'), "the Context tab is retired");
    });

    test("renders every note in the unified bold-term list format", () => {
        const html = render({
            sessions: [
                sessionFixture(),
                sessionFixture({ sessionId: UNATTRIBUTED_SESSION_ID, paid: 0.002 }),
            ],
        });
        for (const term of [
            "Storage",
            "Hide unavailable models",
            "Session list",
            "BYOK routes",
            "Unattributed",
            "Output reserve",
            "Prompt sanitization",
            "Preset selection",
            "Picker presets",
            "Streaming",
            "Live conversation",
            "Thinking effort",
            "Provider routing",
            "Anthropic caching",
        ]) {
            assert.ok(html.includes(`<li><strong>${term}:</strong>`), `${term} note is a list item`);
        }
        assert.ok(!html.includes('<p class="helptext"><strong>'), "no note renders as a standalone paragraph");
    });

    test("request guidance states cache behavior and avoids blanket verbatim passthrough", () => {
        const html = render();
        assert.ok(
            html.includes("Anthropic-family models (<code>anthropic/*</code>, including <code>~anthropic/*</code>) get a top-level, 5-minute <code>cache_control</code>"),
            "anthropic auto cache_control footnote present"
        );
        assert.ok(
            html.includes("No routing is added automatically. A pasted <code>provider</code> object passes through unchanged."),
            "provider routing passthrough is clear"
        );
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
            assert.deepStrictEqual(s.errors, ["Enter a limit of 0 or more."], `value ${JSON.stringify(value)}`);
            assert.strictEqual(s.updates.length, 0);
            assert.strictEqual(s.refreshes, 0);
        }
        const ok = spyDeps();
        await handlePanelMessage({ type: "saveLimit", value: "25" }, ok.deps);
        assert.deepStrictEqual(ok.updates, [["creditLimit", 25]]);
        assert.strictEqual(
            ok.refreshes,
            0,
            "saveConfig does not refresh; the config-change listener owns the refresh"
        );
    });

    test("saveResetPeriod rejects unknown cadences", async () => {
        const bad = spyDeps();
        await handlePanelMessage({ type: "saveResetPeriod", value: "hourly" }, bad.deps);
        assert.deepStrictEqual(bad.errors, ["Select a valid reset period."]);
        assert.strictEqual(bad.updates.length, 0);
        const ok = spyDeps();
        await handlePanelMessage({ type: "saveResetPeriod", value: "weekly" }, ok.deps);
        assert.deepStrictEqual(ok.updates, [["creditResetPeriod", "weekly"]]);
    });

    test("saveIncludeByok requires an actual boolean", async () => {
        const bad = spyDeps();
        await handlePanelMessage({ type: "saveIncludeByok", value: "false" }, bad.deps);
        assert.deepStrictEqual(bad.errors, ["Choose whether BYOK usage counts."]);
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
            assert.match(s.errors[0], /Enter a refresh interval from 1 to 1440 minutes\./);
            assert.strictEqual(s.updates.length, 0);
        }
        const ok = spyDeps();
        await handlePanelMessage({ type: "saveRefreshInterval", value: "1440" }, ok.deps);
        assert.deepStrictEqual(ok.updates, [["creditRefreshIntervalMinutes", 1440]]);
    });

    test("saveSanitizeBase64 requires a boolean and updates the setting", async () => {
        const bad = spyDeps();
        await handlePanelMessage({ type: "saveSanitizeBase64", value: "false" }, bad.deps);
        assert.deepStrictEqual(bad.errors, ["Choose whether long base64-like text is removed."]);
        assert.strictEqual(bad.updates.length, 0);
        const ok = spyDeps();
        await handlePanelMessage({ type: "saveSanitizeBase64", value: false }, ok.deps);
        assert.deepStrictEqual(ok.updates, [["sanitizeBase64Content", false]]);
        assert.strictEqual(ok.refreshes, 0, "the config-change listener owns the panel re-render");
    });

    test("saveHideUnavailableModels requires a boolean and updates the setting", async () => {
        const bad = spyDeps();
        await handlePanelMessage({ type: "saveHideUnavailableModels", value: "false" }, bad.deps);
        assert.deepStrictEqual(bad.errors, ["Choose whether unavailable models are hidden."]);
        assert.strictEqual(bad.updates.length, 0);
        const ok = spyDeps();
        await handlePanelMessage({ type: "saveHideUnavailableModels", value: false }, ok.deps);
        assert.deepStrictEqual(ok.updates, [["hideUnavailableModels", false]]);
        assert.strictEqual(ok.refreshes, 0, "the config-change listener owns the model-info rebuild");
    });

    test("saveOutputReservePercent enforces the 1-50 range", async () => {
        for (const value of ["0", "51", "abc"]) {
            const s = spyDeps();
            await handlePanelMessage({ type: "saveOutputReservePercent", value }, s.deps);
            assert.strictEqual(s.errors.length, 1, `value ${value}`);
            assert.match(s.errors[0], /Enter an output reserve from 1% to 50%\./);
            assert.strictEqual(s.updates.length, 0);
        }
        const ok = spyDeps();
        await handlePanelMessage({ type: "saveOutputReservePercent", value: "12.5" }, ok.deps);
        assert.deepStrictEqual(ok.updates, [["outputReservePercent", 12.5]]);
    });

    test("saveOutputReserveMinTokens requires a positive token count", async () => {
        for (const value of ["0", "-5", "abc"]) {
            const s = spyDeps();
            await handlePanelMessage({ type: "saveOutputReserveMinTokens", value }, s.deps);
            assert.strictEqual(s.errors.length, 1, `value ${value}`);
            assert.match(s.errors[0], /Enter an output reserve lower limit above 0 K\./);
            assert.strictEqual(s.updates.length, 0);
        }
        const ok = spyDeps();
        await handlePanelMessage({ type: "saveOutputReserveMinTokens", value: "8" }, ok.deps);
        assert.deepStrictEqual(ok.updates, [["outputReserveMinTokens", 8000]], "K is converted to tokens (decimal)");
        const frac = spyDeps();
        await handlePanelMessage({ type: "saveOutputReserveMinTokens", value: "8.5" }, frac.deps);
        assert.deepStrictEqual(frac.updates, [["outputReserveMinTokens", 8500]]);
    });

    test("saveOutputReserveMaxTokens requires a positive token count", async () => {
        for (const value of ["0", "-5", "abc"]) {
            const s = spyDeps();
            await handlePanelMessage({ type: "saveOutputReserveMaxTokens", value }, s.deps);
            assert.strictEqual(s.errors.length, 1, `value ${value}`);
            assert.match(s.errors[0], /Enter an output reserve upper limit above 0 K\./);
            assert.strictEqual(s.updates.length, 0);
        }
        const ok = spyDeps();
        await handlePanelMessage({ type: "saveOutputReserveMaxTokens", value: "128" }, ok.deps);
        assert.deepStrictEqual(ok.updates, [["outputReserveMaxTokens", 128000]], "K is converted to tokens (decimal)");
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
            assert.deepStrictEqual(s.errors, ["Enter a valid preset slug."], `value ${JSON.stringify(value)}`);
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
        const html = render({ presets: PRESETS });
        assert.ok(html.includes(">Presets</div>"), "section title is just Presets");
        assert.ok(html.includes('id="presetSelect"'), "dropdown present");
        assert.ok(html.includes("<option value=\"\" selected>No preset loaded</option>"), "no-preset default selected");
        assert.ok(html.includes('value="faster-glm-flash"'), "model preset option present");
        assert.ok(html.includes("z-ai/glm-5.3-flash-20260826"), "model shown in the option label");
        assert.ok(html.includes("(routing profile)"), "model-less presets labelled");
        assert.ok(!html.includes('id="loadPresets"'), "no separate load button; the list loads with the panel");
    });

    test("pre-selects the preset referenced by the saved template", () => {
        const html = render({ template: { preset: "faster-glm-flash" }, presets: PRESETS });
        assert.ok(html.includes('<option value="faster-glm-flash" selected>'), "loaded preset selected");
        assert.ok(!html.includes('<option value="" selected>'), "default option not selected");
    });

    test("keeps a template preset that is missing from the list selectable", () => {
        const html = render({ template: { preset: "gone-preset" }, presets: PRESETS });
        assert.ok(html.includes('<option value="gone-preset" selected>gone-preset (not in list)</option>'));
    });

    test("an empty preset list says so; no presets never renders options", () => {
        const empty = render({ presets: [] });
        assert.ok(empty.includes("No presets found for this key."));
        assert.ok(!empty.includes('value="faster-glm-flash"'));
        const none = render();
        assert.ok(!none.includes("No presets found for this key."));
        assert.ok(!none.includes('value="faster-glm-flash"'));
    });

    test("distinguishes a failed presets fetch from a legitimately empty list", () => {
        const failed = render();
        assert.ok(failed.includes("Presets could not be loaded for this key."), "a failed fetch says so");
        assert.ok(!failed.includes("No presets found for this key."), "a failed fetch is not reported as an empty key");
        const empty = render({ presets: [] });
        assert.ok(empty.includes("No presets found for this key."), "an empty list keeps the empty wording");
        assert.ok(!empty.includes("Presets could not be loaded for this key."));
        const listed = render({ presets: PRESETS });
        assert.ok(!listed.includes("Presets could not be loaded for this key."), "a list renders no failure hint");
        assert.ok(!listed.includes("No presets found for this key."), "a list renders no empty hint");
    });

    test("labels lookup-skipped presets apart from model-less routing profiles", () => {
        const presets = [
            { slug: "pinned", name: "pinned", model: "z-ai/glm-5.3-flash" },
            { slug: "skipped", name: "skipped", lookupSkipped: true },
            { slug: "no-model", name: "no-model" },
        ];
        const html = render({ presets });
        assert.ok(html.includes("skipped (model not checked)"), "a lookup-skipped preset is labelled distinctly");
        assert.ok(html.includes("no-model (routing profile)"), "a genuinely model-less preset keeps the routing-profile label");
        assert.ok(!html.includes("skipped (routing profile)"), "a skipped lookup is not mislabelled as a routing profile");
    });

    test("prefills the textarea with the JSON first and the resolved preset config as comments after it", () => {
        const config = { model: "z-ai/glm-5.3-flash-20260826", provider: { order: ["baseten", "makora"] } };
        const html = render({ template: { preset: "faster-glm-flash" }, presets: PRESETS, presetConfig: config });
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
        const plain = render({ template: { temperature: 0.2 }, presets: PRESETS, presetConfig: { model: "x" } });
        const plainValue = JSON.parse(plain.match(/templateEl\.value = (.*);/)![1]) as string;
        assert.ok(!plainValue.includes("//"), "no comments when the template has no preset reference");
        const unresolved = render({ template: { preset: "faster-glm-flash" }, presets: PRESETS });
        const unresolvedValue = JSON.parse(unresolved.match(/templateEl\.value = (.*);/)![1]) as string;
        assert.ok(!unresolvedValue.includes("//"), "no comments when the preset config could not be resolved");
        assert.strictEqual(JSON.parse(unresolvedValue).preset, "faster-glm-flash");
    });

    test("a whitespace-only template preset is not treated as a loaded preset", () => {
        const html = render({ template: { preset: " " }, presets: PRESETS });
        assert.ok(html.includes('<option value="" selected>'), "the dropdown stays on the no-preset default");
        assert.ok(!html.includes('value=" "'), "no option is rendered for the whitespace slug");
    });

    test("the sync script adds a missing preset option so a saved preset is never silently unselected", () => {
        const html = render();
        assert.ok(html.includes("appendChild(option)"), "the presetSelection handler appends a not-in-list option");
    });

    test("preset guidance explains replacement and picker precedence", () => {
        const html = render();
        assert.ok(html.includes('<strong>Preset selection:</strong> Selecting a preset replaces the saved request with <code>{"preset": "&lt;slug&gt;"}</code>'));
        assert.ok(html.includes('Selecting "No preset loaded" clears it.'));
        assert.ok(html.includes("<code>@preset/&lt;slug&gt;</code>"), "picker entry form documented");
        assert.ok(html.includes("takes precedence over a different template preset"), "picker preset precedence documented");
    });
});

function connectionFixture(id: string, kind: ConnectionDefinition['kind'] = 'openrouter'): ConnectionDefinition {
    return {
        id, name: id.toUpperCase(), kind,
        baseUrl: kind === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'http://localhost:1234/v1',
        enabled: true, revision: 1,
        settings: { creditLimit: 10, creditResetPeriod: 'daily', creditIncludeByok: true, hideUnavailableModels: true },
    };
}

/** Run the actual webview script with a small DOM seam; no extension host messages leave this harness. */
function webviewHarness(options: Partial<PanelRenderOptions>, savedState: unknown = {}) {
    class Element {
        value = '';
        type = '';
        hidden = false;
        disabled = false;
        tabIndex = -1;
        dataset: Record<string, string> = {};
        attributes: Record<string, string> = {};
        options: Element[] = [];
        listeners: Record<string, Array<(event: unknown) => void>> = {};
        textContent = '';
        constructor(readonly id: string) {}
        addEventListener(type: string, fn: (event: unknown) => void) {
            (this.listeners[type] ??= []).push(fn);
        }
        setAttribute(name: string, value: string) { this.attributes[name] = value; }
        getAttribute(name: string) { return this.attributes[name]; }
        appendChild(element: Element) { this.options.push(element); }
        focus() {}
        fire(type: string, event = {}) { for (const listener of this.listeners[type] ?? []) listener(event); }
    }
    const html = render(options);
    const elements = new Map<string, Element>();
    const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    for (const match of html.matchAll(/<\w+\b([^>]*?\sid="([^"]+)"[^>]*)>/g)) {
        const element = new Element(match[2]);
        for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) element.attributes[attr[1]] = decode(attr[2]);
        element.value = element.attributes.value ?? '';
        element.type = element.attributes.type ?? '';
        if (element.attributes['data-connection-id']) element.dataset.connectionId = element.attributes['data-connection-id'];
        elements.set(element.id, element);
    }
    const tabs = [...elements.values()].filter(element => element.attributes.role === 'tab');
    const messages: Array<Record<string, unknown>> = [];
    const timers = new Map<number, () => void>();
    const incomingListeners: Array<(event: unknown) => void> = [];
    let state = savedState;
    let timerId = 0;
    runInNewContext(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1], {
        acquireVsCodeApi: () => ({
            getState: () => state,
            setState: (value: unknown) => { state = JSON.parse(JSON.stringify(value)); },
            postMessage: (value: Record<string, unknown>) => messages.push(JSON.parse(JSON.stringify(value))),
        }),
        document: {
            getElementById: (id: string) => elements.get(id),
            querySelectorAll: () => tabs,
            createElement: () => new Element(''),
        },
        window: { addEventListener: (type: string, listener: (event: unknown) => void) => {
            if (type === 'message') incomingListeners.push(listener);
        } },
        setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
        clearTimeout: (id: number) => timers.delete(id),
    });
    return {
        get state() { return state; },
        messages,
        receive: (data: unknown) => { for (const listener of incomingListeners) listener({ data }); },
        element: (id: string) => elements.get(id)!,
        flush: () => { for (const fn of [...timers.values()]) fn(); timers.clear(); },
    };
}

suite('connection panel', () => {
    const connections = [connectionFixture('a'), connectionFixture('b')];
    test('per-connection messages retain their rendered origin after selecting another tab', () => {
        const view = webviewHarness({ connections, selectedConnectionId: 'a' });
        view.element('tab-connection-b').fire('click');
        view.element('saveTemplate').fire('click');
        view.element('outputReservePercent').fire('change');
        assert.deepStrictEqual(view.messages[0], { type: 'selectConnection', connectionId: 'b' });
        assert.deepStrictEqual(view.messages[1], { type: 'saveTemplate', value: '', connectionId: 'a' });
        assert.strictEqual(view.messages[2].type, 'saveOutputReservePercent');
        assert.ok(!('connectionId' in view.messages[2]), 'shared setting does not carry a connection scope');
    });

    test('request drafts remain separate through connection switches and refreshes', () => {
        const a = webviewHarness({ connections, selectedConnectionId: 'a', template: { temperature: 0.1 } });
        a.element('template').value = '{"temperature":0.8}';
        a.element('template').fire('input');
        a.flush();
        const b = webviewHarness({ connections, selectedConnectionId: 'b', template: { temperature: 0.2 } }, a.state);
        assert.ok(b.element('template').value.includes('0.2'), 'A draft is not shown for B');
        b.element('template').value = '{"temperature":0.9}';
        b.element('template').fire('input');
        b.flush();
        const restored = webviewHarness({ connections, selectedConnectionId: 'a', template: { temperature: 0.1 } }, b.state);
        assert.strictEqual(restored.element('template').value, '{"temperature":0.8}');
        const updated = webviewHarness({ connections, selectedConnectionId: 'a', template: { temperature: 0.3 } }, b.state);
        assert.ok(updated.element('template').value.includes('0.3'), 'new saved template replaces a stale draft');
    });

    test('incoming clear and preset events cannot change another connection’s request draft', () => {
        const view = webviewHarness({ connections, selectedConnectionId: 'a' });
        view.element('template').value = '{"temperature":0.8}';
        view.element('template').fire('input');
        view.flush();
        const before = JSON.stringify(view.state);
        view.receive({ type: 'templateCleared', connectionId: 'b' });
        view.receive({ type: 'presetSelection', connectionId: 'b', value: 'other-preset' });
        view.receive({ type: 'templateCleared' });
        view.receive({ type: 'presetSelection', value: 'unscoped-preset' });
        view.flush();
        assert.strictEqual(view.element('template').value, '{"temperature":0.8}');
        assert.strictEqual(view.element('presetSelect').value, '');
        assert.strictEqual(JSON.stringify(view.state), before, 'foreign and unscoped events leave drafts unchanged');
        view.receive({ type: 'presetSelection', connectionId: 'a', value: 'own-preset' });
        view.flush();
        assert.strictEqual(view.element('presetSelect').value, 'own-preset');
        view.receive({ type: 'templateCleared', connectionId: 'a' });
        assert.strictEqual(view.element('template').value, '');
        assert.strictEqual(view.element('presetSelect').value, '');
        assert.ok(!JSON.stringify(view.state).includes('temperature'));
        const legacy = webviewHarness({});
        legacy.element('template').value = '{}';
        legacy.receive({ type: 'templateCleared' });
        assert.strictEqual(legacy.element('template').value, '', 'legacy event seams retain unscoped behavior');
    });

    test('unsent credentials never enter persisted state and clear when switching tabs', () => {
        const view = webviewHarness({ connections, selectedConnectionId: 'a', maskedKey: 'masked…key' });
        view.element('key').value = 'secret-unsent-key';
        view.element('key').fire('input');
        view.element('template').value = '{}';
        view.element('template').fire('input');
        view.flush();
        assert.ok(!JSON.stringify(view.state).includes('secret-unsent-key'));
        view.element('tab-connection-a').fire('click');
        assert.strictEqual(view.element('key').value, 'masked…key');
        view.element('saveKey').fire('click');
        assert.deepStrictEqual(view.messages.at(-1), {
            type: 'saveKey', value: 'masked…key', currentKeyMasked: 'masked…key', connectionId: 'a',
        });
    });

    test('Settings connection selector stays in Settings and identifies the connection being edited', () => {
        const view = webviewHarness({ connections, selectedConnectionId: 'a' });
        view.element('connectionSelect').value = 'b';
        view.element('connectionSelect').fire('change');
        assert.deepStrictEqual(view.messages.at(-1), { type: 'selectConnection', connectionId: 'b', value: 'settings' });
        assert.strictEqual((view.state as { activeTab: string }).activeTab, 'tab-settings');
    });

    test('new connections default to the original group name followed by numbered names', () => {
        const connections: ConnectionDefinition[] = [];
        for (const expected of ['OpenRouter: RC', 'OpenRouter: RC1', 'OpenRouter: RC2', 'OpenRouter: RC3']) {
            const view = webviewHarness({ connections });
            view.element('addConnection').fire('click');
            assert.strictEqual(view.element('connectionName').value, expected);
            view.element('connectionForm').fire('submit', { preventDefault() {} });
            assert.strictEqual((view.messages.at(-1)!.value as { name: string }).name, expected);
            connections.push({ ...connectionFixture(String(connections.length)), name: expected });
        }
    });

    test('default names avoid disabled and case-insensitive collisions while custom names stay editable', () => {
        const connections = [
            { ...connectionFixture('a'), name: 'openrouter: rc', enabled: false },
            { ...connectionFixture('b'), name: 'OpenRouter: RC1' },
            { ...connectionFixture('c'), name: 'OpenRouter: RC3' },
        ];
        const view = webviewHarness({ connections, selectedConnectionId: 'b' });
        view.element('addConnection').fire('click');
        assert.strictEqual(view.element('connectionName').value, 'OpenRouter: RC2');
        view.element('connectionName').value = 'Personal';
        view.element('connectionForm').fire('submit', { preventDefault() {} });
        assert.strictEqual((view.messages.at(-1)!.value as { name: string }).name, 'Personal');
        view.element('cancelConnection').fire('click');
        assert.strictEqual(view.element('connectionName').value, 'OpenRouter: RC1');
    });

    test('escapes connection metadata and renders only one detail editor', () => {
        const hostile = { ...connectionFixture('a'), name: '</script><img src=x>', baseUrl: 'https://example.com/" onmouseover="bad' };
        const html = render({ connections: [hostile, connectionFixture('b')], selectedConnectionId: 'a' });
        assert.ok(!html.includes('</script><img'));
        assert.ok(html.includes('&lt;/script&gt;&lt;img src=x&gt;'));
        assert.ok(html.includes('https://example.com/&quot; onmouseover=&quot;bad'));
        assert.strictEqual((html.match(/id="template"/g) ?? []).length, 1);
    });

    test('compatible APIs show manual models and honest cost availability without OpenRouter controls', () => {
        const html = render({ connections: [connectionFixture('local', 'openai-compatible')], selectedConnectionId: 'local' });
        assert.ok(html.includes('id="manualModels"') && html.includes('id="saveManualModels"'));
        assert.ok(html.includes('does not provide OpenRouter credits or authoritative cost data'));
        assert.ok(!html.includes('id="presetSelect"') && !html.includes('id="limit"'));
        assert.ok(!html.includes('id="hideUnavailableModels"'));
        assert.ok(html.includes('id="connectionKind" disabled'));
        assert.ok(html.includes('&quot;stream_options&quot;: {&quot;include_usage&quot;: true}'));
        assert.ok(!render().includes('To request token usage from servers that support it'));

    });

    test('gateway allowance uses separate effective interval budgets without unsupported controls', () => {
        const budget = { limit: 5, remaining: 3.75, reset: 'daily', usage: 1.25,
            resets_at: '2026-10-29T00:00:00Z', include_byok: true };
        const lane: GatewayLaneAllowance = { ...budget, limit: null, remaining: null, usage: 999,
            status: 'reported', effective_budget: budget, applicable_budgets: [budget], inherited_budgets: [budget] };
        const allowance: GatewayAllowance = { cheap: lane,
            default: { ...lane, effective_budget: { ...budget, limit: 20, remaining: 12.5, usage: 7.5, reset: 'weekly' } },
            fetched_at: '2026-10-28T10:00:00Z' };
        const html = render({ connections: [connectionFixture('gateway', 'gateway')],
            gatewayAllowance: allowance, fetchedAt: new Date('2026-10-28T10:00:01Z'), sessions: [sessionFixture()] });
        assert.ok(html.includes('Cheap lane') && html.includes('Default lane'));
        assert.ok(html.includes('$3.75') && html.includes('$12.50'));
        assert.ok(html.includes('$1.25') && html.includes('$7.50'));
        assert.ok(!html.includes('$999'), 'cumulative key usage is not presented as interval usage');
        assert.ok(!html.includes('$16.25'), 'daily and weekly balances are never summed');
        assert.ok(html.includes('Gateway retrieved:') && html.includes('Retrieved locally:'));
        assert.ok(html.includes('do not guarantee current billing counters'));
        assert.ok(html.includes('using both does not add funds'));
        assert.ok(html.includes('value="gateway" selected'));
        for (const id of ['limit', 'includeByok', 'resetPeriod', 'hideUnavailableModels', 'manualModels', 'saveManualModels', 'presetSelect']) {
            assert.ok(!html.includes(`id="${id}"`), `${id} is unsupported on gateway connections`);
        }
        assert.ok(html.includes('id="refresh"') && html.includes('Refresh allowance'));
        assert.ok(html.includes('id="template"') && html.includes('Session spend'));
    });

    test('gateway partial, stale and missing allowance values remain unavailable', () => {
        const budget = { limit: null, remaining: null, reset: null, usage: null, resets_at: null, include_byok: null };
        const lane: GatewayLaneAllowance = { ...budget, status: 'reported', effective_budget: budget,
            applicable_budgets: [], inherited_budgets: [] };
        const html = render({ connections: [connectionFixture('gateway', 'gateway')], gatewayAllowanceStale: true,
            gatewayAllowance: { cheap: lane, default: { ...lane, status: 'unknown',
                effective_budget: { ...budget, limit: 7, remaining: 6, usage: 1 } }, fetched_at: null },
            errorMessage: 'Allowance refresh failed' });
        const table = html.match(/<table class="rows">([\s\S]*?)<\/table>/)![1];
        assert.ok(table.includes('Reported') && table.includes('Unknown'));
        assert.strictEqual((table.match(/Unavailable/g) ?? []).length, 10);
        assert.ok(!table.includes('$0') && !table.includes('$6') && !table.includes('No limit'));
        assert.ok(html.includes('Saved allowance is stale') && html.includes('Allowance refresh failed'));
        assert.ok(html.includes('Gateway retrieved: Unavailable'));
        const noEffectiveBudget = render({ connections: [connectionFixture('gateway', 'gateway')],
            gatewayAllowance: { cheap: { ...lane, limit: 100, remaining: 90, usage: 10, effective_budget: null },
                default: lane, fetched_at: null } });
        assert.ok(!noEffectiveBudget.includes('$90') && !noEffectiveBudget.includes('$10'),
            'missing effective budget never falls back to cumulative root counters');
        const empty = render({ connections: [connectionFixture('gateway', 'gateway')] });
        assert.ok(empty.includes('No gateway allowance yet'));
        assert.strictEqual((empty.match(/<td>Unknown<\/td>/g) ?? []).length, 2);
    });

    test('gateway allowance escapes metadata and rejects non-finite display amounts', () => {
        const budget = { limit: Number.POSITIVE_INFINITY, remaining: Number.NaN, reset: '</td><script>bad()</script>',
            usage: 0, resets_at: '<img src=x onerror=bad()>', include_byok: null };
        const lane: GatewayLaneAllowance = { ...budget, status: 'reported', effective_budget: budget,
            applicable_budgets: [], inherited_budgets: [] };
        const html = render({ connections: [connectionFixture('gateway', 'gateway')], gatewayAllowance: {
            cheap: lane, default: lane, fetched_at: '</p><script>bad()</script>' },
            errorMessage: '<img src=x onerror=bad()>' });
        assert.ok(!html.includes('<script>bad()') && !html.includes('<img src=x'));
        assert.ok(html.includes('&lt;/td&gt;&lt;script&gt;bad()&lt;/script&gt;'));
        assert.ok(html.includes('&lt;img src=x onerror=bad()&gt;'));
        assert.ok(!html.includes('$Infinity') && !html.includes('$NaN'));
        assert.ok(html.includes('$0.00'), 'known zero remains distinct from unavailable values');
    });

    test('accepts explicit gateway connections from the Settings form', async () => {
        const state = spyDeps();
        const added: unknown[] = [];
        state.deps.addConnection = async input => { added.push(input); };
        await handlePanelMessage({ type: 'addConnection', value: { name: ' Gateway ', kind: 'gateway',
            baseUrl: 'https://gateway.example/v1' } }, state.deps);
        assert.deepStrictEqual(added, [{ name: 'Gateway', kind: 'gateway', baseUrl: 'https://gateway.example/v1' }]);
        assert.deepStrictEqual(state.errors, []);
    });

    test('generic session history shows calls and tokens when cost is missing or zero', () => {
        const session = sessionFixture({ paid: 0, openRouter: 0, upstream: 0, costUnavailable: true,
            routes: [{ ...sessionFixture().routes[0], paid: 0, costUnavailable: true }] });
        const html = renderSessionCosts([session], true);
        assert.ok(html.includes('Unavailable'), 'missing cost is labelled');
        assert.ok(html.includes('class="sessioncost">Unavailable</span>'), 'missing cost never appears free');
        assert.ok(html.includes('Input tokens') && html.includes('Output tokens'));
        assert.ok(html.includes('1,000') && html.includes('2 calls'));
        assert.ok(html.includes('Session <code>copilot-chat:'));
        assert.ok(!html.includes('OpenRouter session'));
        const free = renderSessionCosts([{ ...session, costUnavailable: false, routes: [] }], true);
        assert.ok(free.includes('2 calls'), 'known zero-cost usage is retained');
        assert.ok(renderSessionCosts([], true).includes('No session usage recorded yet'));
        const mixed = renderSessionCosts([{ ...session, paid: 0.1 }], true);
        assert.ok(mixed.includes('$0.1000 + unavailable'), 'partial totals do not claim complete cost');
    });

    test('dispatches connection CRUD to the supplied immutable id and validates manual models', async () => {
        const state = spyDeps();
        const actions: unknown[] = [];
        state.deps.addConnection = async input => { actions.push(['add', input]); };
        state.deps.updateConnection = async (id, patch) => { actions.push(['update', id, patch]); };
        state.deps.deleteConnection = async id => { actions.push(['delete', id]); };
        state.deps.selectConnection = async id => { actions.push(['select', id]); };
        await handlePanelMessage({ type: 'addConnection', value: { name: ' Local ', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' } }, state.deps);
        await handlePanelMessage({ type: 'setConnectionEnabled', connectionId: 'a', value: false }, state.deps);
        await handlePanelMessage({ type: 'saveManualModels', connectionId: 'b', value: '[{"id":"m","contextLength":32768,"toolCalling":true}]' }, state.deps);
        await handlePanelMessage({ type: 'deleteConnection', connectionId: 'a' }, state.deps);
        await handlePanelMessage({ type: 'selectConnection', connectionId: 'b' }, state.deps);
        assert.deepStrictEqual(actions, [
            ['add', { name: 'Local', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' }],
            ['update', 'a', { enabled: false }],
            ['update', 'b', { models: [{ id: 'm', contextLength: 32768, toolCalling: true }] }],
            ['delete', 'a'], ['select', 'b'],
        ]);
        for (const value of ['{}', '[{"id":"m"},{"id":"m"}]', '[{"id":"m","contextLength":-1}]', '[{"id":"m","toolCalling":"yes"}]']) {
            await handlePanelMessage({ type: 'saveManualModels', connectionId: 'b', value }, state.deps);
        }
        await handlePanelMessage({ type: 'addConnection', value: { name: 'bad', kind: 'openai-compatible', baseUrl: 'https://user:pass@example.com/v1' } }, state.deps);
        assert.strictEqual(actions.length, 5, 'invalid input never reaches persistence');
        assert.strictEqual(state.errors.length, 5);
    });
});
