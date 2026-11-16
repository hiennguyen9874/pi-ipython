import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Tests share one Kernel venv that survives between runs.
process.env.PI_IPYTHON_VENV_DIR ??= resolve("node_modules/.cache/pi-ipython/kernel-venv");

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		globalSetup: ["test/global-setup.ts"],
		testTimeout: 30_000,
	},
});
