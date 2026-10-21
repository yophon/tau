// PowerShell commands for permission rules (P40b, Claude Code's PowerShell rules): split a
// compound command into its commands at `|`, `;`, `&&`, `||` and line breaks, put each
// command's alias back to its cmdlet name, and match patterns without regard to case.
// Claude Code parses the PowerShell syntax tree; this is a tokenizer, so anything it cannot
// take apart (subexpressions, script blocks, the call operator) is reported as not ok and
// never allowed by a rule.

/** A PowerShell command taken apart; the shape bash commands have (permission-rules.ts ParsedCommand). */
export interface ParsedPowerShellCommand {
	/** False when the command uses syntax the tokenizer does not take apart, or a quote is left open. */
	ok: boolean;
	raw: string;
	/** Every command, its alias replaced by the cmdlet name, words joined by one space. */
	segments: string[];
	/** Redirection targets (checked like edits). */
	writes: string[];
	/** Always empty: kept for the bash shape. */
	reads: string[];
}

/** PowerShell's built-in aliases (Windows PowerShell 5.1 and PowerShell 7), lower case → cmdlet. */
const ALIASES: Record<string, string> = {
	"%": "ForEach-Object",
	"?": "Where-Object",
	ac: "Add-Content",
	cat: "Get-Content",
	cd: "Set-Location",
	chdir: "Set-Location",
	clc: "Clear-Content",
	clear: "Clear-Host",
	cli: "Clear-Item",
	cls: "Clear-Host",
	compare: "Compare-Object",
	copy: "Copy-Item",
	cp: "Copy-Item",
	cpi: "Copy-Item",
	del: "Remove-Item",
	diff: "Compare-Object",
	dir: "Get-ChildItem",
	echo: "Write-Output",
	erase: "Remove-Item",
	fl: "Format-List",
	foreach: "ForEach-Object",
	ft: "Format-Table",
	gal: "Get-Alias",
	gc: "Get-Content",
	gci: "Get-ChildItem",
	gcm: "Get-Command",
	gi: "Get-Item",
	gl: "Get-Location",
	gm: "Get-Member",
	gmo: "Get-Module",
	gp: "Get-ItemProperty",
	gps: "Get-Process",
	group: "Group-Object",
	gsv: "Get-Service",
	gv: "Get-Variable",
	h: "Get-History",
	history: "Get-History",
	icm: "Invoke-Command",
	iex: "Invoke-Expression",
	ii: "Invoke-Item",
	ipmo: "Import-Module",
	irm: "Invoke-RestMethod",
	iwr: "Invoke-WebRequest",
	kill: "Stop-Process",
	ls: "Get-ChildItem",
	measure: "Measure-Object",
	mi: "Move-Item",
	move: "Move-Item",
	mv: "Move-Item",
	ni: "New-Item",
	popd: "Pop-Location",
	ps: "Get-Process",
	pushd: "Push-Location",
	pwd: "Get-Location",
	r: "Invoke-History",
	rd: "Remove-Item",
	ren: "Rename-Item",
	ri: "Remove-Item",
	rm: "Remove-Item",
	rmdir: "Remove-Item",
	rni: "Rename-Item",
	rv: "Remove-Variable",
	saps: "Start-Process",
	select: "Select-Object",
	set: "Set-Variable",
	si: "Set-Item",
	sl: "Set-Location",
	sleep: "Start-Sleep",
	sls: "Select-String",
	sort: "Sort-Object",
	sp: "Set-ItemProperty",
	spps: "Stop-Process",
	start: "Start-Process",
	sv: "Set-Variable",
	tee: "Tee-Object",
	type: "Get-Content",
	where: "Where-Object",
	write: "Write-Output",
};

/** The cmdlet an alias stands for (case-insensitive); other names come back as written. */
export function canonicalPowerShellCommand(name: string): string {
	return ALIASES[name.toLowerCase()] ?? name;
}

/** Take a PowerShell command apart (see the module comment). */
export function parsePowerShellCommand(command: string): ParsedPowerShellCommand {
	const result: ParsedPowerShellCommand = { ok: true, raw: command, segments: [], writes: [], reads: [] };
	const fail = (): ParsedPowerShellCommand => ({ ...result, ok: false, segments: [], writes: [] });
	let words: string[] = [];
	let word = "";
	let inWord = false;
	/** The next word is a redirection target. */
	let redirectTarget = false;
	/** An operator was just read, so a command must follow (a dangling `|` is an error). */
	let expectCommand = false;
	const endWord = (): void => {
		if (!inWord) return;
		if (redirectTarget) {
			if (word.toLowerCase() !== "$null") result.writes.push(word);
			redirectTarget = false;
		} else {
			words.push(word);
		}
		word = "";
		inWord = false;
	};
	const endSegment = (): void => {
		endWord();
		if (words.length > 0) {
			words[0] = canonicalPowerShellCommand(words[0]);
			result.segments.push(words.join(" "));
			expectCommand = false;
		}
		words = [];
	};
	/** `|`, `||`, `&&`: a command before it and one after it. */
	const operator = (): boolean => {
		endWord();
		if (words.length === 0) return false;
		endSegment();
		expectCommand = true;
		return true;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		const next = command[i + 1];
		if (c === " " || c === "\t") {
			endWord();
			continue;
		}
		if (c === "\r" || c === "\n") {
			endSegment();
			continue;
		}
		if (c === "#" && !inWord) {
			while (i < command.length && command[i] !== "\n") i++;
			endSegment();
			continue;
		}
		if (c === "`") {
			// Line continuation, or an escaped character.
			if (next === "\n" || next === "\r") {
				i += next === "\r" && command[i + 2] === "\n" ? 2 : 1;
				endWord();
				continue;
			}
			if (next === undefined) return fail();
			word += next;
			inWord = true;
			i++;
			continue;
		}
		if (c === "'") {
			inWord = true;
			let closed = false;
			for (i++; i < command.length; i++) {
				if (command[i] === "'") {
					if (command[i + 1] === "'") {
						word += "'";
						i++;
						continue;
					}
					closed = true;
					break;
				}
				word += command[i];
			}
			if (!closed) return fail();
			continue;
		}
		if (c === '"') {
			inWord = true;
			let closed = false;
			for (i++; i < command.length; i++) {
				const d = command[i];
				if (d === "`") {
					if (i + 1 >= command.length) return fail();
					word += command[++i];
					continue;
				}
				if (d === "$" && command[i + 1] === "(") return fail();
				if (d === '"') {
					if (command[i + 1] === '"') {
						word += '"';
						i++;
						continue;
					}
					closed = true;
					break;
				}
				word += d;
			}
			if (!closed) return fail();
			continue;
		}
		if (c === "|") {
			if (!operator()) return fail();
			if (next === "|") i++;
			continue;
		}
		if (c === ";") {
			endSegment();
			continue;
		}
		if (c === "&") {
			// && chains; a lone & is the call operator or a background job.
			if (next !== "&") return fail();
			if (!operator()) return fail();
			i++;
			continue;
		}
		if (c === ">") {
			// A stream number written right before it (2>, *>) belongs to the redirection.
			if (inWord && /^(?:\d|\*)$/.test(word)) {
				word = "";
				inWord = false;
			}
			endWord();
			if (next === ">") i++;
			if (command[i + 1] === "&" && /\d/.test(command[i + 2] ?? "")) {
				i += 2;
				continue;
			}
			redirectTarget = true;
			continue;
		}
		if (c === "<" || c === "(" || c === ")" || c === "{" || c === "}") return fail();
		if ((c === "$" || c === "@") && (next === "(" || next === "{")) return fail();
		word += c;
		inWord = true;
	}
	if (redirectTarget && !inWord) return fail();
	endSegment();
	if (expectCommand) return fail();
	return result;
}

/** A PowerShell rule pattern against one command: bash's wildcard rules, aliases resolved, case ignored. */
export function canonicalPowerShellPattern(pattern: string): string {
	const trimmed = pattern.trim();
	const space = trimmed.search(/\s/);
	const first = space === -1 ? trimmed : trimmed.slice(0, space);
	if (first.includes("*")) return trimmed.toLowerCase();
	return `${canonicalPowerShellCommand(first)}${space === -1 ? "" : trimmed.slice(space)}`.toLowerCase();
}
