import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Color, ColorSchema } from 'src/database/mongoose/schemas/color.schema'
import { ColorRepository } from 'src/database/mongoose/repositories/color.repository'
import { ProductModule } from 'src/modules/product/product.module'
import { ColorService } from './color.service'
import { ColorController } from './color.controller'

@Module({
	// ProductModule for ProductVariantRepository: changing a colour's family rewrites the
	// denormalized color_family on its variants.
	imports: [
		MongooseModule.forFeature([{ name: Color.name, schema: ColorSchema }]),
		ProductModule
	],
	controllers: [ColorController],
	providers: [ColorService, ColorRepository],
	exports: [ColorService, ColorRepository]
})
export class ColorModule {}
