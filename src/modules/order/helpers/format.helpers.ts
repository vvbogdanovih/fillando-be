import { DeliveryMethod, PaymentMethod } from 'src/common/types/enums'

export { formatOrderStatus, formatPaymentStatus } from 'src/common/utils'

export function formatPaymentMethod(method: PaymentMethod): string {
	if (method === PaymentMethod.CASH) return 'Готівка'
	if (method === PaymentMethod.IBAN) return 'IBAN (банківський переказ)'
	if (method === PaymentMethod.LIQPAY) return 'LiqPay'
	if (method === PaymentMethod.MONOPAY) return 'MonoPay'
	if (method === PaymentMethod.COD) return 'Накладний платіж'
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
