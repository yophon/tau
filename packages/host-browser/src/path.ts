export function normalizeBrowserPath(cwd: string, path: string): string {
	const raw = path.startsWith("/") ? path : `${cwd}/${path}`;
	const parts: string[] = [];
	for (const part of raw.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `/${parts.join("/")}`;
}

export function pathName(path: string): string {
	if (path === "/") return "";
	const index = path.lastIndexOf("/");
	return index === -1 ? path : path.slice(index + 1);
}

export function parentPath(path: string): string {
	if (path === "/") return "/";
	const index = path.lastIndexOf("/");
	return index <= 0 ? "/" : path.slice(0, index);
}

export function splitPath(path: string): string[] {
	return path.split("/").filter((part) => part !== "");
}
