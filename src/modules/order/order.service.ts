import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException
} from '@nestjs/common'
import { Types } from 'mongoose'
import { OrderRepository } from 'src/database/mongoose/repositories/order.repository'
import type { OrderDocument } from 'src/database/mongoose/schemas/order.schema'
import { NumbersRepository } from 'src/database/mongoose/repositories/numbers.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { DiscountCouponRepository } from 'src/database/mongoose/repositories/discount-coupon.repository'
import { EmailService } from 'src/modules/email/email.service'
import { orderAccessToken, verifyOrderAccessToken } from 'src/common/services/crypto.util'
import {
	DeliveryMethod,
	OrderStatus,
	PaymentMethod,
	PaymentStatus,
	ProductStatus
} from 'src/common/types/enums'
import {
	canCustomerChangePaymentMethod,
	PAYMENT_METHOD_CHANGEABLE_ORDER_STATUSES,
	PAYMENT_METHOD_CHANGEABLE_PAYMENT_STATUSES,
	resolvePaymentStatusOnOrderStatusChange,
	resolvePaymentStatusOnPaymentMethodChange
} from './helpers/payment-status.helpers'
import { InvoicePdfProvider } from './invoice/invoice-pdf.provider'
import { invoiceTemplate, type InvoiceData } from './invoice/invoice.template'
import { ReportProvider } from './report/report.provider'
import { CreateOrderDto } from './dto/create-order.dto'
import { UpdateOrderStatusDto } from './dto/update-order-status.dto'
import { UpdatePaymentStatusDto } from './dto/update-payment-status.dto'
import { SetTtnDto } from './dto/set-ttn.dto'
import { GetOrdersQueryDto } from './dto/get-orders-query.dto'
import { AdminUpdateOrderDto } from './dto/admin-update-order.dto'
import { ChangePaymentMethodDto } from './dto/change-payment-method.dto'
import { formatDeliveryMethod, formatPaymentMethod } from './helpers/format.helpers'
import {
	liqpayRetryAfterSeconds,
	liqpaySessionExpiredBefore
} from './helpers/liqpay-session.helpers'
import { GenerateReportDto } from './dto/generate-report.dto'

/**
 * The variant fields an order line is built from. `ProductVariantRepository.findByIds` answers
 * lean documents typed as the schema class, which carries no `_id`, so the map holds this shape:
 * naming it keeps every buyer-facing refusal below type-checked instead of `any`.
 */
interface OrderableVariant {
	_id: Types.ObjectId
	product_id: Types.ObjectId
	name: string
	sku: string
	vendor_product_sku?: string | null
	price: number
	stock: number
	status: ProductStatus
	images?: string[] | null
}

@Injectable()
export class OrderService {
	private readonly logger = new Logger(OrderService.name)
	private static readonly ORDER_NUMBER_PREFIX = 'FO'

	/**
	 * Payment methods that are only valid with certain delivery methods.
	 * A method absent from this map is allowed with any delivery method.
	 */
	private static readonly ALLOWED_DELIVERY_BY_PAYMENT: Partial<
		Record<PaymentMethod, DeliveryMethod[]>
	> = {
		[PaymentMethod.COD]: [DeliveryMethod.NOVA_POST, DeliveryMethod.COURIER],
		// Cash changes hands at the counter only. The checkout form always enforced this; the
		// customer-facing payment-method change (TD-0009) is the first path that needs the
		// server to enforce it too.
		[PaymentMethod.CASH]: [DeliveryMethod.PICKUP]
	}

	constructor(
		private readonly orderRepository: OrderRepository,
		private readonly numbersRepository: NumbersRepository,
		private readonly productVariantRepository: ProductVariantRepository,
		private readonly discountCouponRepository: DiscountCouponRepository,
		private readonly emailService: EmailService,
		private readonly invoicePdfProvider: InvoicePdfProvider,
		private readonly reportProvider: ReportProvider
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
			throw new BadRequestException({
				statusCode: 400,
				error: 'Bad Request',
				code: 'DELIVERY_ADDRESS_REQUIRED',
				message: 'Вкажіть адресу доставки, щоб оформити замовлення'
			})
		}
		if (deliveryMethod === DeliveryMethod.NOVA_POST) {
			const a = deliveryAddress!
			if (!a.warehouse_description || a.warehouse_number == null) {
				throw new BadRequestException({
					statusCode: 400,
					error: 'Bad Request',
					code: 'NOVA_POST_WAREHOUSE_REQUIRED',
					message: 'Оберіть відділення Нової Пошти, щоб оформити замовлення'
				})
			}
		}
		if (deliveryMethod === DeliveryMethod.COURIER) {
			const a = deliveryAddress!
			if (!a.street || !a.building) {
				throw new BadRequestException({
					statusCode: 400,
					error: 'Bad Request',
					code: 'COURIER_ADDRESS_REQUIRED',
					message: "Вкажіть вулицю та номер будинку, щоб кур'єр привіз замовлення"
				})
			}
		}
	}

	private validatePaymentDeliveryCombination(
		paymentMethod: PaymentMethod,
		deliveryMethod: DeliveryMethod
	): void {
		const allowed = OrderService.ALLOWED_DELIVERY_BY_PAYMENT[paymentMethod]
		if (!allowed || allowed.includes(deliveryMethod)) return

		// Read by the buyer on the success page (TD-0009), not only by the admin — Ukrainian.
		throw new BadRequestException(
			`Спосіб оплати «${formatPaymentMethod(paymentMethod)}» доступний лише з доставкою: ${allowed.map(formatDeliveryMethod).join(' або ')}`
		)
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
			const variant = variantMap.get(item.variant_id) as OrderableVariant | undefined
			// Every refusal below is read by the buyer on the checkout page — the storefront
			// echoes `message` as it is — so all of them are Ukrainian, say what to do, and carry
			// a machine-readable `code` plus the `variant_id` the storefront pins them to
			// (Plan-0005, screen «Чекаут: помилки»). The realistic path is a guest cart holding a
			// variant that was archived or sold out while it sat there.
			if (!variant) {
				throw new NotFoundException({
					statusCode: 404,
					error: 'Not Found',
					code: 'VARIANT_NOT_FOUND',
					message:
						'Цього товару вже немає в каталозі — приберіть позицію з кошика, щоб оформити замовлення',
					variant_id: item.variant_id
				})
			}
			// Draft/archived variants are hidden from every public read; they must not be
			// orderable by id either.
			if (variant.status !== ProductStatus.ACTIVE) {
				throw new BadRequestException({
					statusCode: 400,
					error: 'Bad Request',
					code: 'VARIANT_UNAVAILABLE',
					message: `Товар знято з продажу (${variant.sku}) — приберіть позицію з кошика, щоб оформити замовлення`,
					variant_id: String(variant._id),
					sku: variant.sku
				})
			}
			if (variant.stock < item.quantity) {
				// 409 like the cart's own quantity check — the request is well-formed, the stock
				// is not. Nothing is left to reduce at zero, so that case gets its own code and
				// its own advice: remove the line instead of lowering a quantity below one.
				const soldOut = variant.stock <= 0
				throw new ConflictException({
					statusCode: 409,
					error: 'Conflict',
					code: soldOut ? 'OUT_OF_STOCK' : 'INSUFFICIENT_STOCK',
					message: soldOut
						? `Товар закінчився (${variant.sku}) — приберіть позицію з кошика, щоб оформити замовлення`
						: `Доступно лише ${variant.stock} шт. (${variant.sku}) — зменште кількість, щоб оформити замовлення`,
					variant_id: String(variant._id),
					sku: variant.sku,
					available: variant.stock,
					requested: item.quantity
				})
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

	/**
	 * Customer-facing shape (POST /orders, GET /orders/me*): like {@link mapOrderResponse}
	 * minus `items[].vendor_sku` — the supplier article snapshot exists for the admin invoice
	 * and vendor e-mail only and must never reach a buyer.
	 *
	 * Plus the two derived payment fields the public lookup already carries, computed by the
	 * same helpers so the cabinet and the success page can never drift: without the clock the
	 * cabinet's «Оплатити карткою» has to guess and let the server refuse (I-33). What the
	 * buyer needs is the number of seconds, so only that derived value is added here — never
	 * a raw session stamp or another internal payment field.
	 */
	private mapCustomerOrderResponse(order: any) {
		const mapped = this.mapOrderResponse(order)
		const paymentState = mapped as {
			payment_method: PaymentMethod
			payment_status: PaymentStatus
			order_status: OrderStatus
			liqpay_checkout_started_at: Date | null
		}
		return {
			...mapped,
			can_change_payment_method: canCustomerChangePaymentMethod(paymentState),
			liqpay_retry_after_seconds: liqpayRetryAfterSeconds(paymentState),
			items: mapped.items.map((item: any) => {
				const customerItem = { ...item }
				delete customerItem.vendor_sku
				return customerItem
			})
		}
	}

	async create(dto: CreateOrderDto, userId?: string) {
		this.validateDeliveryData(dto.delivery_method, dto.delivery_address)
		this.validatePaymentDeliveryCombination(dto.payment_method, dto.delivery_method)
		const { orderItems, subtotalPrice } = await this.buildOrderItems(dto.items)

		let applied_discount: {
			coupon_id: Types.ObjectId
			code: string
			discount_percent: number
			discount_amount: number
		} | null = null
		let couponIsReusable = false
		let total_price = subtotalPrice

		if (dto.coupon_code) {
			const formattedCouponCode = this.formatDiscountCode(dto.coupon_code)
			const coupon = await this.discountCouponRepository.findActiveByCode(formattedCouponCode)
			if (!coupon) {
				throw new BadRequestException({
					statusCode: 400,
					error: 'Bad Request',
					code: 'COUPON_INVALID',
					message: `Купон «${formattedCouponCode}» не знайдено — перевірте код або оформіть замовлення без купона`
				})
			}
			if (new Date(coupon.valid_until).getTime() < Date.now()) {
				throw new BadRequestException({
					statusCode: 400,
					error: 'Bad Request',
					code: 'COUPON_EXPIRED',
					message: `Термін дії купона «${formattedCouponCode}» закінчився — оформіть замовлення без нього`
				})
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
			couponIsReusable = coupon.is_reusable
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
				{
					$inc: { used_count: 1 },
					...(couponIsReusable ? {} : { $set: { is_active: false } })
				}
			)
		}

		this.logger.log(`Order ${order_number} created`)

		if (
			dto.payment_method === PaymentMethod.IBAN ||
			dto.payment_method === PaymentMethod.CASH ||
			dto.payment_method === PaymentMethod.COD
		) {
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

			const emailDetails = {
				orderStatus: order.order_status,
				paymentStatus: order.payment_status,
				customer: emailCustomer,
				items: emailItems,
				subtotalPrice,
				totalPrice: total_price,
				appliedDiscount: applied_discount,
				deliveryMethod: dto.delivery_method,
				deliveryAddress: emailDeliveryAddress
			}

			const sendConfirmation = {
				[PaymentMethod.IBAN]: () =>
					this.emailService.sendOrderIbanConfirmation(
						dto.customer.email,
						order_number,
						emailDetails
					),
				[PaymentMethod.CASH]: () =>
					this.emailService.sendOrderCashConfirmation(
						dto.customer.email,
						order_number,
						emailDetails
					),
				[PaymentMethod.COD]: () =>
					this.emailService.sendOrderCodConfirmation(
						dto.customer.email,
						order_number,
						emailDetails
					)
			}[dto.payment_method]

			const sendEmail = sendConfirmation()

			sendEmail.catch(err =>
				this.logger.error(
					{ err },
					`Failed to send ${dto.payment_method} confirmation email for order ${order_number}`
				)
			)
		}

		const response = this.mapCustomerOrderResponse(order)
		if (dto.payment_method !== PaymentMethod.LIQPAY) return response

		// LiqPay buyers land on the success page without a session; the token lets them
		// read the payment status via GET /orders/lookup/:orderNumber. Never persisted.
		return { ...response, payment_access_token: orderAccessToken(order_number) }
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
			items: items.map(item => this.mapCustomerOrderResponse(item)),
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

	/**
	 * Public, token-gated read of an order's payment status (no auth). A wrong token is
	 * reported as 404 — not 403 — so the endpoint never confirms that an order number exists.
	 */
	async getPaymentStatusPublic(orderNumber: string, token: string) {
		if (!verifyOrderAccessToken(orderNumber, token)) {
			throw new NotFoundException(`Order ${orderNumber} not found`)
		}
		const order = await this.findByNumber(orderNumber)
		return this.toPublicPaymentStatus(order)
	}

	/**
	 * The public shape of an order's payment state: no PII, plus what the storefront needs to
	 * offer a payment-method change — the delivery method decides which offline methods fit,
	 * `can_change_payment_method` is computed here so the rule lives in one place, and
	 * `liqpay_retry_after_seconds` is the cooldown clock (null = never opened a card session).
	 */
	private toPublicPaymentStatus(order: OrderDocument) {
		return {
			order_number: order.order_number,
			payment_method: order.payment_method,
			payment_status: order.payment_status,
			total_price: order.total_price,
			order_status: order.order_status,
			delivery_method: order.delivery_method,
			can_change_payment_method: canCustomerChangePaymentMethod(order),
			liqpay_retry_after_seconds: liqpayRetryAfterSeconds(order)
		}
	}

	/** The guest path from the success page: same HMAC token as the lookup (TD-0009 §5.3). */
	async changePaymentMethodPublic(
		orderNumber: string,
		token: string,
		dto: ChangePaymentMethodDto
	) {
		if (!verifyOrderAccessToken(orderNumber, token)) {
			throw new NotFoundException(`Order ${orderNumber} not found`)
		}
		const order = await this.findByNumber(orderNumber)
		const updated = await this.changePaymentMethod(order, dto.payment_method)
		return this.toPublicPaymentStatus(updated)
	}

	/** The signed-in path from /profile/orders: ownership instead of a token. */
	async changeMyPaymentMethod(userId: string, id: string, dto: ChangePaymentMethodDto) {
		const order = await this.findOwnOrder(userId, id)
		const updated = await this.changePaymentMethod(order, dto.payment_method)
		return this.mapCustomerOrderResponse(updated)
	}

	/**
	 * Switches an unpaid order to an offline payment method (TD-0009 §5.4.1).
	 *
	 * The checks run in this order: the same method is a no-op (a double click must not send
	 * two mails); a paid, refunded, voided or already-processing order is locked; the delivery
	 * rule applies as it does everywhere else. The write pins every field it read — payment
	 * status, order status and the current method — so whatever landed in between makes it miss:
	 * a LiqPay callback that flipped the payment to PAID, or a second tab that already switched
	 * the method. A miss is re-read once: if the order already carries the requested method the
	 * other tab won and this is the no-op; otherwise the buyer gets a 409.
	 */
	private async changePaymentMethod(
		order: OrderDocument,
		target: PaymentMethod
	): Promise<OrderDocument> {
		if (order.payment_method === target) return order

		const locked = () =>
			new ConflictException({
				statusCode: 409,
				error: 'Conflict',
				code: 'PAYMENT_METHOD_LOCKED',
				message: 'Спосіб оплати цього замовлення вже не можна змінити'
			})
		if (!canCustomerChangePaymentMethod(order)) throw locked()

		this.validatePaymentDeliveryCombination(target, order.delivery_method)

		const nextStatus =
			resolvePaymentStatusOnPaymentMethodChange(order.payment_status) ?? order.payment_status

		const updated = await this.orderRepository.update(
			{
				_id: order._id,
				payment_method: order.payment_method,
				payment_status: { $in: PAYMENT_METHOD_CHANGEABLE_PAYMENT_STATUSES },
				order_status: { $in: PAYMENT_METHOD_CHANGEABLE_ORDER_STATUSES }
			},
			{ $set: { payment_method: target, payment_status: nextStatus } }
		)
		if (!updated) {
			const fresh = await this.orderRepository.findById(String(order._id))
			if (fresh && fresh.payment_method === target) return fresh
			throw locked()
		}

		this.logger.log(
			`Order ${order.order_number} payment method changed ${order.payment_method} → ${target} by the customer`
		)

		this.emailService
			.sendPaymentMethodChanged(
				updated.customer.email,
				updated.order_number,
				target as PaymentMethod.COD | PaymentMethod.IBAN | PaymentMethod.CASH,
				order.payment_method,
				this.buildOrderEmailDetails(updated)
			)
			.catch(err =>
				this.logger.error(
					{ err },
					`Failed to send payment-method-changed email for order ${order.order_number}`
				)
			)

		return updated
	}

	/**
	 * Claims the right to open a LiqPay checkout for the order (TD-0009 §5.4.3), atomically:
	 * the stamp is written by a conditional update, so two tabs racing for the same order get
	 * exactly one payload. Returns the stamped order, or `null` when the claim is refused —
	 * a PENDING payment whose previous session is younger than the cooldown, or an order that
	 * is no longer an unpaid LiqPay order. `LiqpayService` turns `null` into the right error.
	 *
	 * The same write moves a `FAILED` payment back to `PENDING`. A retry after a declined card
	 * stays allowed at once — the gateway closed that session itself, so there is nothing to
	 * wait for — but the retry is a payment in flight again, and `PENDING` + a fresh stamp is
	 * what makes the *second simultaneous* retry miss this filter. Without it both tabs of a
	 * `FAILED` order claimed a session and the buyer could be charged twice.
	 *
	 * There are no transactions here (standalone MongoDB), so this is deliberately one
	 * `findOneAndUpdate` pinned on the whole state it read: nothing is written unless the
	 * order is still exactly the unpaid LiqPay order without a live session.
	 */
	async claimLiqpayCheckout(
		orderId: Types.ObjectId,
		now: number = Date.now()
	): Promise<OrderDocument | null> {
		return this.orderRepository.update(
			{
				_id: orderId,
				payment_method: PaymentMethod.LIQPAY,
				payment_status: { $in: [PaymentStatus.PENDING, PaymentStatus.FAILED] },
				order_status: { $ne: OrderStatus.CANCELLED },
				$or: [
					{ liqpay_checkout_started_at: null },
					{ liqpay_checkout_started_at: { $lt: liqpaySessionExpiredBefore(now) } },
					{ payment_status: PaymentStatus.FAILED }
				]
			},
			{
				$set: {
					liqpay_checkout_started_at: new Date(now),
					payment_status: PaymentStatus.PENDING
				}
			}
		)
	}

	async findById(id: string) {
		const order = await this.orderRepository.findById(id)
		if (!order) throw new NotFoundException('Order not found')
		return this.mapOrderResponse(order)
	}

	async findMyOrderById(userId: string, id: string) {
		const order = await this.findOwnOrder(userId, id)
		return this.mapCustomerOrderResponse(order)
	}

	/** An order of this user, or 404 — also for an id that is not an ObjectId (never a BSON 500). */
	private async findOwnOrder(userId: string, id: string): Promise<OrderDocument> {
		if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Order not found')
		const order = await this.orderRepository.findByIdAndUserId(
			new Types.ObjectId(id),
			new Types.ObjectId(userId)
		)
		if (!order) throw new NotFoundException('Order not found')
		return order
	}

	async update(id: string, dto: AdminUpdateOrderDto) {
		const order = await this.orderRepository.findById(id)
		if (!order) throw new NotFoundException('Order not found')

		if (dto.payment_method || dto.delivery_method) {
			this.validatePaymentDeliveryCombination(
				dto.payment_method ?? order.payment_method,
				dto.delivery_method ?? order.delivery_method
			)
		}

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
			updateSet.customer = {
				name: dto.customer.name ?? order.customer.name,
				phone: dto.customer.phone ?? order.customer.phone,
				email: dto.customer.email ?? order.customer.email
			}
		}

		if (dto.payment_method) {
			updateSet.payment_method = dto.payment_method
			// A stale card-session stamp must not lock the buyer out for 15 minutes after the
			// admin moves the order back to LiqPay (TD-0009 §5.4.3).
			if (dto.payment_method !== order.payment_method)
				updateSet.liqpay_checkout_started_at = null
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
					: this.mapDeliveryAddress(deliveryAddress)
		}

		const updatedOrder = await this.orderRepository.update(
			{ _id: new Types.ObjectId(id) },
			{ $set: updateSet }
		)
		if (!updatedOrder) throw new NotFoundException('Order not found')

		return this.mapOrderResponse(updatedOrder)
	}

	async updateOrderStatus(id: string, dto: UpdateOrderStatusDto) {
		const current = await this.orderRepository.findById(id)
		if (!current) throw new NotFoundException('Order not found')

		const update: Record<string, unknown> = { order_status: dto.order_status }

		const nextPaymentStatus = resolvePaymentStatusOnOrderStatusChange(
			current.payment_status,
			current.order_status,
			dto.order_status
		)
		if (nextPaymentStatus) update.payment_status = nextPaymentStatus

		if (
			dto.order_status === OrderStatus.CANCELLED &&
			current.payment_status === PaymentStatus.PAID
		) {
			this.logger.warn(
				`Order ${current.order_number} cancelled while PAID — refund the customer manually and set REFUNDED`
			)
		}

		const order = await this.orderRepository.update(
			{ _id: new Types.ObjectId(id) },
			{ $set: update }
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

	/**
	 * Applies a payment result reported by an online gateway (e.g. LiqPay callback).
	 * Idempotent: an already-PAID order is never reprocessed or downgraded.
	 * On success sends the paid-confirmation email (customer + service).
	 *
	 * Every write pins the payment method it expects, because the buyer may switch the order to
	 * an offline method while the card session is open (TD-0009 §5.4.2): a failed card result
	 * must not mark a COD order FAILED, and a successful one must put the method back to LIQPAY
	 * — the money arrived by card — with a warning to the service so the offline sum is not
	 * collected as well.
	 */
	async applyGatewayPaymentResult(orderNumber: string, isPaid: boolean, transactionId?: string) {
		const order = await this.orderRepository.findByOrderNumber(orderNumber)
		if (!order) throw new NotFoundException(`Order ${orderNumber} not found`)

		if (order.payment_status === PaymentStatus.PAID) {
			this.logger.log(`Order ${orderNumber} already PAID, skipping gateway update`)
			return order
		}

		if (order.order_status === OrderStatus.CANCELLED) {
			return this.applyGatewayPaymentResultToCancelledOrder(order, isPaid, transactionId)
		}

		const stillLiqpay = {
			_id: order._id,
			payment_method: PaymentMethod.LIQPAY,
			payment_status: { $ne: PaymentStatus.PAID }
		}

		if (!isPaid) {
			const update: Record<string, unknown> = { payment_status: PaymentStatus.FAILED }
			if (transactionId) update.payment_transaction_id = transactionId
			const updated = await this.orderRepository.update(stillLiqpay, { $set: update })
			if (!updated) {
				// Paid meanwhile, or moved to an offline method: a dead card session says
				// nothing about either.
				this.logger.log(
					`Order ${orderNumber} is no longer an unpaid LiqPay order — failed gateway result ignored`
				)
				return (await this.orderRepository.findById(String(order._id))) ?? order
			}
			this.logger.log(`Order ${orderNumber} payment marked FAILED via gateway`)
			return updated
		}

		if (order.payment_method === PaymentMethod.LIQPAY) {
			const update: Record<string, unknown> = { payment_status: PaymentStatus.PAID }
			if (transactionId) update.payment_transaction_id = transactionId
			const updated = await this.orderRepository.update(stillLiqpay, { $set: update })
			if (updated) {
				this.logger.log(`Order ${orderNumber} payment marked PAID via gateway`)
				this.sendPaidConfirmationEmail(updated).catch(err =>
					this.logger.error(
						{ err },
						`Failed to send paid confirmation email for order ${orderNumber}`
					)
				)
				return updated
			}
			// The pinned write missed: either a duplicate callback got there first, or the
			// buyer switched methods between our read and our write.
			const fresh = await this.orderRepository.findById(String(order._id))
			if (!fresh) throw new NotFoundException(`Order ${orderNumber} not found`)
			if (fresh.payment_status === PaymentStatus.PAID) {
				this.logger.log(`Order ${orderNumber} already PAID, skipping gateway update`)
				return fresh
			}
			return this.applyGatewayPaymentAfterMethodChange(fresh, transactionId)
		}

		return this.applyGatewayPaymentAfterMethodChange(order, transactionId)
	}

	/**
	 * A gateway callback that arrives after the order was already cancelled.
	 *
	 * A successful payment is still recorded — the money really arrived, so it
	 * must never be silently dropped — but the customer is NOT told the order is
	 * paid. The admin is notified instead, because a refund is now required.
	 * A failed payment leaves the `VOIDED` status alone.
	 */
	private async applyGatewayPaymentResultToCancelledOrder(
		order: OrderDocument,
		isPaid: boolean,
		transactionId?: string
	): Promise<OrderDocument> {
		if (!isPaid) {
			this.logger.log(
				`Order ${order.order_number} is CANCELLED and the gateway reported a failed payment — keeping ${order.payment_status}`
			)
			return order
		}

		const update: Record<string, unknown> = { payment_status: PaymentStatus.PAID }
		if (transactionId) update.payment_transaction_id = transactionId

		const updated = await this.orderRepository.update({ _id: order._id }, { $set: update })
		if (!updated) throw new NotFoundException(`Order ${order.order_number} not found`)

		this.logger.warn(
			`Order ${order.order_number} was paid via gateway after being CANCELLED — refund required`
		)

		this.sendCancelledOrderPaidNotification(updated).catch(err =>
			this.logger.error(
				{ err },
				`Failed to notify service about a paid cancelled order ${order.order_number}`
			)
		)

		return updated
	}

	/**
	 * A successful card payment for an order the buyer has since moved to an offline method.
	 *
	 * The money really arrived: the order becomes PAID and the method goes back to LIQPAY so
	 * nobody also collects the offline sum. The service mail says why — and says it loudest
	 * when the order is already in fulfilment, because a COD invoice may be on the parcel.
	 */
	private async applyGatewayPaymentAfterMethodChange(
		order: OrderDocument,
		transactionId?: string
	): Promise<OrderDocument> {
		const update: Record<string, unknown> = {
			payment_status: PaymentStatus.PAID,
			payment_method: PaymentMethod.LIQPAY
		}
		if (transactionId) update.payment_transaction_id = transactionId

		const updated = await this.orderRepository.update(
			{ _id: order._id, payment_status: { $ne: PaymentStatus.PAID } },
			{ $set: update }
		)
		if (!updated) {
			this.logger.log(`Order ${order.order_number} already PAID, skipping gateway update`)
			return (await this.orderRepository.findById(String(order._id))) ?? order
		}

		const inFulfilment = !PAYMENT_METHOD_CHANGEABLE_ORDER_STATUSES.includes(order.order_status)
		this.logger.warn(
			`Order ${order.order_number} was paid via LiqPay after the buyer switched to ${order.payment_method}${inFulfilment ? ` and the order is already ${order.order_status}` : ''} — payment method restored to LIQPAY, do not collect ${order.payment_method}`
		)

		this.emailService
			.sendLiqpayPaidAfterMethodChange(
				updated.customer.email,
				updated.order_number,
				order.payment_method,
				this.buildOrderEmailDetails(updated),
				{ inFulfilment, ttn: order.nova_post_ttn ?? null }
			)
			.catch(err =>
				this.logger.error(
					{ err },
					`Failed to send paid-after-method-change emails for order ${order.order_number}`
				)
			)

		return updated
	}

	private buildOrderEmailDetails(order: OrderDocument) {
		const emailItems = order.items.map((i: any) => ({
			name: i.name,
			sku: i.sku,
			vendor_sku: i.vendor_sku,
			price: i.price,
			quantity: i.quantity,
			image: i.image
		}))
		const emailDeliveryAddress = order.delivery_address
			? {
					city_name: order.delivery_address.city_name,
					warehouse_description: order.delivery_address.warehouse_description ?? null,
					street: order.delivery_address.street ?? null,
					building: order.delivery_address.building ?? null,
					apartment: order.delivery_address.apartment ?? null
				}
			: null

		return {
			orderStatus: order.order_status,
			paymentStatus: order.payment_status,
			customer: { name: order.customer.name, phone: order.customer.phone },
			items: emailItems,
			subtotalPrice: order.subtotal_price,
			totalPrice: order.total_price,
			appliedDiscount: order.applied_discount ?? null,
			deliveryMethod: order.delivery_method,
			deliveryAddress: emailDeliveryAddress
		}
	}

	private async sendPaidConfirmationEmail(order: OrderDocument): Promise<void> {
		await this.emailService.sendOrderPaidConfirmation(
			order.customer.email,
			order.order_number,
			this.buildOrderEmailDetails(order)
		)
	}

	private async sendCancelledOrderPaidNotification(order: OrderDocument): Promise<void> {
		await this.emailService.sendCancelledOrderPaidNotification(
			order.customer.email,
			order.order_number,
			this.buildOrderEmailDetails(order)
		)
	}

	async setTtn(id: string, dto: SetTtnDto) {
		const order = await this.orderRepository.update(
			{ _id: new Types.ObjectId(id) },
			{ $set: { nova_post_ttn: dto.nova_post_ttn } }
		)
		if (!order) throw new NotFoundException('Order not found')
		return order
	}

	private buildInvoiceData(order: any, adminComment?: string): InvoiceData {
		return {
			orderNumber: order.order_number,
			createdAt: order.createdAt,
			orderStatus: order.order_status,
			paymentMethod: order.payment_method,
			paymentStatus: order.payment_status,
			customer: {
				name: order.customer.name,
				phone: order.customer.phone,
				email: order.customer.email
			},
			items: order.items.map((item: any) => ({
				name: item.name,
				sku: item.sku,
				vendor_sku: item.vendor_sku ?? null,
				price: item.price,
				quantity: item.quantity,
				image: item.image ?? null
			})),
			subtotalPrice: order.subtotal_price,
			totalPrice: order.total_price,
			appliedDiscount: order.applied_discount
				? {
						code: order.applied_discount.code,
						discount_percent: order.applied_discount.discount_percent,
						discount_amount: order.applied_discount.discount_amount
					}
				: null,
			deliveryMethod: order.delivery_method,
			deliveryAddress: order.delivery_address ?? null,
			novaPostTtn: order.nova_post_ttn ?? null,
			orderComment: order.comment ?? null,
			adminComment: adminComment ?? null
		}
	}

	async generateInvoice(
		id: string,
		adminComment?: string
	): Promise<{ buffer: Buffer; orderNumber: string }> {
		const order = await this.findById(id)
		const html = invoiceTemplate(this.buildInvoiceData(order, adminComment))
		const buffer = await this.invoicePdfProvider.generatePdf(html)
		return { buffer, orderNumber: order.order_number }
	}

	async sendVendorEmail(
		id: string,
		vendorEmail: string,
		adminComment?: string,
		attachments?: { filename: string; content: string }[]
	) {
		const order = await this.findById(id)
		const html = invoiceTemplate(this.buildInvoiceData(order, adminComment))
		const subject = `Замовлення ${order.order_number}`

		const emailAttachments = attachments?.map(a => ({
			filename: a.filename,
			content: Buffer.from(a.content, 'base64')
		}))

		await this.emailService.sendVendorOrderEmail(vendorEmail, subject, html, emailAttachments)

		this.logger.log(`Vendor email sent to ${vendorEmail} for order ${order.order_number}`)
	}

	async generateReport(dto: GenerateReportDto): Promise<{ buffer: Buffer; filename: string }> {
		const filter: Record<string, unknown> = {}
		if (dto.order_status) filter.order_status = dto.order_status
		if (dto.payment_status) filter.payment_status = dto.payment_status

		const dateFrom = new Date(dto.date_from)
		const dateTo = new Date(dto.date_to)
		dateTo.setHours(23, 59, 59, 999)

		const orders = await this.orderRepository.findAllByDateRange(filter, dateFrom, dateTo)

		if (orders.length === 0) {
			throw new BadRequestException('Немає замовлень за обраний період')
		}

		const mappedOrders = orders.map(order => this.mapOrderResponse(order))
		const invoices = mappedOrders.map(order => this.buildInvoiceData(order))
		const buffer = await this.reportProvider.generateBatchPdf(invoices)

		const dateFromStr = dto.date_from.replace(/-/g, '')
		const dateToStr = dto.date_to.replace(/-/g, '')
		const filename = `report_${dateFromStr}_${dateToStr}.pdf`

		return { buffer, filename }
	}
}
