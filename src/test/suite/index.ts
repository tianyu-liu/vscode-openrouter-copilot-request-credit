import * as path from "path";
import * as fs from "fs";
import Mocha from "mocha";

/**
 * Recursively collect all '*.test.js' files under a directory.
 */
function collectTestFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...collectTestFiles(full));
        } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
            out.push(full);
        }
    }
    return out;
}

export async function run(): Promise<void> {
    // Create the mocha test
    const mocha = new Mocha({
        ui: "tdd",
        color: true,
        timeout: 30000,
    });

    const testsRoot = path.resolve(__dirname, "..");

    for (const f of collectTestFiles(testsRoot)) {
        mocha.addFile(f);
    }

    try {
        await new Promise<void>((resolve, reject) => {
            mocha.run((failures) => {
                if (failures > 0) {
                    reject(new Error(`${failures} tests failed.`));
                } else {
                    resolve();
                }
            });
        });
    } catch (err) {
        console.error(err);
        process.exitCode = 1;
        throw err;
    }
}