import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { CategoryService } from './category.service'
import { CreateCategoryDto } from './dto/create-category.dto'
import { UpdateCategoryDto } from './dto/update-category.dto'

@Controller(ENDPOINTS.CATEGORIES.BASE)
@ApiTags(ENDPOINTS.CATEGORIES.BASE)
export class CategoryController {
	constructor(private readonly categoryService: CategoryService) {}

	@Get(ENDPOINTS.CATEGORIES.GET_ALL)
	@ApiOperation(API_OPERATION.CATEGORIES.GET_ALL)
	findAll() {
		return this.categoryService.findAll()
	}

	@Get(ENDPOINTS.CATEGORIES.GET_BY_SLUG)
	@ApiOperation(API_OPERATION.CATEGORIES.GET_BY_SLUG)
	findBySlug(@Param('slug') slug: string) {
		return this.categoryService.findBySlug(slug)
	}

	@Get(ENDPOINTS.CATEGORIES.GET_BY_ID)
	@ApiOperation(API_OPERATION.CATEGORIES.GET_BY_ID)
	findById(@Param('id') id: string) {
		return this.categoryService.findById(id)
	}

	@Post(ENDPOINTS.CATEGORIES.CREATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.CREATE)
	create(@Body() dto: CreateCategoryDto) {
		return this.categoryService.create(dto)
	}

	@Patch(ENDPOINTS.CATEGORIES.UPDATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.UPDATE)
	update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
		return this.categoryService.update(id, dto)
	}

	@Put(ENDPOINTS.CATEGORIES.REPLACE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.REPLACE)
	replace(@Param('id') id: string, @Body() dto: CreateCategoryDto) {
		return this.categoryService.replace(id, dto)
	}

	@Delete(ENDPOINTS.CATEGORIES.DELETE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.DELETE)
	delete(@Param('id') id: string) {
		return this.categoryService.delete(id)
	}
}
