/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Vendored subset of VS Code's proposed `languageModelThinkingPart` API
// (microsoft/vscode, src/vscode-dts/vscode.proposed.languageModelThinkingPart.d.ts,
// version 1). Referenced from src/provider.ts via a triple-slash reference so
// the class is typed in the build; the file itself stays out of the tsconfig
// `include` list like typings/vscode.proposed.chatProvider.d.ts.
//
// Only the `LanguageModelThinkingPart` class is vendored — the rest of the
// proposal (LanguageModelChatResponse, LanguageModelChatMessage2, ...) already
// exists in stable @types/vscode and would conflict if redeclared.

declare module 'vscode' {

	/**
	 * A language model response part containing thinking/reasoning content.
	 * Thinking tokens represent the model's internal reasoning process that
	 * typically streams before the final response.
	 */
	export class LanguageModelThinkingPart {
		/**
		 * The thinking/reasoning text content.
		 */
		value: string | string[];

		/**
		 * Optional unique identifier for this thinking sequence.
		 */
		id?: string;

		/**
		 * Optional metadata associated with this thinking sequence.
		 */
		metadata?: { readonly [key: string]: any };

		/**
		 * Construct a thinking part with the given content.
		 * @param value The thinking text content.
		 * @param id Optional unique identifier for this thinking sequence.
		 * @param metadata Optional metadata associated with this thinking sequence.
		 */
		constructor(value: string | string[], id?: string, metadata?: { readonly [key: string]: any });
	}
}
