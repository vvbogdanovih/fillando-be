import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { CreateCategoryDto } from './create-category.dto'
import { UpdateCategoryDto } from './update-category.dto'

describe.each([CreateCategoryDto, UpdateCategoryDto])('%s attribute contract', Dto => {
	const payload = (flag: unknown) =>
		plainToInstance(Dto, {
			name: 'Філамент',
			slug: 'filament',
			required_attributes: [
				{ label: 'Армування', filter_type: 'multi-select', unit: null, is_required: flag }
			]
		})
	it.each([true, false])('accepts an explicit boolean %p', async flag => {
		expect(await validate(payload(flag))).toEqual([])
	})
	it.each([undefined, null, 'false', 'true', 0, 1])(
		'rejects %p even with skipMissingProperties',
		async flag => {
			expect(await validate(payload(flag), { skipMissingProperties: true })).not.toHaveLength(
				0
			)
		}
	)
})
