import { JwtModuleOptions } from '@nestjs/jwt'
import { AccessTokenLifetime, ENV } from '../constants'

export const getJwtConfig = (): Promise<JwtModuleOptions> =>
	Promise.resolve({
		secret: ENV.JWT_SECRET,
		signOptions: {
			expiresIn: AccessTokenLifetime.sec
		}
	})
