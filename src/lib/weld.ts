// weld.ts — Fusion de sommets (weld) et calcul de normales pour géométrie LDraw.
//
// Réimplémentation, en sortie JSON-compatible (tableaux de nombres plats), du
// welder du parser LDraw : hachage spatial des positions, dédoublonnage de
// sommets (également par UV pour ne pas casser les seams de texmap) et normales
// de face ou lissées (avec angle de fente). Sans dépendance DB / -parser, pour
// rester testable hors-connexion.

import type { Vec2, Vec3 } from "./geometry"

export interface WeldOptions {
	/** Tolérance de fusion de sommets, dans l'espace des positions (defaut 1e-4). */
	epsilon?: number
	/** Normales lissées par averaging de normales de face (defaut false). */
	smoothNormals?: boolean
	/**
	 * Angle de fente en degrés : en dessous de cet angle (faces trop proches),
	 * les normales sont lissées ; au-dessus, l'arête reste tranchante
	 * (defaut 60).
	 */
	creasAngle?: number
}

/** Stratégie de normales produites. */
export type NormalMode = "flat" | "smooth" | "none"

/** Sommet de triangle : position + UV optionnel. */
interface Vtx {
	position: Vec3
	uv?: Vec2
}

/** Triangle transformé (déjà dans l'espace de sortie : unité + repère). */
export interface TriVertex {
	a: Vtx
	b: Vtx
	c: Vtx
}

export interface WeldResult {
	/** Positions plates [x, y, z, x, y, z, …]. */
	positions: number[]
	/** Normales plates [nx, ny, nz, …], ou null si `normals === "none"`. */
	normals: number[] | null
	/** UVs plates [u, v, …], ou null s'il n'y en a pas. */
	uvs: number[] | null
	/** Indices des sommets (pointeur vers `positions`). */
	indices: number[]
	/** Nombre de sommets après weld. */
	vertexCount: number
	/** Nombre de triangles. */
	triangleCount: number
}

/** Hachage spatial des positions (même table de hachage que le parser LDraw). */
class Grid {
	private cells = new Map<number, number[]>()
	private eps: number

	constructor(eps: number) {
		this.eps = eps
	}

	private h(x: number, y: number, z: number): number {
		const ix = Math.round(x / this.eps) | 0
		const iy = Math.round(y / this.eps) | 0
		const iz = Math.round(z / this.eps) | 0
		return ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0
	}

	add(i: number, x: number, y: number, z: number) {
		const k = this.h(x, y, z)
		const c = this.cells.get(k)
		if (c) c.push(i)
		else this.cells.set(k, [i])
	}

	near(x: number, y: number, z: number): number[] {
		const out: number[] = []
		for (let dx = -1; dx <= 1; dx++)
			for (let dy = -1; dy <= 1; dy++)
				for (let dz = -1; dz <= 1; dz++) {
					const ix = (Math.round(x / this.eps) | 0) + dx
					const iy = (Math.round(y / this.eps) | 0) + dy
					const iz = (Math.round(z / this.eps) | 0) + dz
					const k = ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0
					const c = this.cells.get(k)
					if (c) for (const i of c) out.push(i)
				}
		return out
	}
}

/** Normale de face (normalisée) d'un triangle. */
function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
	const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z
	const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z
	let nx = uy * vz - uz * vy
	let ny = uz * vx - ux * vz
	let nz = ux * vy - uy * vx
	const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
	return { x: nx / len, y: ny / len, z: nz / len }
}

/**
 * Fusion (weld) et calcul de normales pour un nuage de triangles déjà dans
 * l'espace de sortie (unité + repère appliqués).
 *
 * @param triangles triangles transformés
 * @param opts options de weld (ignorées si `weld` est à `false`)
 * @param {weld, normals} stratégie de weld et de normales
 */
export function weldTriangles(
	triangles: TriVertex[],
	opts: WeldOptions = {},
	{ weld, normals }: { weld: boolean; normals: NormalMode },
): WeldResult {
	const eps = opts.epsilon ?? 1e-4
	const hasUV = triangles.length > 0 &&
		(triangles[0]!.a.uv !== undefined ||
			triangles[0]!.b.uv !== undefined ||
			triangles[0]!.c.uv !== undefined)

	const positions: number[] = []
	const uvArr: number[] = []
	const uvMirror: number[] = [] // [u, v] de chaque sommet weldé, pour comparer

	// Soupe de triangles : aucun dédoublonnage, indices séquentiels.
	const indices: number[] = []
	if (!weld) {
		for (const t of triangles) {
			positions.push(t.a.position.x, t.a.position.y, t.a.position.z)
			positions.push(t.b.position.x, t.b.position.y, t.b.position.z)
			positions.push(t.c.position.x, t.c.position.y, t.c.position.z)
			if (hasUV) {
				uvArr.push(t.a.uv?.u ?? 0, t.a.uv?.v ?? 0)
				uvArr.push(t.b.uv?.u ?? 0, t.b.uv?.v ?? 0)
				uvArr.push(t.c.uv?.u ?? 0, t.c.uv?.v ?? 0)
			}
			const base = positions.length / 3 - 3
			indices.push(base, base + 1, base + 2)
		}
	} else {
		// Dédoublonnage par position (+ UV pour préserver les seams de texmap).
		const grid = new Grid(eps)
		for (const t of triangles) {
			for (const v of [t.a, t.b, t.c] as const) {
				const { position } = v
				const { x, y, z } = position
				let found = -1
				for (const ci of grid.near(x, y, z)) {
					const px = positions[ci * 3] ?? 0
					const py = positions[ci * 3 + 1] ?? 0
					const pz = positions[ci * 3 + 2] ?? 0
					const d2 = (x - px) ** 2 + (y - py) ** 2 + (z - pz) ** 2
					if (d2 < eps * eps) {
						if (!hasUV ||
							(v.uv?.u ?? 0) === (uvMirror[ci * 2] ?? 0) &&
							(v.uv?.v ?? 0) === (uvMirror[ci * 2 + 1] ?? 0)) {
							found = ci
							break
						}
					}
				}
				if (found < 0) {
					found = positions.length / 3
					positions.push(x, y, z)
					if (hasUV) {
						const u = v.uv?.u ?? 0
						const vv = v.uv?.v ?? 0
						uvArr.push(u, vv)
						uvMirror.push(u, vv)
					}
					grid.add(found, x, y, z)
				}
				indices.push(found)
			}
		}
	}

	// Normales.
	let normalsOut: number[] | null = null
	if (normals !== "none") {
		normalsOut = (normals === "smooth" && weld)
			? computeSmooth(positions, triangles, indices, opts)
			: computeFlat(positions, triangles, indices)
	}

	return {
		positions,
		normals: normalsOut,
		uvs: hasUV ? uvArr : null,
		indices,
		vertexCount: positions.length / 3,
		triangleCount: triangles.length,
	}
}

/** Normales de face affectées à chaque sommet (dernier écrivain gagne). */
function computeFlat(positions: number[], triangles: TriVertex[], indices: number[]): number[] {
	const out = new Array<number>(positions.length).fill(0)
	for (let fi = 0; fi < triangles.length; fi++) {
		const t = triangles[fi]!
		const n = faceNormal(t.a.position, t.b.position, t.c.position)
		const base = fi * 3
		for (let ci = 0; ci < 3; ci++) {
			const vi = indices[base + ci]!
			out[vi * 3] = n.x
			out[vi * 3 + 1] = n.y
			out[vi * 3 + 2] = n.z
		}
	}
	return out
}

/** Normales lissées par averaging de normales de face, avec filtre d'angle de fente. */
function computeSmooth(
	positions: number[],
	triangles: TriVertex[],
	indices: number[],
	opts: WeldOptions,
): number[] {
	const creaseAngle = opts.creasAngle != null ? (opts.creasAngle * Math.PI) / 180 : Math.PI / 4
	const cosCrease = Math.cos(creaseAngle)
	const vertexCount = positions.length / 3

	// acc[vi] = [rx, ry, rz (normale de ref), sx, sy, sz (somme accumulée)]
	const accum = new Array<[number, number, number, number, number, number] | null>(vertexCount)

	for (let fi = 0; fi < triangles.length; fi++) {
		const t = triangles[fi]!
		const n = faceNormal(t.a.position, t.b.position, t.c.position)
		const base = fi * 3
		for (let ci = 0; ci < 3; ci++) {
			const vi = indices[base + ci]!
			const acc = accum[vi]
			if (!acc) {
				accum[vi] = [n.x, n.y, n.z, n.x, n.y, n.z]
			} else if (acc[0] * n.x + acc[1] * n.y + acc[2] * n.z >= cosCrease) {
				acc[3] += n.x
				acc[4] += n.y
				acc[5] += n.z
			}
		}
	}

	const out = new Array<number>(positions.length).fill(0)
	for (let vi = 0; vi < vertexCount; vi++) {
		const acc = accum[vi]
		if (acc) {
			const sx = acc[3], sy = acc[4], sz = acc[5]
			const len = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1
			out[vi * 3] = sx / len
			out[vi * 3 + 1] = sy / len
			out[vi * 3 + 2] = sz / len
		}
	}
	return out
}
