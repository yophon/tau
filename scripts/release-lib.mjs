// Shared release helpers: the publishable package list (dependency-ordered)
// and the dev→publish manifest rewrite. Repo package.json files keep dev-time
// exports (./src/index.ts — zero-build workspace runs); publishing rewrites to
// dist/ because npm (unlike pnpm) does not honor publishConfig.exports.
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PUBLISHABLE_PACKAGES = [
	"kernel",
	"host-node",
	"host-browser",
	"host-weapp",
	"host-rn",
	"ext-subagents",
	"ext-mcp",
	"ext-mcp-http",
	"ext-provider-anthropic",
	"ext-resources",
	"cli",
];

/** Rewrite dev-time (src) entry points to the published dist/ shape. */
export function toPublishManifest(pkg, dir) {
	const out = structuredClone(pkg);
	delete out.private;
	if (dir === "cli") {
		out.exports = { ".": { types: "./dist/main.d.ts", default: "./dist/main.js" }, "./package.json": "./package.json" };
		out.bin = { tau: "./dist/main.js" };
	} else {
		out.exports = {
			".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
			"./package.json": "./package.json",
		};
	}
	return out;
}

/** Run fn with the package.json temporarily rewritten to its publish shape. */
export async function withPublishManifest(pkgDir, dir, fn) {
	const manifestPath = join(pkgDir, "package.json");
	const backupPath = join(pkgDir, "package.json.publish-backup");
	const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
	copyFileSync(manifestPath, backupPath);
	try {
		writeFileSync(manifestPath, `${JSON.stringify(toPublishManifest(pkg, dir), null, "\t")}\n`);
		return await fn(pkg);
	} finally {
		copyFileSync(backupPath, manifestPath);
		rmSync(backupPath);
	}
}
