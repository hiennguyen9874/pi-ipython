// Images from a Cell's displays, kept within what a result can carry: the last few, each fitted to
// the size models accept.

import { resizeImage } from "@earendil-works/pi-coding-agent";

export const MAX_IMAGES_PER_RESULT = 8;
/** pi's resize target: base64 headroom below Anthropic's 5 MB image limit. */
const MAX_IMAGE_BASE64_BYTES = 4.5 * 1024 * 1024;

export interface CellImage {
	mimeType: string;
	/** base64 */
	data: string;
}

interface Entry {
	raw?: CellImage;
	fitted: Promise<CellImage | undefined>;
	resolve: (image: CellImage | undefined) => void;
}

export class ImageCollector {
	private entries: Entry[] = [];
	private settling: Entry[] = [];
	private fitting = false;
	private overLimit = 0;

	push(raw: CellImage): void {
		if (this.entries.length === MAX_IMAGES_PER_RESULT) {
			this.entries.shift();
			this.overLimit++;
		}
		let resolve!: Entry["resolve"];
		const fitted = new Promise<CellImage | undefined>((done) => { resolve = done; });
		this.entries.push({ raw, fitted, resolve });
		if (!this.fitting) void this.fitPending();
	}

	/** Freeze this result; new Background output goes into the next one. */
	async take(): Promise<{ images: CellImage[]; notice?: string }> {
		this.settling = this.entries;
		const overLimit = this.overLimit;
		this.reset();
		const fitted = await Promise.all(this.settling.map((entry) => entry.fitted));
		this.settling = [];
		const images = fitted.filter((image): image is CellImage => image !== undefined);
		const tooLarge = fitted.length - images.length;
		const notices = [
			...(overLimit ? [`[${plural(overLimit)} dropped: over the ${MAX_IMAGES_PER_RESULT}-image limit]`] : []),
			...(tooLarge ? [`[${plural(tooLarge)} dropped: too large to send]`] : []),
		];
		return { images, notice: notices.length ? notices.join("\n") : undefined };
	}

	reset(): void {
		this.entries = [];
		this.overLimit = 0;
	}

	private async fitPending(): Promise<void> {
		this.fitting = true;
		try {
			for (;;) {
				const entry = this.settling.find((e) => e.raw) ?? this.entries.find((e) => e.raw);
				if (!entry) return;
				const raw = entry.raw!;
				entry.raw = undefined;
				entry.resolve(await fitImage(raw));
			}
		} finally {
			this.fitting = false;
		}
	}
}

/** The image resized to fit, the original when resizing fails but it already fits, or undefined. */
async function fitImage(image: CellImage): Promise<CellImage | undefined> {
	try {
		const resized = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType);
		if (resized) return { mimeType: resized.mimeType, data: resized.data };
	} catch {}
	return Buffer.byteLength(image.data) <= MAX_IMAGE_BASE64_BYTES ? image : undefined;
}

const plural = (n: number) => `${n} image${n === 1 ? "" : "s"}`;
