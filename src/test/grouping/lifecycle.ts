import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { FixtureApi, FixtureResponse } from './extension';

const EXTENSION_ID = 'tianyu-liu.openrouter-copilot-request-credit';
const VENDOR = 'openrouter-copilot-request-credit';
const UPSTREAM_ID = 'fixture/shared-model';

interface Group {
    vendor: string;
    name: string;
    connectionId: string;
    rawIds?: boolean;
    settings?: Record<string, { effort: string }>;
}

interface Evidence {
    client: string;
    extensionVersion: string;
    checks: string[];
}

function requiredEnvironment(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} must be supplied by the isolated grouping runner.`);
    return value;
}

async function eventually<T>(operation: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 15000;
    do {
        const result = await operation();
        if (result !== undefined) return result;
        await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error('The native model catalog did not reach the expected state within 15 seconds.');
}

async function modelsFor(...connections: string[]): Promise<vscode.LanguageModelChat[]> {
    return eventually(async () => {
        const models = await vscode.lm.selectChatModels({ vendor: VENDOR });
        return models.map((model) => model.version).sort().join(',') === [...connections].sort().join(',')
            ? models : undefined;
    });
}

async function respond(model: vscode.LanguageModelChat): Promise<FixtureResponse> {
    const response = await model.sendRequest([vscode.LanguageModelChatMessage.User('routing probe')]);
    let result = '';
    for await (const chunk of response.text) result += chunk;
    return JSON.parse(result) as FixtureResponse;
}

function assertRetiredHandle(error: unknown, group: Group, model: vscode.LanguageModelChat): void {
    assert.ok(error instanceof Error);
    assert.match(error.message, /not registered|not found|not available|unavailable|does not exist/i);
    assert.ok(error.message.includes(`${VENDOR}/${group.name}/${model.id}`),
        'the retired native identifier includes the old group name');
}

async function writeGroups(groups: Group[]): Promise<void> {
    const uri = vscode.Uri.file(requiredEnvironment('OPENROUTER_RC_GROUPING_CONFIG'));
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
        JSON.stringify(groups, null, 2) + '\n');
    assert.ok(await vscode.workspace.applyEdit(edit), 'native configuration edit applies');
    assert.ok(await document.save(), 'native configuration saves');
}

suite('native configured model groups (isolated fixture)', () => {
    let api: FixtureApi;
    let evidence: Evidence;
    const phase = requiredEnvironment('OPENROUTER_RC_GROUPING_PHASE');
    const statePath = requiredEnvironment('OPENROUTER_RC_GROUPING_STATE');
    const personal: Group = { vendor: VENDOR, name: 'Personal OpenRouter', connectionId: 'fixture-a' };
    const work: Group = { vendor: VENDOR, name: 'Work OpenRouter', connectionId: 'fixture-b' };
    const renamed: Group = { ...personal, name: 'Renamed Personal' };

    suiteSetup(async () => {
        assert.ok(phase === 'lifecycle' || phase === 'reload', 'known isolated runner phase');
        const extension = vscode.extensions.getExtension<FixtureApi>(EXTENSION_ID);
        assert.ok(extension, 'fixture uses the existing extension identity');
        api = await extension.activate();
        evidence = phase === 'reload' ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {
            client: vscode.version,
            extensionVersion: extension.packageJSON.version,
            checks: [],
        };
        assert.strictEqual(evidence.extensionVersion, extension.packageJSON.version);
        console.log(`Native group probe: VS Code ${vscode.version}, extension ${extension.packageJSON.version}`);
    });

    suiteTeardown(() => {
        if (evidence) fs.writeFileSync(statePath, JSON.stringify(evidence, null, 2) + '\n');
    });

    if (phase === 'lifecycle') {
        test('adds named groups with independent routes for the same upstream model', async () => {
            const commands = await vscode.commands.getCommands(true);
            assert.ok(commands.includes('lm.addLanguageModelsProviderGroup'), 'native group add is available');
            await modelsFor();
            await vscode.commands.executeCommand('lm.addLanguageModelsProviderGroup', personal);
            await modelsFor(personal.connectionId);
            await vscode.commands.executeCommand('lm.addLanguageModelsProviderGroup', work);
            const models = await modelsFor(personal.connectionId, work.connectionId);
            assert.strictEqual(new Set(models.map((model) => model.id)).size, 2);
            for (const model of models) {
                assert.strictEqual(model.id, `${model.version}::${UPSTREAM_ID}`);
                assert.deepStrictEqual(await respond(model), {
                    connectionId: model.version, upstreamId: UPSTREAM_ID, configuration: { effort: 'low' },
                });
            }
            evidence.checks.push('add; duplicate upstream models route independently with scoped public IDs');
        });

        test('isolates native model settings by connection-scoped model ID', async () => {
            personal.settings = { [`${personal.connectionId}::${UPSTREAM_ID}`]: { effort: 'high' } };
            work.settings = { [`${work.connectionId}::${UPSTREAM_ID}`]: { effort: 'low' } };
            await writeGroups([personal, work]);
            await eventually(async () => {
                const models = await modelsFor(personal.connectionId, work.connectionId);
                const results = await Promise.all(models.map(respond));
                return results.every((result) => result.configuration.effort ===
                    (result.connectionId === personal.connectionId ? 'high' : 'low')) ? true : undefined;
            });
            await api.setPreference(personal.connectionId, 'context:65536');
            await api.setPreference(work.connectionId, 'context:32768');
            assert.strictEqual(api.getPreference(personal.connectionId), 'context:65536');
            assert.strictEqual(api.getPreference(work.connectionId), 'context:32768');
            evidence.checks.push('native settings and extension-owned preferences isolated by connection ID');
        });

        test('renames a group, preserving connection preferences and characterizing stale selection', async () => {
            const before = (await modelsFor(personal.connectionId, work.connectionId))
                .find((model) => model.version === personal.connectionId)!;
            renamed.settings = personal.settings;
            await writeGroups([renamed, work]);
            await eventually(async () => {
                try {
                    await respond(before);
                    return undefined;
                } catch (error) {
                    assertRetiredHandle(error, personal, before);
                    return true;
                }
            });
            const after = (await modelsFor(personal.connectionId, work.connectionId))
                .find((model) => model.version === personal.connectionId)!;
            assert.strictEqual(after.id, before.id, 'public scoped model ID is independent of the group name');
            assert.strictEqual((await respond(after)).configuration.effort, 'high');
            assert.strictEqual(api.getPreference(personal.connectionId), 'context:65536');
            evidence.checks.push(
                'rename preserves connection ID/preferences; old native selection handle stops working'
            );
        });

        test('removes a group without rerouting its saved model handle', async () => {
            const removed = (await modelsFor(personal.connectionId, work.connectionId))
                .find((model) => model.version === work.connectionId)!;
            await writeGroups([renamed]);
            await modelsFor(personal.connectionId);
            await assert.rejects(() => respond(removed), (error: unknown) => {
                assertRetiredHandle(error, work, removed);
                return true;
            });
            assert.strictEqual((await respond((await modelsFor(personal.connectionId))[0])).connectionId,
                personal.connectionId);
            assert.strictEqual(api.getPreference(work.connectionId), 'context:32768');
            evidence.checks.push('remove withdraws models; stale handle fails without fallback');
        });

        test('characterizes raw duplicate IDs in separate native groups', async () => {
            const rawA = { ...personal, name: 'Raw A', connectionId: 'raw-a', rawIds: true, settings: undefined };
            const rawB = { ...work, name: 'Raw B', connectionId: 'raw-b', rawIds: true, settings: undefined };
            await writeGroups([renamed, rawA, rawB]);
            const models = await modelsFor(personal.connectionId, rawA.connectionId, rawB.connectionId);
            const rawModels = models.filter((model) => model.id === UPSTREAM_ID);
            assert.strictEqual(rawModels.length, 2, 'same provider model ID may appear in distinct native groups');
            const responses = await Promise.all(rawModels.map(respond));
            assert.deepStrictEqual(responses.map((response) => response.connectionId).sort(), ['raw-a', 'raw-b']);
            await writeGroups([renamed]);
            await modelsFor(personal.connectionId);
            evidence.checks.push(
                'raw duplicate IDs coexist and route by native group (settings mutation needs UI review)'
            );
        });
    } else {
        test('restores the renamed native group and model settings after a process restart', async () => {
            assert.strictEqual(evidence.client, vscode.version, 'both phases use the same client');
            assert.strictEqual(evidence.checks.length, 5, 'lifecycle phase completed');
            const models = await modelsFor(personal.connectionId);
            assert.deepStrictEqual(await respond(models[0]), {
                connectionId: personal.connectionId, upstreamId: UPSTREAM_ID, configuration: { effort: 'high' },
            });
            const groups: Group[] = JSON.parse(fs.readFileSync(requiredEnvironment('OPENROUTER_RC_GROUPING_CONFIG'),
                'utf8'));
            assert.strictEqual(groups.length, 1);
            assert.strictEqual(groups[0].name, renamed.name);
            assert.strictEqual(groups[0].connectionId, personal.connectionId);
            evidence.checks.push('process restart restores renamed group and native settings');
        });
    }
});
