import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { LoggerModule } from 'nestjs-pino'

import { AuthModule } from './modules/auth/auth.module'
import { VendorModule } from './modules/vendor/vendor.module'
import { CategoryModule } from './modules/category/category.module'
import { ProductModule } from './modules/product/product.module'
import { UploadModule } from './modules/upload/upload.module'
import { NumbersModule } from './modules/numbers/numbers.module'
import { CartModule } from './modules/cart/cart.module'
import { EmailModule } from './modules/email/email.module'
import { PaymentDetailsModule } from './modules/payment-details/payment-details.module'
import { NovaPostModule } from './modules/nova-post/nova-post.module'
import { OrderModule } from './modules/order/order.module'
import { DiscountCouponModule } from './modules/discount-coupon/discount-coupon.module'
import { UsersModule } from './modules/users/users.module'
import { ENV } from './common/constants'

@Module({
	imports: [
		LoggerModule.forRoot({
			pinoHttp: {
				level: ENV.LOG_LEVEL,
				transport:
					ENV.NODE_ENV !== 'production'
						? { target: 'pino-pretty', options: { colorize: true } }
						: undefined,
				autoLogging: true
			}
		}),
		MongooseModule.forRoot(ENV.DATABASE_URL),
		AuthModule,
		VendorModule,
		CategoryModule,
		ProductModule,
		UploadModule,
		NumbersModule,
		CartModule,
		EmailModule,
		PaymentDetailsModule,
		NovaPostModule,
		OrderModule,
		DiscountCouponModule,
		UsersModule
	],
	controllers: [],
	providers: [],
	exports: []
})
export class AppModule {}
