import { ApiProperty } from '@nestjs/swagger'
import { IsString, IsNotEmpty } from 'class-validator'

export class SetTtnDto {
	@ApiProperty({ example: '20450081729182' })
	@IsString()
	@IsNotEmpty()
	nova_post_ttn: string
}
