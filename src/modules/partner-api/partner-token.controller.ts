import {
	Body,
	Controller,
	Delete,
	Get,
	Header,
	HttpCode,
	Param,
	Post,
	Req,
	UseGuards
} from '@nestjs/common'
import {
	ApiCreatedResponse,
	ApiNoContentResponse,
	ApiOkResponse,
	ApiOperation,
	ApiTags
} from '@nestjs/swagger'
import { Request } from 'express'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { PartnerApiService } from './partner-api.service'
import { CreatedPartnerTokenDto, CreatePartnerTokenDto, PartnerTokenDto } from './partner-api.dto'
@Controller(ENDPOINTS.PARTNER_TOKENS.BASE)
@ApiTags('Partner API tokens (admin)')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class PartnerTokenController {
	constructor(private readonly service: PartnerApiService) {}
	@Get()
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PARTNER_API.LIST_TOKENS)
	@ApiOkResponse({ type: PartnerTokenDto, isArray: true })
	list() {
		return this.service.list()
	}
	@Post()
	@Header('Cache-Control', 'no-store')
	@ApiOperation(API_OPERATION.PARTNER_API.CREATE_TOKEN)
	@ApiCreatedResponse({ type: CreatedPartnerTokenDto })
	create(@Body() dto: CreatePartnerTokenDto, @Req() req: Request & { user: { id: string } }) {
		return this.service.create(dto.name, req.user.id)
	}
	@Delete(ENDPOINTS.PARTNER_TOKENS.REVOKE)
	@HttpCode(204)
	@ApiOperation(API_OPERATION.PARTNER_API.REVOKE_TOKEN)
	@ApiNoContentResponse()
	revoke(@Param('id') id: string) {
		return this.service.revoke(id)
	}
}
