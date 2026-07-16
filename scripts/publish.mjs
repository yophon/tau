// Idempotent npm publish (mirrors pi's scripts/publish.mjs). tau twist: the
// repo's package.json files keep dev-time exports (./src/index.ts, zero-build
// workspace runs); this script temporarily rewrites each package.json to the
// dist/ shape for pack/publish and restores it afterwards — npm does not honor
// publishConfig.exports (that is a pnpm feature), so rewrite is the mechanism.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLISHABLE_PACKAGES, withPublishManifest } from "./release-lib.mjs";

const root = new URL("..", import.meta.url).pathname;
const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
if (unknownArgs.length > 0) {
	console.error("Usage: node scripts/publish.mjs [--dry-run]");
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(`Command failed: ${command} ${args.join(" ")}${output ? `\n${output}` : ""}`);
	}
	return result;
}

function isPublished(name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});
	if (result.status === 0 && result.stdout.trim()) return true;
	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) return false;
	throw new Error(`Failed to query ${name}@${version}\n${output}`);
}

const states = [];
for (const dir of PUBLISHABLE_PACKAGES) {
	const pkgDir = join(root, "packages", dir);
	const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	states.push({ dir, pkgDir, name: pkg.name, version: pkg.version, pkg });
}

const versions = [...new Set(states.map((state) => state.version))];
if (versions.length !== 1) {
	throw new Error(`Packages are not lockstep versioned: ${versions.join(", ")}`);
}
console.log(`Publishing tau packages at ${versions[0]}${dryRun ? " (dry run)" : ""}\n`);

for (const state of states) {
	const entry = state.dir === "cli" ? "dist/main.js" : "dist/index.js";
	if (!existsSync(join(state.pkgDir, entry))) {
		throw new Error(`${state.pkgDir}/${entry} missing — run npm run build first`);
	}
	state.published = isPublished(state.name, state.version);
	console.log(
		`${state.name}@${state.version} ${state.published ? "already published; validating only" : "will be published"}`,
	);
}
console.log();

// PUBLISHABLE_PACKAGES is dependency-ordered (kernel first, cli last), so a
// partial failure never leaves a published package with unpublished deps.
for (const state of states) {
	await withPublishManifest(state.pkgDir, state.dir, async () => {
		const packResult = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
			capture: true,
			cwd: state.pkgDir,
		});
		const packed = JSON.parse(packResult.stdout)[0];
		console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.unpackedSize} bytes unpacked`);
		const hasEntry = packed.files.some(
			(file) => file.path === (state.dir === "cli" ? "dist/main.js" : "dist/index.js"),
		);
		if (!hasEntry) throw new Error(`${state.name}: pack is missing its dist entry`);

		if (!dryRun && !state.published) {
			run("npm", ["publish", "--access", "public", "--ignore-scripts"], { cwd: state.pkgDir });
		}
	});
	console.log();
}

console.log(dryRun ? "Dry run complete." : "Publication complete.");
