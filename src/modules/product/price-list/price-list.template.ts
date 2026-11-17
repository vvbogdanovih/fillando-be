import type { PriceListBlock, PriceListData, PriceListSection } from './price-list.types'

/**
 * Product names and colours are vendor-scraped and do contain `&`, `<` and quotes, so
 * every interpolated value goes through this. The invoice template gets away without it
 * because its data is admin-entered; this one cannot.
 */
function esc(value: string | number | null | undefined): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

/**
 * Prices are whole hryvnias, so this is deliberately not `formatPrice` from the order helpers
 * (which hard-codes 2 decimals and appends ₴ to every cell).
 */
function formatUah(value: number): string {
	return value.toLocaleString('uk-UA', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

function formatDateTime(date: Date): string {
	return date.toLocaleString('uk-UA', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	})
}

/** The longest word: a column narrower than it breaks the word in the middle. */
const longestWord = (text: string) => Math.max(0, ...text.split(/\s+/).map(word => word.length))

/**
 * Column widths, as percentages of the printable width (190mm portrait, 267mm landscape). SKU,
 * quantity and price are fixed — a code or four digits. The name and the category's columns share
 * the rest by what they hold: a column gets room for its longest text up to a cap, and never less
 * than its longest word (header included), so «Помаранчевий (Orange)» is not split mid-word while
 * «1.75 мм» stays narrow. Measured in characters; the font is the same everywhere.
 */
function columnWidths(section: PriceListSection): string[] {
	const fixed = { sku: 10, stock: 5, price: 7 }
	const rows = section.blocks.flatMap(block => block.rows)
	// A word needs its letters plus the cell's padding; a bold header letter is wider still.
	const weight = (texts: string[], label: string) =>
		Math.max(
			5,
			(longestWord(label) + 2) * 1.15,
			...texts.map(text => longestWord(text) + 2),
			Math.min(20, Math.max(0, ...texts.map(text => text.length)) * 0.6)
		)
	const flexible = [
		Math.max(
			14,
			Math.min(26, Math.max(0, ...section.blocks.map(block => block.product_name.length)) / 2)
		),
		...section.columns.map(column =>
			weight(
				rows.map(row => row.values[column.key] ?? ''),
				column.label
			)
		),
		...(section.variant_column
			? [
					weight(
						rows.map(row => row.variant_label),
						'Варіант'
					)
				]
			: [])
	]
	const rest = 100 - fixed.sku - fixed.stock - fixed.price
	const total = flexible.reduce((sum, value) => sum + value, 0)
	return [
		fixed.sku,
		...flexible.map(value => (rest * value) / total),
		fixed.stock,
		fixed.price
	].map(width => `${width.toFixed(2)}%`)
}

function renderBlock(section: PriceListSection, block: PriceListBlock): string {
	const span = block.rows.length
	const rows = block.rows
		.map((row, index) => {
			const first = index === 0
			// The product's name and product-level values are one merged cell; its axis — the one
			// value that differs between its SKUs — one cell per row.
			const columns = section.columns
				.map(column =>
					column.key === block.axis_key
						? `<td>${esc(row.values[column.key] ?? '—')}</td>`
						: first
							? `<td class="merged" rowspan="${span}">${esc(row.values[column.key] ?? '—')}</td>`
							: ''
				)
				.join('')
			const nameCell = first
				? `<td class="name" rowspan="${span}">${esc(block.product_name)}${
						block.is_continuation ? '<span class="cont"> (продовження)</span>' : ''
					}</td>`
				: ''

			return `<tr>
			<td class="sku">${esc(row.sku)}</td>
			${nameCell}${columns}${section.variant_column ? `<td>${esc(row.variant_label)}</td>` : ''}
			<td class="c">${row.stock}</td>
			<td class="r">${formatUah(row.price)}</td>
		</tr>`
		})
		.join('\n\t\t')

	return `<tbody class="grp">\n\t\t${rows}\n\t</tbody>`
}

/** One category: its heading and its own table — the header repeats on every page it spans. */
function renderSection(section: PriceListSection): string {
	return `<h2>${esc(section.category_name)}</h2>
	<table>
		<colgroup>
			${columnWidths(section)
				.map(width => `<col style="width:${width}" />`)
				.join('\n\t\t\t')}
		</colgroup>
		<thead>
			<tr>
				<th>SKU</th>
				<th>Назва</th>
				${section.columns.map(column => `<th>${esc(column.label)}</th>`).join('')}${
					section.variant_column ? '<th>Варіант</th>' : ''
				}
				<th>К-ть</th>
				<th>Ціна</th>
			</tr>
		</thead>
		${section.blocks.map(block => renderBlock(section, block)).join('\n\t\t')}
	</table>`
}

export function priceListTemplate(data: PriceListData): string {
	const filters = [
		data.categoryNames.length > 0
			? `категорії: ${data.categoryNames.map(esc).join(', ')}`
			: 'усі категорії',
		data.inStockOnly ? 'тільки в наявності' : 'усі позиції',
		`позицій: ${data.totalRows}`
	].join(' · ')

	const logo = data.logoDataUri
		? `<img class="logo" src="${data.logoDataUri}" alt="Fillando" />`
		: `<div class="wordmark">FILLANDO</div>`

	return `<!DOCTYPE html>
<html lang="uk">
<head>
	<meta charset="UTF-8" />
	<title>Fillando — Прайс-лист</title>
	<style>
		* { box-sizing: border-box; }
		body {
			margin: 0;
			/* With border-collapse the outer border is centred ON the table's edge, so half
			   of it falls outside. A table at exactly 100% of the printable width therefore
			   has its rightmost border land on the clip boundary and Chromium drops it —
			   the last column printed with no right edge. 1px of inset keeps it inside. */
			padding: 0 1px;
			/* The Alpine runtime image installs only ttf-freefont (see Dockerfile), so
			   FreeSans is the one font that resolves AND covers Cyrillic. Keep it first —
			   dropping it renders every Ukrainian label as tofu boxes in production. */
			font-family: 'FreeSans', 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif;
			font-size: 9px;
			color: #111;
		}
		.head { margin-bottom: 8px; }
		.logo { height: 26px; display: block; margin-bottom: 6px; }
		.wordmark { font-size: 18px; font-weight: 700; letter-spacing: 2px; margin-bottom: 6px; }
		h1 { font-size: 13px; margin: 0 0 3px; }
		h2 { font-size: 11px; margin: 10px 0 4px; break-after: avoid; page-break-after: avoid; }
		.meta { font-size: 8px; color: #666; }
		table { width: 100%; border-collapse: collapse; table-layout: fixed; }
		/* Repeats the column header on every printed page. */
		thead { display: table-header-group; }
		/* Keeps a merged-name block whole, so a rowspan never straddles a page break. */
		tbody.grp, tr { break-inside: avoid; page-break-inside: avoid; }
		/* Category labels are long («Котушка в комплекті»): plain case, wrapped between words. */
		th {
			border: 1px solid #999;
			background: #f0f0f0;
			padding: 4px 5px;
			font-size: 8px;
			font-weight: 600;
			text-align: left;
			vertical-align: bottom;
			overflow-wrap: anywhere;
		}
		td { border: 1px solid #999; padding: 3px 5px; vertical-align: top; word-break: break-word; }
		td.name { vertical-align: middle; font-weight: 600; }
		td.merged { vertical-align: middle; }
		td.sku, td.r { white-space: nowrap; font-variant-numeric: tabular-nums; }
		td.c { text-align: center; }
		td.r { text-align: right; }
		.cont { font-weight: 400; color: #777; font-size: 8px; }
	</style>
</head>
<body>
	<div class="head">
		${logo}
		<h1>Прайс-лист</h1>
		<div class="meta">Станом на ${formatDateTime(data.generatedAt)} · ${filters}</div>
	</div>
	${data.sections.map(renderSection).join('\n\t')}
</body>
</html>`
}
