import { GatewayAllowance, gatewayAllowanceUrl, parseGatewayAllowance } from './gatewayAllowance';

export interface GatewayAllowanceRefreshState {
    gatewayAllowance?: GatewayAllowance;
    gatewayAllowanceStale?: boolean;
    fetchedAt?: Date;
    error?: string;
}

export interface GatewayAllowanceRefreshOptions {
    baseUrl: string;
    apiKey: string;
    signal: AbortSignal;
    isCurrent: () => boolean;
}

/** Publish only complete reads belonging to the captured connection revision. */
export async function refreshGatewayAllowanceState(
    state: GatewayAllowanceRefreshState,
    options: GatewayAllowanceRefreshOptions
): Promise<'updated' | 'failed' | 'superseded'> {
    const current = (): boolean => !options.signal.aborted && options.isCurrent();
    if (!current()) return 'superseded';
    try {
        const response = await fetch(gatewayAllowanceUrl(options.baseUrl), {
            redirect: 'error',
            headers: {
                Authorization: `Bearer ${options.apiKey}`,
                Accept: 'application/json',
                'User-Agent': 'vscode-openrouter-copilot-request-credit',
            },
            signal: AbortSignal.any([options.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw new Error('Allowance request failed.');
        const expected = new URL(gatewayAllowanceUrl(options.baseUrl));
        if (response.url && new URL(response.url).href !== expected.href) {
            throw new Error('Unexpected allowance response URL.');
        }
        const allowance = parseGatewayAllowance(await response.json());
        if (!current()) return 'superseded';
        state.gatewayAllowance = allowance;
        state.gatewayAllowanceStale = false;
        state.fetchedAt = new Date();
        state.error = undefined;
        return 'updated';
    } catch {
        if (!current()) return 'superseded';
        state.gatewayAllowanceStale = state.gatewayAllowance !== undefined;
        state.error = 'Gateway allowance refresh failed.';
        return 'failed';
    }
}
