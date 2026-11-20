import * as vscode from 'vscode';
import { ConnectionRegistry, type ConnectionDefinition } from './connections';
import { OpenRouterChatProvider, onTurnCost, type SessionCost, type TurnCost } from './provider';

interface ProviderEntry {
    revision: number;
    provider: OpenRouterChatProvider;
    subscription: vscode.Disposable;
}

/** Older connections retain their original picker IDs until their credentials or routing boundary changes. */
export function connectionModelId(connectionId: string, upstreamModelId: string, routingRevision?: number): string {
    const identity = routingRevision === undefined ? [connectionId, upstreamModelId]
        : [connectionId, upstreamModelId, routingRevision];
    return `rc:${Buffer.from(JSON.stringify(identity)).toString('base64url')}`;
}
export function decodeModelId(id: string): [string, string, number?] | undefined {
    try {
        if (!id.startsWith('rc:')) { return undefined; }
        const value: unknown = JSON.parse(Buffer.from(id.slice(3), 'base64url').toString());
        if (!Array.isArray(value) || typeof value[0] !== 'string' || !value[0]
            || typeof value[1] !== 'string' || !value[1]) return undefined;
        if (value.length === 2) return [value[0], value[1]];
        if (value.length === 3 && Number.isSafeInteger(value[2]) && value[2] > 0) {
            return [value[0], value[1], value[2]];
        }
        return undefined;
    } catch { return undefined; }
}
function modelVersion(upstreamModelId: string, revision: number): string {
    return JSON.stringify([upstreamModelId, revision]);
}

/** One provider registration dispatching only through a model's explicit connection identity. */
export class ConnectionChatProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
    private readonly entries = new Map<string, ProviderEntry>();
    private readonly changes = new vscode.EventEmitter<void>();
    private readonly costs = new vscode.EventEmitter<TurnCost>();
    private readonly subscriptions: vscode.Disposable[];
    private disposed = false;
    readonly onDidChangeLanguageModelChatInformation = this.changes.event;
    readonly onTurnCost = this.costs.event;

    constructor(
        private readonly registry: ConnectionRegistry,
        private readonly allowProxyConnections = false,
        private readonly workspaceId?: string,
    ) {
        this.subscriptions = [
            registry.onDidChange(() => {
                for (const [id, entry] of this.entries) {
                    const current = this.getConnection(id);
                    if (!current || current.revision !== entry.revision) {
                        entry.provider.resetCatalogCache();
                        if (!current) {
                            entry.subscription.dispose();
                            entry.provider.dispose();
                            this.entries.delete(id);
                        }
                    }
                }
                this.changes.fire();
            }),
            onTurnCost(cost => { if (cost.connectionId && this.getConnection(cost.connectionId)) { this.costs.fire(cost); } }),
        ];
    }

    private getConnection(id: string): ConnectionDefinition | undefined {
        return this.allowProxyConnections ? this.registry.get(id) : this.registry.getOpenRouter(id);
    }

    getProvider(connectionId: string): OpenRouterChatProvider | undefined {
        if (this.disposed) { return undefined; }
        const connection = this.getConnection(connectionId);
        if (!connection) { return undefined; }
        let entry = this.entries.get(connectionId);
        if (entry?.revision === connection.revision) { return entry.provider; }
        const previous = entry?.provider;
        entry?.subscription.dispose();
        const provider = new OpenRouterChatProvider(
            this.registry.secretsFor(connectionId), this.registry.stateFor(connectionId), {
                connectionId, kind: connection.kind, baseUrl: connection.baseUrl,
                hideUnavailableModels: connection.settings.hideUnavailableModels,
                manualModels: connection.models, accounting: previous, workspaceId: this.workspaceId,
                readKey: () => this.registry.readKey(connectionId),
                isCurrent: () => {
                    const current = this.getConnection(connectionId);
                    return !this.disposed && current?.revision === connection.revision && current.enabled;
                },
            }
        );
        const subscription = provider.onDidChangeLanguageModelChatInformation(() => {
            if (this.entries.get(connectionId)?.provider === provider) { this.changes.fire(); }
        });
        entry = { provider, subscription, revision: connection.revision };
        this.entries.set(connectionId, entry);
        previous?.dispose();
        return provider;
    }

    getSessionCosts(connectionId: string): SessionCost[] {
        return this.getProvider(connectionId)?.getSessionCosts() ?? [];
    }

    async provideLanguageModelChatInformation(
        options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        const id = (options as { configuration?: { connectionId?: unknown } }).configuration?.connectionId;
        if (typeof id !== 'string') { return []; }
        const connection = this.getConnection(id);
        if (!connection?.enabled || this.disposed) { return []; }
        const provider = this.getProvider(id);
        if (!provider) { return []; }
        const models = await provider.provideLanguageModelChatInformation(options, token);
        const current = this.getConnection(id);
        if (this.disposed || !current?.enabled || current.revision !== connection.revision) { return []; }
        return models.map(model => ({
            ...model, id: connectionModelId(id, model.id, connection.routingRevision),
            version: modelVersion(model.id, connection.revision),
            connectionId: id, upstreamModelId: model.id, connectionRevision: connection.revision,
        }));
    }

    private resolveModel(model: vscode.LanguageModelChatInformation): {
        provider: OpenRouterChatProvider; upstream: vscode.LanguageModelChatInformation; connection: ConnectionDefinition;
    } {
        const identity = decodeModelId(model.id);
        const connection = identity ? this.getConnection(identity[0]) : undefined;
        if (this.disposed || !identity || !connection?.enabled || identity[2] !== connection.routingRevision
            || model.version !== modelVersion(identity[1], connection.revision)) {
            throw vscode.LanguageModelError.NotFound('This connection changed or is unavailable. Select its model again.');
        }
        const provider = this.getProvider(connection.id);
        if (!provider) { throw vscode.LanguageModelError.NotFound('Connection unavailable.'); }
        return { provider, upstream: { ...model, id: identity[1], version: identity[1] }, connection };
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken
    ): Promise<void> {
        const { provider, upstream } = this.resolveModel(model);
        await provider.provideLanguageModelChatResponse(upstream, messages, options, progress, token);
    }

    async provideTokenCount(
        model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage,
        token: vscode.CancellationToken
    ): Promise<number> {
        const { provider, upstream } = this.resolveModel(model);
        return provider.provideTokenCount(upstream, text, token);
    }

    resetCatalogCache(): void { for (const entry of this.entries.values()) { entry.provider.resetCatalogCache(); } }
    refreshModelInfo(): void { for (const entry of this.entries.values()) { entry.provider.refreshModelInfo(); } }
    dispose(): void {
        this.disposed = true;
        for (const subscription of this.subscriptions) { subscription.dispose(); }
        for (const entry of this.entries.values()) { entry.subscription.dispose(); entry.provider.dispose(); }
        this.entries.clear();
        this.changes.dispose();
        this.costs.dispose();
    }
}
