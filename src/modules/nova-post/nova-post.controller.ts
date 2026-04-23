import { Controller, Get, MessageEvent, Query, Sse, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger'
import { Observable } from 'rxjs'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { NovaPostWarehouseType, Role } from 'src/common/types/enums'
import { ENDPOINTS } from 'src/common/constants/endpoints.constant'
import { API_OPERATION } from 'src/common/constants/docs/api-operation.constant'
import { NovaPostService } from './nova-post.service'
import { NovaPostSyncService } from './nova-post-sync.service'
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino'

@ApiTags(ENDPOINTS.NOVA_POST.BASE)
@Controller(ENDPOINTS.NOVA_POST.BASE)
export class NovaPostController {
	constructor(
		@InjectPinoLogger(NovaPostController.name) private readonly logger: PinoLogger,
		private readonly novaPostService: NovaPostService,
		private readonly syncService: NovaPostSyncService
	) {}

	@Sse(ENDPOINTS.NOVA_POST.SYNC)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.NOVA_POST.SYNC)
	sync(): Observable<MessageEvent> {
		this.logger.info('Manual Nova Post sync triggered')
		return this.syncService.syncWithProgress()
	}

	@Get(ENDPOINTS.NOVA_POST.CITIES)
	@ApiOperation(API_OPERATION.NOVA_POST.CITIES)
	getCities(@Query('q') q: string) {
		if (!q || q.length < 2) return []
		return this.novaPostService.searchCities(q)
	}

	@Get(ENDPOINTS.NOVA_POST.WAREHOUSES)
	@ApiOperation(API_OPERATION.NOVA_POST.WAREHOUSES)
	@ApiQuery({ name: 'cityRef', required: true })
	@ApiQuery({ name: 'type', enum: NovaPostWarehouseType, required: false })
	@ApiQuery({
		name: 'q',
		required: false,
		description:
			'Optional search: warehouse number (substring on numeric №) and/or fragment of description / short address. Case-insensitive for text; trim and repeated spaces collapsed; word gaps match flexibly. Omit or leave blank for all warehouses in the city (and type).'
	})
	getWarehouses(
		@Query('cityRef') cityRef: string,
		@Query('type') type?: NovaPostWarehouseType,
		@Query('q') q?: string
	) {
		if (!cityRef) return []
		return this.novaPostService.getWarehouses(cityRef, type, q)
	}
}
