// 打包 JS bundle 供 Flutter 加载：esbuild iife（platform neutral，纯 ES，供裸引擎
// flutter_js 加载），产物写入 assets/tau.js 并提交进仓库（clone 即可跑）。
// 用法：node js/build.mjs （在 examples/flutter/app/ 下运行）
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const appRoot = fileURLToPath(new URL(".", import.meta.url).href).replace(/\/js\/?$/, "");
const outFile = `${appRoot}/assets/tau.js`;

const result = await build({
	entryPoints: [`${appRoot}/js/tau-entry.ts`],
	bundle: true,
	platform: "neutral",
	format: "iife",
	target: "es2020",
	write: false,
	logLevel: "info",
});
writeFileSync(outFile, result.outputFiles[0].text);
console.log(`wrote ${outFile} (${result.outputFiles[0].text.length} bytes)`);
