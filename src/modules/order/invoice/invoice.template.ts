import {
	DeliveryMethod,
	OrderStatus,
	PaymentMethod,
	PaymentStatus
} from 'src/common/types/enums'

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

function formatOrderStatus(status: OrderStatus): string {
	if (status === OrderStatus.NEW) return 'Нове'
	if (status === OrderStatus.CONFIRMED) return 'Підтверджене'
	if (status === OrderStatus.PROCESSING) return 'В обробці'
	if (status === OrderStatus.SHIPPED) return 'Відправлене'
	if (status === OrderStatus.DELIVERED) return 'Доставлене'
	if (status === OrderStatus.COMPLETED) return 'Виконане'
	if (status === OrderStatus.CANCELLED) return 'Скасоване'
	if (status === OrderStatus.RETURNED) return 'Повернене'
	return '—'
}

function formatPaymentStatus(status: PaymentStatus): string {
	if (status === PaymentStatus.PENDING) return 'Очікує оплату'
	if (status === PaymentStatus.PAID) return 'Оплачено'
	if (status === PaymentStatus.FAILED) return 'Оплата неуспішна'
	if (status === PaymentStatus.REFUNDED) return 'Кошти повернено'
	return '—'
}

function formatPaymentMethod(method: PaymentMethod): string {
	if (method === PaymentMethod.CASH) return 'Готівка'
	if (method === PaymentMethod.IBAN) return 'IBAN (банківський переказ)'
	if (method === PaymentMethod.LIQPAY) return 'LiqPay'
	if (method === PaymentMethod.MONOPAY) return 'MonoPay'
	return '—'
}

function formatDeliveryMethod(method: DeliveryMethod): string {
	if (method === DeliveryMethod.NOVA_POST) return 'Нова Пошта'
	if (method === DeliveryMethod.COURIER) return "Кур'єр"
	if (method === DeliveryMethod.PICKUP) return 'Самовивіз'
	return '—'
}

function formatPrice(value: number): string {
	return (
		value.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
		' ₴'
	)
}

function formatDate(date: Date): string {
	return new Date(date).toLocaleString('uk-UA', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	})
}

function formatDeliveryAddress(data: InvoiceData): string {
	if (data.deliveryMethod === DeliveryMethod.PICKUP) return 'Самовивіз'
	if (!data.deliveryAddress) return '—'

	const { city_name, warehouse_description, street, building, apartment } = data.deliveryAddress

	if (data.deliveryMethod === DeliveryMethod.NOVA_POST) {
		return `${city_name}, ${warehouse_description ?? ''}`
	}

	const apt = apartment ? `, кв. ${apartment}` : ''
	return `${city_name}, вул. ${street} ${building}${apt}`
}

export function invoiceTemplate(data: InvoiceData): string {
	const itemRows = data.items
		.map(
			(item, index) => `
		<tr>
			<td style="border:1px solid #999;padding:6px 8px;text-align:center;vertical-align:middle;">${index + 1}</td>
			<td style="border:1px solid #999;padding:4px;vertical-align:middle;">
				${item.image ? `<img src="${item.image}" style="width:44px;height:44px;object-fit:cover;border-radius:4px;display:block;" />` : `<div style="width:44px;height:44px;border-radius:4px;background:#eee;"></div>`}
			</td>
			<td style="border:1px solid #999;padding:6px 8px;vertical-align:middle;">${item.name}</td>
			<td style="border:1px solid #999;padding:6px 8px;vertical-align:middle;">${item.sku}</td>
			<td style="border:1px solid #999;padding:6px 8px;vertical-align:middle;">${item.vendor_sku ?? '—'}</td>
			<td style="border:1px solid #999;padding:6px 8px;text-align:center;vertical-align:middle;">${item.quantity}</td>
			<td style="border:1px solid #999;padding:6px 8px;text-align:right;white-space:nowrap;vertical-align:middle;">${formatPrice(item.price)}</td>
			<td style="border:1px solid #999;padding:6px 8px;text-align:right;white-space:nowrap;vertical-align:middle;">${formatPrice(item.price * item.quantity)}</td>
		</tr>`
		)
		.join('')

	const discountSection = data.appliedDiscount
		? `
		<div style="margin-top:8px;">
			<span>Знижка (${data.appliedDiscount.code}, ${data.appliedDiscount.discount_percent}%):</span>
			<span style="float:right;">-${formatPrice(data.appliedDiscount.discount_amount)}</span>
		</div>`
		: ''

	const commentsSection: string[] = []
	if (data.orderComment) {
		commentsSection.push(`
		<div style="border-top:1px dashed #999;padding-top:12px;margin-top:16px;">
			<p style="margin:0 0 4px;font-weight:bold;">Коментар замовника:</p>
			<p style="margin:0;white-space:pre-wrap;">${data.orderComment}</p>
		</div>`)
	}
	if (data.adminComment) {
		commentsSection.push(`
		<div style="border-top:1px dashed #999;padding-top:12px;margin-top:16px;">
			<p style="margin:0 0 4px;font-weight:bold;">Коментар адміністратора:</p>
			<p style="margin:0;white-space:pre-wrap;">${data.adminComment}</p>
		</div>`)
	}

	return `<!DOCTYPE html>
<html lang="uk">
<head>
	<meta charset="UTF-8" />
	<title>Інвойс ${data.orderNumber}</title>
	<style>
		* { margin: 0; padding: 0; box-sizing: border-box; }
		body {
			font-family: 'Courier New', Courier, monospace;
			font-size: 13px;
			color: #111;
			line-height: 1.5;
			padding: 0;
		}
		.container {
			max-width: 100%;
			padding: 0;
		}
		.header {
			text-align: center;
			padding-bottom: 16px;
			border-bottom: 2px dashed #999;
			margin-bottom: 16px;
		}
		.header h1 {
			font-size: 28px;
			letter-spacing: 4px;
			margin-bottom: 4px;
		}
		.header p {
			font-size: 12px;
			color: #555;
		}
		.section {
			border-bottom: 1px dashed #999;
			padding-bottom: 12px;
			margin-bottom: 16px;
		}
		.section-title {
			font-size: 13px;
			font-weight: bold;
			text-transform: uppercase;
			letter-spacing: 2px;
			color: #555;
			margin-bottom: 8px;
		}
		.info-row {
			display: flex;
			justify-content: space-between;
			margin-bottom: 2px;
		}
		.info-label {
			color: #555;
		}
		table {
			width: 100%;
			border-collapse: collapse;
			margin-top: 8px;
		}
		th {
			border: 1px solid #999;
			padding: 6px 8px;
			text-align: left;
			font-size: 11px;
			text-transform: uppercase;
			letter-spacing: 1px;
			background: #f5f5f5;
		}
		.totals {
			margin-top: 12px;
			text-align: right;
		}
		.totals .total-line {
			margin-bottom: 4px;
		}
		.totals .grand-total {
			font-size: 16px;
			font-weight: bold;
			border-top: 2px solid #111;
			padding-top: 6px;
			margin-top: 6px;
		}
		.footer {
			text-align: center;
			font-size: 11px;
			color: #999;
			margin-top: 24px;
			padding-top: 12px;
			border-top: 2px dashed #999;
		}
	</style>
</head>
<body>
	<div class="container">
		<div class="header">
			<h1>FILLANDO</h1>
			<p>fillando.com | info@fillando.com</p>
		</div>

		<div class="section">
			<p class="section-title">Замовлення</p>
			<div class="info-row">
				<span class="info-label">Номер:</span>
				<span>${data.orderNumber}</span>
			</div>
			<div class="info-row">
				<span class="info-label">Дата:</span>
				<span>${formatDate(data.createdAt)}</span>
			</div>
			<div class="info-row">
				<span class="info-label">Статус:</span>
				<span>${formatOrderStatus(data.orderStatus)}</span>
			</div>
		</div>

		<div class="section">
			<p class="section-title">Замовник</p>
			<div class="info-row">
				<span class="info-label">Ім'я:</span>
				<span>${data.customer.name}</span>
			</div>
			<div class="info-row">
				<span class="info-label">Телефон:</span>
				<span>${data.customer.phone}</span>
			</div>
			<div class="info-row">
				<span class="info-label">Email:</span>
				<span>${data.customer.email}</span>
			</div>
		</div>

		<div class="section">
			<p class="section-title">Товари</p>
			<table>
				<thead>
					<tr>
						<th style="width:5%;text-align:center;">№</th>
						<th style="width:8%;">Фото</th>
						<th style="width:25%;">Назва</th>
						<th style="width:11%;">SKU</th>
						<th style="width:11%;">Vendor SKU</th>
						<th style="width:8%;text-align:center;">К-сть</th>
						<th style="width:14%;text-align:right;">Ціна</th>
						<th style="width:14%;text-align:right;">Сума</th>
					</tr>
				</thead>
				<tbody>
					${itemRows}
				</tbody>
			</table>

			<div class="totals">
				<div class="total-line">
					<span>Підсумок:</span>
					<span>${formatPrice(data.subtotalPrice)}</span>
				</div>
				${discountSection}
				<div class="grand-total">
					<span>Загальна сума:</span>
					<span>${formatPrice(data.totalPrice)}</span>
				</div>
			</div>
		</div>

		<div class="section">
			<p class="section-title">Оплата</p>
			<div class="info-row">
				<span class="info-label">Метод:</span>
				<span>${formatPaymentMethod(data.paymentMethod)}</span>
			</div>
			<div class="info-row">
				<span class="info-label">Статус:</span>
				<span>${formatPaymentStatus(data.paymentStatus)}</span>
			</div>
		</div>

		<div class="section">
			<p class="section-title">Доставка</p>
			<div class="info-row">
				<span class="info-label">Метод:</span>
				<span>${formatDeliveryMethod(data.deliveryMethod)}</span>
			</div>
			<div class="info-row">
				<span class="info-label">Отримувач:</span>
				<span>${data.customer.name}</span>
			</div>
			<div class="info-row">
				<span class="info-label">Телефон:</span>
				<span>${data.customer.phone}</span>
			</div>
			<div class="info-row">
				<span class="info-label">Адреса:</span>
				<span>${formatDeliveryAddress(data)}</span>
			</div>
			${data.novaPostTtn ? `<div class="info-row"><span class="info-label">ТТН:</span><span>${data.novaPostTtn}</span></div>` : ''}
		</div>

		${commentsSection.length > 0 ? commentsSection.join('') : ''}

		<div class="footer">
			<p>&copy; Fillando</p>
		</div>
	</div>
</body>
</html>`
}
