import {
	BadRequestException,
	ConflictException,
	Injectable,
	Logger,
	NotFoundException
} from '@nestjs/common'
import { Types } from 'mongoose'
import { OrderRepository } from 'src/database/mongoose/repositories/order.repository'
import type { ManualDiscount, OrderDocument } from 'src/database/mongoose/schemas/order.schema'
import { NumbersRepository } from 'src/database/mongoose/repositories/numbers.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { DiscountCouponRepository } from 'src/database/mongoose/repositories/discount-coupon.repository'
import { EmailService } from 'src/modules/email/email.service'
import { orderAccessToken, verifyOrderAccessToken } from 'src/common/services/crypto.util'
import {
	DeliveryMethod,
	InvoiceAudience,
	OrderStatus,
	PaymentMethod,
	PaymentStatus,
	ProductStatus
} from 'src/common/types/enums'
import {
	canCustomerChangePaymentMethod,
	PAYMENT_METHOD_CHANGEABLE_ORDER_STATUSES,
	PAYMENT_METHOD_CHANGEABLE_PAYMENT_STATUSES,
	resolvePaymentStatusOnPaymentMethodChange
} from './helpers/payment-status.helpers'
import {
	adminStatusTransitions,
	initialStatusHistory,
	planStatusChange,
	shipsOnTtn,
	statusChangeUpdate,
	statusHistoryEntry
} from './helpers/order-status.rules'
import { InvoicePdfProvider } from './invoice/invoice-pdf.provider'
import { invoiceTemplate, type InvoiceData } from './invoice/invoice.template'
import { ReportProvider } from './report/report.provider'
import { buildSalesReport, type ReportSourceOrder } from './report/report.builder'
import { storeDayEnd, storeDayStart } from './report/report.period'
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

/**
 * The admin order shape: the stored document plus the two TD-0011 fields derived per response.
 * `mapOrderResponse` is untyped, so this names what the admin endpoints are known to return.
 */
type AdminOrderResponse = Record<string, unknown> & {
	order_number: string
	order_status: OrderStatus
	payment_status: PaymentStatus
	payment_method: PaymentMethod
	delivery_method: DeliveryMethod
	allowed_status_transitions: OrderStatus[]
	ships_on_ttn: boolean
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
	 * Admin order detail: the base shape plus the status actions the admin may take from here
	 * (TD-0011). The rule lives here, so the admin UI renders buttons without mirroring it.
	 */
	private mapAdminOrderResponse(order: unknown): AdminOrderResponse {
		const mapped = this.mapOrderResponse(order) as AdminOrderResponse
		return {
			...mapped,
			allowed_status_transitions: adminStatusTransitions(mapped),
			ships_on_ttn: shipsOnTtn(mapped)
		}
	}

	/** An admin list row: the base shape without the history, which only the detail shows. */
	private mapAdminListRow(order: unknown) {
		const row = this.mapOrderResponse(order) as Record<string, unknown>
		delete row.status_history
		return row
	}

	/**
	 * Customer-facing shape (POST /orders, GET /orders/me*): like {@link mapOrderResponse}
	 * minus `status_history` (who changed what, admin ids — internal) and minus `items[].vendor_sku` — the supplier article snapshot exists for the admin invoice
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
		const customerOrder: Record<string, unknown> = { ...mapped }
		delete customerOrder.status_history
		// The amount is the buyer's; the reason is the admin's note about them.
		const { manual_discount } = mapped as { manual_discount?: ManualDiscount | null }
		return {
			...customerOrder,
			...(manual_discount ? { manual_discount: { amount: manual_discount.amount } } : {}),
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
			comment: dto.comment ?? null,
			status_history: initialStatusHistory({
				order_status: OrderStatus.NEW,
				payment_status: PaymentStatus.PENDING
			})
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
			items: items.map(item => this.mapAdminListRow(item)),
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
		const plan = planStatusChange(order, { payment_status: nextStatus }, 'customer', {
			note: `Спосіб оплати: ${order.payment_method} → ${target}`
		})

		const updated = await this.orderRepository.update(
			{
				_id: order._id,
				payment_method: order.payment_method,
				payment_status: { $in: PAYMENT_METHOD_CHANGEABLE_PAYMENT_STATUSES },
				order_status: { $in: PAYMENT_METHOD_CHANGEABLE_ORDER_STATUSES }
			},
			statusChangeUpdate(plan, { payment_method: target })
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
	 *
	 * The update is a pipeline so the `FAILED → PENDING` move can be written to
	 * `status_history` by the same atomic write (TD-0011 F6) — only when the stored status really
	 * is `FAILED`, which no plain `$push` can express without reading the document first.
	 */
	async claimLiqpayCheckout(
		orderId: Types.ObjectId,
		now: number = Date.now()
	): Promise<OrderDocument | null> {
		const retryEntry = statusHistoryEntry(
			'payment_status',
			PaymentStatus.FAILED,
			PaymentStatus.PENDING,
			'customer',
			new Date(now)
		)
		return this.orderRepository.updateWithPipeline(
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
			[
				{
					$set: {
						liqpay_checkout_started_at: new Date(now),
						payment_status: PaymentStatus.PENDING,
						status_history: {
							$cond: [
								{ $eq: ['$payment_status', PaymentStatus.FAILED] },
								{
									$concatArrays: [
										{ $ifNull: ['$status_history', []] },
										[retryEntry]
									]
								},
								{ $ifNull: ['$status_history', []] }
							]
						}
					}
				}
			]
		)
	}

	async findById(id: string) {
		const order = await this.orderRepository.findById(id)
		if (!order) throw new NotFoundException('Order not found')
		return this.mapAdminOrderResponse(order)
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

		if (dto.manual_discount !== undefined) this.assertManualDiscountAllowed(order)

		if (dto.items || dto.manual_discount !== undefined) {
			let subtotalPrice = order.subtotal_price
			let couponAmount = order.applied_discount?.discount_amount ?? 0

			if (dto.items) {
				const built = await this.buildOrderItems(dto.items)
				subtotalPrice = built.subtotalPrice
				updateSet.items = built.orderItems
				updateSet.subtotal_price = subtotalPrice
				if (order.applied_discount) {
					couponAmount = Number(
						((subtotalPrice * order.applied_discount.discount_percent) / 100).toFixed(2)
					)
					updateSet.applied_discount = {
						coupon_id: order.applied_discount.coupon_id,
						code: order.applied_discount.code,
						discount_percent: order.applied_discount.discount_percent,
						discount_amount: couponAmount
					}
				}
			}

			let manualDiscount = order.manual_discount ?? null
			if (dto.manual_discount !== undefined) {
				const reason = dto.manual_discount?.reason.trim()
				if (dto.manual_discount && !reason) {
					throw new BadRequestException('manual_discount.reason must not be blank')
				}
				manualDiscount = dto.manual_discount
					? {
							amount: dto.manual_discount.amount,
							reason: reason!,
							applied_at: new Date()
						}
					: null
				updateSet.manual_discount = manualDiscount
			}

			const payable = Number((subtotalPrice - couponAmount).toFixed(2))
			if (manualDiscount && manualDiscount.amount > payable) {
				throw new BadRequestException({
					statusCode: 400,
					error: 'Bad Request',
					code: 'MANUAL_DISCOUNT_TOO_LARGE',
					message: `Знижка ${manualDiscount.amount} ₴ більша за суму до сплати ${payable} ₴`
				})
			}
			updateSet.total_price = Number((payable - (manualDiscount?.amount ?? 0)).toFixed(2))
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

		return this.mapAdminOrderResponse(updatedOrder)
	}

	/**
	 * A manual discount changes `total_price`, which is what the buyer pays and what LiqPay's
	 * callback is checked against. Once the money has moved it is a refund, not a discount; and
	 * while a card session is open it was built with the old amount — a second session at the
	 * new amount is the double charge the cooldown exists to prevent, so the admin waits it out.
	 */
	private assertManualDiscountAllowed(order: OrderDocument): void {
		if (
			order.payment_status === PaymentStatus.PAID ||
			order.payment_status === PaymentStatus.REFUNDED
		) {
			throw new ConflictException({
				statusCode: 409,
				error: 'Conflict',
				code: 'MANUAL_DISCOUNT_ORDER_PAID',
				message: 'Замовлення вже оплачене — знижку можна оформити лише як повернення коштів'
			})
		}
		const retryAfter = liqpayRetryAfterSeconds(order)
		if (retryAfter) {
			throw new ConflictException({
				statusCode: 409,
				error: 'Conflict',
				code: 'LIQPAY_SESSION_ACTIVE',
				message: 'Покупець зараз оплачує карткою за старою сумою — спробуйте пізніше',
				retry_after_seconds: retryAfter
			})
		}
	}

	/**
	 * Admin status change (TD-0011): only the transitions {@link adminStatusTransitions} offers,
	 * with the payment rule, the `COMPLETED` settlement and the history entry decided together by
	 * `planStatusChange`. The write is pinned on the state it read, so a tracker or gateway write
	 * that landed in between makes it a 409 instead of being overwritten.
	 */
	async updateOrderStatus(id: string, dto: UpdateOrderStatusDto, adminId?: string) {
		const current = await this.findOrderOrThrow(id)

		const allowed = adminStatusTransitions(current)
		// The current status again is a no-op — unless the payment rule still has something to
		// do: re-applying CANCELLED heals an order cancelled before VOIDED existed (TD-0003).
		if (current.order_status === dto.order_status) {
			const heal = planStatusChange(current, { order_status: dto.order_status }, 'admin', {
				adminId
			})
			if (heal.history.length === 0) return this.mapAdminOrderResponse(current)
			return this.mapAdminOrderResponse(
				await this.writePinned(current, statusChangeUpdate(heal))
			)
		}
		if (!allowed.includes(dto.order_status)) {
			throw new ConflictException({
				statusCode: 409,
				error: 'Conflict',
				code: 'INVALID_STATUS_TRANSITION',
				message: 'Такий перехід статусу недоступний для цього замовлення',
				from: current.order_status,
				to: dto.order_status,
				allowed
			})
		}

		const plan = planStatusChange(current, { order_status: dto.order_status }, 'admin', {
			adminId
		})
		if (
			plan.order_status === OrderStatus.CANCELLED &&
			plan.payment_status === PaymentStatus.PAID
		) {
			this.logger.warn(
				`Order ${current.order_number} cancelled while PAID — refund the customer manually and set REFUNDED`
			)
		}

		const order = await this.writePinned(current, statusChangeUpdate(plan))
		return this.mapAdminOrderResponse(order)
	}

	async updatePaymentStatus(id: string, dto: UpdatePaymentStatusDto, adminId?: string) {
		const current = await this.findOrderOrThrow(id)
		const plan = planStatusChange(current, { payment_status: dto.payment_status }, 'admin', {
			adminId
		})
		const extra: Record<string, unknown> = {}
		if (dto.payment_transaction_id) extra.payment_transaction_id = dto.payment_transaction_id

		const order = await this.writePinned(current, statusChangeUpdate(plan, extra))
		return this.mapAdminOrderResponse(order)
	}

	/**
	 * A TTN is the parcel leaving: a carrier order that has not shipped yet becomes `SHIPPED` in
	 * the same write (TD-0011). Pickup orders and orders past that point keep their status — a
	 * replaced TTN on a shipped order is just a new parcel number.
	 */
	async setTtn(id: string, dto: SetTtnDto, adminId?: string) {
		const current = await this.findOrderOrThrow(id)
		const plan = shipsOnTtn(current)
			? planStatusChange(current, { order_status: OrderStatus.SHIPPED }, 'admin', {
					adminId,
					note: `ТТН ${dto.nova_post_ttn}`
				})
			: planStatusChange(current, {}, 'admin')

		// A new TTN is a new parcel: what the tracker saw and alerted on was the old one's.
		const order = await this.writePinned(
			current,
			statusChangeUpdate(plan, {
				nova_post_ttn: dto.nova_post_ttn,
				nova_post_status: null,
				nova_post_alerted_code: null
			})
		)
		return this.mapAdminOrderResponse(order)
	}

	private async findOrderOrThrow(id: string): Promise<OrderDocument> {
		if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Order not found')
		const order = await this.orderRepository.findById(id)
		if (!order) throw new NotFoundException('Order not found')
		return order
	}

	/**
	 * An admin write pinned on both statuses it read. Mongo here is standalone (no transactions),
	 * so this conditional update is the concurrency control: a miss means the tracker, a gateway
	 * callback or another tab changed the order first, and the admin has to look again.
	 */
	private async writePinned(
		current: OrderDocument,
		update: Record<string, unknown>
	): Promise<OrderDocument> {
		const order = await this.orderRepository.update(
			{
				_id: current._id,
				order_status: current.order_status,
				payment_status: current.payment_status
			},
			update
		)
		if (order) return order
		const exists = await this.orderRepository.findById(String(current._id))
		if (!exists) throw new NotFoundException('Order not found')
		throw new ConflictException({
			statusCode: 409,
			error: 'Conflict',
			code: 'ORDER_STATUS_CHANGED',
			message: 'Статус замовлення щойно змінився — оновіть сторінку й спробуйте ще раз'
		})
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
		return this.applyGatewayResultTo(order, isPaid, transactionId, false)
	}

	/**
	 * One attempt, pinned on the whole state read — method, order status and payment status.
	 * The planned write carries a derived order status (a paid delivery closes, TD-0011) and the
	 * history's `from`, and both are only right for the state that was read: pinned on less, a
	 * callback racing the tracker could stamp COMPLETED over RETURNING. A miss re-reads once and
	 * starts over from the fresh state, so a switched method, a cancellation or a tracker move
	 * takes the branch it should have; a second miss is logged and left to the next callback.
	 */
	private async applyGatewayResultTo(
		order: OrderDocument,
		isPaid: boolean,
		transactionId: string | undefined,
		retried: boolean
	): Promise<OrderDocument> {
		const orderNumber = order.order_number
		if (order.payment_status === PaymentStatus.PAID) {
			this.logger.log(`Order ${orderNumber} already PAID, skipping gateway update`)
			return order
		}

		const extra: Record<string, unknown> = {}
		if (transactionId) extra.payment_transaction_id = transactionId
		const pinned = {
			_id: order._id,
			payment_method: order.payment_method,
			order_status: order.order_status,
			payment_status: order.payment_status
		}
		const retry = async (): Promise<OrderDocument> => {
			const fresh = await this.orderRepository.findById(String(order._id))
			if (!fresh) throw new NotFoundException(`Order ${orderNumber} not found`)
			if (retried) {
				this.logger.warn(
					`Order ${orderNumber} changed twice while one gateway result was applied — left as ${fresh.order_status}/${fresh.payment_status}`
				)
				return fresh
			}
			return this.applyGatewayResultTo(fresh, isPaid, transactionId, true)
		}

		if (order.order_status === OrderStatus.CANCELLED) {
			if (!isPaid) {
				this.logger.log(
					`Order ${orderNumber} is CANCELLED and the gateway reported a failed payment — keeping ${order.payment_status}`
				)
				return order
			}
			// The money really arrived, so it is recorded; the customer is not told the order
			// is paid — the admin is, because a refund is now required (TD-0003).
			const plan = planStatusChange(
				order,
				{ payment_status: PaymentStatus.PAID },
				'gateway',
				{
					note: 'Оплата після скасування — потрібне повернення'
				}
			)
			const updated = await this.orderRepository.update(
				pinned,
				statusChangeUpdate(plan, extra)
			)
			if (!updated) return retry()
			this.logger.warn(
				`Order ${orderNumber} was paid via gateway after being CANCELLED — refund required`
			)
			this.sendCancelledOrderPaidNotification(updated).catch(err =>
				this.logger.error(
					{ err },
					`Failed to notify service about a paid cancelled order ${orderNumber}`
				)
			)
			return updated
		}

		if (!isPaid) {
			if (order.payment_method !== PaymentMethod.LIQPAY) {
				// A dead card session says nothing about an order now paid offline.
				this.logger.log(
					`Order ${orderNumber} is no longer a LiqPay order — failed gateway result ignored`
				)
				return order
			}
			const plan = planStatusChange(
				order,
				{ payment_status: PaymentStatus.FAILED },
				'gateway'
			)
			const updated = await this.orderRepository.update(
				pinned,
				statusChangeUpdate(plan, extra)
			)
			if (!updated) return retry()
			this.logger.log(`Order ${orderNumber} payment marked FAILED via gateway`)
			return updated
		}

		if (order.payment_method === PaymentMethod.LIQPAY) {
			const plan = planStatusChange(order, { payment_status: PaymentStatus.PAID }, 'gateway')
			const updated = await this.orderRepository.update(
				pinned,
				statusChangeUpdate(plan, extra)
			)
			if (!updated) return retry()
			this.logger.log(`Order ${orderNumber} payment marked PAID via gateway`)
			this.sendPaidConfirmationEmail(updated).catch(err =>
				this.logger.error(
					{ err },
					`Failed to send paid confirmation email for order ${orderNumber}`
				)
			)
			return updated
		}

		// A successful card payment for an order the buyer has since moved to an offline method.
		// The money really arrived: the order becomes PAID and the method goes back to LIQPAY so
		// nobody also collects the offline sum. The service mail says why — and says it loudest
		// when the order is already in fulfilment, because a COD invoice may be on the parcel.
		const plan = planStatusChange(order, { payment_status: PaymentStatus.PAID }, 'gateway', {
			note: `Оплачено карткою після зміни способу на ${order.payment_method}`
		})
		const updated = await this.orderRepository.update(
			pinned,
			statusChangeUpdate(plan, { ...extra, payment_method: PaymentMethod.LIQPAY })
		)
		if (!updated) return retry()

		const inFulfilment = !PAYMENT_METHOD_CHANGEABLE_ORDER_STATUSES.includes(order.order_status)
		this.logger.warn(
			`Order ${orderNumber} was paid via LiqPay after the buyer switched to ${order.payment_method}${inFulfilment ? ` and the order is already ${order.order_status}` : ''} — payment method restored to LIQPAY, do not collect ${order.payment_method}`
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
					`Failed to send paid-after-method-change emails for order ${orderNumber}`
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

	private invoiceManualDiscount(order: {
		manual_discount?: ManualDiscount | null
	}): InvoiceData['manualDiscount'] {
		const discount = order.manual_discount
		return discount ? { amount: discount.amount, reason: discount.reason } : null
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
			manualDiscount: this.invoiceManualDiscount(order),
			deliveryMethod: order.delivery_method,
			deliveryAddress: order.delivery_address ?? null,
			novaPostTtn: order.nova_post_ttn ?? null,
			orderComment: order.comment ?? null,
			adminComment: adminComment ?? null
		}
	}

	async generateInvoice(
		id: string,
		adminComment?: string,
		audience: InvoiceAudience = InvoiceAudience.INTERNAL
	): Promise<{ buffer: Buffer; orderNumber: string }> {
		const order = await this.findById(id)
		const html = invoiceTemplate(this.buildInvoiceData(order, adminComment), audience)
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

	/**
	 * The sales report the finance department works from: goods sold over the period, the orders
	 * they came from, and the reconciliation figures — not a stack of per-order invoices, which
	 * answer «what does this one buyer owe» rather than «what did the period bring in».
	 */
	async generateReport(dto: GenerateReportDto): Promise<{ buffer: Buffer; filename: string }> {
		const filter: Record<string, unknown> = {}
		if (dto.order_status) filter.order_status = dto.order_status
		if (dto.payment_status) filter.payment_status = dto.payment_status

		// The picker hands over plain calendar days, and finance reads them as Kyiv days.
		const dayFrom = dto.date_from.slice(0, 10)
		const dayTo = dto.date_to.slice(0, 10)
		const dateFrom = storeDayStart(dayFrom)
		const dateTo = storeDayEnd(dayTo)

		const orders = await this.orderRepository.findAllByDateRange(filter, dateFrom, dateTo)

		if (orders.length === 0) {
			throw new BadRequestException('Немає замовлень за обраний період')
		}

		// Lean docs: `Order` does not declare the `timestamps: true` fields, so the cast goes
		// through `unknown`. `ReportSourceOrder` is the narrow shape the report actually reads.
		const report = buildSalesReport(orders as unknown as ReportSourceOrder[], {
			dateFrom: dayFrom,
			dateTo: dayTo,
			orderStatus: dto.order_status ?? null,
			paymentStatus: dto.payment_status ?? null
		})

		const buffer = await this.reportProvider.generateSalesReportPdf(report)
		const filename = `sales-report_${dayFrom.replace(/-/g, '')}_${dayTo.replace(/-/g, '')}.pdf`

		return { buffer, filename }
	}
}
