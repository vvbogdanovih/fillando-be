import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { OrderRepository } from 'src/database/mongoose/repositories/order.repository'
import { NumbersRepository } from 'src/database/mongoose/repositories/numbers.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { DiscountCouponRepository } from 'src/database/mongoose/repositories/discount-coupon.repository'
import { EmailService } from 'src/modules/email/email.service'
import { DeliveryMethod, PaymentMethod } from 'src/common/types/enums'
import { CreateOrderDto } from './dto/create-order.dto'
import { UpdateOrderStatusDto } from './dto/update-order-status.dto'
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto'
import { SetTtnDto } from './dto/set-ttn.dto'
import { GetOrdersQueryDto } from './dto/get-orders-query.dto'
import { AdminUpdateOrderDto } from './dto/admin-update-order.dto'

@Injectable()
export class OrderService {
	private readonly logger = new Logger(OrderService.name)
	private static readonly ORDER_NUMBER_PREFIX = 'FO'

	constructor(
		private readonly orderRepository: OrderRepository,
		private readonly numbersRepository: NumbersRepository,
		private readonly productVariantRepository: ProductVariantRepository,
		private readonly discountCouponRepository: DiscountCouponRepository,
		private readonly emailService: EmailService
	) {}

	private formatOrderNumber(sequence: number): string {
		return `${OrderService.ORDER_NUMBER_PREFIX}-${String(sequence).padStart(7, '0')}`
	}

	private formatDiscountCode(userInputCode: string): string {
		return userInputCode.trim().toUpperCase()
	}

	private toLineTotal(price: number, quantity: number): number {
		return Number((price * quantity).toFixed(2))
	}

	private mapDeliveryAddress(
		address:
			| {
					city_name?: string
					warehouse_description?: string | null
					warehouse_number?: number | null
					street?: string | null
					building?: string | null
					apartment?: string | null
			  }
			| null
			| undefined
	) {
		if (!address) return null
		return {
			city_name: address.city_name!,
			warehouse_description: address.warehouse_description ?? null,
			warehouse_number: address.warehouse_number ?? null,
			street: address.street ?? null,
			building: address.building ?? null,
			apartment: address.apartment ?? null
		}
	}

	private validateDeliveryData(
		deliveryMethod: DeliveryMethod,
		deliveryAddress:
			| {
					city_name?: string
					warehouse_description?: string | null
					warehouse_number?: number | null
					street?: string | null
					building?: string | null
			  }
			| null
			| undefined
	): void {
		if (deliveryMethod !== DeliveryMethod.PICKUP && !deliveryAddress) {
			throw new BadRequestException('delivery_address is required for this delivery method')
		}
		if (deliveryMethod === DeliveryMethod.NOVA_POST) {
			const a = deliveryAddress!
			if (!a.warehouse_description || a.warehouse_number == null) {
				throw new BadRequestException(
					'warehouse_description and warehouse_number are required for NOVA_POST delivery'
				)
			}
		}
		if (deliveryMethod === DeliveryMethod.COURIER) {
			const a = deliveryAddress!
			if (!a.street || !a.building) {
				throw new BadRequestException(
					'street and building are required for COURIER delivery'
				)
			}
		}
	}

	private async buildOrderItems(items: Array<{ variant_id: string; quantity: number }>): Promise<{
		orderItems: Array<{
			variant_id: Types.ObjectId
			product_id: Types.ObjectId
			name: string
			sku: string
			vendor_sku: string | null
			price: number
			quantity: number
			image: string | null
		}>
		subtotalPrice: number
	}> {
		const variantIds = items.map(i => new Types.ObjectId(i.variant_id))
		const variants = await this.productVariantRepository.findByIds(variantIds)
		const variantMap = new Map(variants.map((v: any) => [v._id.toString(), v]))
		const orderItems: Array<{
			variant_id: Types.ObjectId
			product_id: Types.ObjectId
			name: string
			sku: string
			vendor_sku: string | null
			price: number
			quantity: number
			image: string | null
		}> = []
		let subtotalPrice = 0

		for (const item of items) {
			const variant = variantMap.get(item.variant_id)
			if (!variant) throw new NotFoundException(`Variant ${item.variant_id} not found`)
			if (variant.stock < item.quantity) {
				throw new BadRequestException(
					`Only ${variant.stock} units available for SKU ${variant.sku}`
				)
			}

			const linePrice = this.toLineTotal(variant.price, item.quantity)
			subtotalPrice += linePrice
			orderItems.push({
				variant_id: new Types.ObjectId(item.variant_id),
				product_id: variant.product_id,
				name: variant.name,
				sku: variant.sku,
				vendor_sku: variant.vendor_product_sku ?? null,
				price: variant.price,
				quantity: item.quantity,
				image: variant.images?.[0] ?? null
			})
		}

		return {
			orderItems,
			subtotalPrice: Number(subtotalPrice.toFixed(2))
		}
	}

	private mapOrderResponse(order: any) {
		const plainOrder = typeof order?.toObject === 'function' ? order.toObject() : order
		return {
			...plainOrder,
			items: plainOrder.items.map((item: any) => ({
				...item,
				line_total: this.toLineTotal(item.price, item.quantity)
			}))
		}
	}

	async create(dto: CreateOrderDto, userId?: string) {
		this.validateDeliveryData(dto.delivery_method, dto.delivery_address)
		const { orderItems, subtotalPrice } = await this.buildOrderItems(dto.items)

		let applied_discount: {
			coupon_id: Types.ObjectId
			code: string
			discount_percent: number
			discount_amount: number
		} | null = null
		let total_price = subtotalPrice

		if (dto.coupon_code) {
			const formattedCouponCode = this.formatDiscountCode(dto.coupon_code)
			const coupon = await this.discountCouponRepository.findActiveByCode(formattedCouponCode)
			if (!coupon) {
				throw new BadRequestException('Invalid coupon code')
			}
			if (new Date(coupon.valid_until).getTime() < Date.now()) {
				throw new BadRequestException('Coupon is expired')
			}

			const discountPercent = coupon.discount_percent
			const discountAmount = Number(((subtotalPrice * discountPercent) / 100).toFixed(2))
			total_price = Number((subtotalPrice - discountAmount).toFixed(2))
			applied_discount = {
				coupon_id: coupon._id,
				code: coupon.code,
				discount_percent: discountPercent,
				discount_amount: discountAmount
			}
		}

		const nextOrderSequence = await this.numbersRepository.increment('order')
		const order_number = this.formatOrderNumber(nextOrderSequence)

		const order = await this.orderRepository.create({
			order_number,
			user_id: userId ? new Types.ObjectId(userId) : null,
			customer: dto.customer,
			items: orderItems,
			subtotal_price: subtotalPrice,
			total_price,
			applied_discount,
			payment_method: dto.payment_method,
			delivery_method: dto.delivery_method,
			delivery_address:
				dto.delivery_method === DeliveryMethod.PICKUP
					? null
					: this.mapDeliveryAddress(dto.delivery_address),
			comment: dto.comment ?? null
		})

		if (applied_discount) {
			await this.discountCouponRepository.update(
				{ _id: applied_discount.coupon_id },
				{ $set: { is_active: false } }
			)
		}

		this.logger.log(`Order ${order_number} created`)

		if (dto.payment_method === PaymentMethod.IBAN) {
			const emailCustomer = { name: dto.customer.name, phone: dto.customer.phone }
			const emailItems = orderItems.map(i => ({
				name: i.name,
				sku: i.sku,
				vendor_sku: i.vendor_sku,
				price: i.price,
				quantity: i.quantity,
				image: i.image
			}))
			const emailDeliveryAddress = dto.delivery_address
				? {
						city_name: dto.delivery_address.city_name,
						warehouse_description: dto.delivery_address.warehouse_description ?? null,
						street: dto.delivery_address.street ?? null,
						building: dto.delivery_address.building ?? null,
						apartment: dto.delivery_address.apartment ?? null
					}
				: null

			this.emailService
				.sendOrderIbanConfirmation(dto.customer.email, order_number, {
					orderStatus: order.order_status,
					paymentStatus: order.payment_status,
					customer: emailCustomer,
					items: emailItems,
					subtotalPrice,
					totalPrice: total_price,
					appliedDiscount: applied_discount,
					deliveryMethod: dto.delivery_method,
					deliveryAddress: emailDeliveryAddress
				})
				.catch(err =>
					this.logger.error(
						{ err },
						`Failed to send IBAN confirmation email for order ${order_number}`
					)
				)
		}

		return order
	}

	async findAll(query: GetOrdersQueryDto) {
		const { page = 1, limit = 20, order_status, payment_status } = query
		const filter: Record<string, unknown> = {}
		if (order_status) filter.order_status = order_status
		if (payment_status) filter.payment_status = payment_status

		const skip = (page - 1) * limit
		const [items, total] = await Promise.all([
			this.orderRepository.findAllPaginated(filter, skip, limit),
			this.orderRepository.countDocuments(filter)
		])

		return {
			items: items.map(item => this.mapOrderResponse(item)),
			total,
			page,
			limit
		}
	}

	async findMyOrders(userId: string, query: GetOrdersQueryDto) {
		const { page = 1, limit = 20, order_status, payment_status } = query
		const filter: Record<string, unknown> = {}
		if (order_status) filter.order_status = order_status
		if (payment_status) filter.payment_status = payment_status

		const skip = (page - 1) * limit
		const userObjectId = new Types.ObjectId(userId)
		const [items, total] = await Promise.all([
			this.orderRepository.findAllByUserPaginated(userObjectId, filter, skip, limit),
			this.orderRepository.countDocumentsByUser(userObjectId, filter)
		])

		return {
			items: items.map(item => this.mapOrderResponse(item)),
			total,
			page,
			limit
		}
	}

	async findByNumber(orderNumber: string) {
		const order = await this.orderRepository.findByOrderNumber(orderNumber)
		if (!order) throw new NotFoundException(`Order ${orderNumber} not found`)
		return order
	}

	async findById(id: string) {
		const order = await this.orderRepository.findById(id)
		if (!order) throw new NotFoundException('Order not found')
		return this.mapOrderResponse(order)
	}

	async findMyOrderById(userId: string, id: string) {
		const order = await this.orderRepository.findByIdAndUserId(
			new Types.ObjectId(id),
			new Types.ObjectId(userId)
		)
		if (!order) throw new NotFoundException('Order not found')
		return this.mapOrderResponse(order)
	}

	async update(id: string, dto: AdminUpdateOrderDto) {
		const order = await this.orderRepository.findById(id)
		if (!order) throw new NotFoundException('Order not found')

		const updateSet: Record<string, unknown> = {}

		if (dto.items) {
			const { orderItems, subtotalPrice } = await this.buildOrderItems(dto.items)
			updateSet.items = orderItems
			updateSet.subtotal_price = subtotalPrice
			if (order.applied_discount) {
				const discountAmount = Number(
					((subtotalPrice * order.applied_discount.discount_percent) / 100).toFixed(2)
				)
				updateSet.applied_discount = {
					coupon_id: order.applied_discount.coupon_id,
					code: order.applied_discount.code,
					discount_percent: order.applied_discount.discount_percent,
					discount_amount: discountAmount
				}
				updateSet.total_price = Number((subtotalPrice - discountAmount).toFixed(2))
			} else {
				updateSet.total_price = subtotalPrice
			}
		}

		if (dto.customer) {
			updateSet.customer = { ...order.customer, ...dto.customer }
		}

		if (dto.payment_method) {
			updateSet.payment_method = dto.payment_method
		}

		if (dto.comment !== undefined) {
			updateSet.comment = dto.comment
		}

		if (dto.delivery_method || dto.delivery_address) {
			const deliveryMethod = dto.delivery_method ?? order.delivery_method
			if (deliveryMethod === DeliveryMethod.PICKUP && dto.delivery_address) {
				throw new BadRequestException(
					'delivery_address must be omitted for PICKUP delivery'
				)
			}

			const deliveryAddress =
				deliveryMethod === DeliveryMethod.PICKUP
					? null
					: (dto.delivery_address ?? order.delivery_address)

			this.validateDeliveryData(deliveryMethod, deliveryAddress)
			updateSet.delivery_method = deliveryMethod
			updateSet.delivery_address =
				deliveryMethod === DeliveryMethod.PICKUP
					? null
					: this.mapDeliveryAddress(
							deliveryAddress as NonNullable<typeof deliveryAddress>
						)
		}

		const updatedOrder = await this.orderRepository.update(
			{ _id: new Types.ObjectId(id) },
			{ $set: updateSet }
		)
		if (!updatedOrder) throw new NotFoundException('Order not found')

		return this.mapOrderResponse(updatedOrder)
	}

	async updateOrderStatus(id: string, dto: UpdateOrderStatusDto) {
		const order = await this.orderRepository.update(
			{ _id: new Types.ObjectId(id) },
			{ $set: { order_status: dto.order_status } }
		)
		if (!order) throw new NotFoundException('Order not found')
		return order
	}

	async updatePaymentStatus(id: string, dto: UpdatePaymentStatusDto) {
		const update: Record<string, unknown> = { payment_status: dto.payment_status }
		if (dto.payment_transaction_id) update.payment_transaction_id = dto.payment_transaction_id
		const order = await this.orderRepository.update(
			{ _id: new Types.ObjectId(id) },
			{ $set: update }
		)
		if (!order) throw new NotFoundException('Order not found')
		return order
	}

	async setTtn(id: string, dto: SetTtnDto) {
		const order = await this.orderRepository.update(
			{ _id: new Types.ObjectId(id) },
			{ $set: { nova_post_ttn: dto.nova_post_ttn } }
		)
		if (!order) throw new NotFoundException('Order not found')
		return order
	}
}
