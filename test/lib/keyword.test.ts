import { describe, it, expect } from "bun:test";
import { normalizeDimension } from "../../src/lib/keyword";

describe("normalizeDimension (côté recherche)", () => {
  it("unifie les variantes de dimension en forme canonique", () => {
    expect(normalizeDimension("2 x  2")).toBe("2x2");
    expect(normalizeDimension("2×2")).toBe("2x2");
    expect(normalizeDimension("2 X 2")).toBe("2x2");
    expect(normalizeDimension("2 x 2 x 2")).toBe("2x2x2");
    expect(normalizeDimension("2x2")).toBe("2x2");
  });

  it("ne touche pas le reste de la requête", () => {
    expect(normalizeDimension("plate 2 x 2 round")).toBe("plate 2x2 round");
    expect(normalizeDimension("16898")).toBe("16898");
    expect(normalizeDimension("box")).toBe("box");
  });

  it("une requête vide reste vide", () => {
    expect(normalizeDimension("")).toBe("");
  });
});
