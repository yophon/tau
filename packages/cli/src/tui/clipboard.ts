/**
 * Copy text to the system clipboard: clip on Windows, pbcopy on macOS,
 * wl-copy / xclip / xsel on Linux, and OSC 52 through the terminal when none
 * of those is available (works over SSH in most modern terminals).
 */
import { spawn } from "node:child_process";

function pipeTo(command: string, args: string[], input: Buffer): Promise<boolean> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
		} catch {
			resolve(false);
			return;
		}
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
		child.stdin?.end(input);
	});
}

/** Returns how the text was copied. */
export async function copyToClipboard(
	text: string,
	write: (data: string) => void = (data) => process.stdout.write(data),
): Promise<string> {
	if (process.platform === "win32") {
		// clip.exe reads UTF-16LE when the input starts with a byte order mark.
		const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
		if (await pipeTo("clip", [], utf16)) return "clip";
	} else if (process.platform === "darwin") {
		if (await pipeTo("pbcopy", [], Buffer.from(text, "utf8"))) return "pbcopy";
	} else {
		const utf8 = Buffer.from(text, "utf8");
		if (await pipeTo("wl-copy", [], utf8)) return "wl-copy";
		if (await pipeTo("xclip", ["-selection", "clipboard"], utf8)) return "xclip";
		if (await pipeTo("xsel", ["--clipboard", "--input"], utf8)) return "xsel";
	}
	write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
	return "the terminal (OSC 52)";
}
