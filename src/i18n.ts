// Localization glue that stays free of `vscode` imports so the pure modules
// (`logic.ts`, `modelInfo.ts`) can keep importing it.
//
// Messages are written in English with `{0}`-style placeholders and passed
// through `t`. The extension host installs `vscode.l10n.t` as the translator in
// `activate`; every other context (unit tests, the panel preview harness) keeps
// the default formatter, which substitutes the arguments and returns the English
// source unchanged.

/** A message id (English source text with `{0}` placeholders) plus its arguments. */
export type Translate = (message: string, ...args: Array<string | number | boolean>) => string;

/** Substitute `{0}`, `{1}`, … into the English source. */
export function formatMessage(message: string, ...args: Array<string | number | boolean>): string {
    return message.replace(/\{(\d+)\}/g, (_match, index: string) => {
        const value = args[Number(index)];
        return value === undefined ? '' : String(value);
    });
}

let translator: Translate = formatMessage;

/** Install the runtime translator (the extension host wires `vscode.l10n.t`). */
export function setTranslator(fn: Translate): void {
    translator = fn;
}

/** Restore the default (English) formatter; used by tests. */
export function resetTranslator(): void {
    translator = formatMessage;
}

/** Localize a message id, substituting the given arguments. */
export function t(message: string, ...args: Array<string | number | boolean>): string {
    return translator(message, ...args);
}
