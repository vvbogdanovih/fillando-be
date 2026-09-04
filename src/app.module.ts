import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { ScheduleModule } from '@nestjs/schedule'
import { ThrottlerModule } from '@nestjs/throttler'
import { isInternalRequest } from './common/guards/internal-request.util'
import { LoggerModule } from 'nestjs-pino'
import { stdSerializers } from 'pino-http'

import { AuthModule } from './modules/auth/auth.module'
import { VendorModule } from './modules/vendor/vendor.module'
import { CategoryModule } from './modules/category/category.module'
import { ProductModule } from './modules/product/product.module'
import { UploadModule } from './modules/upload/upload.module'
import { NumbersModule } from './modules/numbers/numbers.module'
import { CartModule } from './modules/cart/cart.module'
import { EmailModule } from './modules/email/email.module'
import { PaymentDetailsModule } from './modules/payment-details/payment-details.module'
import { PaymentProvidersModule } from './modules/payment-providers/payment-providers.module'
import { LiqpayModule } from './modules/liqpay/liqpay.module'
import { NovaPostModule } from './modules/nova-post/nova-post.module'
import { PromModule } from './modules/prom/prom.module'
import { OrderModule } from './modules/order/order.module'
import { DiscountCouponModule } from './modules/discount-coupon/discount-coupon.module'
import { UsersModule } from './modules/users/users.module'
import { WholesaleInquiryModule } from './modules/wholesale-inquiry/wholesale-inquiry.module'
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
				autoLogging: true,
				// The order payment-status lookup carries its access token in the query string
				// and is polled by the success page — keep it (and auth material) out of logs.
				redact: {
					paths: ['req.query.token', 'req.headers.cookie', 'req.headers.authorization'],
					censor: '[redacted]'
				},
				serializers: {
					req: req => {
						const serialized = stdSerializers.req(req)
						serialized.url = serialized.url.replace(/([?&]token=)[^&]*/, '$1[redacted]')
						return serialized
					}
				}
			}
		}),
		// Rate limiting is opt-in per endpoint (@UseGuards(ThrottlerGuard) + @Throttle) — there is
		// deliberately no APP_GUARD: a global per-IP limit would throttle our own SSR traffic and
		// the public catalogue. `default` is the ceiling for any guarded handler without @Throttle.
		ThrottlerModule.forRoot({
			throttlers: [{ name: 'default', ttl: 60_000, limit: 20 }],
			skipIf: isInternalRequest
		}),
		MongooseModule.forRoot(ENV.DATABASE_URL),
		ScheduleModule.forRoot(),
		AuthModule,
		VendorModule,
		CategoryModule,
		ProductModule,
		UploadModule,
		NumbersModule,
		CartModule,
		EmailModule,
		PaymentDetailsModule,
		PaymentProvidersModule,
		LiqpayModule,
		NovaPostModule,
		PromModule,
		OrderModule,
		DiscountCouponModule,
		UsersModule,
		WholesaleInquiryModule
	],
	controllers: [],
	providers: [],
	exports: []
})
export class AppModule {}
