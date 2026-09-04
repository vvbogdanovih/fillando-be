import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { LandingService } from './landing.service'
import { CreateLandingDto } from './dto/create-landing.dto'
import { UpdateLandingDto } from './dto/update-landing.dto'

@Controller(ENDPOINTS.LANDINGS.BASE)
@ApiTags(ENDPOINTS.LANDINGS.BASE)
export class LandingController {
	constructor(private readonly landingService: LandingService) {}

	// Route order matters: '/slugs' and '/admin' are declared before '/:id', which would
	// otherwise capture them as an id.
	@Get(ENDPOINTS.LANDINGS.GET_SLUGS)
	@ApiOperation(API_OPERATION.LANDINGS.GET_SLUGS)
	findSlugs() {
		return this.landingService.findActiveSlugs()
	}

	@Get(ENDPOINTS.LANDINGS.GET_ADMIN_ALL)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.LANDINGS.GET_ADMIN_ALL)
	@ApiQuery({ name: 'category_id', required: false })
	findAllForAdmin(@Query('category_id') categoryId?: string) {
		return this.landingService.findAllForAdmin(categoryId)
	}

	@Get(ENDPOINTS.LANDINGS.GET_BY_SLUG)
	@ApiOperation(API_OPERATION.LANDINGS.GET_BY_SLUG)
	findBySlugs(
		@Param('categorySlug') categorySlug: string,
		@Param('landingSlug') landingSlug: string
	) {
		return this.landingService.findActiveBySlugs(categorySlug, landingSlug)
	}

	@Get(ENDPOINTS.LANDINGS.GET_ALL)
	@ApiOperation(API_OPERATION.LANDINGS.GET_ALL)
	@ApiQuery({ name: 'category_id', required: false })
	findActive(@Query('category_id') categoryId?: string) {
		return this.landingService.findActive(categoryId)
	}

	@Get(ENDPOINTS.LANDINGS.GET_BY_ID)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.LANDINGS.GET_BY_ID)
	findById(@Param('id') id: string) {
		return this.landingService.findById(id)
	}

	@Post(ENDPOINTS.LANDINGS.CREATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.LANDINGS.CREATE)
	create(@Body() dto: CreateLandingDto) {
		return this.landingService.create(dto)
	}

	@Patch(ENDPOINTS.LANDINGS.UPDATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.LANDINGS.UPDATE)
	update(@Param('id') id: string, @Body() dto: UpdateLandingDto) {
		return this.landingService.update(id, dto)
	}

	@Delete(ENDPOINTS.LANDINGS.DELETE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.LANDINGS.DELETE)
	delete(@Param('id') id: string) {
		return this.landingService.delete(id)
	}
}
