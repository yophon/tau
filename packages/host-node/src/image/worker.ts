// Runs processImageInProcess off the main thread (pi image-resize-worker.ts), so
// decoding and resizing a large screenshot does not freeze the TUI.
import { parentPort } from "node:worker_threads";
import { processImageInProcess } from "./resize.ts";

const IMAGE_WORKER_RESPONSE_TYPE = "tau:image-process-response";

const port = parentPort;
if (!port) throw new Error("image worker requires parentPort");

port.once("message", (message: { bytes?: unknown; mimeType?: unknown; autoResize?: unknown }) => {
	void (async () => {
		try {
			if (!(message.bytes instanceof Uint8Array) || typeof message.mimeType !== "string") {
				throw new Error("Invalid image worker request");
			}
			const result = await processImageInProcess(message.bytes, message.mimeType, {
				...(message.autoResize === false ? { autoResize: false } : {}),
			});
			port.postMessage({ type: IMAGE_WORKER_RESPONSE_TYPE, result });
		} catch (error) {
			port.postMessage({
				type: IMAGE_WORKER_RESPONSE_TYPE,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	})();
});
