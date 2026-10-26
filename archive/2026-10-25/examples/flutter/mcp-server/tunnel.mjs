// Cloudflare Quick Tunnel wiring (P19). Spawns the system `cloudflared`
// binary — deliberately NOT the npm `cloudflared` package, whose postinstall
// binary download conflicts with the repo's --ignore-scripts supply-chain
// discipline (spec phase-19, open question 2).
import { spawn } from "node:child_process";

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?![.\w-])/;

/**
 * Extract the public Quick Tunnel URL from one line of cloudflared output.
 * Pure — unit-tested without touching Cloudflare.
 * @param {string} line
 * @returns {string | null}
 */
export function extractTryCloudflareUrl(line) {
	const match = TRYCLOUDFLARE_RE.exec(line);
	return match ? match[0] : null;
}

export const CLOUDFLARED_INSTALL_HINT = [
	"cloudflared not found. Install it first:",
	"  macOS : brew install cloudflared",
	"  Linux : https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
	"  other : https://github.com/cloudflare/cloudflared/releases",
].join("\n");

/**
 * Start a Quick Tunnel (no Cloudflare account) pointing at 127.0.0.1:<port>.
 * Resolves with the public https URL once cloudflared reports it. The child
 * is killed when the current process exits (SIGINT/SIGTERM wired here).
 *
 * @param {number} port
 * @param {{ onExit?: (code: number | null) => void }} [hooks]
 * @returns {Promise<{ url: string, child: import("node:child_process").ChildProcess }>}
 */
export function startQuickTunnel(port, hooks = {}) {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let settled = false;
		let buffered = "";

		const scan = (chunk) => {
			buffered += chunk;
			const lines = buffered.split("\n");
			buffered = lines.pop() ?? "";
			for (const line of lines) {
				const url = extractTryCloudflareUrl(line);
				if (url && !settled) {
					settled = true;
					resolvePromise({ url, child });
				}
			}
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", scan);
		child.stderr.on("data", scan); // cloudflared prints its banner (and the URL) to stderr

		child.on("error", (cause) => {
			if (settled) return;
			settled = true;
			rejectPromise(cause.code === "ENOENT" ? new Error(CLOUDFLARED_INSTALL_HINT) : cause);
		});
		child.on("exit", (code) => {
			if (!settled) {
				settled = true;
				rejectPromise(new Error(`cloudflared exited before reporting a URL (code ${code})`));
				return;
			}
			hooks.onExit?.(code);
		});

		const kill = () => {
			if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
		};
		process.once("exit", kill);
		process.once("SIGINT", () => {
			kill();
			process.exit(130);
		});
		process.once("SIGTERM", () => {
			kill();
			process.exit(143);
		});
	});
}
