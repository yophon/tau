// Paired devices and pairing codes for remote access (P59). A phone trades a one-time pairing code
// (6 digits, 10 minutes, 5 tries — yo-agent's gate) for a device token; the server keeps only the
// token's SHA-256 (Codex's capability tokens), with the device's name and when it paired and was
// last seen, in ~/.tau/daemon/devices.json (0600). `tau serve revoke` forgets one.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import type { DeviceInfo } from "@yophon/tau-protocol";

export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_TRIES = 5;

interface StoredDevice {
	name: string;
	tokenSha256: string;
	pairedAt: string;
	lastSeenAt?: string;
}

const digest = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

export function devicesPath(home: string): string {
	return join(home, ".tau", "daemon", "devices.json");
}

export class DeviceStore {
	private readonly path: string;
	private devices: StoredDevice[];
	private readonly now: () => Date;

	constructor(path: string, now: () => Date = () => new Date()) {
		this.path = path;
		this.now = now;
		this.devices = existsSync(path)
			? ((JSON.parse(readFileSync(path, "utf8")) as { devices?: StoredDevice[] }).devices ?? [])
			: [];
	}

	list(): DeviceInfo[] {
		return this.devices.map((device) => ({
			name: device.name,
			pairedAt: device.pairedAt,
			...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {}),
		}));
	}

	/** A new device: its token (shown once) and its name (made unique). */
	add(requested: string | undefined): { name: string; token: string } {
		const base =
			(requested ?? "")
				.replace(/[^\p{L}\p{N} ._-]/gu, "")
				.trim()
				.slice(0, 40) || "device";
		let name = base;
		for (let n = 2; this.devices.some((device) => device.name === name); n++) name = `${base}-${n}`;
		const token = randomBytes(32).toString("base64url");
		this.devices.push({ name, tokenSha256: digest(token).toString("hex"), pairedAt: this.now().toISOString() });
		this.save();
		return { name, token };
	}

	/** The device a token belongs to (constant-time compare), or undefined. */
	verify(token: string | undefined): string | undefined {
		if (!token) return undefined;
		const given = digest(token);
		const device = this.devices.find((candidate) => {
			const stored = Buffer.from(candidate.tokenSha256, "hex");
			return stored.length === given.length && timingSafeEqual(stored, given);
		});
		if (!device) return undefined;
		device.lastSeenAt = this.now().toISOString();
		this.save();
		return device.name;
	}

	revoke(name: string): boolean {
		const before = this.devices.length;
		this.devices = this.devices.filter((device) => device.name !== name);
		if (this.devices.length === before) return false;
		this.save();
		return true;
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		const temp = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ version: 1, devices: this.devices }, null, 2)}\n`, { mode: 0o600 });
		try {
			chmodSync(temp, 0o600);
		} catch {
			// Windows has no POSIX modes.
		}
		renameSync(temp, this.path);
	}
}

/** One pairing code at a time: a new one replaces the old. */
export class PairingCodes {
	private active: { code: string; name: string | undefined; expiresAt: number; tries: number } | undefined;
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	issue(name: string | undefined): { code: string; expiresAt: string } {
		const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
		const expiresAt = this.now() + PAIRING_TTL_MS;
		this.active = { code, name, expiresAt, tries: 0 };
		return { code, expiresAt: new Date(expiresAt).toISOString() };
	}

	/** The code is right and alive: it is used up, and the name asked for comes back. */
	consume(code: string): { ok: true; name: string | undefined } | { ok: false; reason: string } {
		const active = this.active;
		if (!active || this.now() > active.expiresAt) {
			this.active = undefined;
			return { ok: false, reason: "No pairing code is waiting (tau serve pair)" };
		}
		const right = /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(code), Buffer.from(active.code));
		if (!right) {
			active.tries++;
			if (active.tries >= PAIRING_TRIES) this.active = undefined;
			return { ok: false, reason: "Wrong pairing code" };
		}
		this.active = undefined;
		return { ok: true, name: active.name };
	}
}

/**
 * Where a phone can reach a listener on `host:port`: every IPv4 address of this machine for
 * 0.0.0.0 (a Tailscale address among them, 100.64.0.0/10), else the host itself.
 */
export function reachableUrls(host: string, port: number): string[] {
	if (host !== "0.0.0.0" && host !== "::" && host !== "") return [`http://${host}:${port}/`];
	const found: Array<{ address: string; rank: number }> = [];
	for (const [name, addresses] of Object.entries(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) {
				found.push({ address: address.address, rank: addressRank(address.address, name) });
			}
		}
	}
	const urls = found.sort((a, b) => a.rank - b.rank).map(({ address }) => `http://${address}:${port}/`);
	return urls.length > 0 ? urls : [`http://127.0.0.1:${port}/`];
}

/**
 * The address a phone most likely reaches first (the QR code shows it): a home network (192.168,
 * 10), Tailscale (100.64/10), other private ranges; adapters of virtual machines, containers and
 * proxies (WSL, Hyper-V, Docker, a TUN with 198.18/15) last.
 */
function addressRank(address: string, adapter: string): number {
	const [a = 0, b = 0] = address.split(".").map(Number);
	let rank = 4;
	if (a === 192 && b === 168) rank = 0;
	else if (a === 10) rank = 1;
	else if (a === 100 && b >= 64 && b <= 127) rank = 2;
	else if (a === 172 && b >= 16 && b <= 31) rank = 3;
	else if (a === 198 && (b === 18 || b === 19)) rank = 6;
	if (/vethernet|wsl|hyper-v|docker|vmware|virtualbox|vbox|utun|\btun|\btap|meta|clash|loopback/i.test(adapter))
		rank += 5;
	return rank;
}
