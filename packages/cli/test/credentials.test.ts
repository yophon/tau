// P32b: the credential store, ${cred:…} references, scrubbing and masking.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	auditCredentials,
	CredentialStore,
	credentialRefs,
	credentialsPath,
	credentialUsage,
	expandRefs,
} from "../src/credentials.ts";
import { resolveConfigValue } from "../src/models.ts";
import {
	knownSecrets,
	maskSecrets,
	registerEnvSecrets,
	registerSecret,
	resetSecrets,
	scrubbedNames,
	scrubEnv,
} from "../src/secrets.ts";

afterEach(() => resetSecrets());

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "tau-cred-"));
	mkdirSync(join(dir, ".tau"), { recursive: true });
	return dir;
}

describe("credential store", () => {
	it("stores values 0600, lists names only, and registers values for masking on read", () => {
		const dir = home();
		const store = new CredentialStore(credentialsPath(dir));
		store.set("github", "ghp_abcdefghijklmnop", "GitHub PAT");
		store.set("notion", "secret_notion_value");
		assert.deepEqual(
			store.names().map((entry) => entry.name),
			["github", "notion"],
		);
		assert.equal(store.names()[0]?.note, "GitHub PAT");
		assert.ok(!JSON.stringify(store.names()).includes("ghp_"));
		if (process.platform !== "win32") assert.equal(statSync(store.file).mode & 0o777, 0o600);
		assert.equal(store.get("github"), "ghp_abcdefghijklmnop");
		assert.equal(knownSecrets().get("ghp_abcdefghijklmnop"), "cred:github");
		assert.equal(store.remove("notion"), true);
		assert.equal(store.remove("notion"), false);
		assert.throws(() => store.set("Bad Name", "x"), /lowercase letters/);
		assert.throws(() => store.set("ok", ""), /empty/);
	});

	it("resolves ${cred:…} in models.json values", () => {
		const dir = home();
		new CredentialStore(credentialsPath(dir)).set("deepseek", "sk-deepseek-1234567890");
		assert.equal(
			resolveConfigValue("${cred:deepseek}", { env: { HOME: dir, USERPROFILE: dir } }),
			"sk-deepseek-1234567890",
		);
		assert.equal(resolveConfigValue("${cred:nope}", { env: { HOME: dir, USERPROFILE: dir } }), undefined);
		assert.equal(knownSecrets().get("sk-deepseek-1234567890"), "cred:deepseek");
	});

	it("expands references inside strings; a project file gets no credentials and no secret-looking variables", () => {
		const env = { API_BASE: "https://api.example.com", GITHUB_TOKEN: "gho_tokenvalue123", PLAIN: "p" };
		const credential = (name: string) => (name === "github" ? "ghp_fromstore12345" : undefined);
		const user = expandRefs("Bearer ${cred:github} ${API_BASE:-x}/mcp ${MISSING} ${NOPE:-fallback}", {
			env,
			credential,
			allowCredentials: true,
		});
		assert.equal(user.value, "Bearer ghp_fromstore12345 https://api.example.com/mcp  fallback");
		assert.deepEqual(user.missing, ["MISSING"]);
		const project = expandRefs("Bearer ${cred:github} ${GITHUB_TOKEN} ${PLAIN}", {
			env,
			credential,
			allowCredentials: false,
		});
		assert.equal(project.value, "Bearer   p");
		assert.deepEqual(project.blocked, ["cred:github", "GITHUB_TOKEN"]);
		assert.deepEqual(credentialRefs("a ${cred:one} b ${cred:two} ${OTHER}"), ["one", "two"]);
	});

	it("audits config files for written-out secrets and unresolved references", () => {
		const dir = home();
		const store = new CredentialStore(credentialsPath(dir));
		store.set("github", "ghp_abcdefghijklmnop");
		writeFileSync(
			join(dir, ".tau", "models.json"),
			JSON.stringify({
				providers: { a: { apiKey: "sk-literal-1234567890" }, b: { apiKey: "$OK_KEY" }, c: { apiKey: "${cred:gone}" } },
			}),
		);
		writeFileSync(
			join(dir, ".tau", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					gh: { url: "https://x", headers: { Authorization: "Bearer ${cred:github}" } },
					bad: { url: "https://y", headers: { Authorization: "Bearer abcdef0123456789" } },
				},
			}),
		);
		const findings = auditCredentials(dir, store).map((finding) => `${finding.code} ${finding.where}`);
		assert.deepEqual(findings.sort(), [
			"PLAINTEXT_FOUND mcpServers.bad.headers.Authorization",
			"PLAINTEXT_FOUND mcpServers.bad.headers.Authorization",
			"PLAINTEXT_FOUND providers.a.apiKey",
			"REF_UNRESOLVED providers.c.apiKey",
		]);
		assert.deepEqual(credentialUsage(dir).get("github"), ["mcp.json"]);
		assert.ok(readFileSync(store.file, "utf8").includes("ghp_"), "the store itself is not audited");
	});
});

describe("secrets", () => {
	it("scrubs secret-looking names and known values, except allowed names", () => {
		registerSecret("value-from-store-123", "cred:x");
		const env = {
			PATH: "/bin",
			OPENAI_API_KEY: "sk-1",
			GH_TOKEN: "gho_1",
			DB_PASSWORD: "pw",
			HOME: "/home/u",
			COPY: "value-from-store-123",
			AWS_SESSION_TOKEN: "t",
		};
		assert.deepEqual(scrubEnv(env), { PATH: "/bin", HOME: "/home/u" });
		assert.deepEqual(scrubEnv(env, ["gh_token"]), { PATH: "/bin", GH_TOKEN: "gho_1", HOME: "/home/u" });
		assert.deepEqual(scrubbedNames(env).sort(), [
			"AWS_SESSION_TOKEN",
			"COPY",
			"DB_PASSWORD",
			"GH_TOKEN",
			"OPENAI_API_KEY",
		]);
	});

	it("masks known secrets in text, longest first, and ignores short values", () => {
		registerSecret("abc", "short");
		registerSecret("sk-live-1234567890", "OPENAI_API_KEY");
		registerSecret("sk-live-1234567890-extended", "cred:long");
		registerEnvSecrets({ GITHUB_TOKEN: "gho_envtoken_9876", EDITOR: "vim-with-long-name" });
		const text = "key=sk-live-1234567890-extended other=sk-live-1234567890 gh=gho_envtoken_9876 abc vim-with-long-name";
		assert.equal(
			maskSecrets(text),
			"key=[已隐藏:cred:long] other=[已隐藏:OPENAI_API_KEY] gh=[已隐藏:GITHUB_TOKEN] abc vim-with-long-name",
		);
	});
});
