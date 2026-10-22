// A language server for tests: Content-Length JSON-RPC on stdio.
// Diagnostics come from the text: a line containing "ERROR: msg" (or WARN, INFO, HINT)
// gives a diagnostic at that column. Navigation works on `function NAME` lines (and
// indented `method NAME` lines as their children); calls are `NAME(`.
// FAKE_LSP_LOG: every message received is appended to this file, one JSON per line.
// FAKE_LSP_MODE: crash-on-open | hang-init | garbage | ask-during-init | silent | slow-publish
// (FAKE_LSP_PUBLISH_DELAY ms, default 400)
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_LSP_LOG;
const mode = process.env.FAKE_LSP_MODE ?? "";
const docs = new Map();
const waiting = new Map();
let nextId = 1000;
let buffer = Buffer.alloc(0);

function send(message) {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
}
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
function request(method, params) {
	const id = nextId++;
	send({ jsonrpc: "2.0", id, method, params });
	return new Promise((resolve) => waiting.set(id, resolve));
}

if (mode === "garbage") process.stdout.write("starting fake server\n");
process.stderr.write("fake server ready\n");

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const end = buffer.indexOf("\r\n\r\n");
		if (end < 0) return;
		const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))?.[1]);
		if (buffer.length < end + 4 + length) return;
		const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
		buffer = buffer.subarray(end + 4 + length);
		handle(JSON.parse(body));
	}
});
process.stdin.on("end", () => process.exit(0));

const SEVERITIES = { ERROR: 1, WARN: 2, INFO: 3, HINT: 4 };

function publish(uri) {
	if (mode === "silent") return;
	const text = docs.get(uri) ?? "";
	const diagnostics = [];
	text.split(/\r?\n/).forEach((line, index) => {
		const match = /(ERROR|WARN|INFO|HINT): (.*)$/.exec(line);
		if (!match) return;
		diagnostics.push({
			range: { start: { line: index, character: match.index }, end: { line: index, character: line.length } },
			severity: SEVERITIES[match[1]],
			code: `F${SEVERITIES[match[1]]}`,
			source: "fake",
			message: match[2],
		});
	});
	setTimeout(() => notify("textDocument/publishDiagnostics", { uri, diagnostics }), mode === "slow-publish" ? Number(process.env.FAKE_LSP_PUBLISH_DELAY ?? 400) : 20);
}

function lines(uri) {
	return (docs.get(uri) ?? "").split(/\r?\n/);
}

function wordAt(uri, position) {
	const line = lines(uri)[position.line] ?? "";
	let start = position.character;
	let end = position.character;
	while (start > 0 && /\w/.test(line[start - 1])) start--;
	while (end < line.length && /\w/.test(line[end])) end++;
	return line.slice(start, end);
}

/** Every `function NAME` / `method NAME` with its range and the range of its body lines. */
function definitions() {
	const out = [];
	for (const [uri] of docs) {
		const all = lines(uri);
		all.forEach((line, index) => {
			const match = /^(\s*)(function|method) (\w+)/.exec(line);
			if (!match) return;
			const character = match[1].length + match[2].length + 1;
			out.push({
				uri,
				name: match[3],
				kind: match[2] === "function" ? 12 : 6,
				nested: match[1].length > 0,
				line: index,
				range: { start: { line: index, character }, end: { line: index, character: character + match[3].length } },
			});
		});
	}
	return out;
}

function bodyOf(definition) {
	const all = lines(definition.uri);
	const body = [];
	for (let index = definition.line + 1; index < all.length; index++) {
		if (/^(function|method) /.test(all[index].trimStart()) && !all[index].startsWith("    ")) break;
		body.push({ index, text: all[index] });
	}
	return body;
}

const itemOf = (definition) => ({
	name: definition.name,
	kind: definition.kind,
	uri: definition.uri,
	range: definition.range,
	selectionRange: definition.range,
});

function handle(message) {
	if (log) appendFileSync(log, `${JSON.stringify(message)}\n`);
	if (message.method === undefined) {
		waiting.get(message.id)?.(message);
		return;
	}
	const params = message.params ?? {};
	switch (message.method) {
		case "initialize": {
			if (mode === "hang-init") return;
			const answer = () =>
				respond(message.id, {
					capabilities: {
						textDocumentSync: 1,
						hoverProvider: true,
						definitionProvider: true,
						referencesProvider: true,
						documentSymbolProvider: true,
						workspaceSymbolProvider: true,
						implementationProvider: true,
						callHierarchyProvider: true,
					},
					serverInfo: { name: "fake" },
				});
			if (mode === "ask-during-init") {
				request("window/workDoneProgress/create", { token: "t" })
					.then(() => request("client/registerCapability", { registrations: [] }))
					.then(() => request("workspace/configuration", { items: [{ section: "a" }, { section: "b" }] }))
					.then(() => request("workspace/applyEdit", { edit: { changes: {} } }))
					.then(() => request("fake/unknown", {}))
					.then(answer);
				return;
			}
			answer();
			return;
		}
		case "shutdown":
			respond(message.id, null);
			return;
		case "exit":
			process.exit(0);
			return;
		case "textDocument/didOpen":
			if (mode === "crash-on-open") process.exit(3);
			docs.set(params.textDocument.uri, params.textDocument.text);
			publish(params.textDocument.uri);
			return;
		case "textDocument/didChange":
			docs.set(params.textDocument.uri, params.contentChanges[0].text);
			publish(params.textDocument.uri);
			return;
		case "textDocument/didClose":
			docs.delete(params.textDocument.uri);
			return;
		case "textDocument/definition":
		case "textDocument/implementation": {
			const word = wordAt(params.textDocument.uri, params.position);
			const found = definitions().filter((definition) => definition.name === word);
			if (message.method === "textDocument/definition") {
				respond(
					message.id,
					found.map((definition) => ({ uri: definition.uri, range: definition.range })),
				);
			} else {
				respond(
					message.id,
					found.map((definition) => ({
						targetUri: definition.uri,
						targetRange: definition.range,
						targetSelectionRange: definition.range,
					})),
				);
			}
			return;
		}
		case "textDocument/references": {
			const word = wordAt(params.textDocument.uri, params.position);
			const out = [];
			if (word) {
				for (const [uri] of docs) {
					lines(uri).forEach((line, index) => {
						for (const match of line.matchAll(new RegExp(`\\b${word}\\b`, "g"))) {
							out.push({
								uri,
								range: {
									start: { line: index, character: match.index },
									end: { line: index, character: match.index + word.length },
								},
							});
						}
					});
				}
			}
			respond(message.id, out);
			return;
		}
		case "textDocument/hover": {
			const word = wordAt(params.textDocument.uri, params.position);
			respond(message.id, word ? { contents: { kind: "markdown", value: `\`\`\`ts\nfunction ${word}()\n\`\`\`` } } : null);
			return;
		}
		case "textDocument/documentSymbol": {
			const symbols = [];
			for (const definition of definitions().filter((item) => item.uri === params.textDocument.uri)) {
				const symbol = { name: definition.name, kind: definition.kind, range: definition.range, selectionRange: definition.range };
				if (definition.nested && symbols.length > 0) {
					const parent = symbols[symbols.length - 1];
					parent.children = [...(parent.children ?? []), symbol];
				} else symbols.push(symbol);
			}
			respond(message.id, symbols);
			return;
		}
		case "workspace/symbol": {
			const query = params.query ?? "";
			respond(
				message.id,
				query === ""
					? []
					: definitions()
							.filter((definition) => definition.name.includes(query))
							.map((definition) => ({
								name: definition.name,
								kind: definition.kind,
								location: { uri: definition.uri, range: definition.range },
							})),
			);
			return;
		}
		case "textDocument/prepareCallHierarchy": {
			const word = wordAt(params.textDocument.uri, params.position);
			respond(
				message.id,
				definitions()
					.filter((definition) => definition.name === word)
					.map(itemOf),
			);
			return;
		}
		case "callHierarchy/incomingCalls": {
			const target = params.item.name;
			const out = [];
			for (const definition of definitions()) {
				const ranges = [];
				for (const { index, text } of bodyOf(definition)) {
					for (const match of text.matchAll(new RegExp(`\\b${target}\\(`, "g"))) {
						ranges.push({ start: { line: index, character: match.index }, end: { line: index, character: match.index + target.length } });
					}
				}
				if (ranges.length > 0) out.push({ from: itemOf(definition), fromRanges: ranges });
			}
			respond(message.id, out);
			return;
		}
		case "callHierarchy/outgoingCalls": {
			const source = definitions().find((definition) => definition.name === params.item.name);
			const out = [];
			if (source) {
				for (const callee of definitions()) {
					const ranges = [];
					for (const { index, text } of bodyOf(source)) {
						for (const match of text.matchAll(new RegExp(`\\b${callee.name}\\(`, "g"))) {
							ranges.push({ start: { line: index, character: match.index }, end: { line: index, character: match.index + callee.name.length } });
						}
					}
					if (ranges.length > 0) out.push({ to: itemOf(callee), fromRanges: ranges });
				}
			}
			respond(message.id, out);
			return;
		}
		default:
			if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `No ${message.method}` } });
	}
}
