const KAGGLE_KERNELS_DOC = "https://raw.githubusercontent.com/Kaggle/kaggle-cli/main/docs/kernels.md";

export type KaggleAccelerator = {
	id: string;
	description?: string;
};

export async function fetchKaggleAccelerators(
	fetchImpl: typeof fetch = fetch,
): Promise<{
	asOf: string;
	source: string;
	accelerators: KaggleAccelerator[];
	notes: string[];
}> {
	const res = await fetchImpl(KAGGLE_KERNELS_DOC);
	if (!res.ok) throw new Error(`Failed to fetch kernels.md: ${res.status}`);
	const md = await res.text();
	const heading = md.match(/Accelerators available as of ([^:\n]+):\s*\n/);
	if (!heading) {
		throw new Error(
			"Could not locate 'Accelerators available as of …' heading in kernels.md; upstream doc format may have changed.",
		);
	}
	const tail = md.slice(md.indexOf(heading[0]) + heading[0].length);
	const accelerators: KaggleAccelerator[] = [];
	const notes: string[] = [];
	let listEnded = false;
	for (const line of tail.split("\n")) {
		const bullet = line.match(/^\*\s+(\S+)(?:\s+(.*))?$/);
		if (!listEnded && bullet) {
			const description = bullet[2]?.trim();
			accelerators.push({
				id: bullet[1],
				...(description ? { description } : {}),
			});
			continue;
		}
		if (!accelerators.length) continue;
		if (!line.trim()) {
			listEnded = true;
			continue;
		}
		if (line.startsWith("#")) break;
		notes.push(line.trim());
	}
	return {
		asOf: heading[1].trim(),
		source: "https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels.md",
		accelerators,
		notes,
	};
}
