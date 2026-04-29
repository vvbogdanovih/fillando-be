import { Body, Controller, Get, Patch, Query, Req, UseGuards } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Roles } from 'src/common/decorators/roles.decorator'
import { Role } from 'src/common/types/enums'
import { JWTPayload } from 'src/common/types/jwt-payload'
import { UpdateMeDto } from './dto/update-me.dto'
import { GetUsersQueryDto } from './dto/get-users-query.dto'
import { UsersListResponseDto } from './dto/users-list-response.dto'
import { UsersService } from './users.service'

@Controller(ENDPOINTS.USERS.BASE)
@ApiTags(ENDPOINTS.USERS.BASE)
@UseGuards(JwtAuthGuard)
export class UsersController {
	constructor(private readonly usersService: UsersService) {}

	@Get(ENDPOINTS.USERS.GET_ALL)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.USERS.GET_ALL)
	@ApiOkResponse({ type: UsersListResponseDto })
	findAll(@Query() query: GetUsersQueryDto) {
		return this.usersService.findAll(query)
	}

	@Get(ENDPOINTS.USERS.ME)
	@ApiOperation(API_OPERATION.USERS.ME)
	async me(@Req() req: Request) {
		const user = await this.usersService.getMe(req.user as JWTPayload)
		return { message: 'Profile fetched successfully', user }
	}

	@Patch(ENDPOINTS.USERS.ME)
	@ApiOperation(API_OPERATION.USERS.UPDATE_ME)
	async updateMe(@Req() req: Request, @Body() dto: UpdateMeDto) {
		const user = await this.usersService.updateMe(req.user as JWTPayload, dto)
		return { message: 'Profile updated successfully', user }
	}
}
