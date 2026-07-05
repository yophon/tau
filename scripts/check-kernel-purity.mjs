// Kernel purity gate: @tau/kernel must bundle for a neutral platform with no
// external imports, and its sources must not reference host globals. Anything
// beyond ECMAScript must flow through the Platform seam.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const kernelSrc = join(root, "packages/kernel/src");

const BANNED_PATTERNS = [
	{ pattern: /from\s+["']node:/, reason: "node: builtin import" },
	{ pattern: /\brequire\s*\(/, reason: "CommonJS require" },
	{ pattern: /\bprocess\.\w/, reason: "process global" },
	{ pattern: /\bBuffer\b/, reason: "Buffer global" },
	{ pattern: /__dirname|__filename/, reason: "CommonJS path global" },
	{ pattern: /\bimport\s*\(/, reason: "dynamic import" },
];

// Globals outside the Platform seam that the kernel may not touch directly.
// TextDecoder/fetch/crypto are allowed ONLY in platform.ts (the seam itself).
const SEAM_ONLY_PATTERNS = [
	{ pattern: /(?<!\.)\bfetch\s*\(/, reason: "direct fetch call (use Platform.fetch)" },
	{ pattern: /\bnew\s+TextDecoder\b|\bnew\s+TextEncoder\b/, reason: "direct TextDecoder/TextEncoder (use Platform)" },
	{ pattern: /\bcrypto\./, reason: "direct crypto access (extend Platform instead)" },
	{ pattern: /\bsetTimeout\b|\bsetInterval\b/, reason: "direct timer (extend Platform instead)" },
];

function listTsFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...listTsFiles(path));
		else if (entry.name.endsWith(".ts")) files.push(path);
	}
	return files;
}

const violations = [];
for (const file of listTsFiles(kernelSrc)) {
	const text = readFileSync(file, "utf8");
	const relPath = relative(root, file);
	const isSeam = relPath.endsWith("platform.ts");
	const lines = text.split("\n");
	for (const { pattern, reason } of [...BANNED_PATTERNS, ...(isSeam ? [] : SEAM_ONLY_PATTERNS)]) {
		lines.forEach((line, i) => {
			if (pattern.test(line)) violations.push(`${relPath}:${i + 1}: ${reason}\n    ${line.trim()}`);
		});
	}
}

if (violations.length > 0) {
	console.error("Kernel purity violations:\n");
	for (const violation of violations) console.error(`  ${violation}`);
	process.exit(1);
}

try {
	await build({
		entryPoints: [join(kernelSrc, "index.ts")],
		bundle: true,
		platform: "neutral",
		format: "esm",
		write: false,
		logLevel: "silent",
	});
} catch (error) {
	console.error("Kernel failed to bundle for a neutral platform:\n");
	const errors = error && typeof error === "object" && Array.isArray(error.errors) ? error.errors : [];
	for (const entry of errors) {
		const location = entry.location ? `${entry.location.file}:${entry.location.line}` : "";
		console.error(`  ${[location, entry.text].filter(Boolean).join(" ")}`);
	}
	if (errors.length === 0) console.error(error);
	process.exit(1);
}

console.log("Kernel purity check passed.");
