import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Cart, CartSchema } from 'src/database/mongoose/schemas/cart.schema'
import { CartRepository } from 'src/database/mongoose/repositories/cart.repository'
import { ProductModule } from 'src/modules/product/product.module'
import { CartService } from './cart.service'
import { CartController } from './cart.controller'

@Module({
	imports: [MongooseModule.forFeature([{ name: Cart.name, schema: CartSchema }]), ProductModule],
	controllers: [CartController],
	providers: [CartService, CartRepository]
})
export class CartModule {}
