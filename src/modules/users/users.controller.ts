import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { JWTPayload } from 'src/common/types/jwt-payload'
import { UpdateMeDto } from './dto/update-me.dto'
import { UsersService } from './users.service'

@Controller(ENDPOINTS.USERS.BASE)
@ApiTags(ENDPOINTS.USERS.BASE)
@UseGuards(JwtAuthGuard)
export class UsersController {
	constructor(private readonly usersService: UsersService) {}

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
