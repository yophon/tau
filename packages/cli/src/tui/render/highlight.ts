/**
 * Syntax highlighting for code blocks and file previews (P38b), after pi's
 * utils/syntax-highlight.ts: highlight.js 10.7.3 core with pi's eager languages,
 * its HTML read back into styled spans (scopes → colors as pi's dark theme maps
 * them, in Ink color names). No language, an unknown one or a failure: plain lines
 * (pi skips auto-detection, which colors prose at random).
 */
import hljs from "highlight.js/lib/core.js";
import bash from "highlight.js/lib/languages/bash.js";
import c from "highlight.js/lib/languages/c.js";
import cpp from "highlight.js/lib/languages/cpp.js";
import csharp from "highlight.js/lib/languages/csharp.js";
import dart from "highlight.js/lib/languages/dart.js";
import go from "highlight.js/lib/languages/go.js";
import groovy from "highlight.js/lib/languages/groovy.js";
import java from "highlight.js/lib/languages/java.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import json from "highlight.js/lib/languages/json.js";
import kotlin from "highlight.js/lib/languages/kotlin.js";
import lua from "highlight.js/lib/languages/lua.js";
import nix from "highlight.js/lib/languages/nix.js";
import perl from "highlight.js/lib/languages/perl.js";
import php from "highlight.js/lib/languages/php.js";
import python from "highlight.js/lib/languages/python.js";
import ruby from "highlight.js/lib/languages/ruby.js";
import rust from "highlight.js/lib/languages/rust.js";
import scala from "highlight.js/lib/languages/scala.js";
import swift from "highlight.js/lib/languages/swift.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import type { Span, StyledLine } from "./spans.ts";

const LANGUAGES = {
	python,
	java,
	go,
	javascript,
	json,
	cpp,
	typescript,
	php,
	ruby,
	c,
	csharp,
	nix,
	bash,
	rust,
	scala,
	kotlin,
	swift,
	dart,
	groovy,
	perl,
	lua,
};
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

type Style = Omit<Span, "text">;

/** pi's highlight theme (dark), as Ink colors. */
const SCOPES: Record<string, Style> = {
	keyword: { color: "blue" },
	built_in: { color: "magenta" },
	literal: { color: "green" },
	number: { color: "green" },
	regexp: { color: "yellow" },
	string: { color: "yellow" },
	comment: { dim: true },
	doctag: { dim: true },
	meta: { dim: true },
	function: { color: "cyan" },
	title: { color: "cyan" },
	class: { color: "magenta" },
	type: { color: "magenta" },
	name: { color: "blue" },
	operator: { dim: true },
	punctuation: { dim: true },
	emphasis: { italic: true },
	strong: { bold: true },
	link: { underline: true },
	addition: { color: "green" },
	deletion: { color: "red" },
};

/** A scope's style: exact, then its prefix before "." or "-" (pi getScopeFormatter). */
function scopeStyle(scope: string | undefined): Style | undefined {
	if (!scope) return undefined;
	return SCOPES[scope] ?? SCOPES[scope.split(".")[0] ?? ""] ?? SCOPES[scope.split("-")[0] ?? ""];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'" };

/** highlight.js HTML → lines of spans, the innermost styled scope winning (pi renderHighlightedHtml). */
function htmlToLines(html: string, base: Style): StyledLine[] {
	const lines: StyledLine[] = [[]];
	const scopes: Array<string | undefined> = [];
	const emit = (text: string): void => {
		let style = base;
		for (let i = scopes.length - 1; i >= 0; i--) {
			const found = scopeStyle(scopes[i]);
			if (found) {
				style = found;
				break;
			}
		}
		text.split("\n").forEach((part, index) => {
			if (index > 0) lines.push([]);
			if (part !== "") (lines.at(-1) as StyledLine).push({ text: part, ...style });
		});
	};
	let buffer = "";
	for (let i = 0; i < html.length; ) {
		if (html.startsWith("<span", i)) {
			const end = html.indexOf(">", i);
			if (end !== -1) {
				emit(buffer);
				buffer = "";
				const scope = /class="hljs-([^"\s]+)/.exec(html.slice(i, end))?.[1];
				scopes.push(scope);
				i = end + 1;
				continue;
			}
		}
		if (html.startsWith("</span>", i)) {
			emit(buffer);
			buffer = "";
			scopes.pop();
			i += "</span>".length;
			continue;
		}
		if (html[i] === "&") {
			const end = html.indexOf(";", i);
			const entity = end !== -1 && end - i < 10 ? ENTITIES[html.slice(i + 1, end)] : undefined;
			if (entity !== undefined) {
				buffer += entity;
				i = end + 1;
				continue;
			}
		}
		buffer += html[i];
		i++;
	}
	emit(buffer);
	return lines;
}

/** Code as styled lines in `language`; plain (in `base`) when the language is unknown. */
export function highlightCode(code: string, language: string | undefined, base: Style = {}): StyledLine[] {
	const known = language !== undefined && language !== "" && hljs.getLanguage(language) !== undefined;
	if (known) {
		try {
			return htmlToLines(hljs.highlight(code, { language, ignoreIllegals: true }).value, base);
		} catch {
			// Fall through to plain lines.
		}
	}
	return code.split("\n").map((line) => (line === "" ? [] : [{ text: line, ...base }]));
}

/** A file's language from its extension (pi getLanguageFromPath). */
export function languageOf(path: string): string | undefined {
	const ext = path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;
	const byExt: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		mts: "typescript",
		cts: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		json: "json",
		lua: "lua",
		perl: "perl",
		pl: "perl",
		scala: "scala",
		dart: "dart",
		groovy: "groovy",
		nix: "nix",
	};
	return byExt[ext];
}
