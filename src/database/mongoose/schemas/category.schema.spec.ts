import mongoose from 'mongoose'
import { CategorySchema } from './category.schema'

const model = mongoose.model('CategoryRequirednessTest', CategorySchema)
const attribute = { key: 'finish', label: 'Ефект', filter_type: 'multi-select', unit: null }
it('does not synthesize a flag on a historical document and refuses saving it', async () => {
	const document = model.hydrate({
		name: 'Філамент',
		slug: 'filament',
		required_attributes: [attribute]
	})
	expect(document.required_attributes[0].is_required).toBeUndefined()
	await expect(document.validate()).rejects.toThrow('is_required')
})
it.each([true, false])('accepts explicitly stored %p', async flag => {
	const document = new model({
		name: 'Філамент',
		slug: 'filament',
		required_attributes: [{ ...attribute, is_required: flag }]
	})
	await expect(document.validate()).resolves.toBeUndefined()
	expect(document.toObject().required_attributes[0].is_required).toBe(flag)
})
