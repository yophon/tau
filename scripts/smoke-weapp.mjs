// The WeChat mini-program stack bundles for a neutral platform with no Node leakage (P10; P62: the
// demo app is archived, so the entry is inline). The kernel, host-weapp and a statically imported
// extension (D8: no dynamic code loading) go into one CommonJS file in a temp directory, which is
// scanned for Node APIs.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = `
import { createWeappPlatform } from "@yophon/tau-host-weapp";
import { AbortHandle, Agent, ExtensionRegistry } from "@yophon/tau-kernel";

export { AbortHandle };

const clock = (api) => {
	api.registerTool({
		name: "get_time",
		description: "The device's time",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: new Date().toString() }] }),
	});
};

export async function createChatAgent(wx, config) {
	return new Agent({
		config: { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model },
		platform: createWeappPlatform(wx),
		extensions: await ExtensionRegistry.load([clock]),
	});
}
`;

const outdir = await mkdtemp(join(tmpdir(), "tau-weapp-"));
try {
	const outfile = join(outdir, "tau.js");
	await build({
		stdin: { contents: entry, resolveDir: root, loader: "js", sourcefile: "weapp-entry.js" },
		bundle: true,
		format: "cjs",
		platform: "neutral",
		target: "es2020",
		outfile,
		logLevel: "silent",
	});
	const bundled = await readFile(outfile, "utf8");
	for (const banned of ['from "node:', 'require("node:', 'require("fs")', "process.env"]) {
		if (bundled.includes(banned)) throw new Error(`weapp bundle unexpectedly contains ${banned}`);
	}
	console.log(`weapp bundle ok (${bundled.length} bytes)`);
} finally {
	await rm(outdir, { recursive: true, force: true });
}
