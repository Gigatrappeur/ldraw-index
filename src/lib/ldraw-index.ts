import LDrawParser, { type LengthUnit } from "@gigatrappeur/ldraw-parser"

import { buildPartMetadata, type PartBoundingBox, type PartMetadata } from "./part";
import { DB, type PartVariant } from "./db";
import { buildPartMaterial } from "./material";
import { convertFlatGeometry, SCALE_FROM_LDU, transformAabb, type GeometryOptions, type GeometryLengthUnit, type PartGeometry } from "./geometry";

export type { PartMetadata, LengthUnit }

export interface LdrawIndexOptions {
	/**
	 * Dossier contenant les données d'indexation
	 */
	dataDir: string
}


export interface SearchParams {
	q?: string;
	color?: number;
	category?: string;
	limit?: number;
	offset?: number;
	excludeStickers?: boolean;
}

export interface SearchResult {
	items: Part[];
	total: number;
	limit: number;
	offset: number;
}


export interface Part {
	ldrawRef: string
	name: string
	category: string
	tag: string | null
	keywords: string[]
	variants?: PartVariant[]
}

export interface Color {
	code: number
	name: string
	color: string
	material: {
		name: string
		color: [number, number, number]
		metalness: number
		roughness: number
		transparent: boolean
		opacity: number
		depthWrite: boolean
		side: 0 | 2
		flatShading: boolean
		emissive?: [number, number, number]
		emissiveIntensity?: number
	}
}

/**
 * Référence LDraw et sa boîte englobante (unité de sortie), issue du listing
 * bulk — voir {@link LdrawIndex.getAllBoundingBoxes}.
 */
export interface PartBoundingBoxEntry {
	/** Reference LDraw de la pièce. */
	ldrawRef: string
	/** Boîte englobante axe-à-axe (min, max, size, center) dans l'unité de sortie. */
	boundingBox: PartBoundingBox
}

export default class LdrawIndex {
	private db: DB;
	private parser: LDrawParser;

	constructor(options: LdrawIndexOptions) {
		this.db = new DB(options.dataDir + '/ldraw-data.sqlite')
		this.parser = new LDrawParser({ libraryRoot: options.dataDir + '/ldraw' });
	}

	// Cache + génération (lecture + écriture)
	async search(params: SearchParams): Promise<SearchResult> {
		let items: Part[] = [];
		let total = 0;
		const limit = params.limit ?? 50;
		const offset = params.offset ?? 0;

		total = this.db.countDistinctFts(params.q || '', {
			category: params.category,
			color: params.color,
			excludeStickers: params.excludeStickers,
		});
		const results = this.db.searchDistinct(params.q || '', {
			category: params.category,
			color: params.color,
			excludeStickers: params.excludeStickers,
		}, limit, offset);
		items = results.map(r => ({
			ldrawRef: r.ldrawRef,
			name: r.name,
			category: r.category,
			tag: r.tag,
			variants: r.variants,
			keywords: r.keywords ? r.keywords.split(/[, ]/) : [],
		}));

		return {
			items,
			total,
			limit,
			offset,
		};
	}

	async get(ref: string): Promise<PartMetadata> {
		const part = this.db.getByLdrawRef(ref);
		if (!part) {
			throw new Error(`Part not found: ${ref}`);
		}
		return buildPartMetadata(this.db, part, this.parser.colorTable, this.parser);
	}


	async getByLegoRef(legoRef: string): Promise<{ ldrawRef: string, legoRef: string, color: number } | undefined> {
		return this.db.getByLegoRef(legoRef);
	}


	/**
	 * Récupère la géométrie triangulée d'une pièce, jsonifiable, groupée par
	 * couleur et munie de son matériau : chaque mesh se monte directement en un
	 * `THREE.BufferGeometry` + matériau côté front.
	 *
	 * Nécessite `data/ldraw/` (le parsing des `.dat`).
	 *
	 * @param ref reference LDraw de la pièce
	 * @param options unité de sortie, repère (Y-up par défaut), weld des
	 *   sommets (activé par défaut) et normales
	 */
	async getGeometry(ref: string, options: GeometryOptions = {}): Promise<PartGeometry> {
		const part = this.db.getByLdrawRef(ref);
		if (!part) {
			throw new Error(`Part not found: ${ref}`);
		}

		const parsed = await this.parser.parse(`${part.ldrawRef}.dat`);
		return convertFlatGeometry(part.ldrawRef, parsed.geometry, options);
	}


	/**
	 * Récupère la boîte englobante de toutes les pièces du catalogue.
	 *
	 * Le parser calcule l'AABB au parse d'un `.dat` (aucune méthode bulk), donc
	 * on parcourt les refs de la DB en séquentiel et on parse chacune. Les
	 * pièces sans fichier `.dat` (ou en échec de parsing) sont ignorées.
	 *
	 * La transformée (unité + repère) est partagée avec `getGeometry` via
	 * {@link transformAabb} : le `boundingBox` retourné y est identique.
	 *
	 * Nécessite `data/ldraw/` (le parsing des `.dat`).
	 *
	 * @param options.unit   unité de sortie des coordonnées (défaut : « studs »)
	 * @param options.yUp    repère Y-up (défaut : « true », pareil que getGeometry)
	 */
	async getAllBoundingBoxes(options: { unit?: GeometryLengthUnit; yUp?: boolean } = {}): Promise<PartBoundingBoxEntry[]> {
		const unit = options.unit ?? "studs";
		const yUp = options.yUp ?? true;
		const scale = SCALE_FROM_LDU[unit];

		const entries: PartBoundingBoxEntry[] = [];
		for (const ref of this.db.getAllLdrawRefs()) {
			try {
				const { geometry: { aabb } } = await this.parser.parse(`${ref}.dat`);
				entries.push({ ldrawRef: ref, boundingBox: transformAabb(aabb, scale, yUp) });
			} catch {
				// Pièce sans `.dat` (ou géométrie vide) : on l'ignore.
			}
		}
		return entries;
	}


	async listCategories(): Promise<string[]> {
		return this.db.getCategories();
	}

	async listColors(): Promise<Color[]> {
		const colors: Color[] = [];

		for (const [code, ldColor] of await this.parser.colorTable.getTable()) {
			const [r, g, b, a] = ldColor.rgba;

			// Métallicité / rugosité / emission sont dérivées de la finition LDraw.
			// On les centralise dans buildPartMaterial pour ne pas les dupliquer.
			const base = buildPartMaterial(ldColor, { side: "double", flatShading: true });

			const newColor: Color = {
				code,
				name: ldColor.name,
				color: `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Math.round(a * 100) / 100})`,
				material: {
					name: `LDRAW-${code} - ${ldColor.name}`,
					color: base.color,
					metalness: base.metalness,
					roughness: base.roughness,
					transparent: base.transparent,
					opacity: base.opacity,
					depthWrite: a >= 1,
					// alphaTest: 0.5
					side: a >= 1 ? 2 : 0, //THREE.DoubleSide = 2 sinon 0
					flatShading: base.flatShading,
				},
			}
			if (base.emissiveIntensity && base.emissive) {
				newColor.material.emissive = base.emissive
				newColor.material.emissiveIntensity = base.emissiveIntensity;
			}

			colors.push(newColor)

		}

		return colors;
	}

	async generate(ref: string, format: "glb", options?: { color?: number, weld?: false | { smoothNormals?: boolean }, transmission?: boolean, normals?: boolean, unit?: LengthUnit }): Promise<Uint8Array<ArrayBuffer>>
	async generate(ref: string, format: "svg" | "gltf", options?: { width?: number, azimuth?: number, elevation?: number, color?: number, weld?: false | { smoothNormals?: boolean }, transmission?: boolean, normals?: boolean }): Promise<string>
	async generate(ref: string, format: "svg" | "glb" | "gltf", options?: { width?: number, azimuth?: number, elevation?: number, color?: number, weld?: false | { smoothNormals?: boolean }; transmission?: boolean; normals?: boolean, unit?: LengthUnit }): Promise<Uint8Array | string> {
		
		const part = this.db.getByLdrawRef(ref);
		if (!part) {
			throw new Error(`Part not found: ${ref}`);
		}
		
		const result = await this.parser.parse(`${part.ldrawRef}.dat`, options?.color != undefined ? { defaultColor: options.color } : undefined);
		
		let content: Uint8Array | string;
		if (format == 'gltf') {
			content = JSON.stringify(await result.toGltf({
				transmission: options?.transmission ?? true,
				weld: options?.weld ?? { smoothNormals: true },
				normals: options?.normals ?? false
			}))
		} else if (format === "glb") {
			content = await result.toGlb({
				transmission: options?.transmission ?? true,
				weld: options?.weld ?? { smoothNormals: true },
				normals: options?.normals ?? false
			}, options?.unit || 'studs');
		} else {
			content = result.toSvg({
				width: options?.width ?? 512,
				azimuth: options?.azimuth ?? 30,
				elevation: options?.elevation ?? 15,
				showEdges: false
			});
		}

		return content;
	}


	close() {
		this.db.internalDb.close();
	}
}
