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
	/** The image as emitted, until it is fitted or dropped. */
	raw?: CellImage;
	/** The fitted image, or undefined when it is too large to send. */
	fitted: Promise<CellImage | undefined>;
}

/** Keeps the last images pushed, fitting each one as it arrives; older ones are dropped unfitted. */
export class ImageCollector {
	private entries: Entry[] = [];
	private chain: Promise<unknown> = Promise.resolve();
	/** Images dropped to stay within the per-result limit. */
	overLimit = 0;

	push(image: CellImage): void {
		if (this.entries.length === MAX_IMAGES_PER_RESULT) this.drop(this.entries.shift()!);
		const entry: Entry = { raw: image, fitted: Promise.resolve(undefined) };
		// One at a time, so a burst of images never holds more than the kept ones in memory.
		entry.fitted = this.chain.then(async () => {
			const raw = entry.raw;
			entry.raw = undefined;
			return raw && fitImage(raw);
		});
		this.chain = entry.fitted;
		this.entries.push(entry);
	}

	/** Hand over the kept images and the count dropped so far. */
	take(): { entries: Promise<CellImage | undefined>[]; overLimit: number } {
		return { entries: this.entries.map((e) => e.fitted), overLimit: this.overLimit };
	}

	private drop(entry: Entry): void {
		entry.raw = undefined;
		this.overLimit++;
	}
}

/** The last images of all collectors (in order), and a notice for the ones dropped. */
export async function collectImages(collectors: ImageCollector[]): Promise<{ images: CellImage[]; notice?: string }> {
	const taken = collectors.map((c) => c.take());
	const all = taken.flatMap((t) => t.entries);
	const kept = all.slice(-MAX_IMAGES_PER_RESULT);
	const overLimit = taken.reduce((n, t) => n + t.overLimit, 0) + all.length - kept.length;
	const fitted = await Promise.all(kept);
	const images = fitted.filter((image): image is CellImage => image !== undefined);
	const tooLarge = fitted.length - images.length;
	const notices = [
		...(overLimit ? [`[${plural(overLimit)} dropped: over the ${MAX_IMAGES_PER_RESULT}-image limit]`] : []),
		...(tooLarge ? [`[${plural(tooLarge)} dropped: too large to send]`] : []),
	];
	return { images, notice: notices.length ? notices.join("\n") : undefined };
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
