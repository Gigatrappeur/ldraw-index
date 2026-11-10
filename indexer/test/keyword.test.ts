import { describe, it, expect } from "bun:test";
import { normalizeDimension } from "../src/keyword";

describe("normalizeDimension", () => {
  it("collapse spaces around x between digits (N x N)", () => {
    expect(normalizeDimension("2 x 2")).toBe("2x2");
    expect(normalizeDimension("2 x  2")).toBe("2x2"); // double espace
    expect(normalizeDimension(" 2 x 2 ")).toBe(" 2x2 "); // espaces limites : épurés plus tard (dedupWords)
  });

  it("handle arbitrary dimension count (N x N x N)", () => {
    expect(normalizeDimension("2 x 2 x 2")).toBe("2x2x2");
    expect(normalizeDimension("1 x 2 x 4")).toBe("1x2x4");
    expect(normalizeDimension("2 x 2 x 2 x 2")).toBe("2x2x2x2");
  });

  it("normalize the multiplication sign (× · uppercase X)", () => {
    expect(normalizeDimension("2×2")).toBe("2x2");
    expect(normalizeDimension("2·2")).toBe("2x2");
    expect(normalizeDimension("2 X 2")).toBe("2x2");
    expect(normalizeDimension("2 X 2 X 4")).toBe("2x2x4");
  });

  it("keep already-canonical forms unchanged", () => {
    expect(normalizeDimension("2x2")).toBe("2x2");
    expect(normalizeDimension("2x2x2")).toBe("2x2x2");
    expect(normalizeDimension("1x2")).toBe("1x2");
  });

  it("keep the x only between digits, leave text and refs intact", () => {
    expect(normalizeDimension("plate 2 x 2 round")).toBe("plate 2x2 round");
    expect(normalizeDimension("brick 4 x 8 with 1 x 2")).toBe("brick 4x8 with 1x2");
    expect(normalizeDimension("box")).toBe("box");      // x interne non encadré de chiffres
    expect(normalizeDimension("16898")).toBe("16898");  // ref sans x
    expect(normalizeDimension("1 x")).toBe("1 x");      // pas de 2e chiffre -> inchangé
  });
});
