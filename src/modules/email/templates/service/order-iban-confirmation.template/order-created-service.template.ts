import { DeliveryMethod, OrderStatus, PaymentStatus } from 'src/common/types/enums'

export interface ServiceOrderCreatedEmailData {
	orderNumber: string
	orderStatus: OrderStatus
	paymentStatus: PaymentStatus
	paymentType: string
	customer: { name: string; email: string; phone: string }
	items: {
		name: string
		sku: string
		vendor_sku: string | null
		image: string | null
		price: number
		quantity: number
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
		street: string | null
		building: string | null
		apartment: string | null
	} | null
}

function formatOrderStatus(status: OrderStatus): string {
	if (status === OrderStatus.NEW) return 'Нове'
	if (status === OrderStatus.CONFIRMED) return 'Підтверджене'
	if (status === OrderStatus.PROCESSING) return 'В обробці'
	if (status === OrderStatus.SHIPPED) return 'Відправлене'
	if (status === OrderStatus.DELIVERED) return 'Доставлене'
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

function formatDelivery(data: ServiceOrderCreatedEmailData): string {
	if (data.deliveryMethod === DeliveryMethod.PICKUP) return 'Самовивіз'
	if (!data.deliveryAddress) return '—'
	const { city_name, warehouse_description, street, building, apartment } = data.deliveryAddress
	if (data.deliveryMethod === DeliveryMethod.NOVA_POST) {
		return `${city_name}, ${warehouse_description ?? ''}`
	}
	const apt = apartment ? `, кв. ${apartment}` : ''
	return `${city_name}, вул. ${street} ${building}${apt}`
}

function formatDeliveryMethod(data: ServiceOrderCreatedEmailData): string {
	if (data.deliveryMethod === DeliveryMethod.NOVA_POST) return 'Нова Пошта'
	if (data.deliveryMethod === DeliveryMethod.COURIER) return "Кур'єр"
	if (data.deliveryMethod === DeliveryMethod.PICKUP) return 'Самовивіз'
	return '—'
}

function formatPrice(value: number): string {
	return (
		value.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴'
	)
}

export function serviceOrderCreatedTemplate(data: ServiceOrderCreatedEmailData): string {
	const itemRows = data.items
		.map(
			item => `
      <tr>
        <td style="padding:10px 8px 10px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;">
          ${item.image ? `<img src="${item.image}" alt="${item.name}" style="width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid #e5e7eb;display:block;" />` : `<div style="width:56px;height:56px;border-radius:8px;border:1px solid #e5e7eb;background:#f8fafc;"></div>`}
        </td>
        <td style="padding:10px 8px 10px 0;border-bottom:1px solid #f0f0f0;">${item.name}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;">${item.sku}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;">${item.vendor_sku ?? '—'}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;text-align:center;">${item.quantity}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;text-align:right;white-space:nowrap;">${formatPrice(item.price)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #f0f0f0;text-align:right;white-space:nowrap;">${formatPrice(item.price * item.quantity)}</td>
      </tr>`
		)
		.join('')

	return `<!DOCTYPE html>
<html lang="uk">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Нове замовлення</title>
  </head>
  <body style="margin:0;padding:24px 12px;background-color:#ffffff;font-family:Arial,sans-serif;">
    <div style="max-width:900px;margin:24px auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e5e7eb;">
      <div style="background-color:#ffffff;padding:24px 32px;border-bottom:1px solid #eceff4;">
        <h1 style="margin:0;color:#111827;font-size:28px;font-weight:700;letter-spacing:0.02em;">Fillando</h1>
      </div>
      <div style="padding:32px;color:#333333;">
        <p style="font-size:18px;font-weight:700;color:#1a1a1a;margin:0 0 16px;">Нове замовлення ${data.orderNumber}</p>

        <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#999;margin:20px 0 10px;">Тип оплати</p>
        <p style="font-size:14px;margin:4px 0;color:#333;">${data.paymentType}</p>

        <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#999;margin:20px 0 10px;">Статус замовлення</p>
        <p style="font-size:14px;margin:4px 0;color:#333;">${formatOrderStatus(data.orderStatus)}</p>
        <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#999;margin:20px 0 10px;">Статус оплати</p>
        <p style="font-size:14px;margin:4px 0;color:#333;">${formatPaymentStatus(data.paymentStatus)}</p>

        <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#999;margin:20px 0 10px;">Покупець</p>
        <p style="font-size:14px;margin:4px 0;color:#333;">${data.customer.name}</p>
        <p style="font-size:14px;margin:4px 0;color:#333;">${data.customer.phone}</p>
        <p style="font-size:14px;margin:4px 0;color:#333;">${data.customer.email}</p>

        <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#999;margin:28px 0 10px;">Доставка</p>
        <p style="font-size:14px;margin:4px 0;color:#333;">${formatDeliveryMethod(data)}</p>
        ${data.deliveryMethod !== DeliveryMethod.PICKUP ? `<p style="font-size:14px;margin:4px 0;color:#333;">${formatDelivery(data)}</p>` : ''}

        <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#999;margin:28px 0 10px;">Склад замовлення</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;table-layout:fixed;">
          <thead>
            <tr>
              <th style="padding:8px 8px 8px 0;text-align:left;font-size:12px;color:#999;font-weight:600;border-bottom:2px solid #f0f0f0;width:10%;">Фото</th>
              <th style="padding:8px 8px 8px 0;text-align:left;font-size:12px;color:#999;font-weight:600;border-bottom:2px solid #f0f0f0;width:26%;">Товар</th>
              <th style="padding:8px;text-align:left;font-size:12px;color:#999;font-weight:600;border-bottom:2px solid #f0f0f0;width:14%;">SKU</th>
              <th style="padding:8px;text-align:left;font-size:12px;color:#999;font-weight:600;border-bottom:2px solid #f0f0f0;width:14%;">VENDOR SKU</th>
              <th style="padding:8px;text-align:center;font-size:12px;color:#999;font-weight:600;border-bottom:2px solid #f0f0f0;width:12%;">К-сть</th>
              <th style="padding:8px;text-align:right;font-size:12px;color:#999;font-weight:600;border-bottom:2px solid #f0f0f0;width:14%;">Ціна</th>
              <th style="padding:8px;text-align:right;font-size:12px;color:#999;font-weight:600;border-bottom:2px solid #f0f0f0;width:14%;">Сума</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows}
            ${
				data.appliedDiscount
					? `
            <tr>
              <td colspan="6" style="padding:10px 8px;color:#374151;text-align:right;">Підсумок без знижки:</td>
              <td style="padding:10px 8px;color:#111827;text-align:right;white-space:nowrap;">${formatPrice(data.subtotalPrice)}</td>
            </tr>
            <tr>
              <td colspan="6" style="padding:10px 8px;color:#16a34a;text-align:right;">Знижка (${data.appliedDiscount.code}, ${data.appliedDiscount.discount_percent}%):</td>
              <td style="padding:10px 8px;color:#16a34a;text-align:right;white-space:nowrap;">-${formatPrice(data.appliedDiscount.discount_amount)}</td>
            </tr>
            `
					: ''
			}
            <tr>
              <td colspan="6" style="padding:12px 8px;font-size:15px;font-weight:700;color:#1a1a1a;text-align:right;">Разом до оплати:</td>
              <td style="padding:12px 8px;font-size:15px;font-weight:700;color:#1a1a1a;text-align:right;white-space:nowrap;">${formatPrice(data.totalPrice)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </body>
</html>`
}
