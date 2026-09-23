import { describe, expect, it } from "vitest";
import { isSameMenu, textSimilarity } from "./text-similarity";

const REAL_MENU = `PRIMO + SECONDO + CONTORNO €13,00
RISOTTO + SECONDO + CONTORNO €15,00
Bevande escluse

PRIMI €8,00
Pasta al cinghiale
Zuppa di legumi con farro e crostino di pane
Risotto alla barbabietola e crema di formaggio €10,00

SECONDI+CONTORNO €10,00
Arrosto con patate al forno
Carpaccio di manzo con scaglie di grana e insalata
Costine di maiale con polenta
Caprese con insalata
Insalatone €11,00
Pasta al cinghiale e arrosto con patate al forno €13,00

I SEMPER VERD
Risott Giald e Oss' Bùs €26,00
La Cutulèta a la Milanesa €30,00
Risott Giald €15,00`;

describe("textSimilarity / isSameMenu", () => {
	it("is 1 for identical text", () => {
		expect(textSimilarity(REAL_MENU, REAL_MENU)).toBe(1);
		expect(isSameMenu(REAL_MENU, REAL_MENU)).toBe(true);
	});

	it("treats minor OCR noise on the same photo as unchanged", () => {
		// same photo re-OCR'd: extra whitespace, punctuation drift, a comma
		// vs dot in a price, a minor mis-read on an accented word.
		const reOcr = REAL_MENU.replace("€13,00", "€ 13.00")
			.replace("Bùs", "Bus")
			.replace("\n\n", "\n");

		const similarity = textSimilarity(REAL_MENU, reOcr);
		expect(similarity).toBeGreaterThanOrEqual(0.92);
		expect(isSameMenu(REAL_MENU, reOcr)).toBe(true);
	});

	it("detects a genuinely changed menu (different dishes/prices)", () => {
		const changed = REAL_MENU.replace(
			"Pasta al cinghiale",
			"Lasagna alla bolognese",
		)
			.replace("Arrosto con patate al forno", "Pollo arrosto con verdure")
			.replace("€13,00", "€14,00");

		expect(isSameMenu(REAL_MENU, changed)).toBe(false);
	});

	it("treats a completely different menu as changed", () => {
		expect(isSameMenu(REAL_MENU, "Sushi menu: nigiri, sashimi, temaki")).toBe(
			false,
		);
	});
});
