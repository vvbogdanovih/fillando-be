import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	Query,
	Res,
	UseGuards
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { ProductService } from './product.service'
import { PriceListService } from './price-list/price-list.service'
import { CreateProductDto } from './dto/create-product.dto'
import { UpdateProductDto } from './dto/update-product.dto'
import { ValidateProductDto } from './dto/validate-product.dto'
import { SetVariantImagesDto } from './dto/set-variant-images.dto'
import { AddVariantDto, UpdateVariantDto } from './dto/update-variant.dto'
import { SearchProductsDto } from './dto/search-products.dto'
import { GetPriceSheetQueryDto } from './dto/get-price-sheet-query.dto'
import { GeneratePriceListDto } from './dto/generate-price-list.dto'

@Controller(ENDPOINTS.PRODUCTS.BASE)
@ApiTags(ENDPOINTS.PRODUCTS.BASE)
export class ProductController {
	constructor(
		private readonly productService: ProductService,
		private readonly priceListService: PriceListService
	) {}

	// Unpaginated full dump for the admin catalogue screen — the storefront uses /catalog.
	@Get(ENDPOINTS.PRODUCTS.GET_ALL)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.GET_ALL)
	findAll() {
		return this.productService.findAll()
	}

	@Get(ENDPOINTS.PRODUCTS.CATALOG)
	@ApiOperation(API_OPERATION.PRODUCTS.CATALOG)
	getCatalog(@Query() query: Record<string, string>) {
		return this.productService.getCatalog(query)
	}

	@Get(ENDPOINTS.PRODUCTS.SEARCH)
	@ApiOperation(API_OPERATION.PRODUCTS.SEARCH)
	search(@Query() dto: SearchProductsDto) {
		return this.productService.search(dto)
	}

	@Get(ENDPOINTS.PRODUCTS.VARIANT_SLUGS)
	@ApiOperation(API_OPERATION.PRODUCTS.VARIANT_SLUGS)
	getAllVariantSlugs() {
		return this.productService.getAllVariantSlugs()
	}

	@Get(ENDPOINTS.PRODUCTS.VARIANT_COUNT)
	@ApiOperation(API_OPERATION.PRODUCTS.VARIANT_COUNT)
	getVariantCount() {
		return this.productService.getVariantCount()
	}

	@Get(ENDPOINTS.PRODUCTS.PRICE_SHEET)
	@ApiOperation(API_OPERATION.PRODUCTS.PRICE_SHEET)
	getPriceSheet(@Query() query: GetPriceSheetQueryDto) {
		return this.productService.getPriceSheet(query)
	}

	// JwtAuthGuard must come first — RolesGuard reads req.user.role, which only exists
	// once the JWT has been validated.
	@Post(ENDPOINTS.PRODUCTS.PRICE_LIST_PDF)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.PRICE_LIST_PDF)
	async generatePriceListPdf(@Body() dto: GeneratePriceListDto, @Res() res: Response) {
		const { buffer, filename } = await this.priceListService.generatePdf(dto)
		res.set({
			'Content-Type': 'application/pdf',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Content-Length': buffer.length.toString()
		})
		res.end(buffer)
	}

	@Get(ENDPOINTS.PRODUCTS.BY_SLUG)
	@ApiOperation(API_OPERATION.PRODUCTS.BY_SLUG)
	getVariantBySlug(@Param('slug') slug: string) {
		return this.productService.getVariantBySlug(slug)
	}

	@Get(ENDPOINTS.PRODUCTS.GET_BY_ID)
	@ApiOperation(API_OPERATION.PRODUCTS.GET_BY_ID)
	findById(@Param('id') id: string) {
		return this.productService.findById(id)
	}

	@Post(ENDPOINTS.PRODUCTS.VALIDATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.VALIDATE)
	validate(@Body() dto: ValidateProductDto) {
		return this.productService.validate(dto)
	}

	@Post(ENDPOINTS.PRODUCTS.CREATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.CREATE)
	create(@Body() dto: CreateProductDto) {
		return this.productService.create(dto)
	}

	// Raw variant documents carry supplier identifiers (vendor_product_sku, prom_id) that the
	// admin editor needs but the public API must never expose — hence ADMIN-only.
	@Get(ENDPOINTS.PRODUCTS.VARIANTS)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.GET_VARIANTS)
	getVariants(@Param('id') id: string) {
		return this.productService.getVariants(id)
	}

	@Get(ENDPOINTS.PRODUCTS.VARIANT)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.GET_VARIANT)
	getVariant(@Param('id') id: string, @Param('variantId') variantId: string) {
		return this.productService.getVariant(id, variantId)
	}

	@Post(ENDPOINTS.PRODUCTS.VARIANTS)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.ADD_VARIANT)
	addVariant(@Param('id') id: string, @Body() dto: AddVariantDto) {
		return this.productService.addVariant(id, dto)
	}

	@Patch(ENDPOINTS.PRODUCTS.VARIANT)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.UPDATE_VARIANT)
	updateVariant(
		@Param('id') id: string,
		@Param('variantId') variantId: string,
		@Body() dto: UpdateVariantDto
	) {
		return this.productService.updateVariant(id, variantId, dto)
	}

	@Delete(ENDPOINTS.PRODUCTS.VARIANT)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.DELETE_VARIANT)
	deleteVariant(@Param('id') id: string, @Param('variantId') variantId: string) {
		return this.productService.deleteVariant(id, variantId)
	}

	@Patch(ENDPOINTS.PRODUCTS.PATCH_VARIANT_IMAGES)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.PATCH_VARIANT_IMAGES)
	setVariantImages(
		@Param('id') id: string,
		@Param('variantId') variantId: string,
		@Body() dto: SetVariantImagesDto
	) {
		return this.productService.setVariantImages(id, variantId, dto)
	}

	@Patch(ENDPOINTS.PRODUCTS.UPDATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.UPDATE)
	update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
		return this.productService.update(id, dto)
	}

	@Delete(ENDPOINTS.PRODUCTS.DELETE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.DELETE)
	delete(@Param('id') id: string) {
		return this.productService.delete(id)
	}
}
