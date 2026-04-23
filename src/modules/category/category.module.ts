import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Category, CategorySchema } from 'src/database/mongoose/schemas/category.schema'
import { CategoryRepository } from 'src/database/mongoose/repositories/category.repository'
import { CategoryService } from './category.service'
import { CategoryController } from './category.controller'

@Module({
	imports: [MongooseModule.forFeature([{ name: Category.name, schema: CategorySchema }])],
	controllers: [CategoryController],
	providers: [CategoryService, CategoryRepository],
	exports: [CategoryService, CategoryRepository]
})
export class CategoryModule {}
