import { SUPPORT } from 'src/common/constants/contacts.constant'
import { DeliveryMethod, PaymentMethod } from 'src/common/types/enums'
import { formatOrderStatus, formatPaymentStatus } from 'src/common/utils'
import type { BreakdownRow, DayRow, SalesReportData } from './report.builder'
import { STORE_TIME_ZONE } from './report.period'

/**
 * Short method labels. The invoice spells out «IBAN (банківський переказ)» because it has a whole
 * line for it; here the same string wraps to three lines and triples the height of every row in a
 * thirty-order register.
 */
const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
	[PaymentMethod.CASH]: 'Готівка',
	[PaymentMethod.IBAN]: 'IBAN',
	[PaymentMethod.LIQPAY]: 'LiqPay',
	[PaymentMethod.MONOPAY]: 'MonoPay',
	[PaymentMethod.COD]: 'Накл. платіж'
}

const DELIVERY_METHOD_LABELS: Record<DeliveryMethod, string> = {
	[DeliveryMethod.NOVA_POST]: 'Нова Пошта',
	[DeliveryMethod.COURIER]: "Кур'єр",
	[DeliveryMethod.PICKUP]: 'Самовивіз'
}

/** Days are laid out across this many side-by-side tables rather than one long column. */
const DAY_COLUMNS = 3

const dateTimeFormat = new Intl.DateTimeFormat('uk-UA', {
	timeZone: STORE_TIME_ZONE,
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit'
})

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

/** Money without a currency mark — the column header carries the ₴. */
function amount(value: number): string {
	return value.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function money(value: number): string {
	return `${amount(value)} ₴`
}

function dateTime(value: Date): string {
	return dateTimeFormat.format(new Date(value))
}

/** `YYYY-MM-DD` as the day Ukrainian paperwork writes. */
function day(value: string): string {
	const [year, month, dayOfMonth] = value.split('-')
	return `${dayOfMonth}.${month}.${year}`
}

function breakdownTable<Key extends string>(
	title: string,
	rows: BreakdownRow<Key>[],
	label: (key: Key) => string
): string {
	if (rows.length === 0) return ''

	return `
	<div class="panel">
		<p class="panel-title">${escapeHtml(title)}</p>
		<table class="grid compact">
			<thead>
				<tr>
					<th style="width:34%"></th>
					<th class="num" style="width:18%">Замов.</th>
					<th class="num" style="width:28%">Сума, ₴</th>
					<th class="num" style="width:20%">Частка</th>
				</tr>
			</thead>
			<tbody>
				${rows
					.map(
						row => `<tr>
					<td>${escapeHtml(label(row.key))}</td>
					<td class="num">${row.orders}</td>
					<td class="num">${amount(row.amount)}</td>
					<td class="num">${amount(row.share)}%</td>
				</tr>`
					)
					.join('\n\t\t\t\t')}
			</tbody>
		</table>
	</div>`
}

function daysChunk(rows: DayRow[]): string {
	return `
		<table class="grid compact days-table">
			<thead>
				<tr>
					<th style="width:30%">Дата</th>
					<th class="num" style="width:21%">Замовлень</th>
					<th class="num" style="width:19%">Одиниць</th>
					<th class="num" style="width:30%">До сплати, ₴</th>
				</tr>
			</thead>
			<tbody>
				${rows
					.map(
						row => `<tr>
					<td>${day(row.day)}</td>
					<td class="num">${row.orders}</td>
					<td class="num">${row.units}</td>
					<td class="num">${amount(row.amount)}</td>
				</tr>`
					)
					.join('\n\t\t\t\t')}
			</tbody>
		</table>`
}

function daysTables(rows: DayRow[]): string {
	const perColumn = Math.ceil(rows.length / DAY_COLUMNS)
	const chunks: DayRow[][] = []

	for (let start = 0; start < rows.length; start += perColumn) {
		chunks.push(rows.slice(start, start + perColumn))
	}

	return `
	<div class="days">
		<p class="panel-title">Продажі за днями</p>
		<div class="day-columns">
			${chunks.map(daysChunk).join('\n\t\t\t')}
		</div>
	</div>`
}

function filtersLine(data: SalesReportData): string {
	const { orderStatus, paymentStatus } = data.filters

	const parts = [
		`Статус замовлення: ${orderStatus ? formatOrderStatus(orderStatus) : 'усі'}`,
		`Статус оплати: ${paymentStatus ? formatPaymentStatus(paymentStatus) : 'усі'}`
	]

	return parts.join(' &nbsp;·&nbsp; ')
}

/** «01.09.2026 — 30.09.2026», for the title, the running footer and the section headings. */
export function salesReportPeriodLabel(filters: SalesReportData['filters']): string {
	return `${day(filters.dateFrom)} — ${day(filters.dateTo)}`
}

/**
 * The finance report: what was sold, when, and for how much.
 *
 * Three sections, in the order the finance department reads them — the goods sold over the
 * period, the orders they came from, and the reconciliation figures. It is deliberately not a
 * stack of per-order invoices: those answer «what does this one buyer owe», not «what did the
 * period bring in». A single order's invoice stays available from its own card in the admin.
 */
export function salesReportTemplate(data: SalesReportData): string {
	const { totals, filters } = data

	const periodLine = salesReportPeriodLabel(filters)

	const productRows = data.products
		.map(
			(product, index) => `<tr>
					<td class="num muted">${index + 1}</td>
					<td class="mono">${escapeHtml(product.sku)}</td>
					<td class="mono">${escapeHtml(product.vendorSku ?? '—')}</td>
					<td>${escapeHtml(product.name)}</td>
					<td class="num">${product.orders}</td>
					<td class="num">${product.quantity}</td>
					<td class="num muted">${amount(product.grossAmount)}</td>
					<td class="num">${product.discount === 0 ? '—' : `-${amount(product.discount)}`}</td>
					<td class="num">${amount(product.averagePrice)}</td>
					<td class="num strong">${amount(product.amount)}</td>
				</tr>`
		)
		.join('\n\t\t\t\t')

	const orderRows = data.orders
		.map(
			(order, index) => `<tr>
					<td class="num muted">${index + 1}</td>
					<td class="mono">${escapeHtml(order.orderNumber)}</td>
					<td class="nowrap">${dateTime(order.createdAt)}</td>
					<td>${escapeHtml(order.customer)}</td>
					<td class="num">${order.positions} / ${order.units}</td>
					<td>${escapeHtml(formatOrderStatus(order.orderStatus))}</td>
					<td class="nowrap">${escapeHtml(PAYMENT_METHOD_LABELS[order.paymentMethod])}</td>
					<td class="nowrap">${escapeHtml(formatPaymentStatus(order.paymentStatus))}</td>
					<td class="nowrap">${escapeHtml(DELIVERY_METHOD_LABELS[order.deliveryMethod])}</td>
					<td class="num">${amount(order.subtotal)}</td>
					<td class="num">${order.discount === 0 ? '—' : `-${amount(order.discount)}${order.discountCode ? `<br /><span class="muted tiny">${escapeHtml(order.discountCode)}</span>` : ''}`}</td>
					<td class="num strong">${amount(order.total)}</td>
				</tr>`
		)
		.join('\n\t\t\t\t')

	const nonRevenueNote =
		data.nonRevenue.orders === 0
			? ''
			: `<p class="note warn">У вибірку потрапили скасовані, повернені або відшкодовані замовлення: ${data.nonRevenue.orders} шт. на ${money(data.nonRevenue.amount)}. Вони враховані в підсумках вище — відніміть їх, якщо звіт іде у виручку.</p>`

	const mismatchNote =
		data.subtotalMismatch === null
			? ''
			: `<p class="note warn">Сума позицій у розділі «Продані товари» розходиться з підсумками замовлень на ${money(data.subtotalMismatch)}. Розбіжність означає правку замовлення в обхід перерахунку — перевірте перед здачею звіту.</p>`

	return `<!DOCTYPE html>
<html lang="uk">
<head>
	<meta charset="UTF-8" />
	<title>Звіт про продажі ${periodLine}</title>
	<style>
		* { box-sizing: border-box; }
		body {
			margin: 0;
			font-family: "Courier New", Courier, monospace;
			font-size: 11px;
			line-height: 1.45;
			color: #111;
		}
		.section { page-break-after: always; }
		.section:last-child { page-break-after: auto; }
		.brand {
			display: flex;
			align-items: flex-end;
			justify-content: space-between;
			border-bottom: 2px dashed #999;
			padding-bottom: 10px;
			margin-bottom: 14px;
		}
		.brand h1 { font-size: 22px; letter-spacing: 4px; margin: 0; }
		.brand .contacts { font-size: 10px; color: #555; }
		.doc-title {
			font-size: 15px;
			font-weight: bold;
			text-transform: uppercase;
			letter-spacing: 3px;
			margin: 0 0 2px;
		}
		.meta { font-size: 10px; color: #555; }
		.section-title {
			font-size: 12px;
			font-weight: bold;
			text-transform: uppercase;
			letter-spacing: 2px;
			color: #555;
			margin: 0 0 8px;
		}
		table.grid { width: 100%; border-collapse: collapse; }
		table.grid th, table.grid td {
			border: 1px solid #999;
			padding: 4px 6px;
			vertical-align: top;
		}
		table.grid th {
			background: #f2f2f2;
			font-size: 9px;
			text-transform: uppercase;
			letter-spacing: 1px;
			text-align: left;
		}
		table.grid thead { display: table-header-group; }
		table.grid tr { page-break-inside: avoid; }
		/*
		 * A repeating footer group would print the grand total at the bottom of every page of a
		 * long register, where it reads as that page's subtotal. It belongs at the end, once.
		 */
		table.grid tfoot { display: table-row-group; }
		table.grid tfoot td {
			background: #f2f2f2;
			font-weight: bold;
			border-top: 2px solid #111;
		}
		table.compact th, table.compact td { padding: 3px 4px; }
		.num { text-align: right; white-space: nowrap; }
		/* Headers wrap; only the figures under them must stay on one line. */
		table.grid th { white-space: normal; }
		.nowrap { white-space: nowrap; }
		.mono { white-space: nowrap; }
		.strong { font-weight: bold; }
		.muted { color: #777; }
		.tiny { font-size: 9px; }
		.note { font-size: 10px; color: #555; margin: 8px 0 0; }
		.note.warn { color: #111; border-left: 3px solid #111; padding-left: 8px; margin-bottom: 12px; }
		.kpi {
			display: flex;
			flex-wrap: wrap;
			gap: 8px;
			margin-bottom: 14px;
		}
		.kpi .cell {
			border: 1px solid #999;
			padding: 6px 10px;
			min-width: 140px;
			flex: 1 1 140px;
		}
		.kpi .label {
			font-size: 9px;
			text-transform: uppercase;
			letter-spacing: 1px;
			color: #555;
			display: block;
		}
		.kpi .value { font-size: 15px; font-weight: bold; white-space: nowrap; }
		.kpi .cell.accent { border-width: 2px; border-color: #111; }
		/*
		 * Fixed tracks, not wrapping flex: a fourth panel that wraps onto its own row stretches to
		 * the full width and pushes the day tables onto a page of their own.
		 */
		.panels { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; align-items: start; }
		.panel { page-break-inside: avoid; min-width: 0; }
		.days { margin-top: 12px; }
		.day-columns { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; align-items: start; }
		.day-columns .days-table { page-break-inside: avoid; min-width: 0; }
		/*
		 * Inside a grid track a table still claims its min-content width and spills over the next
		 * column, so the small tables are laid out to their declared widths and wrap instead.
		 */
		.panel table.grid, .day-columns table.grid { table-layout: fixed; }
		.panel table.grid td:first-child { overflow-wrap: break-word; }
		.panel-title {
			font-size: 10px;
			font-weight: bold;
			text-transform: uppercase;
			letter-spacing: 1px;
			color: #555;
			margin: 0 0 4px;
		}
		.footer {
			text-align: center;
			font-size: 9px;
			color: #999;
			margin-top: 16px;
			padding-top: 8px;
			border-top: 1px dashed #999;
		}
	</style>
</head>
<body>
	<div class="section">
		<div class="brand">
			<div>
				<h1>FILLANDO</h1>
				<p class="doc-title">Звіт про продажі</p>
				<p class="meta">Період: <strong>${periodLine}</strong> &nbsp;·&nbsp; ${filtersLine(data)}</p>
			</div>
			<div class="contacts">
				<div>fillando.com | ${SUPPORT.EMAIL}</div>
				<div>Сформовано: ${dateTime(data.generatedAt)}</div>
				<div>Час київський (${STORE_TIME_ZONE})</div>
			</div>
		</div>

		<div class="kpi">
			<div class="cell"><span class="label">Замовлень</span><span class="value">${totals.orders}</span></div>
			<div class="cell"><span class="label">Позицій / одиниць</span><span class="value">${totals.positions} / ${totals.units}</span></div>
			<div class="cell"><span class="label">Сума позицій</span><span class="value">${money(totals.subtotal)}</span></div>
			<div class="cell"><span class="label">Знижки</span><span class="value">-${money(totals.discount)}</span></div>
			<div class="cell accent"><span class="label">До сплати</span><span class="value">${money(totals.total)}</span></div>
		</div>

		<p class="section-title">1. Продані товари</p>
		<table class="grid">
			<thead>
				<tr>
					<th style="width:3%">№</th>
					<th style="width:10%">SKU</th>
					<th style="width:10%">Артикул пост.</th>
					<th>Назва товару</th>
					<th class="num" style="width:7%">Замовлень</th>
					<th class="num" style="width:6%">К-сть</th>
					<th class="num" style="width:11%">До знижок, ₴</th>
					<th class="num" style="width:10%">Знижка, ₴</th>
					<th class="num" style="width:11%">Сер. ціна, ₴</th>
					<th class="num" style="width:12%">Сума, ₴</th>
				</tr>
			</thead>
			<tbody>
				${productRows}
			</tbody>
			<tfoot>
				<tr>
					<td colspan="5">Разом найменувань (SKU): ${data.products.length}</td>
					<td class="num">${totals.units}</td>
					<td class="num">${amount(totals.subtotal)}</td>
					<td class="num">${totals.discount === 0 ? '—' : `-${amount(totals.discount)}`}</td>
					<td class="num">—</td>
					<td class="num">${amount(totals.total)}</td>
				</tr>
			</tfoot>
		</table>
		<p class="note">«Сер. ціна» і «Сума» — з урахуванням знижок за промокодами: знижку замовлення рознесено по його позиціях пропорційно їхній вартості. Тому «Сума» показує, скільки позиція принесла насправді, а її підсумок збігається з «До сплати».</p>
		${mismatchNote}
	</div>

	<div class="section">
		<p class="section-title">2. Реєстр замовлень &nbsp;<span class="meta">${periodLine}</span></p>
		<table class="grid">
			<thead>
				<tr>
					<th style="width:2.5%">№</th>
					<th style="width:8%">Замовлення</th>
					<th style="width:11%">Дата продажу</th>
					<th style="width:14.5%">Замовник</th>
					<th class="num" style="width:5%">Поз. / од.</th>
					<th style="width:8.5%">Статус</th>
					<th style="width:9%">Метод оплати</th>
					<th style="width:10%">Оплата</th>
					<th style="width:8%">Доставка</th>
					<th class="num" style="width:8%">Сума, ₴</th>
					<th class="num" style="width:7%">Знижка, ₴</th>
					<th class="num" style="width:8.5%">До сплати, ₴</th>
				</tr>
			</thead>
			<tbody>
				${orderRows}
			</tbody>
			<tfoot>
				<tr>
					<td colspan="4">Разом замовлень: ${totals.orders}</td>
					<td class="num">${totals.positions} / ${totals.units}</td>
					<td colspan="4"></td>
					<td class="num">${amount(totals.subtotal)}</td>
					<td class="num">-${amount(totals.discount)}</td>
					<td class="num">${amount(totals.total)}</td>
				</tr>
			</tfoot>
		</table>
		<p class="note">Дата продажу — момент оформлення замовлення. Момент надходження коштів у системі не фіксується окремо.</p>
	</div>

	<div class="section">
		<p class="section-title">3. Підсумки за період</p>

		<div class="kpi">
			<div class="cell accent"><span class="label">До сплати, разом</span><span class="value">${money(totals.total)}</span></div>
			<div class="cell"><span class="label">З них оплачено</span><span class="value">${money(totals.paid)}</span></div>
			<div class="cell"><span class="label">Очікує оплату</span><span class="value">${money(totals.awaiting)}</span></div>
			<div class="cell"><span class="label">Сума позицій</span><span class="value">${money(totals.subtotal)}</span></div>
			<div class="cell"><span class="label">Знижки</span><span class="value">-${money(totals.discount)}</span></div>
		</div>

		${nonRevenueNote}

		<div class="panels">
			${breakdownTable('За статусом оплати', data.byPaymentStatus, formatPaymentStatus)}
			${breakdownTable('За методом оплати', data.byPaymentMethod, key => PAYMENT_METHOD_LABELS[key])}
			${breakdownTable('За статусом замовлення', data.byOrderStatus, formatOrderStatus)}
			${breakdownTable('За способом доставки', data.byDeliveryMethod, key => DELIVERY_METHOD_LABELS[key])}
		</div>

		${daysTables(data.byDay)}

		<div class="footer">
			<p style="margin:0;">&copy; Fillando · Звіт сформовано автоматично ${dateTime(data.generatedAt)}</p>
		</div>
	</div>
</body>
</html>`
}
