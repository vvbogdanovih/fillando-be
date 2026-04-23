import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common'
import { UserRepository } from 'src/database/mongoose/repositories/user.repository'
import { JWTPayload } from 'src/common/types/jwt-payload'
import { UpdateMeDto } from './dto/update-me.dto'

@Injectable()
export class UsersService {
	constructor(private readonly userRepository: UserRepository) {}

	async getMe(user: JWTPayload) {
		const found = await this.userRepository.findById(user.id)
		if (!found) throw new NotFoundException('Користувача не знайдено')

		return {
			id: found.id,
			email: found.email,
			name: found.name,
			role: found.role,
			phone: found.phone ?? null,
			picture: found.picture ?? null,
			authMethod: found.authMethod
		}
	}

	async updateMe(user: JWTPayload, dto: UpdateMeDto) {
		if (Object.keys(dto).length === 0) {
			throw new BadRequestException('Потрібно передати хоча б одне поле для оновлення')
		}

		const normalizedPhone = dto.phone === null ? undefined : dto.phone?.trim()
		if (normalizedPhone) {
			const phoneOwner = await this.userRepository.findByPhone(normalizedPhone)
			if (phoneOwner && phoneOwner.id !== user.id) {
				throw new ConflictException('Телефон вже використовується іншим користувачем')
			}
		}

		const updated = await this.userRepository.update(
			{ _id: user.id },
			{
				...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
				...(dto.phone !== undefined ? { phone: normalizedPhone } : {}),
				...(dto.picture !== undefined
					? { picture: dto.picture === null ? undefined : dto.picture.trim() }
					: {})
			}
		)

		if (!updated) throw new NotFoundException('Користувача не знайдено')

		return {
			id: updated.id,
			email: updated.email,
			name: updated.name,
			role: updated.role,
			phone: updated.phone ?? null,
			picture: updated.picture ?? null,
			authMethod: updated.authMethod
		}
	}
}
