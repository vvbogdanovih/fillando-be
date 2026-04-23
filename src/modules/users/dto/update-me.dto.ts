import { ApiProperty } from '@nestjs/swagger'
import { IsOptional, IsString, Matches } from 'class-validator'
import { API_PROPERTY } from 'src/common/constants/docs'

export class UpdateMeDto {
	@ApiProperty({ ...API_PROPERTY.NAME, required: false })
	@IsOptional()
	@IsString({ message: "Ім'я має бути рядком" })
	name?: string

	@ApiProperty({ ...API_PROPERTY.PHONE, required: false, nullable: true })
	@IsOptional()
	@IsString({ message: 'Телефон має бути рядком' })
	@Matches(new RegExp(API_PROPERTY.PHONE.pattern), {
		message: 'Телефон має бути у форматі +380XXXXXXXXX'
	})
	phone?: string | null

	@ApiProperty({ ...API_PROPERTY.PICTURE, required: false, nullable: true })
	@IsOptional()
	@IsString({ message: 'Посилання на фото має бути рядком' })
	picture?: string | null
}
