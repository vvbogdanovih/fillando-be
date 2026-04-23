import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { MongooseModule } from '@nestjs/mongoose'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'
import { UserRepository } from 'src/database/mongoose/repositories/user.repository'
import { RefreshTokenRepository } from 'src/database/mongoose/repositories/refresh-token.repository'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtStrategy } from '../../common/strategies/jwt.strategy'
import { GoogleStrategy } from '../../common/strategies/google.strategy'
import { AccessTokenLifetime, ENV } from 'src/common/constants'
import { User, UserSchema } from 'src/database/mongoose/schemas/user.schema'
import {
	RefreshToken,
	RefreshTokenSchema
} from 'src/database/mongoose/schemas/refresh-token.schema'

@Module({
	imports: [
		PassportModule,
		JwtModule.registerAsync({
			imports: [ConfigModule],
			inject: [ConfigService],
			useFactory: async () => ({
				secret: ENV.JWT_SECRET,
				signOptions: { expiresIn: AccessTokenLifetime.sec }
			})
		}),
		MongooseModule.forFeature([
			{ name: User.name, schema: UserSchema },
			{ name: RefreshToken.name, schema: RefreshTokenSchema }
		])
	],
	controllers: [AuthController],
	providers: [AuthService, JwtStrategy, GoogleStrategy, UserRepository, RefreshTokenRepository],
	exports: [AuthService]
})
export class AuthModule {}
