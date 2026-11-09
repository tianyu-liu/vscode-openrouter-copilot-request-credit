import * as assert from 'assert';
import { parseGatewayAllowance } from '../../gatewayAllowance';
import {
    GatewayAllowanceRefreshOptions, GatewayAllowanceRefreshState, refreshGatewayAllowanceState,
} from '../../gatewayAllowanceRefresh';

function payload(remaining = 7): unknown {
    return {
        cheap: {
            status: 'reported', limit: 10, remaining, usage: 10 - remaining, reset: 'daily',
            resets_at: null, include_byok: true, effective_budget: null,
            applicable_budgets: [], inherited_budgets: [],
        },
        default: { status: 'unknown' },
        fetched_at: '2026-10-28T12:34:56Z',
    };
}

function options(overrides: Partial<GatewayAllowanceRefreshOptions> = {}): GatewayAllowanceRefreshOptions {
    return {
        baseUrl: 'https://gateway.example/api/v1?unused=private',
        apiKey: 'private-test-key',
        signal: new AbortController().signal,
        isCurrent: () => true,
        ...overrides,
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

suite('gateway allowance refresh', () => {
    let originalFetch: typeof globalThis.fetch;
    let originalTimeout: typeof AbortSignal.timeout;

    setup(() => {
        originalFetch = globalThis.fetch;
        originalTimeout = AbortSignal.timeout;
        globalThis.fetch = async () => { throw new Error('Unexpected test fetch'); };
    });

    teardown(() => {
        globalThis.fetch = originalFetch;
        AbortSignal.timeout = originalTimeout;
    });

    test('uses the origin allowance route and private bearer key with redirect refusal and a timeout', async () => {
        const timeout = new AbortController();
        let timeoutMs: number | undefined;
        AbortSignal.timeout = milliseconds => { timeoutMs = milliseconds; return timeout.signal; };
        const controller = new AbortController();
        let calls = 0;
        globalThis.fetch = async (url, init) => {
            calls++;
            assert.strictEqual(String(url), 'https://gateway.example/lab/allowance');
            assert.strictEqual(init?.redirect, 'error');
            const headers = new Headers(init?.headers);
            assert.strictEqual(headers.get('Authorization'), 'Bearer private-test-key');
            assert.strictEqual(headers.get('Accept'), 'application/json');
            assert.ok(init?.signal);
            assert.strictEqual(init.signal.aborted, false);
            controller.abort();
            assert.strictEqual(init.signal.aborted, true);
            return Response.json(payload());
        };
        const state: GatewayAllowanceRefreshState = {};
        const result = await refreshGatewayAllowanceState(state, options({ signal: controller.signal }));
        assert.strictEqual(result, 'superseded');
        assert.strictEqual(timeoutMs, 15000);
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(state, {});
    });

    test('publishes parsed counters and retrieval time, clearing a prior failure', async () => {
        globalThis.fetch = async () => Response.json(payload());
        const previous = parseGatewayAllowance(payload(2));
        const state: GatewayAllowanceRefreshState = {
            gatewayAllowance: previous, gatewayAllowanceStale: true, error: 'old failure',
        };
        const before = Date.now();
        assert.strictEqual(await refreshGatewayAllowanceState(state, options()), 'updated');
        assert.deepStrictEqual(state.gatewayAllowance, parseGatewayAllowance(payload()));
        assert.notStrictEqual(state.gatewayAllowance, previous);
        assert.strictEqual(state.gatewayAllowanceStale, false);
        assert.strictEqual(state.error, undefined);
        assert.ok(state.fetchedAt instanceof Date);
        assert.ok(state.fetchedAt.getTime() >= before && state.fetchedAt.getTime() <= Date.now());
    });

    test('publishes a valid lane even when the other lane contains malformed counters', async () => {
        globalThis.fetch = async () => Response.json({
            ...(payload() as object), default: { status: 'reported', remaining: 'private-upstream-text' },
        });
        const state: GatewayAllowanceRefreshState = {};
        assert.strictEqual(await refreshGatewayAllowanceState(state, options()), 'updated');
        assert.strictEqual(state.gatewayAllowance?.cheap.remaining, 7);
        assert.strictEqual(state.gatewayAllowance?.default.status, 'unknown');
        assert.strictEqual(state.gatewayAllowance?.default.remaining, null);
        assert.ok(!JSON.stringify(state).includes('private-upstream-text'));
    });

    test('failures preserve stale counters and timestamp without exposing response or exception text', async () => {
        const failures: Array<() => Promise<Response>> = [
            async () => new Response('private upstream error', { status: 403 }),
            async () => new Response('private malformed JSON', { status: 200 }),
            async () => Response.json({ error: 'private schema error' }),
            async () => { throw new Error('private key or network details'); },
        ];
        for (const fail of failures) {
            globalThis.fetch = fail;
            const previous = parseGatewayAllowance(payload(2));
            const fetchedAt = new Date('2026-10-27T00:00:00Z');
            const state: GatewayAllowanceRefreshState = { gatewayAllowance: previous, fetchedAt };
            assert.strictEqual(await refreshGatewayAllowanceState(state, options()), 'failed');
            assert.strictEqual(state.gatewayAllowance, previous);
            assert.strictEqual(state.fetchedAt, fetchedAt);
            assert.strictEqual(state.gatewayAllowanceStale, true);
            assert.strictEqual(state.error, 'Gateway allowance refresh failed.');
            assert.ok(!JSON.stringify(state).includes('private'));
        }
    });

    test('a first failed read leaves allowance unknown rather than manufacturing zero counters', async () => {
        globalThis.fetch = async () => Response.json({ error: 'unavailable' }, { status: 503 });
        const state: GatewayAllowanceRefreshState = {};
        assert.strictEqual(await refreshGatewayAllowanceState(state, options()), 'failed');
        assert.strictEqual(state.gatewayAllowance, undefined);
        assert.strictEqual(state.gatewayAllowanceStale, false);
        assert.strictEqual(state.fetchedAt, undefined);
        assert.strictEqual(state.error, 'Gateway allowance refresh failed.');
    });

    test('rejects a response from an unexpected URL without reading its body', async () => {
        let readBody = false;
        globalThis.fetch = async () => ({
            ok: true,
            url: 'https://other.example/lab/allowance',
            json: async () => { readBody = true; return payload(); },
        }) as Response;
        const state: GatewayAllowanceRefreshState = {};
        assert.strictEqual(await refreshGatewayAllowanceState(state, options()), 'failed');
        assert.strictEqual(readBody, false);
        assert.strictEqual(state.error, 'Gateway allowance refresh failed.');
    });

    test('timeout aborts the request and retains prior allowance as stale', async () => {
        const timeout = new AbortController();
        AbortSignal.timeout = () => timeout.signal;
        const started = deferred<void>();
        globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener('abort', () => reject(new Error('private timeout details')), { once: true });
            started.resolve();
        });
        const previous = parseGatewayAllowance(payload());
        const state: GatewayAllowanceRefreshState = { gatewayAllowance: previous };
        const pending = refreshGatewayAllowanceState(state, options());
        await started.promise;
        timeout.abort();
        assert.strictEqual(await pending, 'failed');
        assert.strictEqual(state.gatewayAllowance, previous);
        assert.strictEqual(state.gatewayAllowanceStale, true);
        assert.strictEqual(state.error, 'Gateway allowance refresh failed.');
    });

    test('concurrent connections keep keys, responses and failures isolated', async () => {
        const firstResponse = deferred<Response>();
        const secondResponse = deferred<Response>();
        globalThis.fetch = async (_url, init) => {
            const key = new Headers(init?.headers).get('Authorization');
            if (key === 'Bearer first-private-key') return firstResponse.promise;
            assert.strictEqual(key, 'Bearer second-private-key');
            return secondResponse.promise;
        };
        const first: GatewayAllowanceRefreshState = {};
        const secondPrevious = parseGatewayAllowance(payload(4));
        const second: GatewayAllowanceRefreshState = { gatewayAllowance: secondPrevious };
        const pendingFirst = refreshGatewayAllowanceState(first, options({ apiKey: 'first-private-key' }));
        const pendingSecond = refreshGatewayAllowanceState(second, options({ apiKey: 'second-private-key' }));
        secondResponse.resolve(new Response('private error', { status: 500 }));
        assert.strictEqual(await pendingSecond, 'failed');
        assert.deepStrictEqual(first, {});
        firstResponse.resolve(Response.json(payload(9)));
        assert.strictEqual(await pendingFirst, 'updated');
        assert.strictEqual(first.gatewayAllowance?.cheap.remaining, 9);
        assert.strictEqual(first.error, undefined);
        assert.strictEqual(second.gatewayAllowance, secondPrevious);
        assert.strictEqual(second.gatewayAllowanceStale, true);
    });

    test('revision changes, disabling and deletion discard a pending response without touching state', async () => {
        for (const mutation of ['revision', 'disable', 'delete'] as const) {
            const response = deferred<Response>();
            globalThis.fetch = async () => response.promise;
            let revision = 1;
            let enabled = true;
            let exists = true;
            const state: GatewayAllowanceRefreshState = { error: 'existing error' };
            const pending = refreshGatewayAllowanceState(state, options({
                isCurrent: () => revision === 1 && enabled && exists,
            }));
            if (mutation === 'revision') revision++;
            if (mutation === 'disable') enabled = false;
            if (mutation === 'delete') exists = false;
            response.resolve(Response.json(payload()));
            assert.strictEqual(await pending, 'superseded', mutation);
            assert.deepStrictEqual(state, { error: 'existing error' }, mutation);
        }
    });

    test('abort during JSON parsing discards a late body even if fetch ignores cancellation', async () => {
        const body = deferred<unknown>();
        const reading = deferred<void>();
        const controller = new AbortController();
        globalThis.fetch = async () => ({
            ok: true, url: '', json: () => { reading.resolve(); return body.promise; },
        }) as Response;
        const state: GatewayAllowanceRefreshState = { error: 'existing error' };
        const pending = refreshGatewayAllowanceState(state, options({ signal: controller.signal }));
        await reading.promise;
        controller.abort();
        body.resolve(payload());
        assert.strictEqual(await pending, 'superseded');
        assert.deepStrictEqual(state, { error: 'existing error' });
    });

    test('superseded failures and already cancelled reads cannot alter state', async () => {
        const response = deferred<Response>();
        const controller = new AbortController();
        let calls = 0;
        globalThis.fetch = async () => { calls++; return response.promise; };
        const state: GatewayAllowanceRefreshState = { error: 'existing error' };
        const pending = refreshGatewayAllowanceState(state, options({ signal: controller.signal }));
        controller.abort();
        response.resolve(new Response('private failure', { status: 500 }));
        assert.strictEqual(await pending, 'superseded');
        const aborted = await refreshGatewayAllowanceState(state, options({ signal: controller.signal }));
        const invalidated = await refreshGatewayAllowanceState(state, options({ isCurrent: () => false }));
        assert.strictEqual(aborted, 'superseded');
        assert.strictEqual(invalidated, 'superseded');
        assert.strictEqual(calls, 1);
        assert.deepStrictEqual(state, { error: 'existing error' });
    });
});
