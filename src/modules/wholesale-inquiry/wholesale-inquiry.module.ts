import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { WholesaleInquiryRepository } from 'src/database/mongoose/repositories/wholesale-inquiry.repository'
import {
	WholesaleInquiry,
	WholesaleInquirySchema
} from 'src/database/mongoose/schemas/wholesale-inquiry.schema'
import { EmailModule } from '../email/email.module'
import { WholesaleInquiryController } from './wholesale-inquiry.controller'
import { WholesaleInquiryService } from './wholesale-inquiry.service'

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: WholesaleInquiry.name, schema: WholesaleInquirySchema }
		]),
		EmailModule
	],
	controllers: [WholesaleInquiryController],
	providers: [WholesaleInquiryService, WholesaleInquiryRepository],
	exports: [WholesaleInquiryService]
})
export class WholesaleInquiryModule {}
