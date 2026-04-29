import {
	BadRequestException,
	ConflictException,
	Injectable,
	NotFoundException
} from '@nestjs/common'
import { Types } from 'mongoose'
import { UserRepository } from 'src/database/mongoose/repositories/user.repository'
import { User } from 'src/database/mongoose/schemas/user.schema'
import { JWTPayload } from 'src/common/types/jwt-payload'
import { UpdateMeDto } from './dto/update-me.dto'
import { GetUsersQueryDto } from './dto/get-users-query.dto'

type LeanUser = User & { _id: Types.ObjectId; createdAt: Date }

@Injectable()
export class UsersService {
	constructor(private readonly userRepository: UserRepository) {}

	async findAll(query: GetUsersQueryDto) {
		const { page = 1, limit = 20, role } = query
		const filter: Record<string, unknown> = {}
		if (role) filter.role = role

		const skip = (page - 1) * limit
		const [items, total] = await Promise.all([
			this.userRepository.findAllPaginated(filter, skip, limit),
			this.userRepository.countDocuments(filter)
		])

		return {
			items: (items as LeanUser[]).map(user => ({
				id: user._id.toString(),
				email: user.email,
				name: user.name,
				role: user.role,
				phone: user.phone ?? null,
				authMethod: user.authMethod,
				createdAt: user.createdAt
			})),
			total,
			page,
			limit
		}
	}

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
