// Publish-time build: tsc each publishable package's src into dist/ (JS + d.ts
// + sourcemaps). Development stays zero-build (Node type-stripping runs src
// directly); dist exists only because Node refuses to strip types inside
// node_modules, so published packages must ship JS.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLISHABLE_PACKAGES } from "./release-lib.mjs";

const root = new URL("..", import.meta.url).pathname;

// tsc's rewriteRelativeImportExtensions only rewrites JS emit; declaration
// files keep the source's ".ts" specifiers, which consumer typecheckers cannot
// resolve inside node_modules. Rewrite them to ".js" (maps to .d.ts) here.
// The lookbehind spares ".d.ts" references.
function rewriteDeclarationImports(distDir) {
	for (const entry of readdirSync(distDir, { withFileTypes: true })) {
		const path = join(distDir, entry.name);
		if (entry.isDirectory()) {
			rewriteDeclarationImports(path);
		} else if (entry.name.endsWith(".d.ts")) {
			const text = readFileSync(path, "utf8");
			const rewritten = text.replace(/(?<!\.d)\.ts(?=["'])/g, ".js");
			if (rewritten !== text) writeFileSync(path, rewritten);
		}
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	for (const dir of PUBLISHABLE_PACKAGES) {
		const pkgDir = join(root, "packages", dir);
		rmSync(join(pkgDir, "dist"), { recursive: true, force: true });
		console.log(`building packages/${dir} ...`);
		const result = spawnSync("npx", ["tsc", "-p", join(pkgDir, "tsconfig.build.json")], {
			cwd: root,
			stdio: "inherit",
		});
		if (result.status !== 0) {
			console.error(`tsc failed for packages/${dir}`);
			process.exit(1);
		}
		const entry = dir === "cli" ? "dist/main.js" : "dist/index.js";
		if (!existsSync(join(pkgDir, entry))) {
			console.error(`packages/${dir}/${entry} missing after build`);
			process.exit(1);
		}
		rewriteDeclarationImports(join(pkgDir, "dist"));
	}
	console.log(`\nbuilt ${PUBLISHABLE_PACKAGES.length} packages`);
}
