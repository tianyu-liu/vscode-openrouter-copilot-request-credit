import * as vscode from 'vscode';

const VENDOR = 'openrouter-copilot-request-credit';
const UPSTREAM_ID = 'fixture/shared-model';

interface FixtureModel extends vscode.LanguageModelChatInformation {
    readonly connectionId: string;
    readonly upstreamId: string;
    readonly configurationSchema: {
        type: string;
        properties: Record<string, { type: string; enum: string[]; default: string }>;
    };
}

export interface FixtureResponse {
    connectionId: string;
    upstreamId: string;
    configuration: Record<string, unknown>;
}

export interface FixtureApi {
    setPreference(connectionId: string, value: string): Thenable<void>;
    getPreference(connectionId: string): string | undefined;
}

export function activate(context: vscode.ExtensionContext): FixtureApi {
    const provider: vscode.LanguageModelChatProvider<FixtureModel> = {
        provideLanguageModelChatInformation(options) {
            // Configured groups are a runtime extension of the published API types.
            const configuration = (options as vscode.PrepareLanguageModelChatModelOptions & {
                configuration?: { connectionId?: unknown; rawIds?: unknown };
            }).configuration;
            if (typeof configuration?.connectionId !== 'string' || !configuration.connectionId) return [];
            const connectionId = configuration.connectionId;
            return [{
                id: configuration.rawIds === true ? UPSTREAM_ID : `${connectionId}::${UPSTREAM_ID}`,
                connectionId,
                upstreamId: UPSTREAM_ID,
                name: `Fixture ${connectionId}`,
                family: 'grouping-fixture',
                version: connectionId,
                maxInputTokens: 4096,
                maxOutputTokens: 1024,
                capabilities: { toolCalling: false, imageInput: false },
                configurationSchema: {
                    type: 'object',
                    properties: { effort: { type: 'string', enum: ['low', 'high'], default: 'low' } },
                },
            }];
        },
        async provideLanguageModelChatResponse(model, _messages, options, progress) {
            const configuration = (options as vscode.ProvideLanguageModelChatResponseOptions & {
                modelConfiguration?: Record<string, unknown>;
            }).modelConfiguration ?? {};
            const response: FixtureResponse = {
                connectionId: model.connectionId,
                upstreamId: model.upstreamId,
                configuration,
            };
            progress.report(new vscode.LanguageModelTextPart(JSON.stringify(response)));
        },
        async provideTokenCount() {
            return 1;
        },
    };
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));
    return {
        setPreference: (connectionId, value) => context.globalState.update(`preference.${connectionId}`, value),
        getPreference: (connectionId) => context.globalState.get<string>(`preference.${connectionId}`),
    };
}
