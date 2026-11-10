// Tests offline du helper Three.js : montage d'une géométrie brick-index
// factice sur THREE.BufferGeometry / matériaux, sans aucun renderer (Three
// suffit à construire géométrie + matériaux en pur JS sous Bun).

import { describe, it, expect } from "bun:test";
import * as THREE from "three";

import type {
	PartGeometry,
	PartGeometryMesh,
	PartMaterial,
} from "@gigatrappeur/brick-index";
import {
	geometryToBufferGeometry,
	edgesToLineSegments,
	buildPartModel,
} from "../src";
import { materialToThree } from "../src/material";

/** Triangle unique (faces selon +z) avec normale et UV. */
function makeMesh(): PartGeometryMesh {
	const material: PartMaterial = {
		code: 37,
		name: "Bright blue",
		hex: "#0077bb",
		color: [0, 0.47, 0.73],
		metalness: 0,
		roughness: 0.8,
		transparent: false,
		opacity: 1,
		side: "double",
		flatShading: true,
	};

	return {
		colorCode: 37,
		material,
		positions: [0, 0, 0, 1, 0, 0, 0, 0, 1],
		normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
		uvs: [0, 0, 1, 0, 0, 1],
		indices: [0, 1, 2],
		triangleCount: 1,
	};
}

describe("geometryToBufferGeometry", () => {
	it("monte positions / normales / UVs / indices", () => {
		const geometry = geometryToBufferGeometry(makeMesh());

		expect(geometry.attributes.position.count).toBe(3);
		expect(geometry.attributes.position.array).toHaveLength(9);
		expect(geometry.attributes.normal.count).toBe(3);
		expect(geometry.attributes.uv.count).toBe(3);
		expect(geometry.getIndex()?.array).toHaveLength(3);
		expect(geometry.index?.array[0]).toBe(0);
	});

	it("ne met pas d'attribut normal ni uv s'il n'y en a pas", () => {
		const mesh = { ...makeMesh(), normals: null, uvs: null };
		const geometry = geometryToBufferGeometry(mesh);

		const attrs = Object.keys(geometry.attributes);
		expect(attrs).not.toContain("normal");
		expect(attrs).not.toContain("uv");
		expect(geometry.index).not.toBeNull();
	});
});

describe("materialToThree", () => {
	it("traduit le côté, le flat shading et la couleur", () => {
		const material = materialToThree(makeMesh().material);

		expect(material.side).toBe(THREE.DoubleSide);
		expect(material.flatShading).toBe(true);
		expect(material.color.r).toBeCloseTo(0, 5);
		expect(material.color.g).toBeCloseTo(0.47, 5);
		expect(material.color.b).toBeCloseTo(0.73, 5);
		expect(material.metalness).toBe(0);
		expect(material.roughness).toBeCloseTo(0.8, 5);
	});

	it("utilise un matériau standard pour une couleur opaque", () => {
		const material = materialToThree(makeMesh().material);
		expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
	});

	it("utilise un matériau physique (transmission) pour un transparent", () => {
		const glass: PartMaterial = {
			...makeMesh().material,
			transparent: true,
			opacity: 0.5,
		};
		const material = materialToThree(glass, { transmission: true });
		expect(material).toBeInstanceOf(THREE.MeshPhysicalMaterial);
		expect(material.transparent).toBe(true);
	});
});

describe("edgesToLineSegments", () => {
	it("monte les lignes d'arêtes", () => {
		const edges = {
			colorCode: 37,
			material: makeMesh().material,
			lines: [0, 0, 0, 1, 1, 1],
		};
		const lines = edgesToLineSegments(edges);

		expect(lines).toBeInstanceOf(THREE.LineSegments);
		expect(lines.geometry?.attributes.position?.count).toBe(2);
	});
});

describe("buildPartModel", () => {
	it("assemble un groupe avec un mesh + ses arêtes", () => {
		const geometry: PartGeometry = {
			ldrawRef: "3001",
			unit: "studs",
			coordinateSystem: "y-up",
			aabb: { min: [0, 0, 0], max: [1, 1, 1], size: [1, 1, 1], center: [0.5, 0.5, 0.5] },
			meshes: [makeMesh()],
			edges: [{ colorCode: 37, material: makeMesh().material, lines: [0, 0, 0, 1, 1, 1] }],
		};

		const group = buildPartModel(geometry);
		expect(group.name).toBe("3001");
		// 1 mesh + 1 jeu d'arêtes.
		expect(group.children).toHaveLength(2);
		expect(group.children[0]).toBeInstanceOf(THREE.Mesh);
		expect(group.children[1]).toBeInstanceOf(THREE.LineSegments);
	});

	it("peut sauter les matériaux", () => {
		const geometry: PartGeometry = {
			ldrawRef: "3001",
			unit: "studs",
			coordinateSystem: "y-up",
			aabb: { min: [0, 0, 0], max: [1, 1, 1], size: [1, 1, 1], center: [0.5, 0.5, 0.5] },
			meshes: [makeMesh()],
			edges: [],
		};

		const group = buildPartModel(geometry, { skipMaterials: true, includeEdges: false });
		expect(group.children).toHaveLength(1);
		expect(group.children[0]).toBeInstanceOf(THREE.Mesh);
	});
});
