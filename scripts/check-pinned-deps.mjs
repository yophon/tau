// Supply-chain gate (mirrors pi's scripts/check-pinned-deps.mjs): every
// dependency in every package.json must be an exact version. Exemptions:
// internal workspace packages (lockstep ^x.y.z via sync-versions) and
// examples/ (unpublished demo apps; expo requires ranges).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const EXACT = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "examples"]);
const INTERNAL_PREFIX = "@yophon/tau-";

const files = [];
(function collect(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!IGNORED_DIRS.has(entry.name)) collect(join(dir, entry.name));
		} else if (entry.name === "package.json") {
			files.push(join(dir, entry.name));
		}
	}
})(root);

const failures = [];
for (const file of files) {
	const pkg = JSON.parse(readFileSync(file, "utf8"));
	for (const section of SECTIONS) {
		for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
			if (name.startsWith(INTERNAL_PREFIX)) {
				const wanted = /^\^\d/.test(spec);
				if (!wanted) failures.push(`${relative(root, file)}: ${name}@${spec} (internal deps use ^x.y.z lockstep)`);
				continue;
			}
			if (!EXACT.test(spec)) {
				failures.push(`${relative(root, file)}: ${section}.${name} = "${spec}" is not an exact version`);
			}
		}
	}
}

if (failures.length > 0) {
	console.error("Unpinned dependencies found:\n");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log(`Pinned-deps check passed (${files.length} package.json files).`);
