import { Worker } from "node:worker_threads";
import type { ImageProcessor, ProcessedImage } from "@yophon/tau-kernel";
import { processImageInProcess } from "./resize.ts";

const RESPONSE_TYPE = "tau:image-process-response";

function processInWorker(bytes: Uint8Array, mimeType: string, autoResize: boolean): Promise<ProcessedImage> {
	const isTypeScript = import.meta.url.endsWith(".ts");
	const worker = new Worker(new URL(isTypeScript ? "./worker.ts" : "./worker.js", import.meta.url));
	// Transfer a copy: transferring detaches the buffer and the caller keeps its bytes.
	const copy = new Uint8Array(bytes);
	return new Promise<ProcessedImage>((resolve, reject) => {
		let settled = false;
		const settle = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			void worker.terminate().catch(() => undefined);
			fn();
		};
		worker.on("message", (message: { type?: string; result?: ProcessedImage; error?: string }) => {
			// Node posts its own messages on the channel under --watch (pi): ignore anything else.
			if (message?.type !== RESPONSE_TYPE) return;
			if (message.error !== undefined) settle(() => reject(new Error(message.error)));
			else if (message.result) settle(() => resolve(message.result as ProcessedImage));
		});
		worker.once("error", (error) => settle(() => reject(error)));
		worker.once("exit", (code) => settle(() => reject(new Error(`Image worker exited with code ${code}`))));
		worker.postMessage({ bytes: copy, mimeType, autoResize }, [copy.buffer]);
	});
}

/**
 * pi's image pipeline for read, `@file` and pasted images (P36d): BMP and other
 * formats become PNG, anything over 2000x2000 or 4.5 MB of base64 is shrunk.
 * Runs in a worker; falls back to this thread when a worker cannot start (pi).
 */
export class NodeImageProcessor implements ImageProcessor {
	/** pi's images.autoResize (P40c): read on every image, so a /reload of the settings applies. */
	private readonly autoResize: () => boolean;

	constructor(options: { autoResize?: () => boolean } = {}) {
		this.autoResize = options.autoResize ?? (() => true);
	}

	async process(bytes: Uint8Array, mimeType: string): Promise<ProcessedImage> {
		const autoResize = this.autoResize();
		try {
			return await processInWorker(bytes, mimeType, autoResize);
		} catch {
			return processImageInProcess(bytes, mimeType, { autoResize });
		}
	}
}
