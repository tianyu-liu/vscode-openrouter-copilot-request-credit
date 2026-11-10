import type { ConnectionKind } from './connections';
import { t } from './i18n';

export function isOpenRouterApiKey(value: string): boolean {
    return /^sk-or-/i.test(value.trim());
}

export function assertConnectionCredential(kind: ConnectionKind | undefined, value: string | undefined): void {
    if (kind !== undefined && kind !== 'openrouter' && value !== undefined && isOpenRouterApiKey(value)) {
        throw new Error(t(
            'OpenRouter API keys cannot be used with a proxy. Use a proxy token or leave the key blank.'
        ));
    }
}
