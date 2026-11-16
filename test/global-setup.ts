import { ensureKernelPython } from "../src/kernel/bootstrap.ts";

/** Build (or reuse) the test Kernel venv once, so the first test does not pay for it inside its timeout. */
export default async function setup(): Promise<void> {
	await ensureKernelPython();
}
