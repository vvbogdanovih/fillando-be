import { z } from 'zod'
import { AttributeDefinition, parseDefinitions } from './attribute-definitions'

const objectId = z.string().regex(/^[a-f0-9]{24}$/i)
const topology = z.object({
	parent_id: objectId.nullable().default(null),
	kind: z.enum(['group', 'product']).default('product'),
	status: z.enum(['draft', 'active', 'archived']).default('active'),
	attribute_contract_version: z.union([z.literal(1), z.literal(2)]).default(1)
})

export interface CategoryConfiguration {
	parent_id: string | null
	kind: 'group' | 'product'
	status: 'draft' | 'active' | 'archived'
	attribute_contract_version: 1 | 2
	attribute_definitions: AttributeDefinition[] | null
}

export class CategoryConfigurationError extends Error {
	constructor(
		readonly code: 'INVALID_CONFIGURATION' | 'MISSING_DEFINITIONS' | 'GROUP_ATTRIBUTES'
	) {
		super(code)
		this.name = 'CategoryConfigurationError'
	}
}

/**
 * Read adapter for serialized DB snapshots (ObjectIds must already be strings).
 * Does not persist defaults, infer typed definitions or activate the v2 contract.
 * Legacy attributes remain the caller's existing required_attributes projection.
 */
export function readCategoryConfiguration(input: unknown): CategoryConfiguration {
	const parsed = topology.safeParse(input)
	if (!parsed.success) throw new CategoryConfigurationError('INVALID_CONFIGURATION')
	const record = input as Record<string, unknown>
	const config = parsed.data
	if (config.attribute_contract_version === 1) {
		// Backfilled v1 nodes are always leaves: creating groups requires v2 writers.
		if (config.kind !== 'product' || config.parent_id !== null) {
			throw new CategoryConfigurationError('INVALID_CONFIGURATION')
		}
		return { ...config, attribute_definitions: null }
	}
	if (record.attribute_definitions === undefined) {
		throw new CategoryConfigurationError('MISSING_DEFINITIONS')
	}
	const definitions = parseDefinitions(record.attribute_definitions)
	if (config.kind === 'group' && definitions.length) {
		throw new CategoryConfigurationError('GROUP_ATTRIBUTES')
	}
	return { ...config, attribute_definitions: definitions }
}
