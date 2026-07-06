import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const outdir = join(tmpdir(), `tau-browser-demo-${Date.now()}`);
await mkdir(outdir, { recursive: true });
const outfile = join(outdir, "app.js");

try {
	await build({
		entryPoints: ["examples/browser/src/app.ts"],
		bundle: true,
		format: "esm",
		platform: "browser",
		target: "es2023",
		outfile,
		logLevel: "silent",
	});
	const bundled = await readFile(outfile, "utf8");
	if (bundled.includes("node:")) {
		throw new Error("browser bundle unexpectedly contains a node: import");
	}
	console.log(`browser demo bundle ok (${bundled.length} bytes)`);
} finally {
	await rm(outdir, { recursive: true, force: true });
}
