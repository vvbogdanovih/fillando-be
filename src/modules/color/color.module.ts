import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Color, ColorSchema } from 'src/database/mongoose/schemas/color.schema'
import { ColorRepository } from 'src/database/mongoose/repositories/color.repository'
import { ProductModule } from 'src/modules/product/product.module'
import { ColorService } from './color.service'
import { ColorController } from './color.controller'
import { ColorAdminController, ColorAdminService } from './color-admin'

@Module({
	// ProductModule for ProductVariantRepository: changing a colour's family rewrites the
	// denormalized color_family on its variants.
	imports: [
		MongooseModule.forFeature([{ name: Color.name, schema: ColorSchema }]),
		ProductModule
	],
	// The journal-backed admin controller is registered first: its two-segment routes never
	// collide with the legacy `/:id`, but keeping the order explicit avoids surprises.
	controllers: [ColorAdminController, ColorController],
	providers: [ColorService, ColorRepository, ColorAdminService],
	exports: [ColorService, ColorRepository]
})
export class ColorModule {}
