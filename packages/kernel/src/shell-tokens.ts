// The shell tokenizer permission rules match commands with (P37a, Claude Code's rules; P62: split
// out of permission-rules.ts): words with their quotes, operators and redirections; heredoc bodies
// skipped; $(…), backticks and <(…) collected as nested commands so each is checked on its own.
// Pure ES. undefined when the command cannot be taken apart (it then asks).

export interface Word {
	/** As written, quotes included. */
	raw: string;
	/** With quotes removed. */
	value: string;
}

export type Token = { type: "word"; word: Word } | { type: "op"; op: string } | { type: "redirect"; op: string };

interface Heredoc {
	delimiter: string;
	/** <<- strips leading tabs from the body and the delimiter line. */
	strip: boolean;
	/** A quoted delimiter ('EOF', "EOF", \EOF): the body is not expanded. */
	quoted: boolean;
}

/** A here-document operator at `i` (<< or <<-, not <<<) and its delimiter word; `end` is just past the word. */
function readHeredocStart(text: string, i: number): { heredoc: Heredoc; end: number } | undefined {
	if (text[i] !== "<" || text[i + 1] !== "<" || text[i + 2] === "<") return undefined;
	let j = i + 2;
	let strip = false;
	if (text[j] === "-") {
		strip = true;
		j++;
	}
	while (text[j] === " " || text[j] === "\t") j++;
	let delimiter = "";
	let quoted = false;
	while (j < text.length && !/[\s;&|<>()]/.test(text[j])) {
		const c = text[j];
		if (c === "'" || c === '"') {
			const close = text.indexOf(c, j + 1);
			if (close === -1) return undefined;
			delimiter += text.slice(j + 1, close);
			quoted = true;
			j = close + 1;
			continue;
		}
		if (c === "\\") {
			quoted = true;
			delimiter += text[j + 1] ?? "";
			j += 2;
			continue;
		}
		delimiter += c;
		j++;
	}
	return delimiter === "" ? undefined : { heredoc: { delimiter, strip, quoted }, end: j };
}

/**
 * Skip the bodies of the pending here-documents, starting just after a newline: the
 * body is data, not commands (bash). An unquoted body still runs its `$(…)` and
 * backtick substitutions, so those go to `nested`. Returns the index after the last body.
 */
function skipHeredocBodies(text: string, start: number, pending: Heredoc[], nested: string[] | undefined): number {
	let pos = start;
	for (const doc of pending) {
		while (pos < text.length) {
			const newline = text.indexOf("\n", pos);
			const lineEnd = newline === -1 ? text.length : newline;
			const line = text.slice(pos, lineEnd).replace(/\r$/, "");
			pos = newline === -1 ? text.length : newline + 1;
			if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) break;
			if (!doc.quoted && nested) collectSubstitutions(line, nested);
		}
	}
	pending.length = 0;
	return pos;
}

/** `$(…)` and backtick substitutions in text that is not itself a command (arithmetic, here-document bodies). */
function collectSubstitutions(text: string, nested: string[]): void {
	for (let k = 0; k < text.length; k++) {
		if (text[k] === "\\") {
			k++;
			continue;
		}
		if (text[k] === "$" && text[k + 1] === "(") {
			const end = matchParen(text, k + 1);
			if (end === -1) return;
			if (text[k + 2] === "(" && text[end - 1] === ")") collectSubstitutions(text.slice(k + 3, end - 1), nested);
			else nested.push(text.slice(k + 2, end));
			k = end;
			continue;
		}
		if (text[k] === "`") {
			const end = text.indexOf("`", k + 1);
			if (end === -1) return;
			nested.push(text.slice(k + 1, end));
			k = end;
		}
	}
}

/**
 * `$(…)` at `start` (pointing at "$"): a command substitution goes to `nested`; for
 * arithmetic `$((…))` only the substitutions inside it do. Returns the closing index.
 */
function substitution(text: string, start: number, nested: string[]): number {
	const end = matchParen(text, start + 1);
	if (end === -1) return -1;
	if (text[start + 2] === "(" && text[end - 1] === ")") collectSubstitutions(text.slice(start + 3, end - 1), nested);
	else nested.push(text.slice(start + 2, end));
	return end;
}

/** Tokens of a command line; substitutions' inner text goes to `nested`. Undefined when quotes or parentheses do not balance. */
export function tokenize(command: string, nested: string[]): Token[] | undefined {
	const tokens: Token[] = [];
	const heredocs: Heredoc[] = [];
	let raw = "";
	let value = "";
	let inWord = false;
	const endWord = (): void => {
		if (inWord) tokens.push({ type: "word", word: { raw, value } });
		raw = "";
		value = "";
		inWord = false;
	};
	let i = 0;
	const n = command.length;
	while (i < n) {
		const c = command[i];
		if (c === "\\" && i + 1 < n) {
			if (command[i + 1] === "\n") {
				i += 2;
				continue;
			}
			raw += c + command[i + 1];
			value += command[i + 1];
			inWord = true;
			i += 2;
			continue;
		}
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			if (end === -1) return undefined;
			raw += command.slice(i, end + 1);
			value += command.slice(i + 1, end);
			inWord = true;
			i = end + 1;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			let inner = "";
			while (j < n && command[j] !== '"') {
				if (command[j] === "\\" && j + 1 < n) {
					inner += command[j + 1];
					j += 2;
					continue;
				}
				if (command[j] === "$" && command[j + 1] === "(") {
					const end = substitution(command, j, nested);
					if (end === -1) return undefined;
					inner += command.slice(j, end + 1);
					j = end + 1;
					continue;
				}
				if (command[j] === "`") {
					const end = command.indexOf("`", j + 1);
					if (end === -1) return undefined;
					nested.push(command.slice(j + 1, end));
					inner += command.slice(j, end + 1);
					j = end + 1;
					continue;
				}
				inner += command[j];
				j++;
			}
			if (j >= n) return undefined;
			raw += command.slice(i, j + 1);
			value += inner;
			inWord = true;
			i = j + 1;
			continue;
		}
		if (c === "$" && command[i + 1] === "(") {
			// $(( … )) is arithmetic: only the substitutions inside it run.
			const end = substitution(command, i, nested);
			if (end === -1) return undefined;
			raw += command.slice(i, end + 1);
			value += command.slice(i, end + 1);
			inWord = true;
			i = end + 1;
			continue;
		}
		if ((c === "<" || c === ">") && command[i + 1] === "(") {
			// Process substitution: its command runs too.
			const end = matchParen(command, i + 1);
			if (end === -1) return undefined;
			nested.push(command.slice(i + 2, end));
			raw += command.slice(i, end + 1);
			value += command.slice(i, end + 1);
			inWord = true;
			i = end + 1;
			continue;
		}
		if (c === "`") {
			const end = command.indexOf("`", i + 1);
			if (end === -1) return undefined;
			nested.push(command.slice(i + 1, end));
			raw += command.slice(i, end + 1);
			value += command.slice(i, end + 1);
			inWord = true;
			i = end + 1;
			continue;
		}
		if (c === "#" && !inWord) {
			while (i < n && command[i] !== "\n") i++;
			continue;
		}
		if (c === " " || c === "\t" || c === "\r") {
			endWord();
			i++;
			continue;
		}
		if (c === "\n" || c === ";" || c === "(" || c === ")") {
			endWord();
			tokens.push({ type: "op", op: c });
			i++;
			// Here-document bodies follow the line that opened them.
			if (c === "\n" && heredocs.length > 0) i = skipHeredocBodies(command, i, heredocs, nested);
			continue;
		}
		if (c === "&" || c === "|") {
			const two = command.slice(i, i + 2);
			if (c === "&" && command[i + 1] === ">") {
				endWord();
				const append = command[i + 2] === ">";
				tokens.push({ type: "redirect", op: append ? "&>>" : "&>" });
				i += append ? 3 : 2;
				continue;
			}
			endWord();
			if (two === "&&" || two === "||" || two === "|&") {
				tokens.push({ type: "op", op: two });
				i += 2;
			} else {
				tokens.push({ type: "op", op: c });
				i++;
			}
			continue;
		}
		const heredoc = c === "<" ? readHeredocStart(command, i) : undefined;
		if (heredoc) {
			// <<EOF / <<-'EOF': the delimiter is the redirect's target; the body is skipped at the newline.
			if (inWord && /^\d+$/.test(raw)) {
				raw = "";
				value = "";
				inWord = false;
			} else {
				endWord();
			}
			tokens.push({ type: "redirect", op: "<<" });
			tokens.push({ type: "word", word: { raw: heredoc.heredoc.delimiter, value: heredoc.heredoc.delimiter } });
			heredocs.push(heredoc.heredoc);
			i = heredoc.end;
			continue;
		}
		if (c === ">" || c === "<") {
			// A leading fd number belongs to the redirection (2>file).
			let op = "";
			if (inWord && /^\d+$/.test(raw)) {
				op = raw;
				raw = "";
				value = "";
				inWord = false;
			} else {
				endWord();
			}
			let j = i;
			while (j < n && (command[j] === c || (command[j] === "&" && j > i) || (command[j] === "|" && c === ">"))) j++;
			op += command.slice(i, j);
			tokens.push({ type: "redirect", op: op.replace(/^\d+/, "") || c });
			i = j;
			continue;
		}
		raw += c;
		value += c;
		inWord = true;
		i++;
	}
	endWord();
	return tokens;
}

/** Index of the ")" closing the "(" at `open`, honoring quotes and here-document bodies; -1 when unbalanced. */
function matchParen(text: string, open: number): number {
	let depth = 0;
	const heredocs: Heredoc[] = [];
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "<") {
			const heredoc = readHeredocStart(text, i);
			if (heredoc) {
				heredocs.push(heredoc.heredoc);
				i = heredoc.end - 1;
				continue;
			}
		}
		if (c === "\n" && heredocs.length > 0) {
			i = skipHeredocBodies(text, i + 1, heredocs, undefined) - 1;
			continue;
		}
		if (c === "'") {
			const end = text.indexOf("'", i + 1);
			if (end === -1) return -1;
			i = end;
			continue;
		}
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			if (j >= text.length) return -1;
			i = j;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}
