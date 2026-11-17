import { CategoryPublicDto } from './dto/category-public.dto'
import {
	CatalogAdaptedRead,
	LegacyCatalogController
} from '../catalog-safety/legacy-catalog-write.interceptor'
import { ApiCreatedResponse, ApiServiceUnavailableResponse } from '@nestjs/swagger'
import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { API_OPERATION, CATALOG_UNAVAILABLE, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { CategoryService } from './category.service'
import { CreateCategoryDto } from './dto/create-category.dto'
import { UpdateCategoryDto } from './dto/update-category.dto'

@LegacyCatalogController()
@Controller(ENDPOINTS.CATEGORIES.BASE)
@ApiTags(ENDPOINTS.CATEGORIES.BASE)
export class CategoryController {
	constructor(private readonly categoryService: CategoryService) {}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.ADAPTED_READ })
	@CatalogAdaptedRead()
	@Get(ENDPOINTS.CATEGORIES.GET_ALL)
	@ApiOperation(API_OPERATION.CATEGORIES.GET_ALL)
	@ApiOkResponse({ type: [CategoryPublicDto] })
	findAll() {
		return this.categoryService.findAll()
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.ADAPTED_READ })
	@CatalogAdaptedRead()
	@Get(ENDPOINTS.CATEGORIES.GET_BY_SLUG)
	@ApiOperation(API_OPERATION.CATEGORIES.GET_BY_SLUG)
	@ApiOkResponse({ type: CategoryPublicDto })
	findBySlug(@Param('slug') slug: string) {
		return this.categoryService.findBySlug(slug)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.ADAPTED_READ })
	@CatalogAdaptedRead()
	@Get(ENDPOINTS.CATEGORIES.GET_BY_ID)
	@ApiOperation(API_OPERATION.CATEGORIES.GET_BY_ID)
	@ApiOkResponse({ type: CategoryPublicDto })
	findById(@Param('id') id: string) {
		return this.categoryService.findById(id)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiCreatedResponse()
	@Post(ENDPOINTS.CATEGORIES.CREATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.CREATE)
	create(@Body() dto: CreateCategoryDto) {
		return this.categoryService.create(dto)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiOkResponse()
	@Patch(ENDPOINTS.CATEGORIES.UPDATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.UPDATE)
	update(@Param('id') id: string, @Body() dto: UpdateCategoryDto) {
		return this.categoryService.update(id, dto)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiOkResponse()
	@Put(ENDPOINTS.CATEGORIES.REPLACE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.REPLACE)
	replace(@Param('id') id: string, @Body() dto: CreateCategoryDto) {
		return this.categoryService.replace(id, dto)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiOkResponse()
	@Delete(ENDPOINTS.CATEGORIES.DELETE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.DELETE)
	delete(@Param('id') id: string) {
		return this.categoryService.delete(id)
	}
}
