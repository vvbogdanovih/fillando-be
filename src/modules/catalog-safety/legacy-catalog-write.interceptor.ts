import {
	CallHandler,
	ExecutionContext,
	Injectable,
	NestInterceptor,
	ServiceUnavailableException,
	SetMetadata
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { InjectConnection } from '@nestjs/mongoose'
import { Connection } from 'mongoose'
import type { Request, Response } from 'express'
import { AsyncLocalStorage } from 'node:async_hooks'
import { catchError, concatMap, finalize } from 'rxjs'

const LEGACY_CATALOG = 'catalog:legacy-controller'
const ADAPTED_READ = 'catalog:adapted-read'
export const CatalogAdaptedRead = () => SetMetadata(ADAPTED_READ, true)
const READ_ONLY_POST = 'catalog:read-only-post'
export const LegacyCatalogController = () => SetMetadata(LEGACY_CATALOG, true)
export const CatalogReadOnlyPost = () => SetMetadata(READ_ONLY_POST, true)
const CONSISTENT_READ = 'catalog:consistent-read'
/**
 * A public read outside the legacy controllers that must answer from one catalogue state — the
 * address resolver, the storefront settings (P05, owner decision 02.11.2026): the same barrier as
 * an adapted legacy read, so a write in progress or one landing mid-read is a 503 with
 * `Retry-After`, never an answer assembled from two states.
 */
export const CatalogConsistentRead = () => SetMetadata(CONSISTENT_READ, true)

type ReadStamp = { initialized: boolean; revision: number; epoch: number }
/**
 * The barrier a guarded request is inside (audit 11.11). The interceptor opens it around the
 * handler and verifies it once when the handler answers; a service's own `beginRead` /
 * `finishRead` inside it (`PublicCatalogService.read`, `CategoryPublicReadService.withMemo`, …)
 * reuse its stamp instead of reading `catalog_control` again — a `/products/catalog/v2` request
 * read it 6–8 times. Safe because the request's barrier spans theirs: a write overlapping any of
 * them fails the request's final check, and the answer is a 503 as before. Closed before that
 * check, so work outliving the request (a timer, a stream) verifies on its own again.
 */
const requestRead = new AsyncLocalStorage<{
	stamp: ReadStamp
	adapted: boolean
	open: boolean
}>()

/** Rollout interlock, not a transaction/lease. Bootstrap requires drained, stopped writers. */
@Injectable()
export class LegacyCatalogWritePolicy {
	constructor(@InjectConnection() private readonly connection: Connection) {}
	async assertAllowed(): Promise<void> {
		const control = await this.connection
			.db!.collection<{ _id: string }>('catalog_control')
			.findOne({ _id: 'catalog' }, { projection: { _id: 1 }, readPreference: 'primary' })
		if (control) this.unavailable('CATALOG_LEGACY_WRITES_DISABLED')
		await this.assertLegacyCompatible('CATALOG_CONTROL_MISSING')
	}
	private async assertLegacyCompatible(code: string) {
		// Missing control is only compatible with the original flat, active v1 catalog.
		const incompatible = await this.connection.db!.collection('categories').findOne(
			{
				$or: [
					{ parent_id: { $ne: null } },
					{ kind: { $exists: true, $ne: 'product' } },
					{ attribute_contract_version: { $exists: true, $ne: 1 } },
					{ status: { $exists: true, $ne: 'active' } }
				]
			},
			{ projection: { _id: 1 }, readPreference: 'primary' }
		)
		if (incompatible) this.unavailable(code)
	}

	async beginRead(adapted = false): Promise<ReadStamp> {
		const scope = requestRead.getStore()
		// Inside a request barrier at least as strict (an adapted read checks less): its stamp.
		if (scope?.open && (!scope.adapted || adapted)) return scope.stamp
		return this.readStamp(adapted)
	}
	private async readStamp(adapted: boolean): Promise<ReadStamp> {
		const control = await this.connection
			.db!.collection<{
				_id: string
				phase: string
				revision: number
				epoch: number
			}>('catalog_control')
			.findOne({ _id: 'catalog' }, { readPreference: 'primary' })
		if (
			control &&
			(control.phase !== 'idle' ||
				!Number.isSafeInteger(control.revision) ||
				control.revision < 0 ||
				!Number.isSafeInteger(control.epoch) ||
				control.epoch < 0)
		)
			this.unavailable('CATALOG_MAINTENANCE')
		if (!adapted || !control)
			await this.assertLegacyCompatible(
				control ? 'CATALOG_READ_UPGRADE_REQUIRED' : 'CATALOG_CONTROL_MISSING'
			)
		return {
			initialized: Boolean(control),
			revision: control?.revision ?? 0,
			epoch: control?.epoch ?? 0
		}
	}
	async finishRead(before: ReadStamp, adapted = false) {
		// The request's own stamp: its barrier verifies it once, when the handler answers.
		const scope = requestRead.getStore()
		if (scope?.open && scope.stamp === before) return
		const after = await this.readStamp(adapted)
		if (
			before.initialized !== after.initialized ||
			before.revision !== after.revision ||
			before.epoch !== after.epoch
		)
			this.unavailable('CATALOG_READ_CHANGED')
	}
	private unavailable(code: string): never {
		throw new ServiceUnavailableException({
			message: 'Каталог тимчасово оновлюється. Спробуйте ще раз за кілька секунд.',
			details: { code }
		})
	}
}

@Injectable()
export class LegacyCatalogWriteInterceptor implements NestInterceptor {
	constructor(
		private readonly reflector: Reflector,
		private readonly policy: LegacyCatalogWritePolicy
	) {}
	async intercept(context: ExecutionContext, next: CallHandler) {
		if (context.getType() !== 'http') return next.handle()
		const method = context.switchToHttp().getRequest<Request>().method
		const legacy = this.reflector.get<boolean>(LEGACY_CATALOG, context.getClass())
		const consistent =
			!legacy && this.reflector.get<boolean>(CONSISTENT_READ, context.getHandler()) === true
		const readOnlyPost =
			method === 'POST' && this.reflector.get<boolean>(READ_ONLY_POST, context.getHandler())
		if ((!legacy && !consistent) || method === 'OPTIONS') return next.handle()
		const fail = (error: unknown): never => {
			if (error instanceof ServiceUnavailableException) {
				const response = context.switchToHttp().getResponse<Response>()
				response.setHeader('Retry-After', '5')
				response.setHeader('Cache-Control', 'no-store')
			}
			throw error
		}
		try {
			if (!['GET', 'HEAD'].includes(method) && !readOnlyPost) {
				await this.policy.assertAllowed()
				return next.handle()
			}
			const adapted =
				consistent ||
				this.reflector.get<boolean>(ADAPTED_READ, context.getHandler()) === true
			const scope = { stamp: await this.policy.beginRead(adapted), adapted, open: true }
			// `next.handle()` binds the handler to the async context it is called in (Nest's
			// `AsyncResource.bind`), so the handler and all it awaits run inside this barrier.
			return requestRead
				.run(scope, () => next.handle())
				.pipe(
					concatMap(async (value: unknown) => {
						scope.open = false
						await this.policy.finishRead(scope.stamp, adapted)
						return value
					}),
					catchError(fail),
					finalize(() => {
						scope.open = false
					})
				)
		} catch (error) {
			return fail(error)
		}
	}
}
