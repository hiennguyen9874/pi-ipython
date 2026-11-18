// The prelude: import statements the Kernel bootstrap runs on every Kernel start, before any Cell,
// so a Cell can use common modules without importing them first.

/** Stdlib only: cheap to import and present in every venv. `subprocess` is left out: programs go through `bash()`. */
export const DEFAULT_PRELUDE: readonly string[] = [
	"import json, os, re, sys, time, math, shutil, itertools, functools, collections, textwrap",
	"from pathlib import Path",
	"from datetime import datetime, timedelta",
	"from collections import Counter, defaultdict",
];

const ID = "[A-Za-z_][A-Za-z0-9_]*";
const DOTTED = `${ID}(?:\\.${ID})*`;
const IMPORT_ITEM = new RegExp(`^(${DOTTED})(?:\\s+as\\s+(${ID}))?$`);
const FROM_ITEM = new RegExp(`^(${ID})(?:\\s+as\\s+(${ID}))?$`);
const IMPORT_STATEMENT = /^import\s+(.+)$/;
const FROM_STATEMENT = new RegExp(`^from\\s+(${DOTTED})\\s+import\\s+(.+)$`);

/**
 * The names one prelude statement binds, or undefined when it is not a single absolute
 * `import …` / `from … import …` statement without `*` (so its names are known up front).
 */
export function preludeStatementNames(statement: string): string[] | undefined {
	const text = statement.trim();
	const items = (list: string) => list.split(",").map((item) => item.trim());
	const plain = IMPORT_STATEMENT.exec(text);
	if (plain) {
		const names: string[] = [];
		for (const item of items(plain[1]!)) {
			const match = IMPORT_ITEM.exec(item);
			if (!match) return undefined;
			names.push(match[2] ?? match[1]!.split(".")[0]!);
		}
		return names;
	}
	const from = FROM_STATEMENT.exec(text);
	if (from) {
		let list = from[2]!.trim();
		const parenthesized = /^\((.*)\)$/.exec(list);
		if (parenthesized) list = parenthesized[1]!.trim().replace(/,$/, "");
		const names: string[] = [];
		for (const item of items(list)) {
			const match = FROM_ITEM.exec(item);
			if (!match) return undefined;
			names.push(match[2] ?? match[1]!);
		}
		return names;
	}
	return undefined;
}

/** Every name the prelude binds. Statements that do not parse bind none. */
export function preludeNames(statements: readonly string[]): string[] {
	return [...new Set(statements.flatMap((statement) => preludeStatementNames(statement) ?? []))];
}

/** Bootstrap code running each statement on its own: a failure goes to stderr and the rest still run. */
export function preludeCode(statements: readonly string[]): string {
	if (statements.length === 0) return "";
	return `
for _pi_ipython_statement in ${JSON.stringify(statements)}:
    try:
        exec(_pi_ipython_statement, globals())
    except Exception as _pi_ipython_error:
        print(f"{_pi_ipython_statement!r} failed: {type(_pi_ipython_error).__name__}: {_pi_ipython_error}", file=_pi_ipython_sys.stderr)
del _pi_ipython_statement
`.trim();
}
