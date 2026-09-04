import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Product, ProductSchema } from 'src/database/mongoose/schemas/product.schema'
import {
	ProductVariant,
	ProductVariantSchema
} from 'src/database/mongoose/schemas/product-variant.schema'
import { Color, ColorSchema } from 'src/database/mongoose/schemas/color.schema'
import { ColorRepository } from 'src/database/mongoose/repositories/color.repository'
import { ProductRepository } from 'src/database/mongoose/repositories/product.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { NumbersModule } from 'src/modules/numbers/numbers.module'
import { CategoryModule } from 'src/modules/category/category.module'
import { ProductService } from './product.service'
import { ProductController } from './product.controller'
import { PriceListService } from './price-list/price-list.service'
import { PriceListPdfProvider } from './price-list/price-list-pdf.provider'

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: Product.name, schema: ProductSchema },
			{ name: ProductVariant.name, schema: ProductVariantSchema },
			// Registered here rather than importing ColorModule: ColorModule already imports
			// this one (to backfill color_family), and the reverse would be a cycle.
			{ name: Color.name, schema: ColorSchema }
		]),
		NumbersModule,
		CategoryModule
	],
	controllers: [ProductController],
	providers: [
		ProductService,
		ProductRepository,
		ProductVariantRepository,
		ColorRepository,
		PriceListService,
		PriceListPdfProvider
	],
	exports: [ProductService, ProductRepository, ProductVariantRepository]
})
export class ProductModule {}
