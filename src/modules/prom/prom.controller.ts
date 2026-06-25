import { Controller, MessageEvent, Sse, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { Observable } from 'rxjs'
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { ENDPOINTS } from 'src/common/constants/endpoints.constant'
import { API_OPERATION } from 'src/common/constants/docs/api-operation.constant'
import { PromSyncService } from './prom-sync.service'

@ApiTags(ENDPOINTS.PROM.BASE)
@Controller(ENDPOINTS.PROM.BASE)
export class PromController {
	constructor(
		@InjectPinoLogger(PromController.name) private readonly logger: PinoLogger,
		private readonly syncService: PromSyncService
	) {}

	@Sse(ENDPOINTS.PROM.SYNC_AVAILABILITY)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.PROM.SYNC_AVAILABILITY)
	syncAvailability(): Observable<MessageEvent> {
		this.logger.info('Manual Prom availability sync triggered')
		return this.syncService.syncWithProgress()
	}
}
