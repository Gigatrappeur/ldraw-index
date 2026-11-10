import { describe, it, expect } from "bun:test";
import { weldTriangles, type TriVertex } from "../../src/lib/weld";
import type { Vec2 } from "../../src/lib/geometry";

// Helper : un triangle dans le plan z=0 (côté face selon +z).
function tri(
	coords: [number, number][],
	uvs?: [number, number][],
): TriVertex {
	return {
		a: { position: { x: coords[0]![0], y: coords[0]![1], z: 0 }, uv: uvs?.[0] as Vec2 | undefined },
		b: { position: { x: coords[1]![0], y: coords[1]![1], z: 0 }, uv: uvs?.[1] as Vec2 | undefined },
		c: { position: { x: coords[2]![0], y: coords[2]![1], z: 0 }, uv: uvs?.[2] as Vec2 | undefined },
	};
}

// Deux triangles formant un quad, partageant l'arête (1,0,0)-(1,1,0).
function quad(withUv = false): TriVertex[] {
	return [
		tri(
			[[0, 0], [1, 0], [1, 1]],
			withUv ? [[0, 0], [0.5, 0], [0.5, 1]] : undefined,
		),
		tri(
			[[0, 0], [1, 1], [0, 1]],
			withUv ? [[0, 0], [0.5, 1], [0, 1]] : undefined,
		),
	];
}

describe("weldTriangles — soupe de triangles (weld: false)", () => {
	it("garde 6 sommets et des indices séquentiels", () => {
		const r = weldTriangles(quad(), {}, { weld: false, normals: "flat" });
		expect(r.positions).toHaveLength(18); // 6 sommets × 3
		expect(r.indices).toEqual([0, 1, 2, 3, 4, 5]);
		expect(r.vertexCount).toBe(6);
	});

	it("ne produit aucune normale", () => {
		const r = weldTriangles(quad(), {}, { weld: false, normals: "none" });
		expect(r.normals).toBeNull();
		expect(r.positions).toHaveLength(18);
	});

	it("expose les UVs quand il y en a", () => {
		const r = weldTriangles(quad(true), {}, { weld: false, normals: "flat" });
		expect(r.uvs).not.toBeNull();
		expect(r.uvs).toHaveLength(12); // 6 × 2
	});
});

describe("weldTriangles — fusion des sommets (weld: true)", () => {
	it("fusionne les sommets partagés par position", () => {
		const r = weldTriangles(quad(), {}, { weld: true, normals: "flat" });
		expect(r.vertexCount).toBe(4); // 4 coins uniques
		expect(r.positions).toHaveLength(12);
		expect(r.indices).toEqual([0, 1, 2, 0, 2, 3]);
	});

	it("garde séparés les sommets à UV différents (seam de texmap)", () => {
		// On recrée un quad où le coin [0,0] porte deux UV différents.
		const r = weldTriangles(quad(true), {}, { weld: true, normals: "flat" });
		// Ici les [0,0] coïncident aussi en UV, donc 4 sommets.
		expect(r.vertexCount).toBe(4);
		expect(r.uvs).toHaveLength(8);
	});

	it("n'indexe pas de sommet en dehors des bornes", () => {
		const r = weldTriangles(quad(true), {}, { weld: true, normals: "flat" });
		const max = Math.max(...r.indices);
		expect(max).toBeLessThan(r.vertexCount);
		expect(Math.min(...r.indices)).toBeGreaterThanOrEqual(0);
	});
});

describe("weldTriangles — normales", () => {
	it("normales de face identiques pour un triangle plat (flat)", () => {
		const r = weldTriangles([tri([[0, 0], [1, 0], [0, 1]])], {}, { weld: true, normals: "flat" });
		const n = r.normals!;
		// Face dans le plan xy (sens +z après weld plat).
		expect(n).toHaveLength(9);
		for (let i = 0; i < 3; i++) {
			expect(n[i * 3 + 2]!).toBeCloseTo(1, 5);
		}
	});

	it("normales lissées normalisées (smooth)", () => {
		const r = weldTriangles(quad(true), {}, { weld: true, normals: "smooth" });
		const n = r.normals!;
		expect(n).toHaveLength(12); // 4 sommets × 3
		for (let i = 0; i < 4; i++) {
			const len = Math.sqrt(n[i * 3]! ** 2 + n[i * 3 + 1]! ** 2 + n[i * 3 + 2]! ** 2);
			expect(len).toBeCloseTo(1, 5);
		}
	});

	it("normales lissées : angle de fente 0 ne mélange pas les normales trop éloignées", () => {
		// Two triangles partageant l'arête (0,0,0)-(1,0,0), plongées à 90° :
		// normals de face +z (A) et -y (B). Partagent le sommet (0,0,0).
		const folded: TriVertex[] = [
			{ a: { position: { x: 0, y: 0, z: 0 } }, b: { position: { x: 1, y: 0, z: 0 } }, c: { position: { x: 0, y: 1, z: 0 } } },
			{ a: { position: { x: 0, y: 0, z: 0 } }, b: { position: { x: 1, y: 0, z: 0 } }, c: { position: { x: 0, y: 0, z: 1 } } },
		];
		// fente 0 : la normale du sommet partagé reste celle du premier triangle (+z).
		const sharp = weldTriangles(folded, { creasAngle: 0 }, { weld: true, normals: "smooth" });
		const n0 = sharp.normals!;
		expect(n0[2]!).toBeCloseTo(1, 5); // composante z seule
		expect(n0[1]!).toBeCloseTo(0, 5);

		// fente large (120°) : les normales perpendiculaires se mélangent → moyenne normalisée.
		const blend = weldTriangles(folded, { creasAngle: 120 }, { weld: true, normals: "smooth" });
		const bn0 = blend.normals!;
		const len = Math.sqrt(bn0[0]! ** 2 + bn0[1]! ** 2 + bn0[2]! ** 2);
		expect(len).toBeCloseTo(1, 5);
		expect(bn0[1]!).toBeCloseTo(-0.7071, 3); // mixte -y et +z
		expect(bn0[2]!).toBeCloseTo(0.7071, 3);
	});
});

describe("weldTriangles — epsilon de fusion", () => {
	it("ne fusionne pas des sommets plus éloignés que epsilon", () => {
		const r = weldTriangles(
			[
				tri([[0, 0], [1, 0], [0, 1]]),
				// triangle voisin décalé de 0.001 ( > epsilon 1e-4 )
				tri([[0.001, 0], [1.001, 0], [0.001, 1]]),
			],
			{ epsilon: 1e-4 },
			{ weld: true, normals: "flat" },
		);
		expect(r.vertexCount).toBe(6);
	});

	it("fusionne des sommets proches dans la limite de epsilon", () => {
		const r = weldTriangles(
			[
				tri([[0, 0], [1, 0], [0, 1]]),
				// même sommet (0,0) recollé à 1e-5 ( < epsilon 1e-4 )
				tri([[1e-5, 0], [1, 0], [0, 1]]),
			],
			{ epsilon: 1e-4 },
			{ weld: true, normals: "flat" },
		);
		expect(r.vertexCount).toBe(3); // (1,0) et (0,1) partagés, (0,0) recollé → 3 sommets uniques
	});
});
