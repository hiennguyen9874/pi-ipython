// Kernel packages: third-party packages installed into the uv-managed Kernel venv.
//
// The default set is Unharnessed's (7d442aafa, packages/coding-agent/src/core/kernel/bootstrap.ts,
// DEFAULT_RLM_EXTRA_PACKAGES).
// Copyright (c) 2026 Unharnessed
// MIT License, see LICENSE.

/** Default Kernel packages: uv requirement and the label the system prompt shows. */
export const DEFAULT_PACKAGES: readonly { requirement: string; label: string }[] = [
	{ requirement: "requests", label: "requests" },
	{ requirement: "httpx", label: "httpx" },
	{ requirement: "pyyaml", label: "yaml (PyYAML)" },
	{ requirement: "tomli", label: "tomli" },
	{ requirement: "python-dotenv", label: "dotenv (python-dotenv)" },
	{ requirement: "pandas", label: "pandas" },
	{ requirement: "numpy", label: "numpy" },
	{ requirement: "scipy", label: "scipy" },
	{ requirement: "beautifulsoup4", label: "bs4 (Beautiful Soup)" },
	{ requirement: "lxml", label: "lxml" },
	{ requirement: "pydantic", label: "pydantic" },
	{ requirement: "tyro", label: "tyro" },
];

export const DEFAULT_PACKAGE_REQUIREMENTS: readonly string[] = DEFAULT_PACKAGES.map((p) => p.requirement);

/** Prelude statements for the default packages, run with the default prelude when those packages are installed. */
export const DEFAULT_PACKAGE_PRELUDE: readonly string[] = [
	"import numpy as np",
	"import pandas as pd",
	"import requests, httpx, yaml",
];

/** Only a name prefix, not PEP 508 validation; uv owns requirement parsing. */
function requirementName(requirement: string): string | undefined {
	const name = requirement.match(/^([a-z0-9][a-z0-9._-]*)(?=\s*(?:$|[\[<>=!~@;]))/i)?.[1];
	if (name === requirement && /\.(?:whl|zip|tar(?:\.[a-z0-9]+)?|tgz)$/i.test(requirement)) return undefined;
	return name;
}

function normalizeName(name: string): string {
	return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Label requested distributions that actually installed, without exposing requirement URLs or paths. */
export function installedPackageLabels(requirements: readonly string[], inventory: { name: string; direct: boolean }[]): string[] {
	const installed = new Map(inventory.filter(({ name }) => /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i.test(name))
		.map((pkg) => [normalizeName(pkg.name), pkg]));
	const names = new Set<string>();
	let hasUnnamedRequirement = false;
	for (const requirement of requirements) {
		const name = requirementName(requirement);
		if (!name) {
			hasUnnamedRequirement = true;
			continue;
		}
		const key = normalizeName(name);
		if (installed.has(key)) names.add(key);
	}
	// A bare path or URL has no name in config. Its installed metadata supplies the name.
	if (hasUnnamedRequirement) {
		for (const [name, pkg] of installed) {
			if (pkg.direct && name !== "pi-ipython-runtime") names.add(name);
		}
	}
	const defaults = DEFAULT_PACKAGES.filter(({ requirement }) => names.delete(requirement)).map(({ label }) => label);
	return [...defaults, ...[...names].sort().map((name) => installed.get(name)!.name)];
}

/** Never send requirement URLs (which can contain credentials) back as diagnostics. */
export function redactPackageUrls(message: string): string {
	return message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"]+/gi, "[redacted URL]");
}
