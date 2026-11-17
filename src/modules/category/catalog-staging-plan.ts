import { mongo } from 'mongoose'
import { AttributeDefinition, parseDefinitions, validateAttributes } from './attribute-definitions'
import { CatalogPatch } from 'src/database/mongoose/repositories/catalog-mutation-journal'

interface LegacyAttribute {
	k: string
	l: string
	v: string | number | boolean
}
interface LegacyDefinition {
	key: string
	label: string
	is_required: boolean
	unit?: string | null
	filter_type: 'multi-select' | 'range'
}
export interface StagingCategory extends mongo.Document {
	_id: mongo.ObjectId
	required_attributes: LegacyDefinition[]
}
export interface StagingProduct extends mongo.Document {
	_id: mongo.ObjectId
	category_id: mongo.ObjectId
	attributes: LegacyAttribute[]
}

/** Additive preparation only: retain v1, legacy values, URLs and variant identity unchanged. */
export function buildCatalogStagingPlan(
	categories: StagingCategory[],
	products: StagingProduct[]
): CatalogPatch[] {
	const patches: CatalogPatch[] = []
	const categoryIds = new Set(categories.map(category => category._id.toHexString()))
	for (const product of products) {
		if (!categoryIds.has(String(product.category_id))) throw new Error('STAGING_ORPHAN_PRODUCT')
	}
	function patch(
		collection: CatalogPatch['collection'],
		row: mongo.Document,
		desired: mongo.Document
	) {
		const fields: CatalogPatch['fields'] = {}
		for (const [key, value] of Object.entries(desired)) {
			// An existing staged field is not overwritten by rerunning the bootstrap.
			if (Object.hasOwn(row, key))
				throw new Error(`STAGING_ALREADY_PRESENT:${collection}:${key}`)
			fields[key] = { before: { exists: false }, after: { exists: true, value } }
		}
		patches.push({ collection, id: String(row._id), fields })
	}
	for (const category of categories) {
		if (!Array.isArray(category.required_attributes))
			throw new Error('STAGING_MISSING_DEFINITIONS')
		const members = products.filter(
			product => String(product.category_id) === String(category._id)
		)
		const definitions = new Map<string, AttributeDefinition>()
		for (const legacy of category.required_attributes) {
			if (definitions.has(legacy.key) || typeof legacy.is_required !== 'boolean')
				throw new Error('STAGING_INVALID_DEFINITION')
			definitions.set(legacy.key, {
				key: legacy.key,
				label: legacy.label,
				value_type: 'string',
				unit: legacy.unit ?? null,
				is_required: legacy.is_required,
				filter_enabled: true,
				filter_type: legacy.filter_type,
				visible_in_specs: true,
				order: definitions.size,
				multiple: false,
				semantic: 'generic',
				options: []
			})
		}
		const types = new Map<string, Set<string>>()
		const labels = new Map<string, Set<string>>()
		for (const product of members) {
			if (!Array.isArray(product.attributes)) throw new Error('STAGING_INVALID_ATTRIBUTES')
			const seen = new Set<string>()
			for (const attribute of product.attributes) {
				if (
					!attribute ||
					typeof attribute.k !== 'string' ||
					!attribute.k ||
					typeof attribute.l !== 'string' ||
					!attribute.l.trim()
				)
					throw new Error('STAGING_INVALID_ATTRIBUTE')
				const type = typeof attribute.v
				if (!['string', 'number', 'boolean'].includes(type))
					throw new Error('STAGING_UNSUPPORTED_VALUE')
				if (!definitions.has(attribute.k))
					definitions.set(attribute.k, {
						key: attribute.k,
						label: attribute.l,
						value_type: 'string',
						unit: null,
						is_required: false,
						filter_enabled: false,
						filter_type: null,
						visible_in_specs: true,
						order: definitions.size,
						multiple: false,
						semantic: 'generic',
						options: []
					})
				const definition = definitions.get(attribute.k)!
				if (seen.has(attribute.k)) definition.multiple = true
				seen.add(attribute.k)
				const keyTypes = types.get(attribute.k) ?? new Set<string>()
				keyTypes.add(type)
				types.set(attribute.k, keyTypes)
				const keyLabels = labels.get(attribute.k) ?? new Set<string>()
				keyLabels.add(attribute.l)
				labels.set(attribute.k, keyLabels)
			}
		}
		for (const definition of definitions.values()) {
			const observed = types.get(definition.key)
			if (observed && observed.size !== 1)
				throw new Error(`STAGING_MIXED_TYPES:${definition.key}`)
			if ((labels.get(definition.key)?.size ?? 0) > 1)
				throw new Error(`STAGING_LABEL_CONFLICT:${definition.key}`)
			if (observed)
				definition.value_type = [...observed][0] as AttributeDefinition['value_type']
			// Do not guess the type of an unused legacy range or coerce numeric strings.
			if (definition.filter_type === 'range' && definition.value_type !== 'number')
				throw new Error(`STAGING_RANGE_MAPPING_REQUIRED:${definition.key}`)
		}
		const checked = parseDefinitions([...definitions.values()])
		patch('categories', category, {
			parent_id: null,
			kind: 'product',
			attribute_contract_version: 1,
			attribute_definitions: checked
		})
		for (const product of members) {
			const attributes = validateAttributes(
				checked,
				product.attributes.map(({ k, v }) => ({ k, v }))
			)
			patch('products', product, { attributes_v2: attributes })
		}
	}
	return patches
}
