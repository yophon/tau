/**
 * Arguments of a tool call that is still streaming (P38b; pi parses them with a
 * streaming JSON parser to show the call early): close what is open — a string, then
 * arrays and objects — and drop a dangling key, comma or colon, until it parses.
 * Best effort: `{}` when nothing usable has arrived yet.
 */
export function parsePartialJson(text: string): Record<string, unknown> {
	let candidate = text;
	for (let attempt = 0; attempt < 4 && candidate.trim() !== ""; attempt++) {
		try {
			const value: unknown = JSON.parse(close(candidate));
			return value !== null && typeof value === "object" && !Array.isArray(value)
				? (value as Record<string, unknown>)
				: {};
		} catch {
			// Cut back to before the last member and try again.
			const cut = Math.max(candidate.lastIndexOf(","), candidate.lastIndexOf("{"), candidate.lastIndexOf("["));
			if (cut <= 0) return {};
			candidate = candidate.slice(0, candidate[cut] === "," ? cut : cut + 1);
		}
	}
	return {};
}

function close(text: string): string {
	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	for (const ch of text) {
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") stack.push("}");
		else if (ch === "[") stack.push("]");
		else if (ch === "}" || ch === "]") stack.pop();
	}
	let out = text;
	if (inString) {
		// A cut escape (`\`, `\u12`) would make the string invalid.
		out = out.replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, "");
		out += '"';
	}
	out = out.replace(/\s+$/, "");
	if (out.endsWith(",")) out = out.slice(0, -1);
	else if (out.endsWith(":")) out += "null";
	return out + stack.reverse().join("");
}
