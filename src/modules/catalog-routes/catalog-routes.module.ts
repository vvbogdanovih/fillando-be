import { Module } from '@nestjs/common'
import { CategoryModule } from 'src/modules/category/category.module'
import { CatalogRoutesController, CatalogRoutesService } from './catalog-routes.controller'

/** Old addresses and redirect-backed slug changes (Plan-0010 B07). */
@Module({
	imports: [CategoryModule],
	controllers: [CatalogRoutesController],
	providers: [CatalogRoutesService]
})
export class CatalogRoutesModule {}
