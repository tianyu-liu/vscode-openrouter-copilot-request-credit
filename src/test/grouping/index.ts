import * as path from 'path';
import Mocha from 'mocha';

export async function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30000 });
    mocha.addFile(path.join(__dirname, 'lifecycle.js'));
    await new Promise<void>((resolve, reject) => {
        mocha.run((failures) => failures ? reject(new Error(`${failures} grouping tests failed.`)) : resolve());
    });
}
