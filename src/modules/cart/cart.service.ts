import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { ProductStatus } from 'src/common/types/enums'
import { Types } from 'mongoose'
import { CartRepository } from 'src/database/mongoose/repositories/cart.repository'
import { CartItem } from 'src/database/mongoose/schemas/cart.schema'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { ProductVariant } from 'src/database/mongoose/schemas/product-variant.schema'
import { AddCartItemDto } from './dto/add-cart-item.dto'
import { UpdateCartItemDto } from './dto/update-cart-item.dto'
import { MergeCartDto } from './dto/merge-cart.dto'
import { publicPromoFields } from 'src/modules/product/promo-pricing'

/** A variant as `findByIds` returns it: a lean row, so it carries its `_id`. */
type StoredVariant = ProductVariant & { _id: Types.ObjectId }

/**
 * A cart line as the repository returns it. On a hydrated cart each line is a subdocument, and
 * `toObject()` yields its stored fields alone; a plain line has no such method.
 */
type StoredCartItem = CartItem & { toObject?: () => CartItem }

/** A plain copy of a cart line, for a write that replaces the whole `items` array. */
const toPlainItem = (item: StoredCartItem): CartItem => item.toObject?.() ?? { ...item }

@Injectable()
export class CartService {
	private readonly logger = new Logger(CartService.name)

	constructor(
		private readonly cartRepository: CartRepository,
		private readonly productVariantRepository: ProductVariantRepository
	) {}

	/** The variants behind these ids, keyed by id. */
	private async findVariants(ids: Types.ObjectId[]): Promise<Map<string, StoredVariant>> {
		// `findByIds` reads with `.lean()`, so every row has its `_id`; the repository's declared
		// `ProductVariant[]` merely leaves the field out.
		const variants = (await this.productVariantRepository.findByIds(ids)) as StoredVariant[]
		return new Map(variants.map(v => [v._id.toString(), v]))
	}

	private async populateItems(items: CartItem[]) {
		if (!items.length) return []
		const variantMap = await this.findVariants(items.map(i => i.variant_id))
		const now = new Date()

		return items.map(item => {
			const v = variantMap.get(item.variant_id.toString())
			return {
				variant_id: item.variant_id.toString(),
				quantity: item.quantity,
				added_at: item.added_at,
				variant: v
					? {
							name: v.name,
							slug: v.slug,
							// The SKU is the item id of every analytics event and the feed's
							// `g:id`: the storefront's begin_checkout must not send the Mongo id.
							sku: v.sku,
							price: v.price,
							// Regular price above, the promotion trio here (TD-0012): the
							// storefront sums `sale_price ?? price`.
							...publicPromoFields(v, now),
							stock: v.stock,
							thumbnail: v.images?.[0] ?? null,
							v_value: v.v_value
						}
					: null
			}
		})
	}

	async getCart(userId: string) {
		const cart = await this.cartRepository.findByUserId(userId)
		if (!cart || !cart.items.length) return { items: [], removed_items: [] }

		const variantMap = await this.findVariants(cart.items.map(i => i.variant_id))

		const validItems: StoredCartItem[] = []
		const removedItems: string[] = []

		for (const item of cart.items) {
			const v = variantMap.get(item.variant_id.toString())
			if (!v || v.stock === 0 || v.status !== ProductStatus.ACTIVE) {
				removedItems.push(item.variant_id.toString())
			} else {
				validItems.push(item)
			}
		}

		if (removedItems.length > 0) {
			await this.cartRepository.update(
				{ user_id: new Types.ObjectId(userId) },
				{ $set: { items: validItems.map(i => i.toObject?.() ?? i) } }
			)
		}

		const populated = await this.populateItems(validItems)
		return { items: populated, removed_items: removedItems }
	}

	async addItem(userId: string, dto: AddCartItemDto) {
		const variant = await this.productVariantRepository.findById(dto.variant_id)
		if (!variant) throw new NotFoundException('Варіант товару не знайдено')
		if (variant.stock === 0) throw new ConflictException('Варіант товару відсутній у наявності')
		if (variant.status !== ProductStatus.ACTIVE) {
			throw new ConflictException('Варіант товару недоступний для замовлення')
		}

		const cart = await this.cartRepository.findByUserId(userId)
		const currentItems = cart ? cart.items.map(toPlainItem) : []
		const existingIndex = currentItems.findIndex(
			i => i.variant_id.toString() === dto.variant_id
		)

		if (existingIndex >= 0) {
			const newQty = currentItems[existingIndex].quantity + dto.quantity
			if (newQty > variant.stock)
				throw new ConflictException(`Доступно лише ${variant.stock} шт. на складі`)
			currentItems[existingIndex].quantity = newQty
		} else {
			if (dto.quantity > variant.stock)
				throw new ConflictException(`Доступно лише ${variant.stock} шт. на складі`)
			currentItems.push({
				variant_id: new Types.ObjectId(dto.variant_id),
				quantity: dto.quantity,
				added_at: new Date()
			})
		}

		const updated = await this.cartRepository.upsertByUserId(userId, {
			$set: { items: currentItems }
		})
		const populated = await this.populateItems(updated.items)
		return { items: populated, removed_items: [] }
	}

	async updateItem(userId: string, variantId: string, dto: UpdateCartItemDto) {
		const variant = await this.productVariantRepository.findById(variantId)
		if (!variant) throw new NotFoundException('Варіант товару не знайдено')
		if (variant.stock === 0) throw new ConflictException('Варіант товару відсутній у наявності')
		if (variant.status !== ProductStatus.ACTIVE) {
			throw new ConflictException('Варіант товару недоступний для замовлення')
		}
		if (dto.quantity > variant.stock)
			throw new ConflictException(`Доступно лише ${variant.stock} шт. на складі`)

		const cart = await this.cartRepository.findByUserId(userId)
		if (!cart) throw new NotFoundException('Кошик порожній')

		const items = cart.items.map(toPlainItem)
		const index = items.findIndex(i => i.variant_id.toString() === variantId)
		if (index < 0) throw new NotFoundException('Товар відсутній у кошику')

		items[index].quantity = dto.quantity
		const updated = await this.cartRepository.update(
			{ user_id: new Types.ObjectId(userId) },
			{ $set: { items } }
		)
		const populated = await this.populateItems(updated!.items)
		return { items: populated, removed_items: [] }
	}

	async removeItem(userId: string, variantId: string) {
		const cart = await this.cartRepository.findByUserId(userId)
		if (!cart) return { items: [], removed_items: [] }

		const items = cart.items.filter(i => i.variant_id.toString() !== variantId).map(toPlainItem)

		const updated = await this.cartRepository.update(
			{ user_id: new Types.ObjectId(userId) },
			{ $set: { items } }
		)
		const populated = await this.populateItems(updated!.items)
		return { items: populated, removed_items: [] }
	}

	async clearCart(userId: string) {
		await this.cartRepository.update(
			{ user_id: new Types.ObjectId(userId) },
			{ $set: { items: [] } }
		)
		return { items: [], removed_items: [] }
	}

	async mergeCart(userId: string, dto: MergeCartDto) {
		const cart = await this.cartRepository.findByUserId(userId)

		if (cart?.items.length) {
			return this.getCart(userId)
		}

		if (!dto.items.length) return { items: [], removed_items: [] }

		const variantIds = dto.items.map(i => new Types.ObjectId(i.variant_id))
		const variantMap = await this.findVariants(variantIds)

		const validItems: Array<{ variant_id: Types.ObjectId; quantity: number; added_at: Date }> =
			[]
		const removedItems: string[] = []

		for (const item of dto.items) {
			const v = variantMap.get(item.variant_id)
			if (!v || v.stock === 0 || v.status !== ProductStatus.ACTIVE) {
				removedItems.push(item.variant_id)
			} else {
				validItems.push({
					variant_id: new Types.ObjectId(item.variant_id),
					quantity: Math.min(item.quantity, v.stock),
					added_at: new Date()
				})
			}
		}

		const updated = await this.cartRepository.upsertByUserId(userId, {
			$set: { items: validItems }
		})
		const populated = await this.populateItems(updated.items)
		return { items: populated, removed_items: removedItems }
	}
}
