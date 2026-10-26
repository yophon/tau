// P62f: EXIF orientation (pi's port, P36d) had no test of its own. The orientation is read from the
// original bytes only, so the containers are built by hand (a JPEG APP1 segment, a WebP EXIF chunk)
// around a TIFF header in either byte order; the pixels come from photon.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyExifOrientation } from "../src/image/exif-orientation.ts";
import { loadPhoton } from "../src/image/resize.ts";

/** A TIFF header with one IFD entry: Orientation (0x0112), SHORT, the given value. */
function tiff(orientation: number, bigEndian: boolean): number[] {
	const u16 = (value: number) => (bigEndian ? [value >> 8, value & 0xff] : [value & 0xff, value >> 8]);
	const u32 = (value: number) =>
		bigEndian
			? [value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
			: [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
	return [
		...(bigEndian ? [0x4d, 0x4d] : [0x49, 0x49]),
		...u16(42),
		...u32(8),
		...u16(1),
		...u16(0x0112),
		...u16(3),
		...u32(1),
		...u16(orientation),
		0,
		0,
		...u32(0),
	];
}

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

function jpeg(orientation: number, bigEndian = false): Uint8Array {
	const payload = [...EXIF_HEADER, ...tiff(orientation, bigEndian)];
	const length = payload.length + 2;
	return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...payload, 0xff, 0xd9]);
}

function webp(orientation: number, exifPrefix: boolean): Uint8Array {
	const data = [...(exifPrefix ? EXIF_HEADER : []), ...tiff(orientation, false)];
	const chunk = [0x45, 0x58, 0x49, 0x46, data.length & 0xff, data.length >> 8, 0, 0, ...data];
	if (data.length % 2) chunk.push(0);
	const size = 4 + chunk.length;
	return new Uint8Array([
		0x52,
		0x49,
		0x46,
		0x46,
		size & 0xff,
		(size >> 8) & 0xff,
		0,
		0,
		0x57,
		0x45,
		0x42,
		0x50,
		...chunk,
	]);
}

describe("P62f: EXIF orientation", () => {
	it("turns each orientation upright: flips in place, rotations into a new image with width and height swapped", async () => {
		const photon = await loadPhoton();
		assert.ok(photon, "photon loads");
		/** 3x2, red at the top-left, the rest grey. */
		const fresh = () => {
			const pixels = new Uint8Array(3 * 2 * 4).fill(128);
			pixels.set([255, 0, 0, 255], 0);
			return new photon.PhotonImage(pixels, 3, 2);
		};
		/** Where the red pixel ended up, as [x, y], and the size. */
		const look = (image: InstanceType<typeof photon.PhotonImage>) => {
			const width = image.get_width();
			const raw = image.get_raw_pixels();
			let at = -1;
			for (let i = 0; i < raw.length; i += 4) if (raw[i] === 255 && raw[i + 1] === 0) at = i / 4;
			return { size: [width, image.get_height()], red: [at % width, Math.floor(at / width)] };
		};
		const expected: Record<number, { size: number[]; red: number[] }> = {
			1: { size: [3, 2], red: [0, 0] },
			2: { size: [3, 2], red: [2, 0] },
			3: { size: [3, 2], red: [2, 1] },
			4: { size: [3, 2], red: [0, 1] },
			5: { size: [2, 3], red: [0, 0] },
			6: { size: [2, 3], red: [1, 0] },
			7: { size: [2, 3], red: [1, 2] },
			8: { size: [2, 3], red: [0, 2] },
		};
		for (const [orientation, want] of Object.entries(expected)) {
			for (const bigEndian of [false, true]) {
				const image = fresh();
				const out = applyExifOrientation(photon, image, jpeg(Number(orientation), bigEndian));
				assert.deepEqual(look(out), want, `orientation ${orientation}, ${bigEndian ? "big" : "little"} endian`);
				if (out !== image) image.free();
				out.free();
			}
		}
		// WebP carries EXIF in its own chunk, with or without the "Exif\0\0" prefix.
		for (const prefix of [true, false]) {
			const image = fresh();
			const out = applyExifOrientation(photon, image, webp(6, prefix));
			assert.deepEqual(look(out), expected[6]);
			image.free();
			out.free();
		}
	});

	it("leaves an image alone without a usable orientation", async () => {
		const photon = await loadPhoton();
		assert.ok(photon);
		const image = new photon.PhotonImage(new Uint8Array(3 * 2 * 4).fill(9), 3, 2);
		for (const bytes of [
			new Uint8Array([0x89, 0x50, 0x4e, 0x47]), // a PNG: no EXIF read
			jpeg(9), // out of range
			jpeg(1),
			new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00]), // cut short
			new Uint8Array([0xff, 0xd8, 0x00, 0x00]), // not a marker
		]) {
			assert.equal(applyExifOrientation(photon, image, bytes), image);
		}
		image.free();
	});
});
