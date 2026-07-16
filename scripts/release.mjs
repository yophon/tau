// Release flow (mirrors pi's scripts/release.mjs, simplified to a single root
// CHANGELOG.md): clean-tree check → lockstep bump → regenerate artifacts →
// full gate → changelog roll → commit + tag → fresh [Unreleased] → push.
// Publishing itself stays manual (npm run publish:dry / node scripts/publish.mjs).
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const target = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

if (!target || (!BUMP_TYPES.has(target) && !SEMVER_RE.test(target))) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	return execSync(cmd, { cwd: root, encoding: "utf8", stdio: options.silent ? "pipe" : "inherit" });
}

function getVersion() {
	return JSON.parse(readFileSync(join(root, "packages/kernel/package.json"), "utf8")).version;
}

if (run("git status --porcelain", { silent: true }).trim() !== "") {
	console.error("Working tree is not clean; commit or stash first.");
	process.exit(1);
}

if (BUMP_TYPES.has(target)) {
	run(`npm run version:${target}`);
} else {
	run(`npm version ${target} -ws --no-git-tag-version --ignore-scripts`);
	run("node scripts/sync-versions.mjs");
	run("npm install --package-lock-only --ignore-scripts");
}
const version = getVersion();

run("npm run shrinkwrap:cli");
run("npm run build");
run("npm run check");
run("npm test");

const changelogPath = join(root, "CHANGELOG.md");
const changelog = readFileSync(changelogPath, "utf8");
if (!changelog.includes("## [Unreleased]")) {
	console.error("CHANGELOG.md has no [Unreleased] section.");
	process.exit(1);
}
const date = new Date().toISOString().split("T")[0];
writeFileSync(changelogPath, changelog.replace("## [Unreleased]", `## [${version}] - ${date}`));

run("git add -A");
run(`git commit -m "release: v${version}"`);
run(`git tag v${version}`);

writeFileSync(
	changelogPath,
	readFileSync(changelogPath, "utf8").replace(
		`## [${version}] - ${date}`,
		`## [Unreleased]\n\n## [${version}] - ${date}`,
	),
);
run("git add CHANGELOG.md");
run(`git commit -m "chore: open ${version} next development cycle"`);

run("git push origin main");
run(`git push origin v${version}`);

console.log(`\nReleased v${version}. Publish with: npm run publish:dry && npm run publish:npm`);
