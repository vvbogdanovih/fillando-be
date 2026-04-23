import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { JWTPayload } from 'src/common/types/jwt-payload'
import { CartService } from './cart.service'
import { AddCartItemDto } from './dto/add-cart-item.dto'
import { UpdateCartItemDto } from './dto/update-cart-item.dto'
import { MergeCartDto } from './dto/merge-cart.dto'

@Controller(ENDPOINTS.CART.BASE)
@ApiTags(ENDPOINTS.CART.BASE)
@UseGuards(JwtAuthGuard)
export class CartController {
	constructor(private readonly cartService: CartService) {}

	@Get(ENDPOINTS.CART.GET)
	@ApiOperation(API_OPERATION.CART.GET)
	getCart(@Req() req: Request) {
		return this.cartService.getCart((req.user as JWTPayload).id)
	}

	@Post(ENDPOINTS.CART.MERGE)
	@ApiOperation(API_OPERATION.CART.MERGE)
	mergeCart(@Req() req: Request, @Body() dto: MergeCartDto) {
		return this.cartService.mergeCart((req.user as JWTPayload).id, dto)
	}

	@Post(ENDPOINTS.CART.ADD_ITEM)
	@ApiOperation(API_OPERATION.CART.ADD_ITEM)
	addItem(@Req() req: Request, @Body() dto: AddCartItemDto) {
		return this.cartService.addItem((req.user as JWTPayload).id, dto)
	}

	@Patch(ENDPOINTS.CART.UPDATE_ITEM)
	@ApiOperation(API_OPERATION.CART.UPDATE_ITEM)
	updateItem(
		@Req() req: Request,
		@Param('variantId') variantId: string,
		@Body() dto: UpdateCartItemDto
	) {
		return this.cartService.updateItem((req.user as JWTPayload).id, variantId, dto)
	}

	@Delete(ENDPOINTS.CART.REMOVE_ITEM)
	@ApiOperation(API_OPERATION.CART.REMOVE_ITEM)
	removeItem(@Req() req: Request, @Param('variantId') variantId: string) {
		return this.cartService.removeItem((req.user as JWTPayload).id, variantId)
	}

	@Delete(ENDPOINTS.CART.CLEAR)
	@ApiOperation(API_OPERATION.CART.CLEAR)
	clearCart(@Req() req: Request) {
		return this.cartService.clearCart((req.user as JWTPayload).id)
	}
}
