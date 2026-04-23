import { Body, Controller, Delete, Post, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { UploadService } from './upload.service'
import { PresignUploadDto } from './dto/presign-upload.dto'
import { ConfirmUploadDto } from './dto/confirm-upload.dto'
import { DeleteUploadDto } from './dto/delete-upload.dto'

@Controller(ENDPOINTS.UPLOAD.BASE)
@ApiTags(ENDPOINTS.UPLOAD.BASE)
@UseGuards(JwtAuthGuard)
export class UploadController {
	constructor(
		@InjectPinoLogger(UploadController.name)
		private readonly logger: PinoLogger,
		private readonly uploadService: UploadService
	) {}

	@Post(ENDPOINTS.UPLOAD.PRESIGN)
	@ApiOperation(API_OPERATION.UPLOAD.PRESIGN)
	presign(@Body() dto: PresignUploadDto) {
		return this.uploadService.generatePresignedUrls(dto.files)
	}

	@Post(ENDPOINTS.UPLOAD.CONFIRM)
	@ApiOperation(API_OPERATION.UPLOAD.CONFIRM)
	confirm(@Body() dto: ConfirmUploadDto) {
		return this.uploadService.confirmUploads(dto.keys)
	}

	@Delete(ENDPOINTS.UPLOAD.DELETE)
	@ApiOperation(API_OPERATION.UPLOAD.DELETE)
	delete(@Body() dto: DeleteUploadDto) {
		return this.uploadService.deleteFiles(dto.keys)
	}
}
