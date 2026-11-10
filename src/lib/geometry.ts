// geometry.ts — Transforme une FlatGeometry (parser LDraw) en une géométrie
// jsonifiable, indexée par couleur, prête à bâtir un mesh + matériau côté front.
//
// Le parser n'explose que la géométrie brute (triangle-soup, sans normales) et
// n'exporte pas ses helpers de weld : on réimplémente ici la transformée
// (unité + repère) dans ce module, et le weld/normales dans `weld.ts`. La logique
// est volontairement pure et sans dépendance DB/-parser, pour rester testable hors-connexion.

import type { FlatGeometry } from "@gigatrappeur/ldraw-parser"
import type { PartBoundingBox } from "./part"
import { buildPartMaterial, fallbackMaterial, type MaterialOptions, type PartMaterial } from "./material"
import { weldTriangles, type WeldOptions, type TriVertex, type NormalMode } from "./weld"

export type { PartMaterial, WeldOptions }

/** Unités de longueur prises en charge (mêmes que le parser LDraw). */
export type GeometryLengthUnit = "ldu" | "mm" | "cm" | "m" | "in" | "studs"

/** Vecteur 2D (UV). */
export interface Vec2 {
	u: number
	v: number
}

/** Vecteur 3D. */
export interface Vec3 {
	x: number
	y: number
	z: number
}

/** Facteur de multiplication d'une coordonnée LDU vers l'unité demandée. */
export const SCALE_FROM_LDU: Record<GeometryLengthUnit, number> = {
	ldu: 1,
	/** 1 LDU = 0,4 mm */
	mm: 0.4,
	/** 1 LDU = 0,04 cm */
	cm: 0.04,
	/** 1 LDU = 0,0004 m */
	m: 0.0004,
	/** 1 LDU = 0,4 mm en inches */
	in: 0.015748031496062992,
	/** 1 LDU = 1/20 stud */
	studs: 0.05,
}

export interface GeometryOptions {
	/** Unité de sortie des positions (defaut : « studs »). */
	unit?: GeometryLengthUnit
	/** Repère Y-up (Three.js) au lieu du repère LDraw (Y-down) (defaut : « true »). */
	yUp?: boolean
	/**
	 * Dédoublonnage de sommets (weld) :
	 * - défaut `{ epsilon: 1e-4 }` → sommets fusionnés par position (+ UV),
	 *   indices indexant un buffer de sommets partagé ;
	 * - `false` → soupe de triangles (aucun weld, indices séquentiels).
	 */
	weld?: WeldOptions | false
	/**
	 * Normales à produire :
	 * - « flat » : normales de face (defaut),
	 * - « smooth » : normals lissées (avec fente), requiert un weld,
	 * - `false` : aucune normale.
	 */
	normals?: "flat" | "smooth" | false
	/** Options transmises à la construction des matériaux (côté, flat shading…). */
	material?: MaterialOptions
}

export interface PartGeometryMesh {
	/** Code couleur LDraw du mesh. */
	colorCode: number
	/** Matériau PBR associé (dérivé de la couleur). */
	material: PartMaterial
	/** Table de positions plate [x, y, z, x, y, z, …]. */
	positions: number[]
	/** Table de normales plate [nx, ny, nz, …], ou null si absentes. */
	normals: number[] | null
	/** Indices des sommets (pointeur vers `positions`), toujours présents. */
	indices: number[]
	/** Table d'UVs plate [u, v, …], ou null si absents. */
	uvs: number[] | null
	/** Nombre de triangles du mesh. */
	triangleCount: number
}

export interface PartGeometryEdges {
	/** Code couleur LDraw des arêtes. */
	colorCode: number
	/** Matériau PBR associé. */
	material: PartMaterial
	/** Lignes plates [x, y, z, x, y, z, …] (début/fin de chaque segment). */
	lines: number[]
}

export interface PartGeometry {
	/** Reference LDraw de la pièce. */
	ldrawRef: string
	/** Unité de sortie. */
	unit: GeometryLengthUnit
	/** Repère de coordonnées. */
	coordinateSystem: "y-up" | "y-down"
	/** Boîte englobante axe-à-axe dans l'unité de sortie. */
	aabb: PartBoundingBox
	/** Meshs groupés par couleur. */
	meshes: PartGeometryMesh[]
	/** Arêtes (contours) de la pièce. */
	edges: PartGeometryEdges[]
}

/** Vecteur 3D en écriture compacte. */
type Vec = [number, number, number]

/** Applique la transformation d'unité (+ retournement Y-down → Y-up) à une position. */
function transformPosition(v: Vec3, scale: number, yUp: boolean): Vec3 {
	let { x, y, z } = v
	if (yUp) { y = -y; z = -z }
	// `+ 0` normalise le zéro négatif (−0 → 0) évité par la négation Y-up.
	return {
		x: x * scale + 0,
		y: y * scale + 0,
		z: z * scale + 0,
	}
}

/**
 * Transforme une boîte englobante brute (min/max en LDU, repère LDraw Y-down)
 * dans l'unité et le repère de sortie. C'est la source unique de vérité pour la
 * transformée de box : le listing bulk (`getAllBoundingBoxes`) l'utilise car le
 * parser expose l'AABB brute en LDU, tandis que `convertFlatGeometry` calcule la
 * sienne directement sur des positions déjà transformées (inchangée).
 *
 * Le repère Y-up négant y et z, le min et le max s'échangent sur ces axes :
 * `min.y(sortie) = -max.y(entrée) * scale`, etc. L'échelle étant positive,
 * l'ordre des extrémités ne fait que se retourner, pas se mélanger.
 */
export function transformAabb(
	aabb: { min: Vec3; max: Vec3 },
	scale: number,
	yUp: boolean,
): PartBoundingBox {
	const min: Vec = yUp
		? [aabb.min.x * scale + 0, -aabb.max.y * scale + 0, -aabb.max.z * scale + 0]
		: [aabb.min.x * scale + 0, aabb.min.y * scale + 0, aabb.min.z * scale + 0]
	const max: Vec = yUp
		? [aabb.max.x * scale + 0, -aabb.min.y * scale + 0, -aabb.min.z * scale + 0]
		: [aabb.max.x * scale + 0, aabb.max.y * scale + 0, aabb.max.z * scale + 0]
	return {
		min,
		max,
		size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
		center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
	}
}

/** Met à jour une boîte englobante axe-à-axe depuis une table de positions. */
function updateAabb(positions: number[], aabb: { min: Vec; max: Vec }): void {
	for (let i = 0; i < positions.length; i += 3) {
		const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!
		if (x < aabb.min[0]!) aabb.min[0] = x
		if (y < aabb.min[1]!) aabb.min[1] = y
		if (z < aabb.min[2]!) aabb.min[2] = z
		if (x > aabb.max[0]!) aabb.max[0] = x
		if (y > aabb.max[1]!) aabb.max[1] = y
		if (z > aabb.max[2]!) aabb.max[2] = z
	}
}

/** Résout la matériau d'un mesh depuis son code couleur et le tableau des couleurs. */
function resolveMaterial(colorCode: number, colorTable: FlatGeometry["colorTable"], options: MaterialOptions): PartMaterial {
	const color = colorTable?.get(colorCode)
	return color ? buildPartMaterial(color, options) : fallbackMaterial(colorCode, options)
}

/**
 * Convertit une `FlatGeometry` du parser en une {@link PartGeometry} jsonifiable,
 * indexée par couleur, avec matériaux dérivés.
 *
 * @param ldrawRef reference de la pièce (stockée dans la structure retournée)
 * @param geometry géométrie brute du parser (`part.geometry`)
 * @param options unité, repère et normales
 */
export function convertFlatGeometry(ldrawRef: string, geometry: FlatGeometry, options: GeometryOptions = {}): PartGeometry {
	const unit = options.unit ?? "studs"
	const yUp = options.yUp ?? true
	const scale = SCALE_FROM_LDU[unit]
	const materialOptions = options.material ?? {}

	const meshes: PartGeometryMesh[] = []

	for (const mesh of geometry.meshes) {
		const triangles = mesh.triangles

		// Triangles transformés (unité + repère), réutilisables par le weld.
		const transformed: TriVertex[] = []
		for (const tri of triangles) {
			transformed.push({
				a: { position: transformPosition(tri.a.position, scale, yUp), uv: tri.a.uv },
				b: { position: transformPosition(tri.b.position, scale, yUp), uv: tri.b.uv },
				c: { position: transformPosition(tri.c.position, scale, yUp), uv: tri.c.uv },
			})
		}

		// Weld (dédoublonnage des sommets) + normales en un seul passage.
		const weldMode = options.weld !== false
		const normalMode: NormalMode = options.normals === false
			? "none"
			: options.normals === "smooth"
				? "smooth"
				: "flat"
		const weldOpts: WeldOptions = options.weld === false ? {} : (options.weld ?? {})
		const result = weldTriangles(transformed, weldOpts, { weld: weldMode, normals: normalMode })

		meshes.push({
			colorCode: mesh.colorCode,
			material: resolveMaterial(mesh.colorCode, geometry.colorTable, materialOptions),
			positions: result.positions,
			normals: result.normals,
			indices: result.indices,
			uvs: result.uvs,
			triangleCount: result.triangleCount,
		})
	}

	// Arêtes (contours) : mêmes transformations, format « lignes ».
	const edges: PartGeometryEdges[] = geometry.edges.map((eg) => {
		const lines: number[] = []
		for (const seg of eg.segments) {
			const s = transformPosition(seg.start, scale, yUp)
			const e = transformPosition(seg.end, scale, yUp)
			lines.push(s.x, s.y, s.z, e.x, e.y, e.z)
		}
		return {
			colorCode: eg.colorCode,
			material: resolveMaterial(eg.colorCode, geometry.colorTable, materialOptions),
			lines,
		}
	})

	// Boîte englobante dans l'unité de sortie : les positions des mesh sont
	// déjà transformées (unité + repère), on prend min/max puis on en dérive
	// la taille et le centre.
	const aabb = {
		min: [Infinity, Infinity, Infinity] as Vec,
		max: [-Infinity, -Infinity, -Infinity] as Vec,
	}
	for (const mesh of meshes) updateAabb(mesh.positions, aabb)
	const size: Vec = [
		aabb.max[0]! - aabb.min[0]!,
		aabb.max[1]! - aabb.min[1]!,
		aabb.max[2]! - aabb.min[2]!,
	]
	const center: Vec = [
		(aabb.min[0]! + aabb.max[0]!) / 2,
		(aabb.min[1]! + aabb.max[1]!) / 2,
		(aabb.min[2]! + aabb.max[2]!) / 2,
	]

	return {
		ldrawRef,
		unit,
		coordinateSystem: yUp ? "y-up" : "y-down",
		aabb: { min: aabb.min, max: aabb.max, size, center },
		meshes,
		edges,
	}
}
