import { OmitType, PartialType } from '@nestjs/swagger'
import { CreatePaymentProviderDto } from './create-payment-provider.dto'

// `provider` is immutable after creation; everything else is optionally updatable.
export class UpdatePaymentProviderDto extends PartialType(
	OmitType(CreatePaymentProviderDto, ['provider'] as const)
) {}
