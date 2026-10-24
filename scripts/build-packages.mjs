// Publish-time build: tsc each publishable package's src into dist/ (JS + d.ts
// + sourcemaps). Development stays zero-build (Node type-stripping runs src
// directly); dist exists only because Node refuses to strip types inside
// node_modules, so published packages must ship JS.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildWeb } from "./build-web.mjs";
import { PUBLISHABLE_PACKAGES } from "./release-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

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

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	for (const dir of PUBLISHABLE_PACKAGES) {
		const pkgDir = join(root, "packages", dir);
		// P59: the web client is a bundle of static files, not tsc output.
		if (dir === "web") {
			console.log("building packages/web ...");
			await buildWeb();
			continue;
		}
		rmSync(join(pkgDir, "dist"), { recursive: true, force: true });
		console.log(`building packages/${dir} ...`);
		const result = spawnSync(commandForPlatform("npx"), ["tsc", "-p", join(pkgDir, "tsconfig.build.json")], {
			cwd: root,
			shell: process.platform === "win32",
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
