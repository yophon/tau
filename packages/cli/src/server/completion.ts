// The input completion a session's extensions add (P57, pi ui.addAutocompleteProvider; P62: split
// out of thread.ts): the providers stack over the client's own completion, which the client sends as
// the base of each request.
import type { AutocompleteProvider, AutocompleteProviderFactory, AutocompleteSuggestions } from "@yophon/tau-kernel";
import type { CompletionItem } from "@yophon/tau-protocol";
import { bottomProvider, CLIENT_APPLIES } from "./ui.ts";

export class ThreadCompletion {
	private providers: AutocompleteProviderFactory[] = [];
	private chain: AutocompleteProvider | undefined;
	private abort: AbortController | undefined;
	/** The client's own completion for the request being answered (the bottom of the chain). */
	private base: AutocompleteSuggestions | null = null;

	add(factory: AutocompleteProviderFactory): void {
		this.providers.push(factory);
		this.chain = undefined;
	}

	get count(): number {
		return this.providers.length;
	}

	/** After a reload the new extensions add their providers again. */
	reset(): void {
		this.providers = [];
		this.chain = undefined;
	}

	/** A session handed over to another keeps the providers its extensions added. */
	adopt(from: ThreadCompletion): void {
		this.providers = from.providers;
		this.chain = undefined;
	}

	private providerChain(): AutocompleteProvider {
		this.chain ??= this.providers.reduce<AutocompleteProvider>(
			(current, factory) => factory(current),
			bottomProvider(() => this.base),
		);
		return this.chain;
	}

	/** The providers' suggestions for the input; a newer request aborts the one before. */
	async suggest(
		lines: string[],
		line: number,
		col: number,
		force?: boolean,
		base?: { items: CompletionItem[]; prefix: string },
	): Promise<{ items: CompletionItem[]; prefix: string } | null> {
		if (this.providers.length === 0) return null;
		this.abort?.abort();
		const abort = new AbortController();
		this.abort = abort;
		this.base = base ?? null;
		const suggestions = await this.providerChain().getSuggestions(lines, line, col, {
			signal: abort.signal,
			...(force ? { force } : {}),
		});
		if (!suggestions || suggestions.items.length === 0) return null;
		return {
			items: suggestions.items.map((item) => ({
				value: item.value,
				label: item.label,
				...(item.description !== undefined ? { description: item.description } : {}),
			})),
			prefix: suggestions.prefix,
		};
	}

	apply(
		lines: string[],
		line: number,
		col: number,
		item: CompletionItem,
		prefix: string,
	): { lines: string[]; line: number; col: number } | null {
		const applied = this.providerChain().applyCompletion(lines, line, col, item, prefix);
		if (applied.cursorLine === CLIENT_APPLIES) return null;
		return { lines: applied.lines, line: applied.cursorLine, col: applied.cursorCol };
	}
}
