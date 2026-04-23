import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'
import { AuthMethod, Role } from 'src/common/types/enums'

@Schema({ collection: 'users', timestamps: true })
export class User {
	@Prop({ required: true, unique: true })
	email: string

	@Prop()
	password?: string

	@Prop({ required: true })
	name: string

	@Prop({ type: String, enum: Role, default: Role.USER })
	role: Role

	@Prop({ unique: true, sparse: true })
	phone?: string

	@Prop()
	picture?: string

	@Prop({ type: String, enum: AuthMethod, default: AuthMethod.EMAIL })
	authMethod: AuthMethod
}

export const UserSchema = SchemaFactory.createForClass(User)
export type UserDocument = HydratedDocument<User>
