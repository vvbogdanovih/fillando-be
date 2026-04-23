import { ApiProperty } from '@nestjs/swagger'
import { IsArray, IsOptional, IsString } from 'class-validator'

export class ValidateProductDto {
	@ApiProperty({ example: ['futbolka-bazova-chorna', 'futbolka-bazova-bila'], required: false })
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	slugs: string[] = []

	@ApiProperty({ example: ['SKU-001', 'SKU-002'], required: false })
	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	skus: string[] = []
}

export class ValidateProductResponseDto {
	@ApiProperty({
		example: ['futbolka-bazova-chorna'],
		description: 'Slugs that are already taken'
	})
	slugs: string[]

	@ApiProperty({ example: ['SKU-001'], description: 'SKUs that are already taken' })
	skus: string[]
}
