// geometry.ts — Monte une géométrie brick-index (JSON de `get:geometry`) sur
// des objects Three.js : BufferGeometry par mesh, puis un THREE.Group (optionnel
// avec les arêtes) assemblant le modèle complet.
//
// Ce module est le lien « présentation » : il ne connaît ni la DB ni le parser,
// il consiste uniquement la sortie jsonifiée de `brick-index get:geometry`.
// L'unité des positions est celle demandée à `get:geometry` (defaut : studs),
// le repère est Y-up (defaut) par compatibilité avec Three.js.

import * as THREE from "three"

import type { PartGeometry, PartGeometryMesh, PartGeometryEdges } from "@gigatrappeur/ldraw-index"
import { materialToThree, type MaterialToThreeOptions } from "./material"

/** Options du montage complet du modèle. */
export interface BuildModelOptions {
	/** Réglages transmis à la conversion des matériaux ({@link materialToThree}). */
	material?: MaterialToThreeOptions
	/** Ne pas créer de matériaux Three.js : meshes avec blanc par défaut. */
	skipMaterials?: boolean
	/** Créer (et attacher) les lignes d'arêtes en plus des meshes. Defaut : `true`. */
	includeEdges?: boolean
}

/** Construit un {@link THREE.BufferGeometry} depuis un mesh brick-index. */
export function geometryToBufferGeometry(mesh: PartGeometryMesh): THREE.BufferGeometry {
	const geometry = new THREE.BufferGeometry()

	geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3))

	// Les normales sont optionnelles (`normals: false` dans get:geometry).
	if (mesh.normals) {
		geometry.setAttribute("normal", new THREE.Float32BufferAttribute(mesh.normals, 3))
	}

	// Les UVs sont optionnels (pièces sans texture).
	if (mesh.uvs) {
		geometry.setAttribute("uv", new THREE.Float32BufferAttribute(mesh.uvs, 2))
	}

	geometry.setIndex(mesh.indices)

	return geometry
}

/** Construit un {@link THREE.LineSegments} depuis un jeu d'arêtes brick-index. */
export function edgesToLineSegments(edges: PartGeometryEdges): THREE.LineSegments {
	const geometry = new THREE.BufferGeometry()
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(edges.lines, 3))

	const lineMaterial = new THREE.LineBasicMaterial({
		color: edges.material.hex,
		transparent: edges.material.transparent,
		opacity: edges.material.opacity,
	})

	return new THREE.LineSegments(geometry, lineMaterial)
}

/**
 * Construit un `THREE.Group` contenant un mesh par couleur et, le cas échéant,
 * une ligne d'arêtes par couleur, à partir de la géométrie jsonifiée d'une
 * pièce.
 *
 * @param geometry géométrie jsonifiée issue de `get:geometry`
 * @param options options de montage (matériaux, arêtes)
 */
export function buildPartModel(geometry: PartGeometry, options: BuildModelOptions = {}): THREE.Group {
	const { material: materialOptions, skipMaterials = false, includeEdges = true } = options
	const group = new THREE.Group()
	group.name = geometry.ldrawRef

	for (const mesh of geometry.meshes) {
		const bufferGeometry = geometryToBufferGeometry(mesh)

		let material: THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial
		if (skipMaterials) {
			material = new THREE.MeshStandardMaterial({ color: mesh.material.hex })
		} else {
			material = materialToThree(mesh.material, materialOptions)
		}

		const meshObject = new THREE.Mesh(bufferGeometry, material)
		meshObject.name = `part-${mesh.colorCode}`
		group.add(meshObject)
	}

	if (includeEdges) {
		for (const edge of geometry.edges) {
			group.add(edgesToLineSegments(edge))
		}
	}

	return group
}
