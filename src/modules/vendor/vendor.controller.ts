import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { API_OPERATION, ENDPOINTS } from 'src/common/constants'
import { Roles } from 'src/common/decorators/roles.decorator'
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard'
import { RolesGuard } from 'src/common/guards/roles.guard'
import { Role } from 'src/common/types/enums'
import { VendorService } from './vendor.service'
import { CreateVendorDto } from './dto/create-vendor.dto'
import { UpdateVendorDto } from './dto/update-vendor.dto'
import { CheckVendorAvailabilityDto } from './dto/check-vendor-availability.dto'

@Controller(ENDPOINTS.VENDORS.BASE)
@ApiTags(ENDPOINTS.VENDORS.BASE)
export class VendorController {
	constructor(private readonly vendorService: VendorService) {}

	@Get(ENDPOINTS.VENDORS.GET_ALL)
	@ApiOperation(API_OPERATION.VENDORS.GET_ALL)
	findAll() {
		return this.vendorService.findAll()
	}

	@Get(ENDPOINTS.VENDORS.CHECK_AVAILABILITY)
	@ApiOperation(API_OPERATION.VENDORS.CHECK_AVAILABILITY)
	checkAvailability(@Query() dto: CheckVendorAvailabilityDto) {
		return this.vendorService.checkAvailability(dto)
	}

	@Get(ENDPOINTS.VENDORS.GET_BY_ID)
	@ApiOperation(API_OPERATION.VENDORS.GET_BY_ID)
	findById(@Param('id') id: string) {
		return this.vendorService.findById(id)
	}

	@Post(ENDPOINTS.VENDORS.CREATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.VENDORS.CREATE)
	create(@Body() dto: CreateVendorDto) {
		return this.vendorService.create(dto)
	}

	@Patch(ENDPOINTS.VENDORS.UPDATE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.VENDORS.UPDATE)
	update(@Param('id') id: string, @Body() dto: UpdateVendorDto) {
		return this.vendorService.update(id, dto)
	}

	@Delete(ENDPOINTS.VENDORS.DELETE)
	@UseGuards(JwtAuthGuard, RolesGuard)
	@Roles(Role.ADMIN)
	@ApiOperation(API_OPERATION.VENDORS.DELETE)
	delete(@Param('id') id: string) {
		return this.vendorService.delete(id)
	}
}
