import { ApiProperty } from '@nestjs/swagger'
import { AuthMethod, Role } from 'src/common/types/enums'

export class UserListItemDto {
	@ApiProperty({ example: '664f1b2c3d4e5f6a7b8c9d0e' })
	id: string

	@ApiProperty({ example: 'ivan@example.com' })
	email: string

	@ApiProperty({ example: 'Іван Петренко' })
	name: string

	@ApiProperty({ enum: Role })
	role: Role

	@ApiProperty({ example: '+380991234567', nullable: true })
	phone: string | null

	@ApiProperty({ enum: AuthMethod })
	authMethod: AuthMethod

	@ApiProperty()
	createdAt: Date
}

export class UsersListResponseDto {
	@ApiProperty({ type: [UserListItemDto] })
	items: UserListItemDto[]

	@ApiProperty({ example: 42 })
	total: number

	@ApiProperty({ example: 1 })
	page: number

	@ApiProperty({ example: 20 })
	limit: number
}
