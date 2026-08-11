import { Module } from '@nestjs/common'
import { OrderModule } from 'src/modules/order/order.module'
import { PaymentProvidersModule } from 'src/modules/payment-providers/payment-providers.module'
import { LiqpayService } from './liqpay.service'
import { LiqpayController } from './liqpay.controller'

@Module({
	imports: [OrderModule, PaymentProvidersModule],
	controllers: [LiqpayController],
	providers: [LiqpayService]
})
export class LiqpayModule {}
