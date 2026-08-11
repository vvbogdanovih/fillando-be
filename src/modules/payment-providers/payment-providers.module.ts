import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import {
	PaymentProviderCredentials,
	PaymentProviderSchema
} from 'src/database/mongoose/schemas/payment-provider.schema'
import { PaymentProviderRepository } from 'src/database/mongoose/repositories/payment-provider.repository'
import { PaymentProvidersService } from './payment-providers.service'
import { PaymentProvidersController } from './payment-providers.controller'

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: PaymentProviderCredentials.name, schema: PaymentProviderSchema }
		])
	],
	controllers: [PaymentProvidersController],
	providers: [PaymentProvidersService, PaymentProviderRepository],
	exports: [PaymentProvidersService]
})
export class PaymentProvidersModule {}
