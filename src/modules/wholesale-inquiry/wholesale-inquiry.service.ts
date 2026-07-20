import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Types } from 'mongoose'
import { WholesaleInquiryRepository } from 'src/database/mongoose/repositories/wholesale-inquiry.repository'
import { WholesaleInquiry } from 'src/database/mongoose/schemas/wholesale-inquiry.schema'
import { EmailService } from '../email/email.service'
import { CreateWholesaleInquiryDto } from './dto/create-wholesale-inquiry.dto'
import { GetWholesaleInquiriesQueryDto } from './dto/get-wholesale-inquiries-query.dto'
import { UpdateWholesaleInquiryStatusDto } from './dto/update-wholesale-inquiry-status.dto'

type LeanWholesaleInquiry = WholesaleInquiry & { _id: Types.ObjectId; createdAt: Date }

@Injectable()
export class WholesaleInquiryService {
	private readonly logger = new Logger(WholesaleInquiryService.name)

	constructor(
		private readonly wholesaleInquiryRepository: WholesaleInquiryRepository,
		private readonly emailService: EmailService
	) {}

	async create(dto: CreateWholesaleInquiryDto) {
		const inquiry = await this.wholesaleInquiryRepository.create({
			name: dto.name.trim(),
			phone: dto.phone.trim(),
			email: dto.email.trim(),
			quantity: dto.quantity.trim(),
			comment: dto.comment?.trim() || null
		})

		// Заявка вже збережена — падіння пошти не має фейлити запит
		this.emailService
			.sendWholesaleInquiryNotification({
				name: inquiry.name,
				phone: inquiry.phone,
				email: inquiry.email,
				quantity: inquiry.quantity,
				comment: inquiry.comment
			})
			.catch((error: unknown) => {
				this.logger.error({ error }, 'Failed to send wholesale inquiry notification email')
			})

		return { message: 'Заявку успішно надіслано', id: inquiry.id }
	}

	async findAll(query: GetWholesaleInquiriesQueryDto) {
		const { page = 1, limit = 20, status } = query
		const filter: Record<string, unknown> = {}
		if (status) filter.status = status

		const skip = (page - 1) * limit
		const [items, total] = await Promise.all([
			this.wholesaleInquiryRepository.findAllPaginated(filter, skip, limit),
			this.wholesaleInquiryRepository.countDocuments(filter)
		])

		return {
			items: (items as LeanWholesaleInquiry[]).map(inquiry => ({
				id: inquiry._id.toString(),
				name: inquiry.name,
				phone: inquiry.phone,
				email: inquiry.email,
				quantity: inquiry.quantity,
				comment: inquiry.comment ?? null,
				status: inquiry.status,
				createdAt: inquiry.createdAt
			})),
			total,
			page,
			limit
		}
	}

	async updateStatus(id: string, dto: UpdateWholesaleInquiryStatusDto) {
		const updated = await this.wholesaleInquiryRepository.update(
			{ _id: id },
			{ status: dto.status }
		)
		if (!updated) throw new NotFoundException('Заявку не знайдено')

		return {
			id: updated.id,
			name: updated.name,
			phone: updated.phone,
			email: updated.email,
			quantity: updated.quantity,
			comment: updated.comment ?? null,
			status: updated.status
		}
	}
}
