// Image conversion and resizing for models (P36d), ported from pi 1.2
// packages/coding-agent/src/utils/{image-resize-core,image-convert,image-process}.ts (MIT):
// the same limits (2000x2000, 4.5 MB of base64), the same strategy and the same notes.
// Deviation: photon is loaded with a plain import (no Bun binary fallback paths).
import type { ProcessedImage } from "@yophon/tau-kernel";
import { applyExifOrientation } from "./exif-orientation.ts";

type Photon = typeof import("@silvia-odwyer/photon-node");

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 2000
	maxHeight?: number; // Default: 2000
	maxBytes?: number; // Default: 4.5MB of base64 payload (below Anthropic's 5MB limit)
	jpegQuality?: number; // Default: 80
}

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

let photonLoad: Promise<Photon | null> | undefined;

/** photon, or null when it cannot be loaded (images are then sent as they are, within the old limits). */
export function loadPhoton(): Promise<Photon | null> {
	photonLoad ??= import("@silvia-odwyer/photon-node").then(
		(module) => ((module as { default?: Photon }).default ?? module) as Photon,
		() => null,
	);
	return photonLoad;
}

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return { data, encodedSize: Buffer.byteLength(data, "utf-8"), mimeType };
}

/**
 * Resize an image to fit within the max dimensions and encoded size (pi resizeImageInProcess).
 * Returns null if the image cannot be resized below maxBytes or photon is unavailable.
 *
 * 1. First resize to maxWidth/maxHeight
 * 2. Try both PNG and JPEG formats, pick the first under the limit
 * 3. If still too large, try JPEG with decreasing quality
 * 4. If still too large, progressively reduce dimensions until 1x1
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	const photon = await loadPhoton();
	if (!photon) return null;

	let image: ReturnType<Photon["PhotonImage"]["new_from_byteslice"]> | undefined;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const format = mimeType.split("/")[1] ?? "png";

		// Check if already within all limits (dimensions AND encoded size)
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: mimeType || `image/${format}`,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		// Calculate initial dimensions respecting max limits
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;
		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		const source = image;
		const tryEncodings = (width: number, height: number, jpegQualities: number[]): EncodedCandidate[] => {
			const resized = photon.resize(source, width, height, photon.SamplingFilter.Lanczos3);
			try {
				const candidates: EncodedCandidate[] = [encodeCandidate(resized.get_bytes(), "image/png")];
				for (const quality of jpegQualities) {
					candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"));
				}
				return candidates;
			} finally {
				resized.free();
			}
		};

		const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		let currentWidth = targetWidth;
		let currentHeight = targetHeight;
		while (true) {
			for (const candidate of tryEncodings(currentWidth, currentHeight, qualitySteps)) {
				if (candidate.encodedSize < opts.maxBytes) {
					return {
						data: candidate.data,
						mimeType: candidate.mimeType,
						originalWidth,
						originalHeight,
						width: currentWidth,
						height: currentHeight,
						wasResized: true,
					};
				}
			}
			if (currentWidth === 1 && currentHeight === 1) break;
			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
			if (nextWidth === currentWidth && nextHeight === currentHeight) break;
			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}
		return null;
	} catch {
		return null;
	} finally {
		image?.free();
	}
}

/** PNG bytes of any image photon can decode (pi convertImageBytesToPng: BMP, the Windows clipboard). */
export async function convertToPngInProcess(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) return null;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			return new Uint8Array(image.get_bytes());
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

/** pi formatDimensionNote: how to map coordinates back to the original. */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) return undefined;
	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}

const SUPPORTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** pi processImage, in one process: convert what models do not take, then resize. */
export async function processImageInProcess(
	bytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ProcessedImage> {
	let normalized = bytes;
	let normalizedType = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
	let convertedFrom: string | undefined;
	if (!SUPPORTED.has(normalizedType)) {
		const png = await convertToPngInProcess(bytes);
		if (!png) {
			return { ok: false, message: "[Image omitted: could not be converted to a supported inline image format.]" };
		}
		convertedFrom = normalizedType;
		normalized = png;
		normalizedType = "image/png";
	}
	const resized = await resizeImageInProcess(normalized, normalizedType, options);
	if (!resized) {
		return { ok: false, message: "[Image omitted: could not be resized below the inline image size limit.]" };
	}
	const hints: string[] = [];
	if (convertedFrom && convertedFrom !== resized.mimeType) {
		hints.push(`[Image converted from ${convertedFrom} to ${resized.mimeType}.]`);
	}
	const dimensionNote = formatDimensionNote(resized);
	if (dimensionNote) hints.push(dimensionNote);
	return { ok: true, data: resized.data, mimeType: resized.mimeType, hints };
}
