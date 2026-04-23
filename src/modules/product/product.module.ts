import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Product, ProductSchema } from 'src/database/mongoose/schemas/product.schema'
import {
	ProductVariant,
	ProductVariantSchema
} from 'src/database/mongoose/schemas/product-variant.schema'
import { ProductRepository } from 'src/database/mongoose/repositories/product.repository'
import { ProductVariantRepository } from 'src/database/mongoose/repositories/product-variant.repository'
import { NumbersModule } from 'src/modules/numbers/numbers.module'
import { ProductService } from './product.service'
import { ProductController } from './product.controller'

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: Product.name, schema: ProductSchema },
			{ name: ProductVariant.name, schema: ProductVariantSchema }
		]),
		NumbersModule
	],
	controllers: [ProductController],
	providers: [ProductService, ProductRepository, ProductVariantRepository],
	exports: [ProductService, ProductRepository, ProductVariantRepository]
})
export class ProductModule {}
