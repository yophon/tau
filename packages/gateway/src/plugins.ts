/**
 * Channel plugins (P30): a module whose default export is a ChannelPlugin.
 * Package names resolve from ~/.tau/gateway/node_modules (installed with
 * `npm install --prefix ~/.tau/gateway <package>`), so it does not matter how
 * the CLI itself was installed. Only the user's config names plugins.
 */
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChannelPlugin } from "./types.ts";

export function isChannelPlugin(value: unknown): value is ChannelPlugin {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ChannelPlugin).name === "string" &&
		(value as ChannelPlugin).name !== "" &&
		typeof (value as ChannelPlugin).create === "function"
	);
}

/** Resolve a plugin spec to a file: an absolute path, or a package installed under the gateway directory. */
export function resolvePlugin(spec: string, gatewayDir: string): string {
	const require = createRequire(join(gatewayDir, "package.json"));
	return require.resolve(spec);
}

export async function loadChannelPlugin(spec: string, gatewayDir: string): Promise<ChannelPlugin> {
	let file: string;
	try {
		file = resolvePlugin(spec, gatewayDir);
	} catch {
		throw new Error(
			isAbsolute(spec)
				? `cannot find ${spec}`
				: `${spec} is not installed; run: npm install --prefix ${gatewayDir} ${spec}`,
		);
	}
	const module = (await import(pathToFileURL(file).href)) as { default?: unknown; plugin?: unknown };
	const plugin = module.default ?? module.plugin;
	if (!isChannelPlugin(plugin)) throw new Error(`${spec} does not export a channel plugin (default { name, create })`);
	return plugin;
}
