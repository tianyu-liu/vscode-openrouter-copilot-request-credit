// Dev-only: render the extension's control panel in a normal browser so the UI
// can be inspected, reviewed, and iterated on without installing the VSIX or
// reloading the VS Code extension host.
//
//   npm run preview         # compile, then serve http://127.0.0.1:8765
//   npm run preview:serve   # serve only (pair with `npm run watch`)
//
// The server re-reads out/panel.js on every request and the page polls
// /__mtime, so after a `tsc` rebuild (or `npm run watch`) a plain browser
// refresh shows the new markup and styles. Data is a fixed, representative
// fixture set covering all three tabs; edit buildFixtures() below to change it.
//
// The `vscode` module is stubbed (a recursive proxy) so out/panel.js can be
// required in Node, the webview CSP is stripped, and a small theme shim
// supplies the --vscode-* variables the panel reads.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'out');
const require = createRequire(import.meta.url);

const port = Number(process.env.PANEL_PREVIEW_PORT || process.argv[2] || 8765);

const CJS_MODULE = require('node:module');
const originalLoad = CJS_MODULE._load;

function anyValue() {
    const fn = function () {
        return anyValue();
    };
    return new Proxy(fn, {
        get(_target, prop) {
            if (prop === 'then' || prop === Symbol.toPrimitive || prop === 'inspect') {
                return undefined;
            }
            return anyValue();
        },
        apply() {
            return anyValue();
        },
        construct() {
            return anyValue();
        },
    });
}

const vscodeStub = new Proxy({}, { get: () => anyValue() });

CJS_MODULE._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return vscodeStub;
    }
    return originalLoad.apply(this, arguments);
};

const THEME_SHIM = `
<style>
    :root {
        --vscode-font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        --vscode-font-size: 13px;
        --vscode-editor-font-family: ui-monospace, Consolas, "Courier New", monospace;
        --vscode-foreground: #1f1f1f;
        --vscode-descriptionForeground: #6a6a6a;
        --vscode-panel-border: #d0d0d0;
        --vscode-focusBorder: #0078d4;
        --vscode-input-background: #ffffff;
        --vscode-input-foreground: #1f1f1f;
        --vscode-input-border: #c8c8c8;
        --vscode-dropdown-background: #ffffff;
        --vscode-dropdown-foreground: #1f1f1f;
        --vscode-dropdown-border: #c8c8c8;
        --vscode-button-background: #0078d4;
        --vscode-button-foreground: #ffffff;
        --vscode-button-hoverBackground: #0066b4;
        --vscode-errorForeground: #c42b1c;
        --vscode-charts-green: #16825d;
        --vscode-editor-selectionBackground: rgba(135, 206, 250, 0.25);
        --vscode-inputValidation-errorBackground: rgba(255, 0, 0, 0.1);
        --vscode-inputValidation-errorBorder: rgba(255, 0, 0, 0.4);
    }
    body { background: #ffffff; }
</style>`;

const LIVE_RELOAD_SCRIPT = `
<script>
    (function () {
        var seen = null;
        setInterval(function () {
            fetch('/__mtime')
                .then(function (r) { return r.text(); })
                .then(function (t) {
                    if (seen === null) { seen = t; }
                    else if (seen !== t) { location.reload(); }
                })
                .catch(function () {});
        }, 800);
    })();
</script>`;

const HARNESS = `
<script>
    window.acquireVsCodeApi = () => ({
        getState: () => ({}),
        setState: (s) => console.log('setState', s),
        postMessage: (m) => console.log('postMessage', m),
    });
</script>${LIVE_RELOAD_SCRIPT}`;

function injectPreviewHarness(html) {
    return html
        .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
        .replace('<head>', `<head>${THEME_SHIM}${HARNESS}`);
}

function buildFixtures() {
    const info = {
        label: 'sk-or-v1-preview',
        limit: null,
        limit_reset: null,
        limit_remaining: null,
        usage: 12.34,
        usage_daily: 0.42,
        usage_weekly: 3.1,
        usage_monthly: 9.9,
        is_free_tier: false,
        byok_usage: 1.2,
        byok_usage_daily: 0.1,
        byok_usage_weekly: 0.5,
        byok_usage_monthly: 1.2,
    };
    const accountCredits = { total_credits: 50, total_usage: 12.34 };
    const template = { preset: 'fast' };
    const presets = [
        { slug: 'fast', name: 'Fast', model: 'openai/gpt-5.6' },
        { slug: 'cheap', name: 'Cheap' },
        { slug: 'unavailable', name: 'Unavailable', lookupSkipped: true },
    ];
    const presetConfig = { model: 'openai/gpt-5.6', provider: { order: ['deepinfra'] } };
    const routes = [
        {
            provider: 'Amazon Bedrock',
            model: 'anthropic/claude-sonnet-4.5',
            byok: false,
            paid: 0.0123,
            openRouter: 0.0123,
            upstream: 0,
            promptTokens: 679570,
            completionTokens: 1200,
            cachedTokens: 583017,
            calls: 8,
            updatedAt: 1759570000000,
        },
        {
            provider: 'Fireworks',
            model: 'deepseek/deepseek-v4-pro',
            byok: true,
            paid: 0.0000134,
            openRouter: 0,
            upstream: 0.0000134,
            promptTokens: 4200,
            completionTokens: 350,
            cachedTokens: 0,
            calls: 2,
            updatedAt: 1759569900000,
        },
    ];
    const sessions = [
        {
            sessionId: 'copilot-chat:abcd-1234-efgh-5678',
            title: 'Refactor the parser',
            byok: false,
            paid: 0.0123134,
            openRouter: 0.0123,
            upstream: 0.0000134,
            promptTokens: 683770,
            completionTokens: 1550,
            cachedTokens: 583017,
            calls: 10,
            routes,
            updatedAt: 1759570000000,
        },
        {
            sessionId: 'unattributed',
            byok: true,
            paid: 0.0002201,
            openRouter: 0,
            upstream: 0.0002201,
            promptTokens: 12000,
            completionTokens: 900,
            cachedTokens: 4000,
            calls: 3,
            routes: [
                {
                    provider: 'Agent host (client BYOK)',
                    model: 'openai/gpt-5.6',
                    byok: true,
                    paid: 0.0002201,
                    openRouter: 0,
                    upstream: 0.0002201,
                    promptTokens: 12000,
                    completionTokens: 900,
                    cachedTokens: 4000,
                    calls: 3,
                    updatedAt: 1759569800000,
                },
            ],
            updatedAt: 1759569800000,
        },
    ];
    return {
        info,
        limit: 10,
        resetPeriod: 'daily',
        includeByok: true,
        refreshIntervalMinutes: 5,
        fetchedAt: new Date(1759570000000),
        maskedKey: 'sk-or-v1-preview...1234',
        accountCredits,
        template,
        presets,
        presetConfig,
        sessions,
        settings: {
            sanitizeBase64Content: true,
            hideUnavailableModels: true,
            outputReservePercent: 25,
            outputReserveMinTokens: 32768,
            outputReserveMaxTokens: 131072,
        },
    };
}

function freshRequire(relative) {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(outDir)) {
            delete require.cache[key];
        }
    }
    return require(path.join(outDir, relative));
}

// A representative catalog exercising buildModelInfo's branches: tiered pricing,
// synthetic vs real output caps, mandatory/optional/no reasoning, free and
// unlisted pricing, and a plain model. Edit to review other cases.
function buildModelFixtures() {
    return [
        {
            id: 'anthropic/claude-sonnet-4.5',
            name: 'Anthropic: Claude Sonnet 4.5',
            context_length: 200000,
            architecture: { input_modalities: ['text', 'image'] },
            supported_parameters: ['tools'],
            pricing: {
                prompt: '0.000003',
                completion: '0.000015',
                input_cache_read: '0.0000003',
                input_cache_write: '0.00000375',
                internal_reasoning: '0.000015',
            },
            top_provider: { context_length: 200000, max_completion_tokens: 64000 },
            reasoning: { supported_efforts: ['low', 'medium', 'high'], default_effort: 'medium', mandatory: false },
        },
        {
            id: 'openai/gpt-5.6',
            name: 'OpenAI: GPT-5.6',
            context_length: 1050000,
            architecture: { input_modalities: ['text', 'image'] },
            supported_parameters: ['tools'],
            pricing: {
                prompt: '0.00000125',
                completion: '0.00001',
                input_cache_read: '0.000000125',
                overrides: [
                    { min_prompt_tokens: 272000, prompt: '0.0000025', completion: '0.000015', input_cache_read: '0.00000025' },
                ],
            },
            top_provider: { context_length: 1050000, max_completion_tokens: 943718 },
            reasoning: { supported_efforts: null, default_effort: 'medium', mandatory: false },
        },
        {
            id: 'deepseek/deepseek-v4.1-flash',
            name: 'DeepSeek: V4.1 Flash',
            context_length: 1048576,
            architecture: { input_modalities: ['text'] },
            supported_parameters: ['tools'],
            pricing: { prompt: '0.0000001', completion: '0.0000004', input_cache_read: '0.00000002' },
            top_provider: { context_length: 1048576, max_completion_tokens: 943718 },
            reasoning: { supported_efforts: null, default_enabled: true, mandatory: false },
        },
        {
            id: 'qwen/qwen3.7-flash',
            name: 'Qwen: Qwen3.7 Flash',
            context_length: 1000000,
            architecture: { input_modalities: ['text'] },
            supported_parameters: ['tools'],
            pricing: {
                prompt: '0.00000005',
                completion: '0.0000002',
                overrides: [
                    { min_prompt_tokens: 32000, prompt: '0.00000008', completion: '0.0000003' },
                    { min_prompt_tokens: 256000, prompt: '0.00000014', completion: '0.0000005' },
                ],
            },
            top_provider: { context_length: 1000000, max_completion_tokens: 900000 },
        },
        {
            id: 'meta-llama/llama-4-free',
            name: 'Meta: Llama 4 (free)',
            context_length: 131072,
            architecture: { input_modalities: ['text'] },
            supported_parameters: [],
            pricing: { prompt: '0', completion: '0' },
            top_provider: { context_length: 131072 },
        },
        {
            id: 'anthropic/claude-opus-reasoner',
            name: 'Anthropic: Claude Opus Reasoner',
            context_length: 200000,
            architecture: { input_modalities: ['text', 'image'] },
            supported_parameters: ['tools'],
            pricing: { prompt: '0.000005', completion: '0.000025' },
            top_provider: { context_length: 200000, max_completion_tokens: 32000 },
            reasoning: { mandatory: true, supported_efforts: ['low', 'medium', 'high'] },
        },
        {
            id: 'vendor/unlisted-model',
            name: 'Vendor: Unlisted Model',
            architecture: { input_modalities: ['text'] },
        },
    ];
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function inlineMarkdown(text) {
    return escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
}

// Minimal renderer for the picker tooltip's markdown subset (**bold**, `code`,
// GFM tables, "- " lists, blank-line-separated blocks). Close enough to VS
// Code's rendering to review wording and layout; not a general implementation.
function renderMarkdownTable(tableLines) {
    const cells = (line) =>
        line
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim());
    const header = cells(tableLines[0]);
    const body = tableLines.slice(2).map((line) => cells(line));
    const head = `<tr>${header.map((c) => `<th>${inlineMarkdown(c)}</th>`).join('')}</tr>`;
    const rows = body
        .map((row) => `<tr>${row.map((c) => `<td>${inlineMarkdown(c)}</td>`).join('')}</tr>`)
        .join('');
    return `<table><thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function markdownToHtml(markdown) {
    const lines = markdown.split('\n');
    const blocks = [];
    let list = false;
    const closeList = () => {
        if (list) {
            blocks.push('</ul>');
            list = false;
        }
    };
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        const isTableLine = /^\s*\|.*\|\s*$/.test(line);
        if (isTableLine) {
            closeList();
            const tableLines = [];
            while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
                tableLines.push(lines[index]);
                index++;
            }
            blocks.push(renderMarkdownTable(tableLines));
            continue;
        }
        if (/^\s*-\s+/.test(line)) {
            if (!list) {
                blocks.push('<ul>');
                list = true;
            }
            blocks.push(`<li>${inlineMarkdown(line.replace(/^\s*-\s+/, ''))}</li>`);
            index++;
            continue;
        }
        closeList();
        if (line.trim() !== '') {
            blocks.push(`<p>${inlineMarkdown(line)}</p>`);
        }
        index++;
    }
    closeList();
    return blocks.join('\n');
}

function renderModelInfoHtml() {
    const { buildModelInfo } = freshRequire('modelInfo.js');
    const cards = buildModelFixtures()
        .map((entry) => {
            const info = buildModelInfo(entry);
            return `<section class="card">
                <h2>${escapeHtml(entry.name ?? entry.id)} <span class="id">${escapeHtml(entry.id)}</span></h2>
                <p class="detail">picker detail: <code>${escapeHtml(info.detail ?? '(none)')}</code></p>
                <div class="tooltip">${markdownToHtml(info.tooltip)}</div>
                <p class="meta">maxInputTokens=${info.maxInputTokens} &middot; maxOutputTokens=${info.maxOutputTokens}</p>
            </section>`;
        })
        .join('\n');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Model picker info preview</title>
<style>
    :root { --vscode-font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
            --vscode-editor-font-family: ui-monospace, Consolas, monospace; }
    body { font-family: var(--vscode-font-family); background: #fff; color: #1f1f1f;
           margin: 0; padding: 24px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .lead { color: #6a6a6a; margin: 0 0 18px; }
    .card { border: 1px solid #d0d0d0; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px;
            max-width: 760px; }
    .card h2 { font-size: 14px; margin: 0 0 6px; }
    .id { font-family: var(--vscode-editor-font-family); font-weight: 400; font-size: 12px;
          color: #6a6a6a; }
    .detail, .meta { font-family: var(--vscode-editor-font-family); font-size: 12px; color: #6a6a6a;
                     margin: 0 0 8px; }
    .tooltip { border-top: 1px solid #eee; padding-top: 8px; font-size: 12px; line-height: 1.5; }
    .tooltip p { margin: 0 0 8px; }
    .tooltip ul { margin: 0 0 8px; padding-left: 20px; }
    .tooltip table { border-collapse: collapse; margin: 0 0 8px; font-family: var(--vscode-editor-font-family); }
    .tooltip th, .tooltip td { border: 1px solid #e0e0e0; padding: 2px 8px; text-align: right; }
    .tooltip th:first-child, .tooltip td:first-child { text-align: left; }
    .tooltip th { font-weight: 600; color: #6a6a6a; }
    code { font-family: var(--vscode-editor-font-family); background: #f3f3f3; padding: 0 3px;
           border-radius: 3px; }
</style>
</head>
<body>
<h1>Model picker info preview</h1>
<p class="lead">Renders <code>buildModelInfo</code> for representative catalog entries. This is the
tooltip the model picker shows; <code>picker detail</code> is the one-line detail.</p>
${cards}
${LIVE_RELOAD_SCRIPT}
</body>
</html>`;
}

function renderHtml() {
    const { renderPanelHtml } = freshRequire('panel.js');
    return injectPreviewHarness(renderPanelHtml(buildFixtures()));
}

function outMtime() {
    let latest = 0;
    for (const file of fs.readdirSync(outDir)) {
        if (file.endsWith('.js')) {
            latest = Math.max(latest, fs.statSync(path.join(outDir, file)).mtimeMs);
        }
    }
    return String(latest);
}

http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/__mtime') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(outMtime());
        return;
    }
    try {
        const html = url.pathname === '/model-info' ? renderModelInfoHtml() : renderHtml();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
    } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String((error && error.stack) || error));
    }
}).listen(port, '127.0.0.1', () => {
    console.log(`Panel preview:  http://127.0.0.1:${port}/`);
    console.log(`Model info:     http://127.0.0.1:${port}/model-info`);
    console.log('Live-reloads when out/*.js changes.');
});
