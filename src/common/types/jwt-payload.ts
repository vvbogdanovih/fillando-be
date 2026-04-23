import { User } from './user'

export type JWTPayload = Omit<User, 'picture'>
