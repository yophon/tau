// Bundle the weapp demo library (kernel + host-weapp + demo entry) into a
// single CommonJS file the mini-program page can require(). With --check the
// bundle goes to a temp dir instead (CI smoke: proves the stack bundles for a
// neutral platform with no Node leakage).
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const checkOnly = process.argv.includes("--check");
const repoOutfile = "examples/weapp/miniprogram/lib/tau.js";
const outdir = checkOnly ? join(tmpdir(), `tau-weapp-demo-${Date.now()}`) : null;
const outfile = checkOnly ? join(outdir, "tau.js") : repoOutfile;

if (outdir) await mkdir(outdir, { recursive: true });
try {
	await build({
		entryPoints: ["examples/weapp/src/tau-entry.ts"],
		bundle: true,
		format: "cjs",
		platform: "neutral",
		target: "es2020",
		outfile,
		logLevel: "silent",
	});
	const bundled = await readFile(outfile, "utf8");
	for (const banned of ['from "node:', 'require("node:', 'require("fs")', "process.env"]) {
		if (bundled.includes(banned)) {
			throw new Error(`weapp bundle unexpectedly contains ${banned}`);
		}
	}
	if (checkOnly) console.log(`weapp demo bundle ok (${bundled.length} bytes)`);
	else console.log(`weapp demo bundle written to ${repoOutfile} (${bundled.length} bytes)`);
} finally {
	if (outdir) await rm(outdir, { recursive: true, force: true });
}
