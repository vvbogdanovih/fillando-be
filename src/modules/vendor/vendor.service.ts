import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { VendorRepository } from 'src/database/mongoose/repositories/vendor.repository'
import { CreateVendorDto } from './dto/create-vendor.dto'
import { UpdateVendorDto } from './dto/update-vendor.dto'
import { CheckVendorAvailabilityDto } from './dto/check-vendor-availability.dto'

@Injectable()
export class VendorService {
	private readonly logger = new Logger(VendorService.name)

	constructor(private readonly vendorRepository: VendorRepository) {}

	findAll() {
		return this.vendorRepository.findAll({})
	}

	async findById(id: string) {
		const vendor = await this.vendorRepository.findById(id)
		if (!vendor) throw new NotFoundException('Vendor not found')
		return vendor
	}

	create(dto: CreateVendorDto) {
		return this.vendorRepository.create(dto)
	}

	async update(id: string, dto: UpdateVendorDto) {
		const updated = await this.vendorRepository.update({ _id: id }, dto)
		if (!updated) throw new NotFoundException('Vendor not found')
		return updated
	}

	async delete(id: string) {
		const deleted = await this.vendorRepository.delete({ _id: id })
		if (!deleted) throw new NotFoundException('Vendor not found')
		return { message: 'Vendor deleted' }
	}

	async checkAvailability(dto: CheckVendorAvailabilityDto) {
		const existing = await this.vendorRepository.findBySlug(dto.slug)
		return { available: !existing }
	}
}
