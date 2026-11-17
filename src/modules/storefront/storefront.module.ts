import { Module } from '@nestjs/common'
import { CategoryModule } from 'src/modules/category/category.module'
import { StorefrontSettingsController, StorefrontSettingsService } from './storefront-settings'

/** Storefront settings (Plan-0010 B09): home categories, collections, the `/catalog` intro. */
@Module({
	imports: [CategoryModule],
	controllers: [StorefrontSettingsController],
	providers: [StorefrontSettingsService]
})
export class StorefrontModule {}
