import type { PriceListBlock, PriceListData } from './price-list.types'

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
 * Wholesale prices are whole hryvnias, so this is deliberately not `formatPrice` from
 * the order helpers (which hard-codes 2 decimals and appends ₴ to every cell).
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

/**
 * Column widths are percentages of the printable width, which differs a lot between
 * orientations (190mm portrait vs 267mm landscape). Landscape spends its extra room on
 * the name and colour columns — the two that wrap — instead of inflating the numeric
 * ones, which never need more than four digits.
 */
const COLUMN_WIDTHS = {
	portrait: ['11%', '32%', '16%', '7%', '11%', '11.5%', '11.5%'],
	landscape: ['9%', '34%', '19%', '6%', '10.5%', '10.75%', '10.75%']
} as const

function renderBlock(block: PriceListBlock): string {
	const rows = block.rows
		.map((row, index) => {
			const nameCell =
				index === 0
					? `<td class="name" rowspan="${block.rows.length}">${esc(block.product_name)}${
							block.is_continuation ? '<span class="cont"> (продовження)</span>' : ''
						}</td>`
					: ''

			return `<tr>
			<td class="sku">${esc(row.sku)}</td>
			${nameCell}
			<td>${esc(row.color)}</td>
			<td class="c">${row.stock}</td>
			<td class="r">${formatUah(row.price)}</td>
			<td class="r">${formatUah(row.price_tier1)}</td>
			<td class="r">${formatUah(row.price_tier2)}</td>
		</tr>`
		})
		.join('\n\t\t')

	return `<tbody class="grp">\n\t\t${rows}\n\t</tbody>`
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
		.meta { font-size: 8px; color: #666; }
		table { width: 100%; border-collapse: collapse; table-layout: fixed; }
		/* Repeats the column header on every printed page. */
		thead { display: table-header-group; }
		/* Keeps a merged-name block whole, so a rowspan never straddles a page break. */
		tbody.grp, tr { break-inside: avoid; page-break-inside: avoid; }
		th {
			border: 1px solid #999;
			background: #f0f0f0;
			padding: 4px 5px;
			font-size: 8px;
			text-align: left;
			text-transform: uppercase;
			letter-spacing: .4px;
		}
		td { border: 1px solid #999; padding: 3px 5px; vertical-align: top; word-break: break-word; }
		td.name { vertical-align: middle; font-weight: 600; }
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
	<table>
		<colgroup>
			${(data.landscape ? COLUMN_WIDTHS.landscape : COLUMN_WIDTHS.portrait)
				.map(width => `<col style="width:${width}" />`)
				.join('\n\t\t\t')}
		</colgroup>
		<thead>
			<tr>
				<th>SKU</th>
				<th>Назва</th>
				<th>Колір</th>
				<th>К-ть</th>
				<th>Ціна</th>
				<th>Ціна від 50кг</th>
				<th>Ціна від 100кг</th>
			</tr>
		</thead>
		${data.blocks.map(renderBlock).join('\n\t\t')}
	</table>
</body>
</html>`
}
