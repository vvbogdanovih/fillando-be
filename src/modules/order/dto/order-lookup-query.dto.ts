import { ApiProperty } from '@nestjs/swagger'
import { IsString, Matches } from 'class-validator'

export class OrderLookupQueryDto {
	@ApiProperty({
		example: '3f2a9c1e8b7d6f5a4c3b2a1908f7e6d5',
		description:
			'HMAC access token issued with the order (LiqPay result_url / create response). 32 lowercase hex chars.'
	})
	@IsString()
	@Matches(/^[a-f0-9]{32}$/, { message: 'token must be 32 lowercase hex characters' })
	token: string
}
