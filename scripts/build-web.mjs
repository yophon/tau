#!/usr/bin/env node
// Build tau's web client (P59): bundle packages/web/src with esbuild (Preact and the protocol package
// inside, nothing at run time) into packages/web/dist — a page, a hashed script and stylesheet, the
// manifest and the icon. The resident server serves dist (packages/cli/src/server/remote.ts).
//
//   node scripts/build-web.mjs           # minified, for the CLI and publishing
//   node scripts/build-web.mjs --dev     # readable, with a source map
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "packages", "web", "src");
const dist = join(root, "packages", "web", "dist");

export async function buildWeb({ dev = false } = {}) {
	rmSync(dist, { recursive: true, force: true });
	mkdirSync(dist, { recursive: true });
	const result = await build({
		entryPoints: [join(src, "main.tsx")],
		bundle: true,
		format: "esm",
		target: ["es2022", "safari16"],
		jsx: "automatic",
		jsxImportSource: "preact",
		minify: !dev,
		sourcemap: dev,
		outdir: dist,
		entryNames: "app-[hash]",
		metafile: true,
		logLevel: "warning",
		legalComments: "none",
	});
	const outputs = Object.keys(result.metafile.outputs).map((path) => basename(path));
	const js = outputs.find((name) => name.endsWith(".js"));
	const css = outputs.find((name) => name.endsWith(".css"));
	if (!js || !css) throw new Error(`build-web: expected a script and a stylesheet, got ${outputs.join(", ")}`);
	const page = readFileSync(join(src, "index.html"), "utf8").replace("{{JS}}", js).replace("{{CSS}}", css);
	writeFileSync(join(dist, "index.html"), page);
	for (const file of ["manifest.webmanifest", "icon.svg"]) copyFileSync(join(src, file), join(dist, file));
	return { js, css };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const built = await buildWeb({ dev: process.argv.includes("--dev") });
	console.log(`built packages/web/dist (${built.js}, ${built.css})`);
}
