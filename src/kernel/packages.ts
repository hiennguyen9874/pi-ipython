// Kernel packages: third-party packages installed into the uv-managed Kernel venv.
//
// The default set is Unharnessed's (crates/uh-core/src/kernel/bootstrap/mod.rs, DEFAULT_RLM_EXTRA_PACKAGES).
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

/** A `python.packages` entry: a non-empty uv requirement that cannot be read as a uv option. */
export function isPackageRequirement(entry: unknown): entry is string {
	return typeof entry === "string" && entry.trim() !== "" && !entry.trim().startsWith("-");
}

/** Labels for the system prompt: default packages by label, configured ones as written. */
export function packageLabels(requirements: readonly string[]): string[] {
	return requirements.map((r) => DEFAULT_PACKAGES.find((p) => p.requirement === r)?.label ?? r);
}
