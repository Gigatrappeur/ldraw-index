import { DB, type PartRow } from "./db";

export interface ColorTableLike {
	get(code: number): Promise<{ name: string; rgba: [number, number, number, number] }>;
}

/**
 * Bounding box (boîte englobante axe-à-axe) d'une pièce, en units LDraw.
 * Les tableaux sont des vecteurs [x, y, z].
 */
export interface PartBoundingBox {
	/** Coin de coordonnées minimales. */
	min: [number, number, number];
	/** Coin de coordonnées maximales. */
	max: [number, number, number];
	/** Dimensions de la boîte (max − min), i.e. longueur × largeur × hauteur. */
	size: [number, number, number];
	/** Centre de la boîte. */
	center: [number, number, number];
}

/**
 * Interface minimale pour extraire le bounding box depuis le parser LDraw.
 * On ne dépend que de la géométrie plate (`geometry.aabb`), pas du reste
 * de `LDrawPart`, pour rester découplé et testable hors-connexion.
 */
export interface BoundingBoxParser {
	parse(
		name: string,
		ctxOverride?: { defaultColor?: number },
	): Promise<{
		geometry: {
			aabb: {
				min: { x: number; y: number; z: number };
				max: { x: number; y: number; z: number };
				size: { x: number; y: number; z: number };
				center: { x: number; y: number; z: number };
			};
		};
	}>;
}

export interface PartMetadata {
	ldrawRef: string;
	name: string | null;
	category: string | null;
	colorCount: number;
	elementCount: number;
	keywords: string[];
	variants: Array<{ color: number; colorName: string; colorRgba: string; legoRefs: string[]; isTransparent: boolean }>;
	/** Boîte englobante axe-à-axe de la pièce (units LDraw), ou null si le .dat est absent. */
	boundingBox: PartBoundingBox | null;
}

export async function buildPartMetadata(
	db: DB,
	part: PartRow,
	colorTable: ColorTableLike,
	parser?: BoundingBoxParser,
): Promise<PartMetadata> {
	const elements = db.getElementVariants(part.ldrawRef);
	const uniqueColors = [...new Set(elements.map(e => e.color).filter((c): c is number => c !== null))];

	const byColor = new Map<number, string[]>();
	for (const e of elements) {
		if (e.color !== null && e.color !== undefined) {
			if (!byColor.has(e.color)) byColor.set(e.color, []);
			if (e.legoRef) byColor.get(e.color)!.push(e.legoRef);
		}
	}

	const variants: PartMetadata["variants"] = [];
	for (const [color, legoRefs] of byColor) {
		let variantColor = { name: 'Inconnu', rgba: '1,1,1,1' };
		try {
			const ldColor = await colorTable.get(color);
			variantColor = {
				name: ldColor.name,
				rgba: ldColor.rgba.map((v: number) => String(v)).join(','),
			};
		} catch {
			// color not found, use defaults
		}
		const isTransparent = parseFloat(variantColor.rgba.split(',')[3] ?? '1') < 1;
		variants.push({ color, colorName: variantColor.name, colorRgba: variantColor.rgba, legoRefs, isTransparent });
	}

	// La boîte englobante ne dépend que de la géométrie (la couleur n'a pas
	// d'influence), on la dérive du parser LDraw si disponible. Échoue silencieusement → null.
	let boundingBox: PartBoundingBox | null = null;
	if (parser) {
		try {
			const { geometry: { aabb } } = await parser.parse(`${part.ldrawRef}.dat`);
			boundingBox = {
				min: [aabb.min.x, aabb.min.y, aabb.min.z],
				max: [aabb.max.x, aabb.max.y, aabb.max.z],
				size: [aabb.size.x, aabb.size.y, aabb.size.z],
				center: [aabb.center.x, aabb.center.y, aabb.center.z],
			};
		} catch {
			boundingBox = null;
		}
	}

	return {
		ldrawRef: part.ldrawRef,
		name: part.name,
		category: part.category,
		colorCount: uniqueColors.length,
		elementCount: elements.length,
		keywords: (part.keywords || '').split(' ').filter(Boolean),
		variants,
		boundingBox,
	};
}

export function displayPartMetadata(metadata: PartMetadata): void {
	console.log(`Nom: ${metadata.name}`);
	console.log(`LDraw: ${metadata.ldrawRef}`);
	console.log(`Catégorie: ${metadata.category ?? 'N/A'}`);
	console.log(`Mots-clés: ${metadata.keywords.join(", ")}`);
	console.log();
	console.log(`Couleurs: ${metadata.colorCount}`);
	console.log(`Elements: ${metadata.elementCount}`);
	console.log();

	if (metadata.boundingBox) {
		const { min, max, size, center } = metadata.boundingBox;
		console.log(`Bounding box (units LDraw):`);
		console.log(`  min : (${min[0]}, ${min[1]}, ${min[2]})`);
		console.log(`  max : (${max[0]}, ${max[1]}, ${max[2]})`);
		console.log(`  taille (L×l×H) : ${size[0]} × ${size[1]} × ${size[2]}`);
		console.log(`  centre : (${center[0]}, ${center[1]}, ${center[2]})`);
		console.log();
	}

	if (metadata.variants.length > 0) {
		console.log("Variantes:");
		for (const v of metadata.variants) {
			console.log(`  ${v.color} (${v.colorName}): ${v.legoRefs.join(", ")}`);
		}
	}
}
