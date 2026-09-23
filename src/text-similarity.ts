// Comparing OCR output exactly (===) is brittle: the same underlying photo
// can come back through the scraper with different bytes (the story-viewer
// proxy re-signs/re-encodes on every load) and the vision model isn't
// perfectly deterministic, so re-transcribing an *unchanged* menu photo can
// yield a slightly different string (extra space, punctuation, a word
// spelled differently). Comparing word sets instead of exact strings makes
// the "did the menu actually change" check tolerant of that noise while
// still catching real changes (different dishes/prices show up as
// different words).
const normalizeToWords = (text: string) =>
	text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "") // strip accents (à -> a, etc.)
		.replace(/[^\p{L}\p{N}]+/gu, " ") // punctuation/whitespace -> separator
		.split(" ")
		.filter(Boolean);

/** Jaccard similarity of the two texts' word sets, in [0, 1]. */
export const textSimilarity = (a: string, b: string): number => {
	const setA = new Set(normalizeToWords(a));
	const setB = new Set(normalizeToWords(b));

	if (setA.size === 0 && setB.size === 0) return 1;

	let intersection = 0;
	for (const word of setA) {
		if (setB.has(word)) intersection++;
	}
	const union = setA.size + setB.size - intersection;

	return union === 0 ? 1 : intersection / union;
};

// Two OCR passes of the exact same photo have been observed to differ by a
// handful of tokens (spacing/punctuation/minor mis-reads); real menu changes
// (new/removed dishes, changed prices) shift far more of the word set. 0.92
// gives headroom for OCR noise without swallowing genuine changes.
export const MENU_UNCHANGED_SIMILARITY_THRESHOLD = 0.92;

export const isSameMenu = (a: string, b: string): boolean =>
	a === b || textSimilarity(a, b) >= MENU_UNCHANGED_SIMILARITY_THRESHOLD;
