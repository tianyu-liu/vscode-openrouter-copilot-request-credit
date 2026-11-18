import * as assert from "assert";
import * as vscode from "vscode";
import { runInNewContext } from "vm";
import type { ConnectionDefinition } from "../../connections";
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

function render(overrides: Partial<PanelRenderOptions> = {}, allowProxyConnections = false): string {
    return renderPanelHtml({
        limit: 10,
        resetPeriod: "daily",
        includeByok: true,
        refreshIntervalMinutes: 5,
        ...overrides,
    }, allowProxyConnections);
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
        assert.ok(html.includes("Session spend appears here after a request reports a cost."), html);
        assert.ok(!html.includes("<details"), "no collapsible rows when there is nothing to show");
    });

    test("the footer says up to 10 sessions are kept, and that they persist", () => {
        const html = renderSessionCosts([sessionFixture()]);
        assert.ok(html.includes("Up to 10 recent chats are stored locally and shown newest first."), html);
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
        assert.ok(!html.includes("This spend came from requests without a Copilot chat identifier."), "and no bucket note in the footer");
    });

    test("spend with no chat id renders as a labelled Unattributed entry", () => {
        const html = renderSessionCosts([
            sessionFixture({ sessionId: UNATTRIBUTED_SESSION_ID, byok: true }),
            sessionFixture({ sessionId: "copilot-chat:chat", paid: 0.002 }),
        ]);
        assert.strictEqual((html.match(/<details/g) ?? []).length, 2, "one row per chat plus the bucket");
        assert.ok(html.includes("Unattributed (no chat id)"), "the bucket is labelled");
        assert.ok(!html.includes("OpenRouter session <code>unattributed"), "the bucket is not described as an OpenRouter session");
        assert.ok(html.includes("This spend came from requests without a Copilot chat identifier."), "the bucket explains itself");
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
        assert.ok(html.includes("Session spend appears here after a request reports a cost."), html);
        assert.ok(html.includes("Requests without a Copilot chat identifier appear under Unattributed."));
    });

    test("a zero-spend bucket is omitted like any other session", () => {
        const html = renderSessionCosts([sessionFixture({ sessionId: UNATTRIBUTED_SESSION_ID, paid: 0, upstream: 0, openRouter: 0 })]);
        assert.ok(!html.includes("<details"), "nothing was spent, so no entry is rendered");
        assert.ok(!html.includes("Unattributed (no chat id)"), "not even a labelled one");
        assert.ok(html.includes("Session spend appears here after a request reports a cost."), "the list falls back to the empty state");
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

    test("ships a per-render nonce CSP and escapes the saved key summary", () => {
        const html = render({ info: BASE_INFO, maskedKey: `<img src=x onerror="alert(1)">` });
        assert.ok(html.includes("default-src 'none'"), "CSP default-src 'none' present");
        assert.match(html, /script-src 'nonce-[0-9a-f]{32}'/, "per-render nonce present");
        assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
        assert.ok(!html.includes('<img src=x'), 'masked key markup is never executable');
    });

    test("keeps the key inside the connection form with a single save action", () => {
        const html = render({ maskedKey: "sk-or-v1-12…456" });
        const form = html.match(/<form id="connectionForm"[\s\S]*?<\/form>/)![0];
        for (const id of ['connectionName', 'key', 'connectionEnabled', 'saveConnection']) {
            assert.ok(form.includes(`id="${id}"`), `${id} belongs to the group editor`);
        }
        assert.ok(!html.includes('id="saveKey"'));
        assert.ok(form.includes('id="clearKey"'), 'key clearing remains a separate action in the group editor');
        assert.ok(!html.includes('id="toggleConnection"'));
        assert.ok(!html.includes("type: 'saveKey'"));
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
        assert.ok(html.includes("OpenRouter enforces this key’s spending limit."));
        const included: KeyInfo = { ...autoInfo, include_byok_in_limit: true };
        assert.ok(render({ info: included }).includes('id="includeByok" checked '), "the key's true flag renders checked");
    });

    test("weekly guardrail labels its trailing window instead of a Monday reset", () => {
        const html = render({ info: BASE_INFO, resetPeriod: "weekly" });
        assert.ok(html.includes("Rolling 7-day window"), html);
        assert.ok(!html.includes("Next reset:"), "no fictional Monday reset date");
    });

    test("offers a separate Clear key action only when a key is set", () => {
        const withKey = render({ maskedKey: "sk-or-v1-12\u2026456" });
        assert.ok(withKey.includes('id="clearKey"'));
        assert.ok(withKey.includes("post('clearKey')"));
        assert.ok(!withKey.includes('id="removeKey"'));
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

    test("shows a neutral keyless state when there is no info", () => {
        const html = render();
        assert.ok(html.includes("Save an API key in Settings to see credit usage."));
        assert.ok(html.includes('<span class="muted">No key saved</span>'));
        assert.ok(html.includes('You can save the connection before adding an OpenRouter API key.'));
        assert.ok(!html.includes('No API key set'));
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
        assert.ok(html.includes('for="outputReservePercent">Target</label>'), "ratio field is labelled Target");
        assert.ok(html.includes('for="outputReserveMinTokens">Lower limit</label>'));
        assert.ok(html.includes('for="outputReserveMaxTokens">Upper limit</label>'));
        assert.ok(html.includes('title="Refresh usage data every 1 to 1440 minutes"'));
        assert.ok(html.includes('aria-label="Spending limit reset period"'));
    });

    test("renders the custom request section, pre-filled from the saved template", () => {
        const template = { temperature: 0.2, provider: { quantizations: ["fp8"] } };
        const html = render({ template });
        assert.ok(html.includes(">Custom request</div>"), "custom request section present");
        assert.ok(html.includes('id="saveTemplate" class="primary" type="button">Save request</button>'), "Save request button present");
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
        assert.ok(!settings.includes('class="sep"'), "spacing separates the reserve controls");
        assert.ok(request.includes("When OpenRouter reports zero for a BYOK request"));
        assert.ok(request.includes("Responses stream automatically"));
        assert.ok(request.includes("A pasted <code>provider</code> object is sent as entered."));
        assert.ok(html.includes('aria-label="OpenRouter API key"'), "key input has an accessible name");
        assert.ok(html.includes('aria-label="Custom request JSON"'), "request editor has an accessible name");
        assert.ok(!html.includes("id=\"fn-"), "numbered internal footnote anchors are removed");
        assert.ok(!html.includes('id="panel-context"'), "the Context tab is retired");
    });

    test("uses paragraphs for guidance and applies button styles by action", () => {
        const html = render({ maskedKey: "sk..." });
        const buttons = [...html.matchAll(/<button id="([^"]+)" class="([^"]+)"/g)];
        assert.deepStrictEqual(buttons.filter(match => match[2] === "primary").map(match => match[1]), [
            "saveConnection", "saveTemplate",
        ]);
        assert.deepStrictEqual(buttons.filter(match => match[2] === "secondary").map(match => match[1]), [
            "addConnection", "clearKey", "cancelConnection", "deleteConnection", "resetOutputReserve", "refresh",
        ]);
        assert.ok(html.includes('<p class="helptext">VS Code stores your API key in SecretStorage.</p>'));
        assert.ok(html.includes('<p class="helptext">Refresh to load credit usage.</p>'));
        assert.ok(!html.includes('<ul class="helptext">'));
        assert.ok(!html.includes('class="helptext connection-url"'), "the direct tab does not repeat its fixed URL");
    });

    test("request guidance states cache behavior and avoids blanket verbatim passthrough", () => {
        const html = render();
        assert.ok(
            html.includes("Models with IDs starting with <code>anthropic/</code> or <code>~anthropic/</code> get a top-level 5-minute <code>cache_control</code>"),
            "anthropic auto cache_control footnote present"
        );
        assert.ok(
            html.includes("A pasted <code>provider</code> object is sent as entered."),
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

    test("status bar settings accept boolean visibility and either display mode", async () => {
        const state = spyDeps();
        await handlePanelMessage({ type: "saveShowBudgetInStatusBar", connectionId: "a", value: "false" }, state.deps);
        await handlePanelMessage({ type: "saveStatusBarBudgetDisplay", value: ["usage"] }, state.deps);
        await handlePanelMessage({ type: "saveStatusBarBudgetDisplay", value: "bogus" }, state.deps);
        assert.strictEqual(state.errors.length, 3);
        assert.strictEqual(state.updates.length, 0);
        await handlePanelMessage({ type: "saveShowBudgetInStatusBar", connectionId: "a", value: false }, state.deps);
        await handlePanelMessage({ type: "saveStatusBarBudgetDisplay", value: "usage" }, state.deps);
        await handlePanelMessage({ type: "saveStatusBarBudgetDisplay", value: "remaining" }, state.deps);
        assert.deepStrictEqual(state.updates, [
            ["showBudgetInStatusBar", false], ["statusBarBudgetDisplay", "usage"], ["statusBarBudgetDisplay", "remaining"],
        ]);
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
        assert.ok(html.includes('<p class="helptext">Selecting a preset replaces the saved request.'));
        assert.ok(html.includes('The “No preset loaded” option clears it.'));
        assert.ok(html.includes("<code>@preset/&lt;slug&gt;</code>"), "picker entry form documented");
        assert.ok(html.includes("overriding the saved request’s preset"), "picker preset precedence documented");
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
function webviewHarness(options: Partial<PanelRenderOptions>, savedState: unknown = {}, allowProxyConnections = false) {
    class Element {
        value = '';
        type = '';
        hidden = false;
        disabled = false;
        checked = false;
        required = false;
        placeholder = '';
        validationMessage = '';
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
        setCustomValidity(message: string) { this.validationMessage = message; }
        reportValidity() { return this.validationMessage === ''; }
        fire(type: string, event = {}) { for (const listener of this.listeners[type] ?? []) listener(event); }
    }
    const html = render(options, allowProxyConnections);
    const elements = new Map<string, Element>();
    const decode = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    for (const match of html.matchAll(/<\w+\b([^>]*?\sid="([^"]+)"[^>]*)>/g)) {
        const element = new Element(match[2]);
        for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) element.attributes[attr[1]] = decode(attr[2]);
        element.value = element.attributes.value ?? '';
        element.type = element.attributes.type ?? '';
        element.placeholder = element.attributes.placeholder ?? '';
        element.checked = /(?:^|\s)checked(?:\s|$)/.test(match[1]);
        element.disabled = /(?:^|\s)disabled(?:\s|$)/.test(match[1]);
        element.hidden = /(?:^|\s)hidden(?:\s|$)/.test(match[1]);
        element.required = /(?:^|\s)required(?:\s|$)/.test(match[1]);
        if (element.attributes['data-connection-id']) element.dataset.connectionId = element.attributes['data-connection-id'];
        elements.set(element.id, element);
    }
    const tabs = [...elements.values()].filter(element => element.attributes.role === 'tab');
    for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
        const options = [...match[2].matchAll(/<option\b([^>]*)>/g)];
        const selected = options.find(option => /\bselected\b/.test(option[1])) ?? options[0];
        if (selected) elements.get(match[1])!.value = decode(selected[1].match(/value="([^"]*)"/)?.[1] ?? '');
    }
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

    test('status bar display is shared and budget visibility belongs to the selected connection', () => {
        const rows = [connections[0], {
            ...connections[1], settings: { ...connections[1].settings, showBudgetInStatusBar: false },
        }];
        const first = webviewHarness({ connections: rows, selectedConnectionId: 'a' });
        assert.strictEqual(first.element('statusBarBudgetDisplay').value, 'remaining');
        assert.strictEqual(first.element('showBudgetInStatusBar').checked, true);
        first.element('showBudgetInStatusBar').checked = false;
        first.element('showBudgetInStatusBar').fire('change');
        first.element('statusBarBudgetDisplay').value = 'usage';
        first.element('statusBarBudgetDisplay').fire('change');
        assert.deepStrictEqual(first.messages, [
            { type: 'saveShowBudgetInStatusBar', connectionId: 'a', value: false },
            { type: 'saveStatusBarBudgetDisplay', value: 'usage' },
        ]);
        const second = webviewHarness({
            connections: rows, selectedConnectionId: 'b', settings: { statusBarBudgetDisplay: 'usage' },
        });
        assert.strictEqual(second.element('statusBarBudgetDisplay').value, 'usage');
        assert.strictEqual(second.element('showBudgetInStatusBar').checked, false);
        assert.ok(!render({ connections: [connectionFixture('proxy', 'gateway')] }, true).includes('id="showBudgetInStatusBar"'));
    });

    test('stable panel hides saved proxies and excludes their scoped data from a direct connection', () => {
        for (const kind of ['gateway', 'openai-compatible'] as const) {
            const proxy = { ...connectionFixture('proxy', kind), name: 'OpenRouter: RC', baseUrl: 'https://hidden.example/v1' };
            const options = {
                connections: [proxy, ...connections], selectedConnectionId: proxy.id,
                maskedKey: 'hidden-masked-key', template: { hiddenTemplate: true },
                errorMessage: 'hidden refresh error', sessions: [sessionFixture({ title: 'hidden session' })],
                presets: [{ name: 'hidden preset', slug: 'hidden-preset' }],
            };
            const html = render(options);
            for (const hidden of [
                'id="connectionKind"', 'id="connectionUrl"', 'OpenRouter proxy', 'data-connection-id="proxy"',
                proxy.baseUrl, 'hidden-masked-key', 'hiddenTemplate', 'hidden refresh error', 'hidden session', 'hidden preset',
            ]) {
                assert.ok(!html.includes(hidden), `stable panel excludes ${hidden}`);
            }
            const view = webviewHarness(options, { activeTab: 'tab-connection-proxy' });
            assert.strictEqual(view.element('connectionSelect').value, 'a');
            assert.strictEqual(view.element('template').value, '');
            assert.strictEqual(view.element('panel-settings').hidden, false);
            view.element('addConnection').fire('click');
            assert.strictEqual(view.element('connectionName').value, 'OpenRouter: RC1');
            const onlyProxy = webviewHarness({ ...options, connections: [proxy] });
            onlyProxy.element('connectionForm').fire('submit', { preventDefault() {} });
            assert.deepStrictEqual(onlyProxy.messages.at(-1), { type: 'addConnection', value: {
                name: 'OpenRouter: RC1', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true,
            } });
        }
    });

    test('each direct editor sends its own key and connection ID', () => {
        const first = webviewHarness({ connections, selectedConnectionId: 'a', maskedKey: 'first-mask' });
        first.element('key').value = 'first-key';
        first.element('connectionForm').fire('submit', { preventDefault() {} });
        const second = webviewHarness({ connections, selectedConnectionId: 'b', maskedKey: 'second-mask' }, first.state);
        assert.strictEqual(second.element('key').placeholder, 'second-mask');
        assert.strictEqual(second.element('key').value, '');
        second.element('key').value = 'second-key';
        second.element('connectionForm').fire('submit', { preventDefault() {} });
        assert.deepStrictEqual([first.messages.at(-1), second.messages.at(-1)], ['a', 'b'].map((id, index) => ({
            type: 'updateConnection', connectionId: id, value: {
                name: id.toUpperCase(), kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true,
                apiKey: ['first-key', 'second-key'][index],
            },
        })));
    });

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

    test('resetting output reserve discards all reserve drafts and removes the shared overrides', async () => {
        const settings = { outputReservePercent: 25, outputReserveMinTokens: 64000, outputReserveMaxTokens: 512000 };
        const view = webviewHarness({ connections, settings });
        const fields = [
            ['outputReservePercent', '30'],
            ['outputReserveMinTokens', '80'],
            ['outputReserveMaxTokens', '600'],
        ];
        for (const [id, value] of fields) {
            view.element(id).value = value;
            view.element(id).fire('input');
        }
        view.element('template').value = '{"temperature":0.5}';
        view.element('template').fire('input');
        view.element('resetOutputReserve').fire('click');
        assert.deepStrictEqual(view.messages, [{ type: 'resetOutputReserve' }]);

        const s = spyDeps();
        await handlePanelMessage(view.messages[0], s.deps);
        assert.deepStrictEqual(s.updates, fields.map(([id]) => [id, undefined]));
        const reopened = webviewHarness({ connections, settings }, view.state);
        assert.deepStrictEqual(fields.map(([id]) => reopened.element(id).value), ['25', '64', '512']);
        const reset = webviewHarness({ connections }, view.state);
        assert.deepStrictEqual(fields.map(([id]) => reset.element(id).value), ['12.5', '16.384', '262.144']);
        assert.strictEqual(reset.element('template').value, '{"temperature":0.5}');
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
        assert.strictEqual(view.element('key').value, '');
        assert.strictEqual(view.element('key').attributes.placeholder, 'masked…key');
        view.element('key').value = 'secret-unsent-key';
        view.element('key').fire('input');
        view.element('template').value = '{}';
        view.element('template').fire('input');
        view.flush();
        assert.ok(!JSON.stringify(view.state).includes('secret-unsent-key'));
        view.element('tab-connection-a').fire('click');
        assert.strictEqual(view.element('key').value, '');
        view.element('connectionForm').fire('submit', { preventDefault() {} });
        assert.ok(!('apiKey' in (view.messages.at(-1)!.value as object)), 'blank input retains the real key');
    });

    test('saved key masks stay in the field hint and are never sent as replacement credentials', () => {
        const view = webviewHarness({ connections, selectedConnectionId: 'a', maskedKey: 'sk-or-v1-12…456' });
        assert.strictEqual(view.element('key').attributes.placeholder, 'sk-or-v1-12…456');
        assert.strictEqual(view.element('key').type, 'password');
        view.element('connectionForm').fire('submit', { preventDefault() {} });
        assert.ok(!('apiKey' in (view.messages.at(-1)!.value as object)));
        view.element('key').value = 'replacement-key';
        view.element('connectionForm').fire('submit', { preventDefault() {} });
        assert.strictEqual((view.messages.at(-1)!.value as { apiKey: string }).apiKey, 'replacement-key');
        view.element('addConnection').fire('click');
        assert.notStrictEqual(view.element('key').placeholder, 'sk-or-v1-12…456');
        view.element('cancelConnection').fire('click');
        assert.strictEqual(view.element('key').placeholder, 'sk-or-v1-12…456');
        assert.strictEqual(view.element('key').value, '');
    });

    test('proxy forms reject OpenRouter key syntax but permit proxy tokens and no key', () => {
        for (const kind of ['gateway', 'openai-compatible'] as const) {
            const view = webviewHarness({ connections: [connectionFixture('proxy', kind)], selectedConnectionId: 'proxy' }, {}, true);
            for (const value of ['sk-or-v1-pretend', '  SK-OR-V1-PRETEND  ', 'sk-or-']) {
                view.element('key').value = value;
                view.element('key').fire('input');
                assert.ok(view.element('key').validationMessage.includes('cannot be used with a proxy'));
                view.element('connectionForm').fire('submit', { preventDefault() {} });
                assert.strictEqual(view.messages.length, 0, 'invalid keys never leave the form');
            }
            for (const value of ['proxy-token', '']) {
                view.element('key').value = value;
                view.element('key').fire('input');
                assert.strictEqual(view.element('key').validationMessage, '');
                view.element('connectionForm').fire('submit', { preventDefault() {} });
                assert.strictEqual(view.messages.at(-1)!.type, 'updateConnection');
            }
        }
    });

    test('switching to proxy rejects a retained OpenRouter key while Clear key remains available', () => {
        const view = webviewHarness({ connections, selectedConnectionId: 'a', maskedKey: 'sk-or-v1-12…456' }, {}, true);
        assert.strictEqual(view.element('key').validationMessage, '');
        view.element('connectionKind').value = 'gateway';
        view.element('connectionKind').fire('change');
        view.element('connectionUrl').value = 'https://proxy.example/v1';
        assert.ok(view.element('key').validationMessage);
        view.element('connectionForm').fire('submit', { preventDefault() {} });
        assert.strictEqual(view.messages.length, 0);
        view.element('clearKey').fire('click');
        assert.deepStrictEqual(view.messages.at(-1), { type: 'clearKey', connectionId: 'a' });
        const refreshed = webviewHarness({ connections, selectedConnectionId: 'a' }, view.state, true);
        assert.strictEqual(refreshed.element('connectionKind').value, 'gateway');
        assert.strictEqual(refreshed.element('key').validationMessage, '');
        refreshed.element('connectionForm').fire('submit', { preventDefault() {} });
        assert.strictEqual(refreshed.messages.at(-1)!.type, 'updateConnection');
        const stable = webviewHarness({ connections, selectedConnectionId: 'a' }, view.state);
        stable.element('connectionForm').fire('submit', { preventDefault() {} });
        assert.deepStrictEqual(stable.messages.at(-1), { type: 'updateConnection', connectionId: 'a', value: {
            name: 'A', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: true,
        } });
    });

    test('clearing an invalid key by switching tabs restores native validity for a keyless proxy', () => {
        const view = webviewHarness({ connections: [connectionFixture('proxy', 'gateway')], selectedConnectionId: 'proxy' }, {}, true);
        view.element('key').value = 'sk-or-v1-pretend';
        view.element('key').fire('input');
        assert.strictEqual(view.element('key').reportValidity(), false);
        view.element('tab-connection-proxy').fire('click');
        view.element('tab-settings').fire('click');
        assert.strictEqual(view.element('key').value, '');
        assert.strictEqual(view.element('key').reportValidity(), true);
        view.element('connectionForm').fire('submit', { preventDefault() {} });
        assert.strictEqual(view.messages.at(-1)!.type, 'updateConnection');
    });

    test('Settings connection selector stays in Settings and identifies the connection being edited', () => {
        const view = webviewHarness({ connections, selectedConnectionId: 'a' });
        view.element('connectionSelect').value = 'b';
        view.element('connectionSelect').fire('change');
        assert.deepStrictEqual(view.messages.at(-1), { type: 'selectConnection', connectionId: 'b', value: 'settings' });
        assert.strictEqual((view.state as { activeTab: string }).activeTab, 'tab-settings');
    });

    test('one form submission saves connection details, enabled state and a new key together', () => {
        const view = webviewHarness({ connections, selectedConnectionId: 'a', maskedKey: 'masked…key' });
        view.element('addConnection').fire('click');
        view.element('connectionName').value = 'Work';
        view.element('connectionEnabled').checked = false;
        view.element('key').value = '  fixture-new-key  ';
        assert.strictEqual(view.messages.length, 0, 'editing the form does not save individual fields');
        view.element('connectionForm').fire('submit', { preventDefault() {} });
        assert.deepStrictEqual(view.messages, [{ type: 'addConnection', value: {
            name: 'Work', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1',
            enabled: false, apiKey: 'fixture-new-key',
        } }]);
        view.element('cancelConnection').fire('click');
        assert.strictEqual(view.element('key').value, '');
        assert.strictEqual(view.element('connectionName').value, 'A');
        assert.strictEqual(view.element('connectionEnabled').checked, true);
        view.flush();
        assert.ok(!JSON.stringify(view.state).includes('fixture-new-key'));
    });

    test('Clear key sends a separate scoped action without saving other pending edits', () => {
        const view = webviewHarness({ connections, selectedConnectionId: 'a', maskedKey: 'masked…key' });
        view.element('connectionName').value = 'Renamed';
        view.element('key').value = 'unsaved-key';
        view.element('clearKey').fire('click');
        assert.deepStrictEqual(view.messages, [{ type: 'clearKey', connectionId: 'a' }]);
        assert.strictEqual(view.element('key').value, '');
        assert.strictEqual(view.element('connectionName').value, 'Renamed');
    });

    test('Clear key preserves nonsecret connection edits across its refresh and Cancel discards them', () => {
        const view = webviewHarness({ connections, selectedConnectionId: 'a', maskedKey: 'masked…key' }, {}, true);
        view.element('connectionName').value = 'Pending rename';
        view.element('connectionKind').value = 'gateway';
        view.element('connectionKind').fire('change');
        view.element('connectionUrl').value = 'https://pending.example/v1';
        view.element('connectionEnabled').checked = false;
        view.element('key').value = 'never-persist-this-key';
        view.element('clearKey').fire('click');
        assert.ok(!JSON.stringify(view.state).includes('never-persist-this-key'));
        const refreshedConnections = connections.map(connection => ({ ...connection, revision: connection.revision + 1 }));
        const refreshed = webviewHarness({ connections: refreshedConnections, selectedConnectionId: 'a' }, view.state, true);
        assert.strictEqual(refreshed.element('connectionName').value, 'Pending rename');
        assert.strictEqual(refreshed.element('connectionKind').value, 'gateway');
        assert.strictEqual(refreshed.element('connectionUrl').value, 'https://pending.example/v1');
        assert.strictEqual(refreshed.element('connectionEnabled').checked, false);
        assert.strictEqual(refreshed.element('key').value, '');
        refreshed.element('connectionForm').fire('submit', { preventDefault() {} });
        assert.deepStrictEqual(refreshed.messages.at(-1), { type: 'updateConnection', connectionId: 'a', value: {
            name: 'Pending rename', kind: 'gateway', baseUrl: 'https://pending.example/v1', enabled: false,
        } });
        refreshed.element('cancelConnection').fire('click');
        const cancelled = webviewHarness({ connections, selectedConnectionId: 'a' }, refreshed.state, true);
        assert.strictEqual(cancelled.element('connectionName').value, 'A');
        assert.strictEqual(cancelled.element('connectionKind').value, 'openrouter');
        const saved = webviewHarness({ connections: [{ ...connections[0], name: 'Saved' }, connections[1]],
            selectedConnectionId: 'a' }, view.state, true);
        assert.strictEqual(saved.element('connectionName').value, 'Saved', 'stale draft cannot overwrite saved metadata');
    });

    test('API type is editable and OpenRouter fixes the URL while custom endpoint drafts survive toggling', () => {
        const view = webviewHarness({ connections, selectedConnectionId: 'a', maskedKey: 'masked…key' }, {}, true);
        assert.strictEqual(view.element('connectionKind').disabled, false);
        assert.strictEqual(view.element('connectionUrl').disabled, true);
        assert.strictEqual(view.element('connectionUrl').value, 'https://openrouter.ai/api/v1');
        view.element('connectionKind').value = 'gateway';
        view.element('connectionKind').fire('change');
        assert.strictEqual(view.element('connectionUrl').disabled, false);
        view.element('connectionUrl').value = 'https://custom.example/v1';
        view.element('connectionUrl').fire('input');
        assert.strictEqual(view.element('endpointKeyHelp').hidden, false);
        view.element('connectionKind').value = 'gateway';
        view.element('connectionKind').fire('change');
        assert.strictEqual(view.element('connectionUrl').value, 'https://custom.example/v1');
        view.element('connectionKind').value = 'openrouter';
        view.element('connectionKind').fire('change');
        assert.strictEqual(view.element('connectionUrl').disabled, true);
        assert.strictEqual(view.element('connectionUrl').value, 'https://openrouter.ai/api/v1');
        view.element('connectionKind').value = 'gateway';
        view.element('connectionKind').fire('change');
        assert.strictEqual(view.element('connectionUrl').value, 'https://custom.example/v1');
        assert.strictEqual(view.messages.length, 0, 'type changes apply only on Save connection');
        view.element('cancelConnection').fire('click');
        assert.strictEqual(view.element('connectionKind').value, 'openrouter');
        assert.strictEqual(view.element('connectionKind').disabled, false);
        assert.strictEqual(view.element('connectionUrl').disabled, true);
    });

    test('existing custom connections can switch API type and the form allows keyless saves for every type', () => {
        const local = { ...connectionFixture('local', 'openai-compatible'), models: [{ id: 'manual-model' }] };
        const view = webviewHarness({ connections: [local], selectedConnectionId: 'local' }, {}, true);
        assert.strictEqual(view.element('connectionUrl').disabled, false);
        view.element('connectionKind').value = 'gateway';
        view.element('connectionKind').fire('change');
        assert.ok(view.element('connectionTypeHint').textContent.includes('removes manual model definitions'));
        assert.strictEqual(view.element('connectionUrl').value, local.baseUrl);
        view.element('cancelConnection').fire('click');
        assert.strictEqual(view.element('connectionKind').value, 'gateway');
        assert.strictEqual(view.element('connectionUrl').disabled, false);
        for (const kind of ['openrouter', 'gateway']) {
            view.element('addConnection').fire('click');
            view.element('connectionKind').value = kind;
            view.element('connectionKind').fire('change');
            if (kind !== 'openrouter') view.element('connectionUrl').value = 'https://custom.example/v1';
            assert.strictEqual(view.element('key').required, false, 'an API key is never required by the form');
            view.element('connectionForm').fire('submit', { preventDefault() {} });
            const message = view.messages.at(-1)!;
            assert.strictEqual(message.type, 'addConnection');
            assert.strictEqual((message.value as { kind: string }).kind, kind);
            assert.ok(!('apiKey' in (message.value as object)));
            view.element('cancelConnection').fire('click');
        }
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

    test('new group mode choices are exactly direct OpenRouter and OpenRouter proxy', () => {
        for (const connections of [[], [connectionFixture('a')], [connectionFixture('proxy', 'gateway')]]) {
            const html = render({ connections }, true);
            const modes = html.match(/<select id="connectionKind">([\s\S]*?)<\/select>/)![1];
            assert.strictEqual((modes.match(/<option /g) ?? []).length, 2);
            assert.ok(modes.includes('Direct OpenRouter') && modes.includes('OpenRouter proxy'));
            assert.ok(!modes.includes('openai-compatible'));
            const view = webviewHarness({ connections }, {}, true);
            view.element('addConnection').fire('click');
            view.element('connectionKind').value = 'gateway';
            view.element('connectionKind').fire('change');
            assert.ok(!html.includes('id="proxyAllowance"'));
        }
    });

    test('proxy panels omit server allowance controls even for old saved flags', () => {
        const proxy = { ...connectionFixture('proxy', 'gateway'), proxyAllowance: true };
        const html = render({ connections: [proxy], sessions: [sessionFixture()] }, true);
        for (const id of ['proxyAllowance', 'proxyOptions', 'manualModels', 'saveManualModels', 'presetSelect', 'limit', 'refresh']) {
            assert.ok(!html.includes(`id="${id}"`));
        }
        assert.ok(!html.includes('Cheap') && !html.includes('Default lane'));
        assert.ok(html.includes('Session spend') && html.includes('reported cost are tracked locally'));
        assert.ok(html.includes('The proxy supplies the available models'));
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
        const hostile = { ...connectionFixture('a', 'gateway'), name: '</script><img src=x>',
            baseUrl: 'https://example.com/" onmouseover="bad' };
        const html = render({ connections: [hostile, connectionFixture('b')], selectedConnectionId: 'a' }, true);
        assert.ok(!html.includes('</script><img'));
        assert.ok(html.includes('&lt;/script&gt;&lt;img src=x&gt;'));
        assert.ok(html.includes('https://example.com/&quot; onmouseover=&quot;bad'));
        assert.strictEqual((html.match(/id="template"/g) ?? []).length, 1);
    });

    test('legacy compatible records expose only two modes and keep behavior until explicit proxy conversion', () => {
        const html = render({ connections: [connectionFixture('local', 'openai-compatible')], selectedConnectionId: 'local' }, true);
        assert.ok(!html.includes('id="manualModels"') && !html.includes('id="saveManualModels"'));
        assert.ok(html.includes('keeps its previous behavior until you save it as an OpenRouter proxy'));
        assert.ok(html.includes('Direct OpenRouter credit and preset APIs are not called through a proxy'));
        assert.ok(!html.includes('id="presetSelect"') && !html.includes('id="limit"'));
        assert.ok(!html.includes('id="hideUnavailableModels"'));
        assert.ok(html.includes('id="connectionKind">'));
        const modes = html.match(/<select id="connectionKind">([\s\S]*?)<\/select>/)![1];
        assert.strictEqual((modes.match(/<option /g) ?? []).length, 2);
        assert.ok(modes.includes('Direct OpenRouter') && modes.includes('OpenRouter proxy'));
        assert.ok(!modes.includes('openai-compatible'));
        const view = webviewHarness({ connections: [connectionFixture('local', 'openai-compatible')],
            selectedConnectionId: 'local' }, {}, true);
        assert.strictEqual(view.messages.length, 0);
        assert.strictEqual(view.element('connectionKind').value, 'gateway');
        view.element('connectionForm').fire('submit', { preventDefault() {} });
        assert.strictEqual((view.messages.at(-1)!.value as { kind: string }).kind, 'gateway');
    });

    test('accepts explicit gateway connections from the Settings form', async () => {
        const state = spyDeps();
        const added: unknown[] = [];
        state.deps.addConnection = async input => { added.push(input); };
        await handlePanelMessage({ type: 'addConnection', value: { name: ' Gateway ', kind: 'gateway',
            baseUrl: 'https://gateway.example/v1' } }, state.deps, true);
        assert.deepStrictEqual(added, [{ name: 'Gateway', kind: 'gateway', baseUrl: 'https://gateway.example/v1' }]);
        assert.deepStrictEqual(state.errors, []);
    });

    test('stable panel rejects crafted non-direct and custom-endpoint changes', async () => {
        const state = spyDeps();
        const actions: unknown[] = [];
        state.deps.addConnection = async input => { actions.push(input); };
        state.deps.updateConnection = async (id, patch) => { actions.push([id, patch]); };
        for (const type of ['addConnection', 'updateConnection']) {
            for (const kind of ['gateway', 'openai-compatible', 'openrouter']) {
                await handlePanelMessage({ type, connectionId: 'a', value: {
                    name: 'Rejected', kind, baseUrl: 'https://other.example/v1', apiKey: 'fixture-key',
                } }, state.deps);
            }
        }
        await handlePanelMessage({ type: 'saveManualModels', connectionId: 'a', value: '[{"id":"custom"}]' }, state.deps);
        assert.deepStrictEqual(actions, []);
        assert.strictEqual(state.errors.length, 6);
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
        await handlePanelMessage({ type: 'addConnection', value: { name: ' Local ', kind: 'gateway',
            baseUrl: 'http://localhost:1234/v1' } }, state.deps, true);
        await handlePanelMessage({ type: 'setConnectionEnabled', connectionId: 'a', value: false }, state.deps);
        await handlePanelMessage({ type: 'saveManualModels', connectionId: 'b', value: '[{"id":"m","contextLength":32768,"toolCalling":true}]' }, state.deps, true);
        await handlePanelMessage({ type: 'deleteConnection', connectionId: 'a' }, state.deps);
        await handlePanelMessage({ type: 'selectConnection', connectionId: 'b' }, state.deps);
        assert.deepStrictEqual(actions, [
            ['add', { name: 'Local', kind: 'gateway', baseUrl: 'http://localhost:1234/v1' }],
            ['update', 'a', { enabled: false }],
            ['update', 'b', { models: [{ id: 'm', contextLength: 32768, toolCalling: true }] }],
            ['delete', 'a'], ['select', 'b'],
        ]);
        for (const value of ['{}', '[{"id":"m"},{"id":"m"}]', '[{"id":"m","contextLength":-1}]', '[{"id":"m","toolCalling":"yes"}]']) {
            await handlePanelMessage({ type: 'saveManualModels', connectionId: 'b', value }, state.deps, true);
        }
        await handlePanelMessage({ type: 'addConnection', value: { name: 'bad', kind: 'gateway', baseUrl: 'https://user:pass@example.com/v1' } }, state.deps, true);
        assert.strictEqual(actions.length, 5, 'invalid input never reaches persistence');
        assert.strictEqual(state.errors.length, 5);
    });

    test('combined saves separate credential changes from connection metadata', async () => {
        const state = spyDeps();
        const actions: unknown[] = [];
        state.deps.addConnection = async (input, key) => { actions.push(['add', input, key]); };
        state.deps.updateConnection = async (id, patch, key) => { actions.push(['update', id, patch, key]); };
        const input = { name: 'Work', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', enabled: false };
        await handlePanelMessage({ type: 'addConnection', value: { ...input, apiKey: '  fixture-new-key  ' } }, state.deps);
        await handlePanelMessage({ type: 'updateConnection', connectionId: 'a', value: input }, state.deps);
        await handlePanelMessage({ type: 'updateConnection', connectionId: 'a', value: { ...input, apiKey: null } }, state.deps);
        await handlePanelMessage({ type: 'updateConnection', connectionId: 'a', value: { ...input, apiKey: '  ' } }, state.deps);
        assert.deepStrictEqual(actions, [
            ['add', input, 'fixture-new-key'], ['update', 'a', input, undefined],
            ['update', 'a', input, null], ['update', 'a', input, undefined],
        ]);
        for (const value of [{ ...input, apiKey: 123 }, { ...input, enabled: 'false' }]) {
            await handlePanelMessage({ type: 'updateConnection', connectionId: 'a', value }, state.deps);
        }
        assert.strictEqual(actions.length, 4, 'malformed fields cannot partially save the connection');
        assert.strictEqual(state.errors.length, 2);
        assert.deepStrictEqual(state.setKeys, [], 'no separate key write is dispatched');
    });

    test('form messages reject legacy mode and ignore obsolete allowance options', async () => {
        const state = spyDeps();
        const saved: unknown[] = [];
        state.deps.addConnection = async input => { saved.push(input); };
        const input = { name: 'Proxy', kind: 'gateway', baseUrl: 'https://proxy.example/v1' };
        await handlePanelMessage({ type: 'addConnection', value: { ...input, proxyAllowance: true } }, state.deps, true);
        assert.deepStrictEqual(saved, [input]);
        await handlePanelMessage({ type: 'addConnection', value: { ...input, kind: 'openai-compatible' } }, state.deps, true);
        assert.strictEqual(saved.length, 1);
        assert.strictEqual(state.errors.length, 1);
    });

});
