import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
	attributeDefinitionSchema,
	AttributeContractError,
	AttributeDefinition,
	parseDefinitions
} from './attribute-definitions'

const identifier = z
	.string()
	.min(1)
	.max(100)
	.refine(value => value === value.trim())
export const definitionInputSchema = z.strictObject({
	...attributeDefinitionSchema.shape,
	key: identifier.optional(),
	label: z.string().trim().min(1).max(200),
	unit: z.string().trim().min(1).max(50).nullable(),
	order: z.number().int().nonnegative().safe(),
	options: z
		.array(
			z.strictObject({
				id: identifier.optional(),
				label: z.string().trim().min(1).max(200),
				order: z.number().int().nonnegative().safe()
			})
		)
		.max(200)
})
export const definitionsInputSchema = z.array(definitionInputSchema).max(100)
export type DefinitionInput = z.infer<typeof definitionInputSchema>
const stableId = (operation: string, path: string) =>
	createHash('sha256').update(`${operation}:${path}`).digest('hex').slice(0, 32)

/**
 * Resolve new identities once per command, not from labels, and never accept a foreign key.
 * Whether a change is allowed is decided separately against the exact per-key usage
 * (`checkDefinitionChange` in `category-definition-change.ts`).
 */
export function resolveDefinitions(
	before: AttributeDefinition[],
	input: DefinitionInput[],
	operation: string
) {
	const previous = new Map(before.map(item => [item.key, item]))
	const resolved = input.map((item, index) => {
		const old = item.key === undefined ? undefined : previous.get(item.key)
		if (item.key !== undefined && !old)
			throw new AttributeContractError('UNKNOWN_KEY', item.key)
		const options = item.options.map((option, optionIndex) => {
			if (option.id !== undefined && !old?.options.some(value => value.id === option.id))
				throw new AttributeContractError('UNKNOWN_KEY', option.id)
			return {
				...option,
				id: option.id ?? `o_${stableId(operation, `${index}:${optionIndex}`)}`
			}
		})
		return { ...item, key: item.key ?? `a_${stableId(operation, String(index))}`, options }
	})
	return parseDefinitions(resolved)
}

/** One projection powers the product-form and filter previews; no inference from labels. */
export function categoryControls(definitions: AttributeDefinition[]) {
	const sorted = [...definitions].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
	return {
		fields: sorted,
		filters: sorted.filter(item => item.filter_enabled),
		specs: sorted.filter(item => item.visible_in_specs),
		variant_axes: sorted.filter(item => !item.multiple).map(item => item.key)
	}
}
