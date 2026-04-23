import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { Numbers, NumbersSchema } from 'src/database/mongoose/schemas/numbers.schema'
import { NumbersRepository } from 'src/database/mongoose/repositories/numbers.repository'

@Module({
	imports: [MongooseModule.forFeature([{ name: Numbers.name, schema: NumbersSchema }])],
	providers: [NumbersRepository],
	exports: [NumbersRepository]
})
export class NumbersModule {}
