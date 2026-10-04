import { SUPPORT } from 'src/common/constants/contacts.constant'
import {
	DeliveryMethod,
	InvoiceAudience,
	OrderStatus,
	PaymentMethod,
	PaymentStatus
} from 'src/common/types/enums'
import {
	formatOrderStatus,
	formatPaymentStatus,
	formatPaymentMethod,
	formatDeliveryMethod,
	formatPrice,
	formatDate,
	formatDeliveryAddress
} from '../helpers/format.helpers'
import { escapeHtml } from 'src/common/utils/html.utils'

export interface InvoiceData {
	orderNumber: string
	createdAt: Date
	orderStatus: OrderStatus
	paymentMethod: PaymentMethod
	paymentStatus: PaymentStatus
	customer: { name: string; phone: string; email: string }
	items: {
		name: string
		sku: string
		vendor_sku: string | null
		price: number
		quantity: number
		image: string | null
	}[]
	subtotalPrice: number
	totalPrice: number
	appliedDiscount?: {
		code: string
		discount_percent: number
		discount_amount: number
	} | null
	manualDiscount?: { amount: number; reason: string } | null
	deliveryMethod: DeliveryMethod
	deliveryAddress: {
		city_name: string
		warehouse_description: string | null
		warehouse_number: number | null
		street: string | null
		building: string | null
		apartment: string | null
	} | null
	novaPostTtn: string | null
	orderComment: string | null
	adminComment: string | null
}

export function invoiceTemplate(
	data: InvoiceData,
	audience: InvoiceAudience = InvoiceAudience.INTERNAL
): string {
	// The supplier article is ours alone: the customer copy drops the column, not just its values.
	const showVendorSku = audience === InvoiceAudience.INTERNAL

	const itemRows = data.items
		.map(
			(item, index) => `
		<tr>
			<td style="border:1px solid #999;padding:6px 8px;text-align:center;vertical-align:middle;">${index + 1}</td>
			<td style="border:1px solid #999;padding:4px;text-align:center;vertical-align:middle;">
				${item.image ? `<img src="${escapeHtml(item.image)}" style="width:44px;height:44px;object-fit:cover;border-radius:4px;display:block;margin:0 auto;" />` : `<div style="width:44px;height:44px;border-radius:4px;background:#eee;margin:0 auto;"></div>`}
			</td>
			<td style="border:1px solid #999;padding:6px 8px;vertical-align:middle;">${escapeHtml(item.name)}</td>
			<td style="border:1px solid #999;padding:6px 8px;white-space:nowrap;vertical-align:middle;">${escapeHtml(item.sku)}</td>
			${showVendorSku ? `<td style="border:1px solid #999;padding:6px 8px;vertical-align:middle;">${escapeHtml(item.vendor_sku ?? '—')}</td>` : ''}
			<td style="border:1px solid #999;padding:6px 8px;text-align:center;vertical-align:middle;">${item.quantity}</td>
			<td style="border:1px solid #999;padding:6px 8px;text-align:right;white-space:nowrap;vertical-align:middle;">${formatPrice(item.price)}</td>
			<td style="border:1px solid #999;padding:6px 8px;text-align:right;white-space:nowrap;vertical-align:middle;">${formatPrice(item.price * item.quantity)}</td>
		</tr>`
		)
		.join('')

	const discountSection = data.appliedDiscount
		? `
		<div style="margin-top:8px;">
			<span>Знижка (${escapeHtml(data.appliedDiscount.code)}, ${data.appliedDiscount.discount_percent}%):</span>
			<span style="float:right;">-${formatPrice(data.appliedDiscount.discount_amount)}</span>
		</div>`
		: ''

	// The reason is the admin's note on why the buyer got it — ours, like the vendor article.
	const manualDiscountSection = data.manualDiscount
		? `
		<div style="margin-top:8px;">
			<span>Знижка магазину${showVendorSku ? ` (${escapeHtml(data.manualDiscount.reason)})` : ''}:</span>
			<span style="float:right;">-${formatPrice(data.manualDiscount.amount)}</span>
		</div>`
		: ''

	const commentsSection: string[] = []
	if (data.orderComment) {
		commentsSection.push(`
		<div style="border-top:1px dashed #999;padding-top:12px;margin-top:16px;">
			<p style="margin:0 0 4px;font-weight:bold;">Коментар замовника:</p>
			<p style="margin:0;white-space:pre-wrap;">${escapeHtml(data.orderComment)}</p>
		</div>`)
	}
	if (data.adminComment) {
		commentsSection.push(`
		<div style="border-top:1px dashed #999;padding-top:12px;margin-top:16px;">
			<p style="margin:0 0 4px;font-weight:bold;">${showVendorSku ? 'Коментар адміністратора' : 'Коментар магазину'}:</p>
			<p style="margin:0;white-space:pre-wrap;">${escapeHtml(data.adminComment)}</p>
		</div>`)
	}

	const LBL =
		'color:#555;white-space:nowrap;padding:1px 12px 1px 0;vertical-align:top;font-family:Courier New,Courier,monospace;font-size:13px;'
	const VAL =
		'padding:1px 0;vertical-align:top;font-family:Courier New,Courier,monospace;font-size:13px;'
	const SECTION = 'border-bottom:1px dashed #999;padding-bottom:12px;margin-bottom:16px;'
	const SECTION_TITLE =
		'font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:2px;color:#555;margin:0 0 8px;font-family:Courier New,Courier,monospace;'
	const TH =
		'border:1px solid #999;padding:6px 8px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;background:#f5f5f5;font-family:Courier New,Courier,monospace;'

	return `<!DOCTYPE html>
<html lang="uk">
<head>
	<meta charset="UTF-8" />
	<title>Інвойс ${escapeHtml(data.orderNumber)}</title>
</head>
<body style="margin:0;padding:0;font-family:Courier New,Courier,monospace;font-size:13px;color:#111;line-height:1.5;">
	<div style="max-width:1400px;margin:0 auto;padding:0;">
		<div style="text-align:center;padding-bottom:16px;border-bottom:2px dashed #999;margin-bottom:16px;">
			<h1 style="font-size:28px;letter-spacing:4px;margin:0 0 4px;font-family:Courier New,Courier,monospace;">FILLANDO</h1>
			<p style="font-size:12px;color:#555;margin:0;font-family:Courier New,Courier,monospace;">fillando.com | ${SUPPORT.EMAIL}</p>
		</div>

		<div style="${SECTION}">
			<p style="${SECTION_TITLE}">Замовлення</p>
			<table style="border-collapse:collapse;">
				<tr><td style="${LBL}">Номер:</td><td style="${VAL}">${escapeHtml(data.orderNumber)}</td></tr>
				<tr><td style="${LBL}">Дата:</td><td style="${VAL}">${formatDate(data.createdAt)}</td></tr>
				<tr><td style="${LBL}">Статус:</td><td style="${VAL}">${formatOrderStatus(data.orderStatus)}</td></tr>
			</table>
		</div>

		<div style="${SECTION}">
			<p style="${SECTION_TITLE}">Замовник</p>
			<table style="border-collapse:collapse;">
				<tr><td style="${LBL}">Ім'я:</td><td style="${VAL}">${escapeHtml(data.customer.name)}</td></tr>
				<tr><td style="${LBL}">Телефон:</td><td style="${VAL}">${escapeHtml(data.customer.phone)}</td></tr>
				<tr><td style="${LBL}">Email:</td><td style="${VAL}">${escapeHtml(data.customer.email)}</td></tr>
			</table>
		</div>

		<div style="${SECTION}">
			<p style="${SECTION_TITLE}">Товари</p>
			<table style="width:100%;border-collapse:collapse;margin-top:8px;">
				<thead>
					<tr>
						<th style="${TH}width:5%;text-align:center;">№</th>
						<th style="${TH}width:8%;">Фото</th>
						<th style="${TH}width:${showVendorSku ? 25 : 36}%;">Назва</th>
						<th style="${TH}width:11%;">SKU</th>
						${showVendorSku ? `<th style="${TH}width:11%;">Vendor SKU</th>` : ''}
						<th style="${TH}width:8%;text-align:center;">К-сть</th>
						<th style="${TH}width:14%;text-align:right;">Ціна</th>
						<th style="${TH}width:14%;text-align:right;">Сума</th>
					</tr>
				</thead>
				<tbody>
					${itemRows}
				</tbody>
			</table>

			<div style="margin-top:12px;text-align:right;">
				<div style="margin-bottom:4px;">
					<span>Підсумок:</span>
					<span>${formatPrice(data.subtotalPrice)}</span>
				</div>
				${discountSection}
				${manualDiscountSection}
				<div style="font-size:16px;font-weight:bold;border-top:2px solid #111;padding-top:6px;margin-top:6px;">
					<span>Загальна сума:</span>
					<span>${formatPrice(data.totalPrice)}</span>
				</div>
			</div>
		</div>

		<div style="${SECTION}">
			<p style="${SECTION_TITLE}">Оплата</p>
			<table style="border-collapse:collapse;">
				<tr><td style="${LBL}">Метод:</td><td style="${VAL}">${formatPaymentMethod(data.paymentMethod)}</td></tr>
				<tr><td style="${LBL}">Статус:</td><td style="${VAL}">${formatPaymentStatus(data.paymentStatus)}</td></tr>
			</table>
		</div>

		<div style="${SECTION}">
			<p style="${SECTION_TITLE}">Доставка</p>
			<table style="border-collapse:collapse;">
				<tr><td style="${LBL}">Метод:</td><td style="${VAL}">${formatDeliveryMethod(data.deliveryMethod)}</td></tr>
				<tr><td style="${LBL}">Отримувач:</td><td style="${VAL}">${escapeHtml(data.customer.name)}</td></tr>
				<tr><td style="${LBL}">Телефон:</td><td style="${VAL}">${escapeHtml(data.customer.phone)}</td></tr>
				<tr><td style="${LBL}">Адреса:</td><td style="${VAL}">${escapeHtml(formatDeliveryAddress(data))}</td></tr>
				${data.novaPostTtn ? `<tr><td style="${LBL}">ТТН:</td><td style="${VAL}">${escapeHtml(data.novaPostTtn)}</td></tr>` : ''}
			</table>
		</div>

		${commentsSection.length > 0 ? commentsSection.join('') : ''}

		<div style="text-align:center;font-size:11px;color:#999;margin-top:24px;padding-top:12px;border-top:2px dashed #999;font-family:Courier New,Courier,monospace;">
			<p style="margin:0;">&copy; Fillando</p>
		</div>
	</div>
</body>
</html>`
}
