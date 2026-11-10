// material.ts — Dérive un matériau PBR (jsonifiable) depuis une couleur LDraw.
//
// Réutilisé à la fois par `listColors()` (catalogue de couleurs) et par
// `getGeometry()` (matériau associé à chaque mesh d'une géométrie). Centralise
// la logique « finish LDraw → metalness / roughness » qui sinon serait dupliquée.

/**
 * Sous-ensemble de `LDrawColor` (parser LDraw, type non-exporté) que l'on peut
 * consister sans importer le type du tiers. La couleur réelle du parser est
 * structurellement assignable vers cette interface.
 */
export interface LDrawColorLike {
	/** Code couleur LDraw. */
	code: number
	/** Nom humain de la couleur. */
	name: string
	/** RGBA chaque composante entre 0 et 1. */
	rgba: [number, number, number, number]
	/** Finition (NORMAL, METAL, CHROME, PEARLESCENT, RUBBER, MATTE_METALLIC…). */
	finish: string
	/** Luminance 0-255 (couleurs électroluminescentes). */
	luminance: number
	/** Indique si la couleur est transparente (alpha < 1). */
	isTransparent: boolean
	/** Hexadécimal « #rrggbb » le cas échéant. */
	hex?: string
}

export interface PartMaterial {
	/** Code couleur LDraw. */
	code: number
	/** Nom de la couleur. */
	name: string
	/** Hexadécimal de la couleur. */
	hex: string
	/** RGB chacune entre 0 et 1. */
	color: [number, number, number]
	/** Metallicité PBR (0-1). */
	metalness: number
	/** Rugosité PBR (0-1). */
	roughness: number
	/** La couleur est transparente. */
	transparent: boolean
	/** Opacité (alpha) entre 0 et 1. */
	opacity: number
	/** Côté de rendu : face visible (front), à l'inverse (back), ou les deux (double). */
	side: "front" | "back" | "double"
	/** Flat shading activé (bords tranchants, typique des briques LEGO). */
	flatShading: boolean
	/** RGB emissive chacune entre 0 et 1 (couleurs luticolores). */
	emissive?: [number, number, number]
	/** Intensité de l'emission (0-1). */
	emissiveIntensity?: number
}

export interface MaterialOptions {
	/** Côté de rendu (defaut : « double »). */
	side?: "front" | "back" | "double"
	/** Flat shading (defaut : « true »). */
	flatShading?: boolean
	/** Utilise la transmission ( verre ) plutôt que l'alpha mode pour les transparents. */
	transmission?: boolean
}

/**
 * Construit un matériau PBR jsonifiable depuis une couleur LDraw.
 *
 * @param color couleur LDraw (ou objet compatible {@link LDrawColorLike})
 * @param options réglages optionnels du matériau
 */
export function buildPartMaterial(color: LDrawColorLike, options: MaterialOptions = {}): PartMaterial {
	const [r, g, b, a] = color.rgba
	const side = options.side ?? "double"
	const flatShading = options.flatShading ?? true

	let metalness = 0
	let roughness = 0.8
	switch (color.finish) {
		case "CHROME": metalness = 1.0; roughness = 0.03; break
		case "METAL": metalness = 1.0; roughness = 0.25; break
		case "PEARLESCENT": metalness = 0.4; roughness = 0.30; break
		case "RUBBER": metalness = 0.0; roughness = 0.95; break
		case "MATTE_METALLIC": metalness = 0.8; roughness = 0.60; break
	}

	const material: PartMaterial = {
		code: color.code,
		name: color.name,
		hex: color.hex ?? "#000000",
		color: [r, g, b],
		metalness,
		roughness,
		transparent: color.isTransparent,
		opacity: a,
		side,
		flatShading,
	}

	if (color.luminance > 0) {
		const emissiveIntensity = color.luminance / 255
		material.emissive = [r * emissiveIntensity, g * emissiveIntensity, b * emissiveIntensity]
		material.emissiveIntensity = emissiveIntensity
	}

	return material
}

/** Matériau par défaut (blanc mate) utilisé quand une couleur manque au tableau. */
export function fallbackMaterial(code: number, options: MaterialOptions = {}): PartMaterial {
	return buildPartMaterial(
		{
			code,
			name: `#${code}`,
			rgba: [1, 1, 1, 1],
			finish: "NORMAL",
			luminance: 0,
			isTransparent: false,
			hex: "#ffffff",
		},
		options,
	)
}
