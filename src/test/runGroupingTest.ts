import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
    const repositoryPath = path.resolve(__dirname, "../..");
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openrouter-rc-grouping-"));
    const userDataDir = path.join(temporaryRoot, "profile");
    const userDirectory = path.join(userDataDir, "User");
    const extensionDevelopmentPath = path.join(temporaryRoot, "fixture");
    const extensionsDir = path.join(temporaryRoot, "extensions");
    const configurationPath = path.join(userDirectory, "chatLanguageModels.json");
    const evidencePath = path.join(temporaryRoot, "evidence.json");

    const cleanup = (): void => {
        try {
            fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        } catch (error) {
            console.error("Failed to clean up the temporary grouping test files", error);
            process.exitCode = 1;
        }
    };
    const timeout = setTimeout(() => {
        console.error("Grouping test run timed out after 10 minutes; aborting.");
        cleanup();
        process.exit(1);
    }, 10 * 60 * 1000);

    try {
        const productionManifest = JSON.parse(
            fs.readFileSync(path.join(repositoryPath, "package.json"), "utf8")
        );
        const fixtureManifest = {
            name: productionManifest.name,
            publisher: productionManifest.publisher,
            version: productionManifest.version,
            engines: productionManifest.engines,
            enabledApiProposals: productionManifest.enabledApiProposals,
            main: "./extension.js",
            activationEvents: ["*"],
            contributes: {
                languageModelChatProviders: [{
                    vendor: "openrouter-copilot-request-credit",
                    displayName: "OpenRouter: RC",
                    configuration: {
                        type: "object",
                        properties: {
                            connectionId: { type: "string" },
                            rawIds: { type: "boolean", default: false },
                        },
                        required: ["connectionId"],
                    },
                }],
            },
        };
        fs.mkdirSync(userDirectory, { recursive: true });
        fs.mkdirSync(extensionDevelopmentPath, { recursive: true });
        fs.mkdirSync(extensionsDir, { recursive: true });
        fs.writeFileSync(configurationPath, "[]\n");
        fs.writeFileSync(path.join(userDirectory, "settings.json"), JSON.stringify({
            "telemetry.telemetryLevel": "off",
            "update.mode": "none",
            "extensions.autoCheckUpdates": false,
            "extensions.autoUpdate": false,
            "workbench.startupEditor": "none",
            "workbench.welcomePage.walkthroughs.openOnInstall": false,
            "update.showReleaseNotes": false,
            "security.workspace.trust.enabled": false,
        }, null, 2));
        fs.writeFileSync(path.join(extensionDevelopmentPath, "package.json"), JSON.stringify(fixtureManifest, null, 2));
        fs.copyFileSync(
            path.join(__dirname, "grouping", "extension.js"),
            path.join(extensionDevelopmentPath, "extension.js")
        );

        // Wrapper shells sometimes force Electron to run as Node, which rejects VS Code's launch arguments.
        delete process.env.ELECTRON_RUN_AS_NODE;
        const executableOverride = process.env.OPENROUTER_RC_VSCODE_EXECUTABLE;
        const isolatedEnvironment = Object.fromEntries(
            Object.keys(process.env).filter((name) => name.startsWith("VSCODE_")).map((name) => [name, undefined])
        );
        for (const phase of ["lifecycle", "reload"]) {
            console.log(`Running native grouping prototype: ${phase}`);
            await runTests({
                ...(executableOverride ? { vscodeExecutablePath: path.resolve(executableOverride) } : {}),
                extensionDevelopmentPath,
                extensionTestsPath: path.join(__dirname, "grouping", "index.js"),
                extensionTestsEnv: {
                    ...isolatedEnvironment,
                    OPENROUTER_RC_GROUPING_PHASE: phase,
                    OPENROUTER_RC_GROUPING_CONFIG: configurationPath,
                    OPENROUTER_RC_GROUPING_STATE: evidencePath,
                },
                launchArgs: [
                    "--disable-extensions",
                    "--skip-welcome",
                    "--skip-release-notes",
                    "--disable-workspace-trust",
                    `--user-data-dir=${userDataDir}`,
                    `--extensions-dir=${extensionsDir}`,
                ],
            });
        }
        console.log(fs.readFileSync(evidencePath, "utf8"));
    } catch (error) {
        console.error("Failed to run native grouping prototype", error);
        process.exitCode = 1;
    } finally {
        clearTimeout(timeout);
        cleanup();
    }
}

void main();
