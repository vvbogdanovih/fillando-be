import { PriceListService } from './price-list.service'

it('renders current/size and dictionary display names under a generic variant heading', async () => {
	const raw = [
		{
			product_id: 'p1',
			product_name: 'AVR',
			variant_name: 'AVR — 63 А',
			v_value: '63 А',
			variant_type: { label: 'Струм' },
			sku: 'A',
			price: 2000
		},
		{
			product_id: 'p2',
			product_name: 'Ковдра',
			variant_name: 'Ковдра',
			v_value: '150 × 180 см',
			variant_type: { label: 'Розмір' },
			sku: 'B',
			price: 1000
		},
		{
			product_id: 'p3',
			product_name: 'PLA',
			variant_name: 'PLA — Чорний (Black)',
			v_value: 'Black',
			variant_type: { label: 'Колір' },
			sku: 'C',
			price: 500
		}
	]
	const generatePdf = jest
		.fn<Promise<Buffer>, [string, string, boolean]>()
		.mockResolvedValue(Buffer.from('pdf'))
	const fetch = jest
		.spyOn(globalThis, 'fetch')
		.mockResolvedValue(new Response(null, { status: 404 }))
	try {
		const service = new PriceListService(
			{ findPriceListRows: jest.fn().mockResolvedValue(raw) } as never,
			{ findAll: jest.fn().mockResolvedValue([]) } as never,
			{ generatePdf } as never
		)
		await service.generatePdf({})
		const html = generatePdf.mock.calls[0][0]
		// A v1 category has no characteristic columns: the variation keeps its own column.
		expect(html).toContain('<th>Варіант</th>')
		for (const value of ['63 А', '150 × 180 см', 'Чорний (Black)'])
			expect(html).toContain(`<td>${value}</td>`)
		expect(html).not.toContain('<th>Колір</th>')
	} finally {
		fetch.mockRestore()
	}
})

it('prints one table per category with the columns its catalogue filters by, no discounts', async () => {
	const definition = (key: string, label: string, extra: object = {}) => ({
		key,
		label,
		value_type: 'string',
		unit: null,
		is_required: true,
		filter_enabled: true,
		filter_type: 'multi-select',
		visible_in_specs: true,
		order: 0,
		multiple: false,
		semantic: 'generic',
		options: [],
		...extra
	})
	const filament = {
		_id: 'c1',
		name: 'Філамент',
		attribute_contract_version: 2,
		attribute_definitions: [
			definition('polymer', 'Тип пластику', { order: 0 }),
			definition('diametr', 'Діаметр', { order: 1, value_type: 'number', unit: 'мм' }),
			// Not a filter, not a colour: no column.
			definition('note', 'Примітка', { order: 2, filter_enabled: false, filter_type: null }),
			definition('color', 'Колір', {
				order: 3,
				is_required: false,
				filter_enabled: false,
				filter_type: null,
				semantic: 'color'
			})
		]
	}
	const row = (sku: string, colour: [string, string] | null, extra: object = {}) => ({
		product_id: 'p1',
		category_id: 'c1',
		product_name: 'Kingroon PLA',
		variant_name: colour ? `Kingroon PLA — ${colour[0]} (${colour[1]})` : 'Kingroon PLA',
		attributes_v2: [
			{ k: 'polymer', v: 'PLA' },
			{ k: 'diametr', v: 1.75 },
			{ k: 'note', v: 'x' }
		],
		variant_axis: { key: 'color' },
		variant_value: 'id',
		color_name_uk: colour?.[0] ?? null,
		color_name_en: colour?.[1] ?? null,
		sku,
		price: 500,
		stock: 2,
		...extra
	})
	const generatePdf = jest
		.fn<Promise<Buffer>, [string, string, boolean]>()
		.mockResolvedValue(Buffer.from('pdf'))
	const fetch = jest
		.spyOn(globalThis, 'fetch')
		.mockResolvedValue(new Response(null, { status: 404 }))
	try {
		const service = new PriceListService(
			{
				findPriceListRows: jest
					.fn()
					.mockResolvedValue([
						row('FL-1', ['Чорний', 'Black']),
						row('FL-2', ['Білий', 'White'])
					])
			} as never,
			{ findAll: jest.fn().mockResolvedValue([]) } as never,
			{ generatePdf } as never,
			{
				productCategories: jest.fn().mockResolvedValue([{ _id: 'c1', name: 'Філамент' }]),
				contentOf: jest.fn().mockResolvedValue(new Map([['c1', filament]]))
			} as never
		)
		await service.generatePdf({})
		const html = generatePdf.mock.calls[0][0]
		expect(html).toContain('<h2>Філамент</h2>')
		expect(html).toContain('<th>Тип пластику</th><th>Діаметр</th><th>Колір</th>')
		expect(html).not.toContain('<th>Примітка</th>')
		expect(html).not.toContain('<th>Варіант</th>')
		// Product-level values are merged across the product's SKUs, the colour is per SKU.
		expect(html).toContain('<td class="merged" rowspan="2">PLA</td>')
		expect(html).toContain('<td class="merged" rowspan="2">1.75 мм</td>')
		expect(html).toContain('<td>Чорний (Black)</td>')
		expect(html).toContain('<td>Білий (White)</td>')
		// A stock extract: the base price only (owner, 2026-11-06).
		expect(html).not.toMatch(/Ціна від|кг<\/th>/)
	} finally {
		fetch.mockRestore()
	}
})

it('orders a category by brand, then product; products without a brand last', async () => {
	const row = (product: string, name: string, brand: string | null) => ({
		product_id: product,
		category_id: 'c1',
		product_name: name,
		variant_name: name,
		attributes: brand ? [{ k: 'vyrobnyk', l: 'Виробник', v: brand }] : [],
		sku: `SKU-${product}`,
		price: 100
	})
	const generatePdf = jest
		.fn<Promise<Buffer>, [string, string, boolean]>()
		.mockResolvedValue(Buffer.from('pdf'))
	const fetch = jest
		.spyOn(globalThis, 'fetch')
		.mockResolvedValue(new Response(null, { status: 404 }))
	try {
		const service = new PriceListService(
			{
				findPriceListRows: jest
					.fn()
					.mockResolvedValue([
						row('p1', 'Aaa', null),
						row('p2', 'Zeta', 'Sunlu'),
						row('p3', 'Alpha', 'Kingroon')
					])
			} as never,
			{ findAll: jest.fn().mockResolvedValue([{ _id: 'c1', name: 'Легасі' }]) } as never,
			{ generatePdf } as never
		)
		await service.generatePdf({})
		const html = generatePdf.mock.calls[0][0]
		expect(html).toContain('<h2>Легасі</h2>')
		const at = (sku: string) => html.indexOf(sku)
		expect(at('SKU-p3')).toBeLessThan(at('SKU-p2'))
		expect(at('SKU-p2')).toBeLessThan(at('SKU-p1'))
	} finally {
		fetch.mockRestore()
	}
})
