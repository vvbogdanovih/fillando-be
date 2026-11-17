import {
	CatalogAdaptedRead,
	LegacyCatalogController
} from '../catalog-safety/legacy-catalog-write.interceptor'
import { ApiCreatedResponse, ApiOkResponse, ApiServiceUnavailableResponse } from '@nestjs/swagger'
import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { API_OPERATION, CATALOG_UNAVAILABLE, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { ColorService } from './color.service'
import { CreateColorDto } from './dto/create-color.dto'
import { UpdateColorDto } from './dto/update-color.dto'

@LegacyCatalogController()
@Controller(ENDPOINTS.COLORS.BASE)
@ApiTags(ENDPOINTS.COLORS.BASE)
export class ColorController {
	constructor(private readonly colorService: ColorService) {}

	// The dictionary is public: the storefront needs it for the swatch filter and for the
	// "Чорний (Black)" labels. It holds no supplier or pricing data.
	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.TREE_FREE_READ })
	// Independent of the category tree, so readable while v2 categories exist (TD-0013).
	@CatalogAdaptedRead()
	@ApiOkResponse()
	@Get(ENDPOINTS.COLORS.GET_ALL)
	@ApiOperation(API_OPERATION.COLORS.GET_ALL)
	findAll() {
		return this.colorService.findAll()
	}

	// Route order matters: '/admin' is declared before '/:id', which would otherwise capture
	// it as an id.
	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.TREE_FREE_READ })
	// Tree-independent like the public list; the typed product editor picks colours from it.
	@CatalogAdaptedRead()
	@ApiOkResponse()
	@Get(ENDPOINTS.COLORS.GET_ADMIN_ALL)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.COLORS.GET_ADMIN_ALL)
	findAllForAdmin() {
		return this.colorService.findAllForAdmin()
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.TREE_FREE_READ })
	@CatalogAdaptedRead()
	@ApiOkResponse()
	@Get(ENDPOINTS.COLORS.GET_BY_ID)
	@ApiOperation(API_OPERATION.COLORS.GET_BY_ID)
	findById(@Param('id') id: string) {
		return this.colorService.findById(id)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiCreatedResponse()
	@Post(ENDPOINTS.COLORS.CREATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.COLORS.CREATE)
	create(@Body() dto: CreateColorDto) {
		return this.colorService.create(dto)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiOkResponse()
	@Patch(ENDPOINTS.COLORS.UPDATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.COLORS.UPDATE)
	update(@Param('id') id: string, @Body() dto: UpdateColorDto) {
		return this.colorService.update(id, dto)
	}

	@ApiServiceUnavailableResponse({ description: CATALOG_UNAVAILABLE.LEGACY_WRITE })
	@ApiOkResponse()
	@Delete(ENDPOINTS.COLORS.DELETE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.COLORS.DELETE)
	delete(@Param('id') id: string) {
		return this.colorService.delete(id)
	}
}
