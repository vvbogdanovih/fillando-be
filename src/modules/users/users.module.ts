import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { UserRepository } from 'src/database/mongoose/repositories/user.repository'
import { User, UserSchema } from 'src/database/mongoose/schemas/user.schema'
import { UsersController } from './users.controller'
import { UsersService } from './users.service'

@Module({
	imports: [MongooseModule.forFeature([{ name: User.name, schema: UserSchema }])],
	controllers: [UsersController],
	providers: [UsersService, UserRepository],
	exports: [UsersService]
})
export class UsersModule {}
