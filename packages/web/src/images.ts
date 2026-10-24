// Photos from the phone (P59): shrunk on the phone before they are sent (a camera picture is several
// megabytes; read's own limit is 2000×2000), as JPEG. Canvas works on plain http, unlike WebCrypto.

const LONGEST = 1600;

export async function shrinkImage(file: File): Promise<{ data: string; mimeType: string; preview: string }> {
	const bitmap = await createImageBitmap(file);
	const scale = Math.min(1, LONGEST / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("No canvas");
	context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	const preview = canvas.toDataURL("image/jpeg", 0.85);
	return { data: preview.slice(preview.indexOf(",") + 1), mimeType: "image/jpeg", preview };
}
