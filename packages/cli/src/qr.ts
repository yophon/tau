// A QR code for the terminal (P59: `tau serve pair` shows the pairing address for a phone's camera).
// Two modules per character with the upper half block, explicit black and white colours so it
// scans on light and dark terminals alike, and a quiet zone of two modules.
import qrcode from "qrcode-generator";

const BLACK = 30;
const WHITE = 37;

export function qrLines(text: string): string[] {
	const qr = qrcode(0, "M");
	qr.addData(text);
	qr.make();
	const size = qr.getModuleCount();
	const margin = 2;
	const dark = (row: number, col: number): boolean =>
		row >= 0 && col >= 0 && row < size && col < size && qr.isDark(row, col);
	const lines: string[] = [];
	for (let row = -margin; row < size + margin; row += 2) {
		let line = "";
		for (let col = -margin; col < size + margin; col++) {
			const top = dark(row, col) ? BLACK : WHITE;
			const bottom = dark(row + 1, col) ? BLACK : WHITE;
			line += `\x1b[${top};${bottom + 10}m▀`;
		}
		lines.push(`${line}\x1b[0m`);
	}
	return lines;
}
