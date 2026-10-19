/**
 * The stdin Ink reads (P34): every read goes through `filter` first, so terminal
 * reports the TUI handles itself (mouse, focus, keys Ink drops) never reach Ink's
 * key parser and are seen whole and in order. A read the filter takes completely
 * is skipped.
 */
export function filteredStdin(stdin: NodeJS.ReadStream, filter: (data: string) => string): NodeJS.ReadStream {
	return new Proxy(stdin, {
		get(target, property) {
			if (property === "read") {
				return (...args: unknown[]) => {
					for (;;) {
						const chunk = (target.read as (...a: unknown[]) => unknown).apply(target, args);
						if (chunk === null || chunk === undefined) return chunk;
						const rest = filter(typeof chunk === "string" ? chunk : String(chunk));
						if (rest !== "") return rest;
					}
				};
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) {
			return Reflect.set(target, property, value, target);
		},
	});
}
