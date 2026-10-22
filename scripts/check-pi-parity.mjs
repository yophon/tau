// Check docs/pi-parity.md against the pi snapshot (D23): the member rows of the
// three surface tables must equal the events / ExtensionAPI / ExtensionContext
// members declared in ../pi/packages/coding-agent/src/core/extensions/types.ts.
// Not part of `npm run check` — the snapshot lives outside the repo (CI has none).
//   node scripts/check-pi-parity.mjs          compare
//   node scripts/check-pi-parity.mjs --list   print the extracted members
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const typesPath = join(repoRoot, "..", "pi", "packages", "coding-agent", "src", "core", "extensions", "types.ts");
const parityPath = join(repoRoot, "docs", "pi-parity.md");

if (!existsSync(typesPath)) {
	console.error(`pi snapshot not found at ${typesPath}. Rebuild it (D23):`);
	console.error("  git clone --depth 1 --branch v1.4.0 https://github.com/earendil-works/pi ../pi");
	process.exit(1);
}
const source = readFileSync(typesPath, "utf8");

/** Body of `export interface <name> ... {` up to its closing brace at column 0. */
function interfaceBody(name) {
	const start = source.search(new RegExp(`^export interface ${name}\\b[^{]*\\{`, "m"));
	if (start < 0) throw new Error(`interface ${name} not found in types.ts`);
	const open = source.indexOf("{", start);
	const close = source.indexOf("\n}", open);
	return source.slice(open + 1, close);
}

/** Members declared at one-tab indent (methods and properties), comments skipped. */
function members(body) {
	const names = new Set();
	const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	for (const match of withoutComments.matchAll(/^\t(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[(:<]/gm)) {
		names.add(match[1]);
	}
	return names;
}

const apiBody = interfaceBody("ExtensionAPI");
const events = new Set([...apiBody.matchAll(/\bon\(\s*event:\s*"([a-z_]+)"/g)].map((match) => match[1]));
const api = members(apiBody);
api.delete("on");
const ctx = members(interfaceBody("ExtensionContext"));
const piSets = { events, api, ctx };

if (process.argv.includes("--list")) {
	for (const [kind, set] of Object.entries(piSets)) console.log(`${kind} (${set.size}): ${[...set].join(", ")}`);
	process.exit(0);
}

// pi-parity.md: rows of the tables under "## 事件", "## ExtensionAPI", "## ExtensionContext"
// whose first cell is a backticked member name.
const parity = readFileSync(parityPath, "utf8");
function tableMembers(heading) {
	const start = parity.indexOf(`\n## ${heading}`);
	if (start < 0) throw new Error(`pi-parity.md has no "## ${heading}" section`);
	const end = parity.indexOf("\n## ", start + 1);
	const section = parity.slice(start, end < 0 ? undefined : end);
	return new Set([...section.matchAll(/^\|\s*`([A-Za-z_$][\w$]*)`\s*\|/gm)].map((match) => match[1]));
}
const docSets = {
	events: tableMembers("事件"),
	api: tableMembers("ExtensionAPI"),
	ctx: tableMembers("ExtensionContext"),
};

let failed = false;
for (const kind of Object.keys(piSets)) {
	const missing = [...piSets[kind]].filter((name) => !docSets[kind].has(name));
	const extra = [...docSets[kind]].filter((name) => !piSets[kind].has(name));
	if (missing.length > 0 || extra.length > 0) {
		failed = true;
		if (missing.length > 0) console.error(`${kind}: missing rows for ${missing.join(", ")}`);
		if (extra.length > 0) console.error(`${kind}: rows not in pi ${extra.join(", ")}`);
	}
}
const total = Object.values(piSets).reduce((sum, set) => sum + set.size, 0);
if (failed) process.exit(1);
console.log(
	`pi-parity check passed: ${piSets.events.size} events + ${piSets.api.size} API + ${piSets.ctx.size} ctx = ${total} members.`,
);
