import { Type } from 'class-transformer'
import { IsArray, IsEnum, IsMongoId, IsNotEmpty, ValidateNested } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { API_PROPERTY } from 'src/common/constants'

export enum UploadEntityType {
	PRODUCT = 'product',
	USER = 'user',
	VENDOR = 'vendor',
	CATEGORY = 'category',
	/** The tile image a landing shows in the category's «Популярні види» block. */
	LANDING = 'landing'
}

export enum UploadContentType {
	JPEG = 'image/jpeg',
	PNG = 'image/png',
	WEBP = 'image/webp'
}

export class FilePresignRequestDto {
	@ApiProperty({ ...API_PROPERTY.UPLOAD_ENTITY_TYPE, enum: UploadEntityType })
	@IsEnum(UploadEntityType)
	entityType: UploadEntityType

	@ApiProperty(API_PROPERTY.UPLOAD_ENTITY_ID)
	@IsMongoId()
	entityId: string

	@ApiProperty({ ...API_PROPERTY.UPLOAD_CONTENT_TYPE, enum: UploadContentType })
	@IsEnum(UploadContentType)
	contentType: UploadContentType
}

export class PresignUploadDto {
	@ApiProperty({ type: [FilePresignRequestDto] })
	@IsArray()
	@IsNotEmpty()
	@ValidateNested({ each: true })
	@Type(() => FilePresignRequestDto)
	files: FilePresignRequestDto[]
}
