import { CategoryPublicReadService } from './category-public-read.service'
import { CategoryPublicationController, CategoryPublicationService } from './category-publication'
import {
	CatalogOperationController,
	CategoryDraftPlacementController,
	CategoryDraftPlacementService
} from './category-draft-placement'
import { CategoryTreeController } from './category-tree.controller'
import { CategoryTreeReadService } from './category-tree-read.service'
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Category, CategorySchema } from 'src/database/mongoose/schemas/category.schema'
import { CategoryRepository } from 'src/database/mongoose/repositories/category.repository'
import { CategoryService } from './category.service'
import { CategoryController } from './category.controller'
import { CategorySeoController, CategorySeoService } from './category-seo'
import { CategoryExportController, CategoryExportService } from './category-export'

@Module({
	imports: [MongooseModule.forFeature([{ name: Category.name, schema: CategorySchema }])],
	controllers: [
		CatalogOperationController,
		CategoryPublicationController,
		CategoryDraftPlacementController,
		CategoryTreeController,
		CategorySeoController,
		CategoryExportController,
		CategoryController
	],
	providers: [
		CategorySeoService,
		CategoryExportService,
		CategoryPublicReadService,
		CategoryPublicationService,
		CategoryDraftPlacementService,
		CategoryService,
		CategoryRepository,
		CategoryTreeReadService
	],
	exports: [CategoryService, CategoryRepository, CategoryPublicReadService]
})
export class CategoryModule {}
