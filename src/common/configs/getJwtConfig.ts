import { JwtModuleOptions } from '@nestjs/jwt'
import { AccessTokenLifetime, ENV } from '../constants'

export const getJwtConfig = async (): Promise<JwtModuleOptions> => ({
	secret: ENV.JWT_SECRET,
	signOptions: {
		expiresIn: AccessTokenLifetime.sec
	}
})
