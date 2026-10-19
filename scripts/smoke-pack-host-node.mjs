// Run by smoke-pack.mjs inside a project that installed the packed kernel and
// host-node (P36): photon's wasm and the image worker resolve from dist, and a
// background command writes its output file and reports its exit.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { NodeBackgroundShell, NodeImageProcessor } from "@yophon/tau-host-node";

const require = createRequire(import.meta.url);
const photon = require("@silvia-odwyer/photon-node");
const image = new photon.PhotonImage(new Uint8Array(3000 * 2000 * 4).fill(180), 3000, 2000);
const png = image.get_bytes();
image.free();
const processed = await new NodeImageProcessor().process(png, "image/png");
if (!processed.ok || !processed.hints[0]?.includes("displayed at 2000x1333")) {
	throw new Error(`image processing failed: ${JSON.stringify(processed).slice(0, 300)}`);
}
const shell = new NodeBackgroundShell(process.cwd());
// Background commands do not keep a process alive (tau exits and stops them): hold it while waiting.
const keepAlive = setInterval(() => undefined, 1000);
const ended = new Promise((resolve) => shell.onTaskEnd(resolve)).finally(() => clearInterval(keepAlive));
const task = await shell.start(`"${process.execPath.replaceAll("\\", "/")}" -e "console.log('bg ok')"`);
const result = await ended;
if (result.status !== "completed" || !readFileSync(task.outputPath, "utf8").includes("bg ok")) {
	throw new Error(`background command failed: ${JSON.stringify(result)}`);
}
console.log("pack smoke host-node ok");
