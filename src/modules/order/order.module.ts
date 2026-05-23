import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Order, OrderSchema } from 'src/database/mongoose/schemas/order.schema'
import {
	DiscountCoupon,
	DiscountCouponSchema
} from 'src/database/mongoose/schemas/discount-coupon.schema'
import { OrderRepository } from 'src/database/mongoose/repositories/order.repository'
import { DiscountCouponRepository } from 'src/database/mongoose/repositories/discount-coupon.repository'
import { NumbersModule } from 'src/modules/numbers/numbers.module'
import { ProductModule } from 'src/modules/product/product.module'
import { EmailModule } from 'src/modules/email/email.module'
import { OrderService } from './order.service'
import { OrderController } from './order.controller'
import { InvoicePdfProvider } from './invoice/invoice-pdf.provider'
import { ReportProvider } from './report/report.provider'

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: Order.name, schema: OrderSchema },
			{ name: DiscountCoupon.name, schema: DiscountCouponSchema }
		]),
		NumbersModule,
		ProductModule,
		EmailModule
	],
	controllers: [OrderController],
	providers: [
		OrderService,
		OrderRepository,
		DiscountCouponRepository,
		InvoicePdfProvider,
		ReportProvider
	]
})
export class OrderModule {}
