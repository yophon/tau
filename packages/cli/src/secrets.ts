// Keeping secrets away from the model (P32b). None of this is a security
// boundary — a model with a shell can still find ways around it (base64, path
// tricks); real isolation needs a sandbox with credentials outside it (Managed
// Agents' vault). It reduces accidents: child processes the model drives get no
// secret-looking environment variables, and known secret values are masked in
// tool output before the model or the session log sees them.

/** Environment variable names that look like secrets (Codex's KEY/SECRET/TOKEN, Claude Code's PASSWORD/AUTH). */
export const SECRET_NAME_RE = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|CREDENTIAL/i;

/** Values shorter than this are not masked: they would match ordinary text. */
const MIN_SECRET_LENGTH = 8;

const known = new Map<string, string>();

/** Remember a secret value (a resolved key, a credential) so tool output can be masked. */
export function registerSecret(value: string | undefined, label: string): void {
	if (!value || value.length < MIN_SECRET_LENGTH) return;
	if (!known.has(value)) known.set(value, label);
}

export function knownSecrets(): ReadonlyMap<string, string> {
	return known;
}

/** Forget registered secrets (tests). */
export function resetSecrets(): void {
	known.clear();
}

/** Register the secret-looking variables of an environment (their values get masked too). */
export function registerEnvSecrets(env: Record<string, string | undefined>): void {
	for (const [name, value] of Object.entries(env)) {
		if (value && SECRET_NAME_RE.test(name)) registerSecret(value, name);
	}
}

/** Replace every known secret in the text with a label; longest first so a secret containing another stays whole. */
export function maskSecrets(text: string): string {
	if (known.size === 0 || text === "") return text;
	let out = text;
	for (const [value, label] of [...known].sort((a, b) => b[0].length - a[0].length)) {
		if (out.includes(value)) out = out.split(value).join(`[已隐藏:${label}]`);
	}
	return out;
}

/**
 * The environment for child processes the model drives (the bash tool, MCP stdio
 * servers): without secret-looking names and without any variable whose value is
 * a known secret, except names listed in `allow` (settings.json shell.envAllow).
 */
export function scrubEnv(
	env: Record<string, string | undefined>,
	allow: readonly string[] = [],
): Record<string, string> {
	const allowed = new Set(allow.map((name) => name.toUpperCase()));
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (!allowed.has(name.toUpperCase()) && (SECRET_NAME_RE.test(name) || known.has(value))) continue;
		out[name] = value;
	}
	return out;
}

/** The names scrubEnv would drop (for hints when a command fails for want of one). */
export function scrubbedNames(env: Record<string, string | undefined>, allow: readonly string[] = []): string[] {
	const kept = scrubEnv(env, allow);
	return Object.keys(env).filter((name) => env[name] !== undefined && !(name in kept));
}
