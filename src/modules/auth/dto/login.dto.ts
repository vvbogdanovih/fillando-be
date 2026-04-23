import { ApiProperty } from '@nestjs/swagger'
import { IsString, IsEmail, MinLength } from 'class-validator'

import { API_PROPERTY } from 'src/common/constants/docs'

export class LoginDto {
	@ApiProperty(API_PROPERTY.EMAIL)
	@IsEmail({}, { message: 'Почта обовязкова' })
	email: string

	@ApiProperty(API_PROPERTY.PASSWORD)
	@IsString({ message: "Пароль обов'язковий" })
	@MinLength(API_PROPERTY.PASSWORD.minLength, {
		message: `Пароль повинен містити щонайменше ${API_PROPERTY.PASSWORD.minLength} символів`
	})
	password: string
}
