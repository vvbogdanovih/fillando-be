import {
	CatalogAdaptedRead,
	LegacyCatalogController,
	CatalogReadOnlyPost
} from '../catalog-safety/legacy-catalog-write.interceptor'
import { ApiCreatedResponse, ApiServiceUnavailableResponse } from '@nestjs/swagger'
import {
	Body,
	Controller,
	Delete,
	Get,
	Param,
	Patch,
	Post,
	StreamableFile,
	UseGuards
} from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { API_OPERATION, CATALOG_UNAVAILABLE, ENDPOINTS } from 'src/common/constants'
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
import { SetProductPromotionDto } from './dto/set-product-promotion.dto'
import { GeneratePriceListDto } from './dto/generate-price-list.dto'

@LegacyCatalogController()
@Controller(ENDPOINTS.PRODUCTS.BASE)
@ApiTags(ENDPOINTS.PRODUCTS.BASE)
export class ProductController {
	constructor(
		private readonly productService: ProductService,
		private readonly priceListService: PriceListService
	) {}

	// Unpaginated full dump for the admin catalogue screen — the storefront uses /catalog.
	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_READ })
	@ApiOkResponse()
	@Get(ENDPOINTS.PRODUCTS.GET_ALL)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.GET_ALL)
	findAll() {
		return this.productService.findAll()
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_READ })
	@ApiOkResponse()
	@Get(ENDPOINTS.PRODUCTS.VARIANT_SLUGS)
	@ApiOperation(API_OPERATION.PRODUCTS.VARIANT_SLUGS)
	getAllVariantSlugs() {
		return this.productService.getAllVariantSlugs()
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_READ })
	@ApiOkResponse()
	@Get(ENDPOINTS.PRODUCTS.VARIANT_COUNT)
	@ApiOperation(API_OPERATION.PRODUCTS.VARIANT_COUNT)
	getVariantCount() {
		return this.productService.getVariantCount()
	}

	// JwtAuthGuard must come first — RolesGuard reads req.user.role, which only exists
	// once the JWT has been validated.
	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.ADAPTED_READ })
	// Adapted read (TD-0013): visible product categories only, v2 products in the legacy shape.
	@CatalogReadOnlyPost()
	@CatalogAdaptedRead()
	@ApiCreatedResponse()
	@Post(ENDPOINTS.PRODUCTS.PRICE_LIST_PDF)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.PRICE_LIST_PDF)
	async generatePriceListPdf(@Body() dto: GeneratePriceListDto) {
		const { buffer, filename } = await this.priceListService.generatePdf(dto)
		return new StreamableFile(buffer, {
			type: 'application/pdf',
			disposition: `attachment; filename="${filename}"`,
			length: buffer.length
		})
	}

	// The raw product document carries `vendor_id` — which supplier the product is bought from —
	// so it is admin-only like the variant reads: supplier fields leave the backend through no
	// public route, without exception. The storefront reads `/products/by-slug/:slug`.
	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_READ })
	@ApiOkResponse()
	@Get(ENDPOINTS.PRODUCTS.GET_BY_ID)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.GET_BY_ID)
	findById(@Param('id') id: string) {
		return this.productService.findById(id)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_READ })
	@CatalogReadOnlyPost()
	@ApiCreatedResponse()
	@Post(ENDPOINTS.PRODUCTS.VALIDATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.VALIDATE)
	validate(@Body() dto: ValidateProductDto) {
		return this.productService.validate(dto)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiCreatedResponse()
	@Post(ENDPOINTS.PRODUCTS.CREATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.CREATE)
	create(@Body() dto: CreateProductDto) {
		return this.productService.create(dto)
	}

	// Raw variant documents carry supplier identifiers (vendor_product_sku, prom_id) that the
	// admin editor needs but the public API must never expose — hence ADMIN-only.
	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_READ })
	@ApiOkResponse()
	@Get(ENDPOINTS.PRODUCTS.VARIANTS)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.GET_VARIANTS)
	getVariants(@Param('id') id: string) {
		return this.productService.getVariants(id)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_READ })
	@ApiOkResponse()
	@Get(ENDPOINTS.PRODUCTS.VARIANT)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.GET_VARIANT)
	getVariant(@Param('id') id: string, @Param('variantId') variantId: string) {
		return this.productService.getVariant(id, variantId)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiCreatedResponse()
	@Post(ENDPOINTS.PRODUCTS.VARIANTS)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.ADD_VARIANT)
	addVariant(@Param('id') id: string, @Body() dto: AddVariantDto) {
		return this.productService.addVariant(id, dto)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiOkResponse()
	@Patch(ENDPOINTS.PRODUCTS.PROMOTION)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.SET_PROMOTION)
	setPromotion(@Param('id') id: string, @Body() dto: SetProductPromotionDto) {
		return this.productService.setProductPromotion(id, dto)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiOkResponse()
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

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiOkResponse()
	@Delete(ENDPOINTS.PRODUCTS.VARIANT)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.DELETE_VARIANT)
	deleteVariant(@Param('id') id: string, @Param('variantId') variantId: string) {
		return this.productService.deleteVariant(id, variantId)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiOkResponse()
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

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiOkResponse()
	@Patch(ENDPOINTS.PRODUCTS.UPDATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.UPDATE)
	update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
		return this.productService.update(id, dto)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiOkResponse()
	@Delete(ENDPOINTS.PRODUCTS.DELETE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PRODUCTS.DELETE)
	delete(@Param('id') id: string) {
		return this.productService.delete(id)
	}
}
