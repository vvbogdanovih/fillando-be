import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common'
import {
	ApiBadRequestResponse,
	ApiConflictResponse,
	ApiNotFoundResponse,
	ApiOkResponse,
	ApiOperation,
	ApiServiceUnavailableResponse,
	ApiTags
} from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { CategoryTreeReadService } from './category-tree-read.service'
import { CategoryPublicReadService } from './category-public-read.service'
import {
	CategoryAncestorsPageDto,
	CategoryChildrenQueryDto,
	CategoryOptionsPageDto,
	CategoryTreePageDto,
	CategoryTreeQueryDto
} from './dto/category-tree.dto'

const BAD_PAGE = 'Invalid limit or cursor (a cursor of another read, audience or scope)'
const CURSOR_CONFLICT =
	'CATEGORY_REVISION_CONFLICT — the catalogue changed since the cursor; restart from page 1'
const TREE_UNAVAILABLE =
	'Catalogue maintenance, missing control, a tree that needs repair or a change during the read'

@Controller(ENDPOINTS.CATEGORIES.BASE)
@ApiTags(ENDPOINTS.CATEGORIES.BASE)
export class CategoryTreeController {
	constructor(
		private readonly tree: CategoryTreeReadService,
		private readonly publicCategories: CategoryPublicReadService
	) {}
	@Get(ENDPOINTS.CATEGORIES.TREE)
	@ApiOperation(API_OPERATION.CATEGORIES.TREE)
	@ApiOkResponse({ type: CategoryTreePageDto })
	@ApiBadRequestResponse({ description: BAD_PAGE })
	@ApiConflictResponse({ description: CURSOR_CONFLICT })
	@ApiServiceUnavailableResponse({ description: TREE_UNAVAILABLE })
	read(@Query() query: CategoryTreeQueryDto) {
		return this.tree.read(query, false)
	}

	@Get(ENDPOINTS.CATEGORIES.CHILDREN)
	@ApiOperation(API_OPERATION.CATEGORIES.CHILDREN)
	@ApiOkResponse({ type: CategoryTreePageDto })
	@ApiBadRequestResponse({ description: BAD_PAGE })
	@ApiConflictResponse({ description: CURSOR_CONFLICT })
	@ApiServiceUnavailableResponse({ description: TREE_UNAVAILABLE })
	@ApiNotFoundResponse({ description: 'Unknown or hidden parent' })
	children(@Query() query: CategoryChildrenQueryDto) {
		return this.tree.read(query, false, query.parent_id?.toLowerCase() ?? null)
	}

	@Get(ENDPOINTS.CATEGORIES.OPTIONS)
	@ApiOperation(API_OPERATION.CATEGORIES.OPTIONS)
	@ApiOkResponse({ type: CategoryOptionsPageDto })
	@ApiBadRequestResponse({ description: BAD_PAGE })
	@ApiConflictResponse({ description: CURSOR_CONFLICT })
	@ApiServiceUnavailableResponse({ description: TREE_UNAVAILABLE })
	options(@Query() query: CategoryTreeQueryDto) {
		return this.tree.readOptions(query)
	}

	@Get(ENDPOINTS.CATEGORIES.ANCESTORS)
	@ApiOperation(API_OPERATION.CATEGORIES.ANCESTORS)
	@ApiOkResponse({ type: CategoryAncestorsPageDto })
	@ApiBadRequestResponse({ description: BAD_PAGE })
	@ApiConflictResponse({
		description:
			'The path or the catalogue revision changed since the cursor; restart from page 1'
	})
	@ApiNotFoundResponse({ description: 'Unknown or not public category' })
	@ApiServiceUnavailableResponse({ description: TREE_UNAVAILABLE })
	ancestors(@Param('id') id: string, @Query() query: CategoryTreeQueryDto) {
		return this.publicCategories.ancestorsPage(id.toLowerCase(), query)
	}

	@Get(ENDPOINTS.CATEGORIES.ADMIN_TREE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.CATEGORIES.ADMIN_TREE)
	@ApiOkResponse({ type: CategoryTreePageDto })
	@ApiBadRequestResponse({ description: BAD_PAGE })
	@ApiConflictResponse({ description: CURSOR_CONFLICT })
	@ApiServiceUnavailableResponse({ description: TREE_UNAVAILABLE })
	admin(@Query() query: CategoryTreeQueryDto) {
		return this.tree.read(query, true)
	}
}
