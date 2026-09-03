import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { ProductStatus } from 'src/common/types/enums'
import { Types } from 'mongoose'
import { CartRepository } from 'src/database/mongoose/repositories/cart.repository'
import { CartItem } from 'src/database/mongoose/schemas/cart.schema'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { AddCartItemDto } from './dto/add-cart-item.dto'
import { UpdateCartItemDto } from './dto/update-cart-item.dto'
import { MergeCartDto } from './dto/merge-cart.dto'

@Injectable()
export class CartService {
	private readonly logger = new Logger(CartService.name)

	constructor(
		private readonly cartRepository: CartRepository,
		private readonly productVariantRepository: ProductVariantRepository
	) {}

	private async populateItems(items: CartItem[]) {
		if (!items.length) return []
		const variantIds = items.map(i => i.variant_id)
		const variants = await this.productVariantRepository.findByIds(variantIds)
		const variantMap = new Map(variants.map((v: any) => [v._id.toString(), v]))

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
							price: v.price,
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

		const variants = await this.productVariantRepository.findByIds(
			cart.items.map(i => i.variant_id)
		)
		const variantMap = new Map(variants.map((v: any) => [v._id.toString(), v]))

		const validItems: CartItem[] = []
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
				{ $set: { items: validItems.map(i => (i as any).toObject?.() ?? i) } }
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
		const currentItems = cart ? cart.items.map((i: any) => i.toObject?.() ?? { ...i }) : []
		const existingIndex = currentItems.findIndex(
			(i: any) => i.variant_id.toString() === dto.variant_id
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

		const items = cart.items.map((i: any) => i.toObject?.() ?? { ...i })
		const index = items.findIndex((i: any) => i.variant_id.toString() === variantId)
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

		const items = cart.items
			.filter(i => i.variant_id.toString() !== variantId)
			.map((i: any) => i.toObject?.() ?? { ...i })

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
		const variants = await this.productVariantRepository.findByIds(variantIds)
		const variantMap = new Map(variants.map((v: any) => [v._id.toString(), v]))

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
