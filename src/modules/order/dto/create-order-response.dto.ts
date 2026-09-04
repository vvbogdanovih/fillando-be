import { ApiPropertyOptional } from '@nestjs/swagger'
import { OrderResponseDto } from './order-response.dto'

export class CreateOrderResponseDto extends OrderResponseDto {
	@ApiPropertyOptional({
		example: '3f2a9c1e8b7d6f5a4c3b2a1f0e9d8c7b',
		description:
			'HMAC access token for GET /orders/lookup/:orderNumber. Present only when payment_method is LIQPAY; never persisted.'
	})
	payment_access_token?: string
}
