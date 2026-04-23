import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { Product } from '../schemas/product.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class ProductRepository extends BaseRepository<Product> {
	constructor(@InjectModel(Product.name) model: Model<Product>) {
		super(model)
	}

	findByCategoryId(categoryId: string): Promise<Product[]> {
		return this.findAll({ category_id: new Types.ObjectId(categoryId) })
	}

	findBySubcategoryId(subcategoryId: string): Promise<Product[]> {
		return this.findAll({ subcategory_id: new Types.ObjectId(subcategoryId) })
	}

	findByVendorId(vendorId: string): Promise<Product[]> {
		return this.findAll({ vendor_id: new Types.ObjectId(vendorId) })
	}
}
