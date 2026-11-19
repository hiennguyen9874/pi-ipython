import { ensureKernelPython } from "../src/kernel/bootstrap.ts";
import { DEFAULT_PACKAGE_REQUIREMENTS } from "../src/kernel/packages.ts";

/** Build (or reuse) the test Kernel venv once, so the first test does not pay for it inside its timeout. */
export default async function setup(): Promise<void> {
	await ensureKernelPython({ packages: DEFAULT_PACKAGE_REQUIREMENTS });
}
