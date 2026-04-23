import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Vendor, VendorSchema } from 'src/database/mongoose/schemas/vendor.schema'
import { VendorRepository } from 'src/database/mongoose/repositories/vendor.repository'
import { VendorService } from './vendor.service'
import { VendorController } from './vendor.controller'

@Module({
	imports: [MongooseModule.forFeature([{ name: Vendor.name, schema: VendorSchema }])],
	controllers: [VendorController],
	providers: [VendorService, VendorRepository],
	exports: [VendorService, VendorRepository]
})
export class VendorModule {}
