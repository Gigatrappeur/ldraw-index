import { describe, it, expect } from "bun:test";
import { convertFlatGeometry, transformAabb } from "../../src/lib/geometry";
import { buildPartMaterial, fallbackMaterial } from "../../src/lib/material";

/** Géométrie factice (FlatGeometry) : un seul triangle, couleur 15 (rouge METAL). */
function makeGeometry(): any {
	return {
		meshes: [
			{
				colorCode: 15,
				triangles: [
					{
						a: { position: { x: 0, y: 0, z: 0 }, uv: { u: 0, v: 0 } },
						b: { position: { x: 20, y: 0, z: 0 } },
						c: { position: { x: 0, y: 20, z: 0 } },
					},
				],
			},
		],
		edges: [
			{ colorCode: 15, segments: [{ start: { x: 0, y: 0, z: 0 }, end: { x: 20, y: 0, z: 0 } }] },
		],
		colorTable: new Map([
			[
				15,
				{
					code: 15,
					name: "Red",
					rgba: [1, 0, 0, 1],
					finish: "METAL",
					luminance: 0,
					isTransparent: false,
					hex: "#ff0000",
				},
			],
		]),
	};
}

const RED_COLOR = {
	code: 15,
	name: "Red",
	rgba: [1, 0, 0, 1] as [number, number, number, number],
	finish: "METAL",
	luminance: 0,
	isTransparent: false,
	hex: "#ff0000",
};

describe("convertFlatGeometry — transformée de base", () => {
	it("renvoie la reference, l'unité et le repère par défaut (studs, Y-up)", () => {
		const geo = convertFlatGeometry("3001", makeGeometry(), { unit: "ldu", normals: "flat" });
		expect(geo.ldrawRef).toBe("3001");
		expect(geo.unit).toBe("ldu");
		expect(geo.coordinateSystem).toBe("y-up");
	});

	it("convertit les positions en studs (1 LDU = 0,05) et retourne en Y-up", () => {
		// Y-up : negation de y et z, puis mise à l'échelle.
		const geo = convertFlatGeometry("3001", makeGeometry(), { unit: "studs", normals: "flat" });
		expect(geo.meshes[0]!.positions).toEqual([
			0, 0, 0, // (0,0,0)
			1, 0, 0, // (20 LDU * 0.05, 0, 0)
			0, -1, 0, // (0, -20*0.05, 0)
		]);
	});

	it("garde le repère LDraw (Y-down) quand yUp = false", () => {
		const geo = convertFlatGeometry("3001", makeGeometry(), { unit: "ldu", yUp: false, normals: "flat" });
		expect(geo.meshes[0]!.positions).toEqual([0, 0, 0, 20, 0, 0, 0, 20, 0]);
		expect(geo.coordinateSystem).toBe("y-down");
	});

	it("calcule des normales de face (flat)", () => {
		const geo = convertFlatGeometry("3001", makeGeometry(), { unit: "ldu", normals: "flat", yUp: false });
		const mesh = geo.meshes[0]!;
		// Normale de face du triangle, normalisée.
		const n = mesh.normals;
		expect(n).not.toBeNull();
		expect(n).toHaveLength(9); // 3 sommets × 3 composantes
		// toutes les normales sont unitaires
		for (let i = 0; i < 3; i++) {
			const len = Math.sqrt((n![i * 3]!) ** 2 + (n![i * 3 + 1]!) ** 2 + (n![i * 3 + 2]!) ** 2);
			expect(len).toBeCloseTo(1, 6);
		}
	});

	it("ne produit aucune normale quand normals = false", () => {
		const geo = convertFlatGeometry("3001", makeGeometry(), { unit: "ldu", normals: false, yUp: false });
		expect(geo.meshes[0]!.normals).toBeNull();
	});

	it("produit des normales lissées (smooth) unitaires", () => {
		const geo = convertFlatGeometry("3001", makeGeometry(), { unit: "ldu", normals: "smooth", yUp: false });
		const n = geo.meshes[0]!.normals!;
		expect(n).toHaveLength(9);
		for (let i = 0; i < 3; i++) {
			const len = Math.sqrt((n[i * 3]!) ** 2 + (n[i * 3 + 1]!) ** 2 + (n[i * 3 + 2]!) ** 2);
			expect(len).toBeCloseTo(1, 6);
		}
	});

	it("contient une table d'indices séquentielle", () => {
		const geo = convertFlatGeometry("3001", makeGeometry(), { unit: "ldu", normals: "flat", yUp: false });
		expect(geo.meshes[0]!.indices).toEqual([0, 1, 2]);
		expect(geo.meshes[0]!.triangleCount).toBe(1);
	});

	it("expose les UVs uniquement s'il y en a", () => {
		const withUv = convertFlatGeometry("3001", makeGeometry(), { unit: "ldu", normals: "flat", yUp: false });
		expect(withUv.meshes[0]!.uvs).toEqual([0, 0, 0, 0, 0, 0]);

		const noGeo: any = { ...makeGeometry() };
		noGeo.meshes[0]!.triangles[0]!.a = { position: { x: 0, y: 0, z: 0 } };
		noGeo.meshes[0]!.triangles[0]!.b = { position: { x: 1, y: 0, z: 0 } };
		noGeo.meshes[0]!.triangles[0]!.c = { position: { x: 0, y: 1, z: 0 } };
		const noUv = convertFlatGeometry("3001", noGeo, { unit: "ldu", normals: "flat", yUp: false });
		expect(noUv.meshes[0]!.uvs).toBeNull();
	});
});

describe("convertFlatGeometry — arêtes et boîte englobante", () => {
	it("transforme les arêtes en lignes plates", () => {
		const geo = convertFlatGeometry("3001", makeGeometry(), { unit: "ldu", normals: "flat", yUp: false });
		expect(geo.edges).toHaveLength(1);
		expect(geo.edges[0]!.lines).toEqual([0, 0, 0, 20, 0, 0]);
	});

	it("calcule la boîte englobante dans l'unité de sortie", () => {
		const geo = convertFlatGeometry("3001", makeGeometry(), { unit: "studs", normals: "flat" });
		const { min, max, size } = geo.aabb;
		expect(min).toEqual([0, -1, 0]);
		expect(max).toEqual([1, 0, 0]);
		expect(size).toEqual([1, 1, 0]);
	});
});

describe("convertFlatGeometry — matériaux par couleur", () => {
	it("dérive le matériau PBR de la finition LDraw (METAL)", () => {
		const geo = convertFlatGeometry("3001", makeGeometry(), { unit: "ldu", normals: "flat", yUp: false });
		const material = geo.meshes[0]!.material;
		expect(material.code).toBe(15);
		expect(material.name).toBe("Red");
		expect(material.metalness).toBe(1.0);
		expect(material.roughness).toBe(0.25);
		expect(material.color).toEqual([1, 0, 0]);
			expect(material.flatShading).toBe(true);
		expect(material.side).toBe("double");
	});

	it("applique un matériau par défaut si la couleur manque au tableau", () => {
		const noTable: any = { ...makeGeometry() };
		noTable.colorTable = undefined;
		const geo = convertFlatGeometry("3001", noTable, { unit: "ldu", normals: "flat", yUp: false });
		const material = geo.meshes[0]!.material;
		expect(material.code).toBe(15);
		expect(material.metalness).toBe(0);
		expect(material.roughness).toBe(0.8);
	});

	it("répète le matériau pour les arêtes de même couleur", () => {
		const geo = convertFlatGeometry("3001", makeGeometry(), { unit: "ldu", normals: "flat", yUp: false });
		expect(geo.edges[0]!.material.code).toBe(15);
	});
});

describe("buildPartMaterial", () => {
	it("mappage des finitions → metalness / roughness", () => {
		const chrome = buildPartMaterial({ ...RED_COLOR, finish: "CHROME" });
		expect(chrome.metalness).toBe(1.0);
		expect(chrome.roughness).toBeCloseTo(0.03, 6);

		const rubber = buildPartMaterial({ ...RED_COLOR, finish: "RUBBER" });
		expect(rubber.metalness).toBe(0.0);
		expect(rubber.roughness).toBeCloseTo(0.95, 6);

		const normal = buildPartMaterial({ ...RED_COLOR, finish: "NORMAL" });
		expect(normal.metalness).toBe(0);
		expect(normal.roughness).toBe(0.8);
	});

	it("expose l'emission pour les couleurs luticoles", () => {
		const glow = buildPartMaterial({ ...RED_COLOR, finish: "NORMAL", luminance: 255 });
		expect(glow.emissiveIntensity).toBe(1);
		expect(glow.emissive).toEqual([1, 0, 0]);
	});

	it("n'expose pas d'emission sans luminance", () => {
		const mat = buildPartMaterial({ ...RED_COLOR, luminance: 0 });
		expect(mat.emissive).toBeUndefined();
		expect(mat.emissiveIntensity).toBeUndefined();
	});

	it("respecte les options (côté, flat shading)", () => {
		expect(buildPartMaterial({ ...RED_COLOR }, { side: "front" }).side).toBe("front");
		expect(buildPartMaterial({ ...RED_COLOR }, { flatShading: false }).flatShading).toBe(false);
	});

	it("fallbackMaterial renvoie un blanc mate", () => {
		const mat = fallbackMaterial(999);
		expect(mat.code).toBe(999);
		expect(mat.color).toEqual([1, 1, 1]);
		expect(mat.metalness).toBe(0);
		expect(mat.roughness).toBe(0.8);
	});
});

describe("transformAabb — transformée de boîte englobante", () => {
	// Boîte brute en LDU, repère LDraw (Y-down).
	const raw = {
		min: { x: 0, y: -10, z: 5 } as { x: number; y: number; z: number },
		max: { x: 20, y: 30, z: 10 } as { x: number; y: number; z: number },
	};

	it("reste identique en LDU quand le repère est Y-down", () => {
		const box = transformAabb(raw, 1, false);
		expect(box.min).toEqual([0, -10, 5]);
		expect(box.max).toEqual([20, 30, 10]);
		expect(box.size).toEqual([20, 40, 5]);
		expect(box.center).toEqual([10, 10, 7.5]);
	});

	it("négue y et z en Y-up (swap min/max) puis met à l'échelle en studs", () => {
		// 1 stud = 20 LDU → scale 0,05. Y-up : y,z négés, min↔max s'échangent.
		const box = transformAabb(raw, 0.05, true);
		expect(box.min).toEqual([0, -1.5, -0.5]);
		expect(box.max).toEqual([1, 0.5, -0.25]);
		expect(box.size).toEqual([1, 2, 0.25]);
		expect(box.center).toEqual([0.5, -0.5, -0.375]);
	});
});
