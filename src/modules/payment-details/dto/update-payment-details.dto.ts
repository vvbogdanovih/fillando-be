import { PartialType } from '@nestjs/swagger'
import { CreatePaymentDetailsDto } from './create-payment-details.dto'

export class UpdatePaymentDetailsDto extends PartialType(CreatePaymentDetailsDto) {}
