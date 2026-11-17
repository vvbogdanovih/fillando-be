import {
	Global,
	Injectable,
	Module,
	type OnApplicationBootstrap,
	type OnModuleDestroy
} from '@nestjs/common'
import { InjectConnection } from '@nestjs/mongoose'
import type { Connection } from 'mongoose'
import { storefrontRevalidation } from './storefront-revalidation.service'

/**
 * Attaches the storefront purge outbox (P12, owner decision 02.11.2026) to the one
 * `storefrontRevalidation` of the process once the app is up, and stops its poll on shutdown —
 * pending purges stay in MongoDB for the next start. Registered once, globally, as that singleton
 * asks.
 */
@Injectable()
export class StorefrontPurgeOutbox implements OnApplicationBootstrap, OnModuleDestroy {
	constructor(@InjectConnection() private readonly connection: Connection) {}
	onApplicationBootstrap() {
		storefrontRevalidation.attach(this.connection.db!)
	}
	onModuleDestroy() {
		storefrontRevalidation.detach()
	}
}

@Global()
@Module({ providers: [StorefrontPurgeOutbox] })
export class StorefrontPurgeModule {}
