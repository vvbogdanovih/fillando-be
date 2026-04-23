import { ApiProperty } from '@nestjs/swagger'
import { DeliveryMethod, OrderStatus, PaymentMethod, PaymentStatus } from 'src/common/types/enums'

class OrderResponseCustomerDto {
	@ApiProperty({ example: 'Іван Петренко' })
	name: string

	@ApiProperty({ example: '+380991234567' })
	phone: string

	@ApiProperty({ example: 'ivan@example.com' })
	email: string
}

class OrderResponseDeliveryAddressDto {
	@ApiProperty({ example: 'Київ' })
	city_name: string

	@ApiProperty({ example: 'Відділення №1: вул. Хрещатик, 1', nullable: true })
	warehouse_description: string | null

	@ApiProperty({ example: 1, nullable: true })
	warehouse_number: number | null

	@ApiProperty({ example: 'вул. Хрещатик', nullable: true })
	street: string | null

	@ApiProperty({ example: '1А', nullable: true })
	building: string | null

	@ApiProperty({ example: '42', nullable: true })
	apartment: string | null
}

class OrderResponseDiscountDto {
	@ApiProperty({ example: 'AB12CD34EF' })
	code: string

	@ApiProperty({ example: 10 })
	discount_percent: number

	@ApiProperty({ example: 125.5 })
	discount_amount: number
}

class OrderResponseItemDto {
	@ApiProperty({ example: '664f1b2c3d4e5f6a7b8c9d0e' })
	variant_id: string

	@ApiProperty({ example: '664f1b2c3d4e5f6a7b8c9d0f' })
	product_id: string

	@ApiProperty({ example: 'Стілець кухонний Fillando' })
	name: string

	@ApiProperty({ example: 'FIL-CHAIR-001' })
	sku: string

	@ApiProperty({ example: 'VEND-CH-42', nullable: true })
	vendor_sku: string | null

	@ApiProperty({ example: 1299 })
	price: number

	@ApiProperty({ example: 2 })
	quantity: number

	@ApiProperty({ example: 2598 })
	line_total: number

	@ApiProperty({ example: 'https://cdn.example.com/product/image.webp', nullable: true })
	image: string | null
}

export class OrderResponseDto {
	@ApiProperty({ example: '664f1b2c3d4e5f6a7b8c9d10' })
	_id: string

	@ApiProperty({ example: 'FO-0000123' })
	order_number: string

	@ApiProperty({ type: OrderResponseCustomerDto })
	customer: OrderResponseCustomerDto

	@ApiProperty({ type: [OrderResponseItemDto] })
	items: OrderResponseItemDto[]

	@ApiProperty({ example: 2598 })
	subtotal_price: number

	@ApiProperty({ example: 2338.2 })
	total_price: number

	@ApiProperty({ type: OrderResponseDiscountDto, nullable: true })
	applied_discount: OrderResponseDiscountDto | null

	@ApiProperty({ enum: PaymentMethod })
	payment_method: PaymentMethod

	@ApiProperty({ enum: PaymentStatus })
	payment_status: PaymentStatus

	@ApiProperty({ example: 'liqpay_tx_123', nullable: true })
	payment_transaction_id: string | null

	@ApiProperty({ enum: DeliveryMethod })
	delivery_method: DeliveryMethod

	@ApiProperty({ type: OrderResponseDeliveryAddressDto, nullable: true })
	delivery_address: OrderResponseDeliveryAddressDto | null

	@ApiProperty({ example: '59001000000000', nullable: true })
	nova_post_ttn: string | null

	@ApiProperty({ enum: OrderStatus })
	order_status: OrderStatus

	@ApiProperty({ example: 'Зателефонуйте перед відправкою', nullable: true })
	comment: string | null

	@ApiProperty()
	createdAt: Date

	@ApiProperty()
	updatedAt: Date
}

export class OrderListResponseDto {
	@ApiProperty({ type: [OrderResponseDto] })
	items: OrderResponseDto[]

	@ApiProperty({ example: 137 })
	total: number

	@ApiProperty({ example: 1 })
	page: number

	@ApiProperty({ example: 20 })
	limit: number
}
