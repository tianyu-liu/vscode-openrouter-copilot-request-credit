import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
    // The folder containing the Extension Manifest package.json
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");

    // The test folder compiled to dist/test/suite
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    // Use a fresh, disposable user-data dir so SecretStorage (and other
    // workspace/global state) never leaks from your real VS Code profile.
    const userDataDir = path.join(
        os.tmpdir(),
        `openrouter-copilot-request-credit-test-${process.pid}`
    );
    // Ensure a clean slate even if a previous crashed run left files.
    fs.rmSync(userDataDir, { recursive: true, force: true });

    // Hard stop so a hung extension host cannot leave CI waiting forever.
    const timeout = setTimeout(() => {
        console.error("Test run timed out after 10 minutes; aborting.");
        process.exit(1);
    }, 10 * 60 * 1000);

    try {
        // Some launcher/wrapper shells set ELECTRON_RUN_AS_NODE=1. When present,
        // Code.exe runs as the embedded Node runtime instead of VS Code and
        // rejects every CLI flag with "<Code.exe>: bad option: ...". Remove it
        // so the test host launches as the real VS Code application.
        delete process.env.ELECTRON_RUN_AS_NODE;

        // Download VS Code, unzip it and run the integration tests
        await runTests({ extensionDevelopmentPath, extensionTestsPath, launchArgs: [
            "--disable-extensions",
            `--user-data-dir=${userDataDir}`,
        ] });
    } catch (err) {
        console.error("Failed to run tests", err);
        // Set the exit code rather than calling process.exit(): exit() skips
        // the finally block below, leaving the temp profile behind.
        process.exitCode = 1;
    } finally {
        clearTimeout(timeout);
        // Clean up the temp profile after the run (VS Code has exited by now).
        // Guard the cleanup so a locked/held directory cannot mask the real
        // test error above.
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch (cleanupErr) {
            console.error("Failed to clean up the temp test profile", cleanupErr);
        }
    }
}

main();
