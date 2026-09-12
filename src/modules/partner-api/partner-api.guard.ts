import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { ThrottlerGuard } from '@nestjs/throttler'
import { Request } from 'express'
import { PartnerApiService, hashPartnerToken } from './partner-api.service'
export type PartnerRequest = Request & { partnerTokenId?: string }
@Injectable()
export class PartnerApiGuard implements CanActivate {
	constructor(private readonly service: PartnerApiService) {}
	async canActivate(context: ExecutionContext) {
		const req = context.switchToHttp().getRequest<PartnerRequest>()
		req.partnerTokenId = await this.service.authenticate(req.headers.authorization)
		return true
	}
}
// Counters are shared across partner endpoints, including single and bulk reads.
// These limits deliberately do not inherit the storefront's internal-token bypass.
@Injectable()
export class PartnerIpThrottlerGuard extends ThrottlerGuard {
	async onModuleInit() {
		await super.onModuleInit()
		this.throttlers = [{ name: 'default', ttl: 60_000, limit: 300 }]
		this.commonOptions = {
			getTracker: req => Promise.resolve(String(req.ip)),
			generateKey: (_context, tracker) => hashPartnerToken('partner-api:ip:' + tracker),
			setHeaders: true
		}
	}
}
@Injectable()
export class PartnerTokenThrottlerGuard extends ThrottlerGuard {
	async onModuleInit() {
		await super.onModuleInit()
		this.throttlers = [{ name: 'default', ttl: 60_000, limit: 60 }]
		this.commonOptions = {
			getTracker: req => Promise.resolve(String(req.partnerTokenId)),
			generateKey: (_context, tracker) => hashPartnerToken('partner-api:token:' + tracker),
			setHeaders: true
		}
	}
}
