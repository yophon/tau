// Port of pi v0.80.3 packages/ai/src/utils/json-parse.ts (repairJson + parseJsonWithRepair),
// minus the partial-json streaming fallback (a dependency; tau parses tool arguments once,
// after the stream completes). Models regularly emit raw control characters inside
// strings or invalid escapes such as `\d` in regexes; a plain JSON.parse turned those
// tool calls into `{}` arguments.

// `u` is handled on its own: valid only with four hex digits, so `\usepackage` gets its backslash doubled (pi 1.3).
const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repair malformed JSON string literals: escape raw control characters inside
 * strings and double backslashes that precede an invalid escape character.
 */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') inString = true;
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}
			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}
			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}
			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

/**
 * The complete arguments text of a finished tool call (pi 1.3 parseToolCallArguments): text that
 * is not a JSON object leaves `arguments` empty and `argumentsError` says why, with the text the
 * model sent, so validation reports it back instead of running the call on a partial parse.
 */
export function parseToolCallArguments(json: string | undefined): {
	arguments: Record<string, unknown>;
	argumentsError?: string;
} {
	if (!json?.trim()) return { arguments: {} };
	try {
		const parsed = parseJsonWithRepair<unknown>(json);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Tool arguments must be a JSON object");
		}
		return { arguments: parsed as Record<string, unknown> };
	} catch (error) {
		return {
			arguments: {},
			argumentsError: `${error instanceof Error ? error.message : String(error)}\n\nReceived arguments:\n${json}`,
		};
	}
}

/** JSON.parse, retried once on the repaired text when the original does not parse. */
export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repaired = repairJson(json);
		if (repaired !== json) return JSON.parse(repaired) as T;
		throw error;
	}
}
