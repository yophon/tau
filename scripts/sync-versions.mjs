// Lockstep versioning (mirrors pi's scripts/sync-versions.js, simplified):
// assert all workspace packages share one version, then point every internal
// dependency at ^<version>.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const packagesDir = join(root, "packages");
const INTERNAL_PREFIX = "@yophon/tau-";

const packages = [];
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const path = join(packagesDir, entry.name, "package.json");
	packages.push({ path, data: JSON.parse(readFileSync(path, "utf8")) });
}

const versions = new Set(packages.map((pkg) => pkg.data.version));
if (versions.size !== 1) {
	console.error(`Packages are not lockstep versioned: ${[...versions].join(", ")}`);
	console.error("Run npm run version:patch|minor|major to bump all workspaces together.");
	process.exit(1);
}
const version = [...versions][0];

let updates = 0;
for (const pkg of packages) {
	let changed = false;
	for (const section of ["dependencies", "devDependencies"]) {
		const deps = pkg.data[section];
		if (!deps) continue;
		for (const name of Object.keys(deps)) {
			if (!name.startsWith(INTERNAL_PREFIX)) continue;
			const wanted = `^${version}`;
			if (deps[name] !== wanted) {
				deps[name] = wanted;
				changed = true;
				updates++;
			}
		}
	}
	if (changed) writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
}

console.log(`lockstep ${version}; ${updates} internal dependency specifier(s) updated`);
