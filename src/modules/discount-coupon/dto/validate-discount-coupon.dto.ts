import { ApiProperty } from '@nestjs/swagger'
import { IsString, Matches } from 'class-validator'

export class ValidateDiscountCouponDto {
	@ApiProperty({ example: 'ZY64GM08WT' })
	@IsString()
	@Matches(/^[A-Za-z0-9]{10}$/, {
		message: 'code must contain exactly 10 letters or digits'
	})
	code: string
}
