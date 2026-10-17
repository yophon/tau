// cross-spawn has the signature of child_process.spawn; declared here instead of
// pulling @types/cross-spawn for one call.
declare module "cross-spawn" {
	import type { spawn } from "node:child_process";
	const crossSpawn: typeof spawn;
	export default crossSpawn;
}
