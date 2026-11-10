import * as assert from 'assert';
import { assertConnectionCredential, isOpenRouterApiKey } from '../../connectionCredentials';

suite('connection credential syntax', () => {
    test('recognizes trimmed, mixed-case, partial and future OpenRouter prefixes', () => {
        for (const key of ['sk-or-v1-test', '  SK-OR-V1-TEST\n', 'sk-or-', 'sk-or-v99-example']) {
            assert.strictEqual(isOpenRouterApiKey(key), true);
            for (const kind of ['gateway', 'openai-compatible'] as const) {
                assert.throws(() => assertConnectionCredential(kind, key), error => {
                    const message = (error as Error).message;
                    return message.includes('OpenRouter API keys cannot be used with a proxy')
                        && !message.includes(key);
                });
            }
            assert.doesNotThrow(() => assertConnectionCredential('openrouter', key));
            assert.doesNotThrow(() => assertConnectionCredential(undefined, key));
        }
    });

    test('allows proxy tokens, empty values and unrecognized prefixes without inferring their issuer', () => {
        for (const key of ['', '  ', 'proxy-token', 'sk-other-token', 'sk-or', 'prefix-sk-or-v1-test']) {
            assert.strictEqual(isOpenRouterApiKey(key), false);
            assert.doesNotThrow(() => assertConnectionCredential('gateway', key));
            assert.doesNotThrow(() => assertConnectionCredential('openai-compatible', key));
        }
        assert.doesNotThrow(() => assertConnectionCredential('gateway', undefined));
        assert.doesNotThrow(() => assertConnectionCredential('openai-compatible', undefined));
    });
});
