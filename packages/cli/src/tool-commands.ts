// `tau credentials …` (P32b): commands that manage configuration and need
// neither a model nor the agent.
import { createInterface } from "node:readline";
import { auditCredentials, CredentialStore, credentialsPath, credentialUsage } from "./credentials.ts";

const CREDENTIALS_USAGE = `tau credentials - secrets referenced from configuration as \${cred:<name>}

Usage:
  tau credentials set <name> [--note <text>]   Store a value (typed without echo, or piped on stdin)
  tau credentials list                         Names, notes and which config files use them (never values)
  tau credentials remove <name>                Delete one
  tau credentials audit                        Find secrets written out in config files, and unresolved references

Stored in ~/.tau/credentials.json (0600). Use them in ~/.tau/models.json (apiKey, headers),
~/.tau/mcp.json (command, args, env, url, headers) and ~/.tau/gateway/config.json (channels).`;

/** Read a secret: hidden typing on a terminal, else all of stdin (trailing newline trimmed). */
async function readSecret(prompt: string): Promise<string> {
	if (!process.stdin.isTTY) {
		let data = "";
		for await (const chunk of process.stdin) data += chunk;
		return data.replace(/\r?\n$/, "");
	}
	return await new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
		const output = rl as unknown as { _writeToOutput?: (text: string) => void };
		let prompted = false;
		output._writeToOutput = (text: string) => {
			// Show the prompt once; swallow the echo of what is typed.
			if (!prompted) {
				process.stdout.write(text);
				prompted = true;
			}
		};
		rl.question(prompt, (answer) => {
			process.stdout.write("\n");
			rl.close();
			resolve(answer);
		});
	});
}

async function credentialsCommand(args: string[], home: string): Promise<number> {
	const store = new CredentialStore(credentialsPath(home));
	const [command = "help", ...rest] = args;
	switch (command) {
		case "help":
		case "--help":
			console.log(CREDENTIALS_USAGE);
			return 0;
		case "set": {
			const name = rest[0];
			const noteIndex = rest.indexOf("--note");
			const note = noteIndex >= 0 ? rest[noteIndex + 1] : undefined;
			if (!name || name.startsWith("--")) {
				console.error("Usage: tau credentials set <name> [--note <text>]");
				return 1;
			}
			const value = await readSecret(`Value for ${name}: `);
			try {
				store.set(name, value, note);
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
				return 1;
			}
			console.log(`Saved ${name} in ${store.file}. Refer to it as \${cred:${name}}.`);
			return 0;
		}
		case "list": {
			const names = store.names();
			if (names.length === 0) {
				console.log(`No credentials (${store.file}). Add one with tau credentials set <name>.`);
				return 0;
			}
			const usage = credentialUsage(home);
			for (const entry of names) {
				const used = usage.get(entry.name);
				console.log(
					`${entry.name}${entry.note ? `  — ${entry.note}` : ""}  (added ${new Date(entry.createdAt).toLocaleDateString()}; ${used ? `used in ${used.join(", ")}` : "not referenced"})`,
				);
			}
			return 0;
		}
		case "remove": {
			const name = rest[0];
			if (!name) {
				console.error("Usage: tau credentials remove <name>");
				return 1;
			}
			const removed = store.remove(name);
			console.log(removed ? `Removed ${name}.` : `No credential named ${name}.`);
			return removed ? 0 : 1;
		}
		case "audit": {
			const findings = auditCredentials(home, store);
			if (findings.length === 0) {
				console.log("No plaintext secrets or unresolved references found.");
				return 0;
			}
			for (const finding of findings)
				console.log(`${finding.code}  ${finding.file}  ${finding.where}  ${finding.detail}`);
			return 1;
		}
		default:
			console.error(`Unknown credentials command "${command}".\n\n${CREDENTIALS_USAGE}`);
			return 1;
	}
}

export async function runToolCommand(
	name: string,
	args: string[],
	context: { home: string; cwd: string },
): Promise<number> {
	if (name === "credentials") return credentialsCommand(args, context.home);
	console.error(`Unknown command ${name}`);
	return 1;
}
