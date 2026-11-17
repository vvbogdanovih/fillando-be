import { pickColor } from './product-attribute.helpers'
it('never exports generic variant values as color', () => {
	expect(pickColor('150 × 180 см', [], { key: 'size', label: 'Розмір' })).toBeNull()
	expect(pickColor('63 А', [], { key: 'rated_current', label: 'Струм' })).toBeNull()
	expect(pickColor('1 кг', [])).toBeNull()
})
it('keeps color-axis and explicit color attribute semantics', () => {
	expect(pickColor('Black', [], { key: 'kolir', label: 'Колір' })).toBe('Black')
	expect(pickColor('XL', [{ l: 'Колір', v: 'Сірий' }], { key: 'size', label: 'Розмір' })).toBe(
		'Сірий'
	)
})
