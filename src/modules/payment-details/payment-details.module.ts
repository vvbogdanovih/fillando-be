import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import {
	PaymentDetails,
	PaymentDetailsSchema
} from 'src/database/mongoose/schemas/payment-details.schema'
import { PaymentDetailsRepository } from 'src/database/mongoose/repositories/payment-details.repository'
import { PaymentDetailsService } from './payment-details.service'
import { PaymentDetailsController } from './payment-details.controller'

@Module({
	imports: [
		MongooseModule.forFeature([{ name: PaymentDetails.name, schema: PaymentDetailsSchema }])
	],
	controllers: [PaymentDetailsController],
	providers: [PaymentDetailsService, PaymentDetailsRepository],
	exports: [PaymentDetailsService, PaymentDetailsRepository]
})
export class PaymentDetailsModule {}
