import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { HydratedDocument, Model } from 'mongoose'
import { Vendor } from '../schemas/vendor.schema'
import { BaseRepository } from './base.repository'

@Injectable()
export class VendorRepository extends BaseRepository<Vendor> {
	constructor(@InjectModel(Vendor.name) model: Model<Vendor>) {
		super(model)
	}

	findBySlug(slug: string): Promise<HydratedDocument<Vendor> | null> {
		return this.findOne({ slug })
	}
}
