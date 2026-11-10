// material.ts — Convertit un matériau PBR jsonifiable (PartMaterial) en un
// matériau Three.js réel (MeshStandardMaterial / MeshPhysicalMaterial).
//
// Ce module est le lien « présentation » : il ne connaît pas la provenance de la
// géométrie ni la DB, il prend uniquement la sortie jsonifiée de
// `brick-index get:geometry`.

import * as THREE from "three"

import type { PartMaterial } from "@gigatrappeur/brick-index"

/** Réglages optionnels de conversion d'un matériau brick-index vers Three.js. */
export interface MaterialToThreeOptions {
	/**
	 * Rendu « verre » par transmission (MeshPhysicalMaterial) pour les
	 * couleurs transparentes (defaut : alpha/opacity classique).
	 */
	transmission?: boolean
	/**
	 * Profondeur de transmission (matériau verre), en unités Three.js.
	 * Ignorée si `transmission` est à `false`.
	 */
	thickness?: number
	/** indice de réfraction (corps de verre), défaut 1.4. */
	ior?: number
}

/** Map des côtés de rendu Three.js (constantes numériques réelles). */
const SIDE_TO_THREE = {
	front: THREE.FrontSide,
	back: THREE.BackSide,
	double: THREE.DoubleSide,
} as const

/**
 * Construit un matériau Three.js depuis un {@link PartMaterial}.
 *
 * Le flat shading est délégué au matériau Three.js (`flatShading`) : `true`
 * (defaut) recalcule les normales de face → rendu plat typique des briques
 * LEGO ; `false` combine avec des normales lissées fournies par la géométrie.
 *
 * @param material matériau jsonifié issue de `get:geometry`
 * @param options réglages optionnels (verre, épaisseur…)
 */
export function materialToThree(
	material: PartMaterial,
	options: MaterialToThreeOptions = {},
): THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial {
	const { transmission = false, thickness = 1, ior = 1.4 } = options
	const { color, metalness, roughness, transparent, opacity, side, flatShading, emissive, emissiveIntensity } = material

	const colorVec = new THREE.Color(color[0]!, color[1]!, color[2]!)
	const emissiveVec = emissive
		? new THREE.Color(emissive[0]!, emissive[1]!, emissive[2]!)
		: new THREE.Color(0, 0, 0)

	const base = {
		color: colorVec,
		metalness,
		roughness,
		emissive: emissiveVec,
		emissiveIntensity: emissiveIntensity ?? 0,
		transparent,
		opacity,
		side: SIDE_TO_THREE[side] ?? THREE.DoubleSide,
		flatShading,
	}

	if (transparent && transmission) {
		return new THREE.MeshPhysicalMaterial({
			...base,
			transmission: 1,
			thickness,
			ior,
		})
	}

	return new THREE.MeshStandardMaterial(base)
}
