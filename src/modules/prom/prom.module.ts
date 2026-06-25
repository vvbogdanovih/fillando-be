import { Module } from '@nestjs/common'
import { ProductModule } from '../product/product.module'
import { PromController } from './prom.controller'
import { PromService } from './prom.service'
import { PromSyncService } from './prom-sync.service'
import { PromCronService } from './prom-cron.service'

@Module({
	imports: [ProductModule],
	controllers: [PromController],
	providers: [PromService, PromSyncService, PromCronService]
})
export class PromModule {}
