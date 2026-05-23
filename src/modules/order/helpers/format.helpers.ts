import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'

export function formatOrderStatus(status: OrderStatus): string {
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

export function formatPaymentStatus(status: PaymentStatus): string {
	if (status === PaymentStatus.PENDING) return 'Очікує оплату'
	if (status === PaymentStatus.PAID) return 'Оплачено'
	if (status === PaymentStatus.FAILED) return 'Оплата неуспішна'
	if (status === PaymentStatus.REFUNDED) return 'Кошти повернено'
	return '—'
}

export function formatPaymentMethod(method: PaymentMethod): string {
	if (method === PaymentMethod.CASH) return 'Готівка'
	if (method === PaymentMethod.IBAN) return 'IBAN (банківський переказ)'
	if (method === PaymentMethod.LIQPAY) return 'LiqPay'
	if (method === PaymentMethod.MONOPAY) return 'MonoPay'
	return '—'
}

export function formatDeliveryMethod(method: DeliveryMethod): string {
	if (method === DeliveryMethod.NOVA_POST) return 'Нова Пошта'
	if (method === DeliveryMethod.COURIER) return "Кур'єр"
	if (method === DeliveryMethod.PICKUP) return 'Самовивіз'
	return '—'
}

export function formatPrice(value: number): string {
	return (
		value.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ₴'
	)
}

export function formatDate(date: Date): string {
	return new Date(date).toLocaleString('uk-UA', {
		day: '2-digit',
		month: '2-digit',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	})
}

export function formatDeliveryAddress(data: {
	deliveryMethod: DeliveryMethod
	deliveryAddress: {
		city_name: string
		warehouse_description: string | null
		warehouse_number: number | null
		street: string | null
		building: string | null
		apartment: string | null
	} | null
}): string {
	if (data.deliveryMethod === DeliveryMethod.PICKUP) return 'Самовивіз'
	if (!data.deliveryAddress) return '—'

	const { city_name, warehouse_description, street, building, apartment } = data.deliveryAddress

	if (data.deliveryMethod === DeliveryMethod.NOVA_POST) {
		return `${city_name}, ${warehouse_description ?? ''}`
	}

	const apt = apartment ? `, кв. ${apartment}` : ''
	return `${city_name}, вул. ${street} ${building}${apt}`
}
