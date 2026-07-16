// Supply-chain hardening for the app package (mirrors pi's
// generate-coding-agent-shrinkwrap.mjs): generate packages/cli/npm-shrinkwrap.json
// from the root lockfile so `npm install @yophon/tau-cli` resolves the exact
// dependency tree we tested, and refuse dependencies with install scripts
// (empty allowlist today). Internal workspace deps are mapped to their registry
// tarball URLs (they publish in the same lockstep release).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const cliDir = join(root, "packages/cli");
const shrinkwrapPath = join(cliDir, "npm-shrinkwrap.json");
const INTERNAL_PREFIX = "@yophon/tau-";
const ALLOWED_INSTALL_SCRIPT_PACKAGES = new Map();

const checkOnly = process.argv.includes("--check");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--check");
if (unknownArgs.length > 0) {
	console.error("Usage: node scripts/generate-cli-shrinkwrap.mjs [--check]");
	process.exit(1);
}

const rootLock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const cliPkg = JSON.parse(readFileSync(join(cliDir, "package.json"), "utf8"));

function readWorkspaceManifest(name) {
	const dir = name.slice(INTERNAL_PREFIX.length);
	return JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
}

function registryTarballUrl(name, version) {
	const tarball = name.startsWith("@") ? name.split("/")[1] : name;
	return `https://registry.npmjs.org/${name}/-/${tarball}-${version}.tgz`;
}

const packages = {
	"": {
		name: cliPkg.name,
		version: cliPkg.version,
		license: cliPkg.license,
		dependencies: cliPkg.dependencies,
		bin: { tau: "./dist/main.js" },
		engines: cliPkg.engines,
	},
};

const failures = [];
const queue = Object.keys(cliPkg.dependencies ?? {});
const seen = new Set();
while (queue.length > 0) {
	const name = queue.shift();
	if (seen.has(name)) continue;
	seen.add(name);

	if (name.startsWith(INTERNAL_PREFIX)) {
		const manifest = readWorkspaceManifest(name);
		packages[`node_modules/${name}`] = {
			version: manifest.version,
			resolved: registryTarballUrl(name, manifest.version),
			license: manifest.license,
			...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
			...(manifest.engines ? { engines: manifest.engines } : {}),
		};
		queue.push(...Object.keys(manifest.dependencies ?? {}));
		continue;
	}

	const entry = rootLock.packages[`node_modules/${name}`];
	if (!entry) {
		failures.push(`${name}: not found in root package-lock.json`);
		continue;
	}
	if (entry.hasInstallScript && !ALLOWED_INSTALL_SCRIPT_PACKAGES.has(`${name}@${entry.version}`)) {
		failures.push(`${name}@${entry.version} has an install script and is not allowlisted`);
	}
	const copied = { ...entry };
	delete copied.dev;
	delete copied.devOptional;
	packages[`node_modules/${name}`] = copied;
	queue.push(...Object.keys({ ...entry.dependencies, ...entry.optionalDependencies }));
}

if (failures.length > 0) {
	console.error("Shrinkwrap generation failed:\n");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}

const shrinkwrap = {
	name: cliPkg.name,
	version: cliPkg.version,
	lockfileVersion: 3,
	requires: true,
	packages,
};
const serialized = `${JSON.stringify(shrinkwrap, null, "\t")}\n`;

if (checkOnly) {
	let current = "";
	try {
		current = readFileSync(shrinkwrapPath, "utf8");
	} catch {
		// missing file fails the comparison below
	}
	if (current !== serialized) {
		console.error("packages/cli/npm-shrinkwrap.json is out of date. Run: npm run shrinkwrap:cli");
		process.exit(1);
	}
	console.log("Shrinkwrap check passed.");
} else {
	writeFileSync(shrinkwrapPath, serialized);
	console.log(`Wrote ${shrinkwrapPath} (${Object.keys(packages).length - 1} entries).`);
}
