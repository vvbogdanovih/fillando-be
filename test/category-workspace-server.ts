import { VendorController } from '../src/modules/vendor/vendor.controller'
import { VendorService } from '../src/modules/vendor/vendor.service'
import { VendorRepository } from '../src/database/mongoose/repositories/vendor.repository'
import { Vendor, VendorSchema } from '../src/database/mongoose/schemas/vendor.schema'
import {
	TypedProductController,
	TypedProductService
} from '../src/modules/product/typed-product.controller'
/** Local-only browser rehearsal. Real category controllers/journal/Mongo; fixture auth only. */
import { Test } from '@nestjs/testing'
import { ValidationPipe } from '@nestjs/common'
import { getConnectionToken, getModelToken } from '@nestjs/mongoose'
import mongoose, { mongo } from 'mongoose'
import { randomUUID } from 'node:crypto'
import { JwtAuthGuard } from '../src/common/guards/jwt-auth.guard'
import { HeaderRoleAuthGuard } from '../src/common/testing/rbac-harness'
import {
	CategoryDraftPlacementController,
	CategoryDraftPlacementService,
	CatalogOperationController
} from '../src/modules/category/category-draft-placement'
import { CategoryTreeController } from '../src/modules/category/category-tree.controller'
import { CategoryTreeReadService } from '../src/modules/category/category-tree-read.service'
import { CategoryTreeWriter } from '../src/modules/category/category-tree-writer'
import { CatalogWriteGate } from '../src/database/mongoose/repositories/catalog-write-gate'
import { APP_INTERCEPTOR } from '@nestjs/core'
import { ThrottlerModule } from '@nestjs/throttler'
import {
	LegacyCatalogWriteInterceptor,
	LegacyCatalogWritePolicy
} from '../src/modules/catalog-safety/legacy-catalog-write.interceptor'
import { CategoryController } from '../src/modules/category/category.controller'
import { CategoryService } from '../src/modules/category/category.service'
import { CategoryPublicReadService } from '../src/modules/category/category-public-read.service'
import {
	CategoryPublicationController,
	CategoryPublicationService
} from '../src/modules/category/category-publication'
import { PublicCatalogController } from '../src/modules/product/public-catalog.controller'
import { PublicCatalogService } from '../src/modules/product/public-catalog.service'
import { PublicProductService } from '../src/modules/product/public-product.service'
import { ProductService } from '../src/modules/product/product.service'
import { ProductVariantRepository } from '../src/database/mongoose/repositories/product-variant.repository'
import {
	ProductVariant,
	ProductVariantSchema
} from '../src/database/mongoose/schemas/product-variant.schema'
import { connectTestDb, dropTestDb, TEST_MONGO_URL } from './integration-db'

async function main() {
	if (TEST_MONGO_URL !== 'mongodb://127.0.0.1:27018/fillando-test')
		throw Error('Disposable local DB only')
	await connectTestDb('category-workspace-browser')
	await mongoose.connection.collection('vendors').insertOne({
		_id: new mongo.ObjectId('000000000000000000000010'),
		name: 'Локальний постачальник',
		slug: 'local-supplier',
		createdAt: new Date(),
		updatedAt: new Date()
	})
	await mongoose.connection
		.collection('numbers')
		.insertOne({ sku: 1000, order: 0, discount_coupon: 0 })
	await mongoose.connection
		.collection('product_variants')
		.createIndex({ sku: 1 }, { unique: true })
	await mongoose.connection
		.collection('product_variants')
		.createIndex({ slug: 1 }, { unique: true })
	const gate = new CatalogWriteGate(mongoose.connection.db!)
	await gate.initialize()
	const writer = new CategoryTreeWriter(mongoose.connection.db!)
	for (const [index, name] of ['Електротовари', 'Дім'].entries())
		await writer.create(
			{ operationId: randomUUID(), ownerId: 'browser-fixture', expectedRevision: index },
			{
				id: String(index + 1).padStart(24, '0'),
				name,
				slug: `group-${index + 1}`,
				kind: 'group',
				order: index,
				parent_id: null,
				attribute_definitions: []
			}
		)
	const exampleId = '000000000000000000000003'
	await writer.create(
		{ operationId: randomUUID(), ownerId: 'browser-fixture', expectedRevision: 2 },
		{
			id: exampleId,
			name: 'Приклад АВР',
			slug: 'example-avr',
			kind: 'product',
			order: 0,
			parent_id: '000000000000000000000001',
			attribute_definitions: [
				{
					key: 'current',
					label: 'Номінальний струм',
					value_type: 'number',
					unit: 'А',
					is_required: true,
					filter_enabled: true,
					filter_type: 'range',
					visible_in_specs: true,
					order: 0,
					multiple: false,
					semantic: 'generic',
					options: []
				},
				{
					key: 'automatic',
					label: 'Автоматичний режим',
					value_type: 'boolean',
					unit: null,
					is_required: false,
					filter_enabled: true,
					filter_type: 'multi-select',
					visible_in_specs: true,
					order: 1,
					multiple: false,
					semantic: 'generic',
					options: []
				},
				{
					key: 'poles',
					label: 'Полюси',
					value_type: 'enum',
					unit: null,
					is_required: false,
					filter_enabled: true,
					filter_type: 'multi-select',
					visible_in_specs: true,
					order: 2,
					multiple: false,
					semantic: 'generic',
					options: [{ id: 'four', label: 'Чотири', order: 0 }]
				}
			]
		}
	)
	const category_id = new mongo.ObjectId(exampleId),
		product_id = new mongo.ObjectId()
	await mongoose.connection.collection('products').insertOne({
		_id: product_id,
		name: 'АВР тестовий',
		category_id,
		variant_axis: { key: 'current' },
		attributes_v2: [
			{ k: 'automatic', v: false },
			{ k: 'poles', v: 'four' }
		]
	})
	await mongoose.connection.collection('product_variants').insertMany(
		[16, 32, 63].map((variant_value, index) => ({
			name: `АВР тестовий — ${variant_value} А`,
			slug: `avr-fixture-${index}`,
			sku: `FL-TEST-${index}`,
			price: 100,
			stock: 5,
			category_id,
			product_id,
			variant_value,
			status: 'draft'
		}))
	)
	await mongoose.connection
		.collection('catalog_control')
		.updateOne({}, { $set: { admin_draft_writes_enabled: true } })
	const module = await Test.createTestingModule({
		// The public catalogue handlers carry their production throttle; never limit a rehearsal.
		imports: [
			ThrottlerModule.forRoot({
				throttlers: [{ ttl: 60000, limit: 1000 }],
				skipIf: () => true
			})
		],
		controllers: [
			VendorController,
			TypedProductController,
			CategoryDraftPlacementController,
			CatalogOperationController,
			CategoryPublicationController,
			CategoryTreeController,
			// Storefront reads for the publication → shop rehearsal (Plan-0010 F06–F08).
			PublicCatalogController,
			CategoryController
		],
		providers: [
			VendorService,
			VendorRepository,
			{
				provide: getModelToken(Vendor.name),
				useValue: mongoose.model(Vendor.name, VendorSchema)
			},
			TypedProductService,
			CategoryDraftPlacementService,
			CategoryTreeReadService,
			CategoryPublicationService,
			CategoryPublicReadService,
			PublicCatalogService,
			PublicProductService,
			ProductVariantRepository,
			{
				provide: getModelToken(ProductVariant.name),
				useValue: mongoose.model(ProductVariant.name, ProductVariantSchema)
			},
			// Only `legacyDetail` (pure mapping) and the v1 catalogue are reachable here.
			{ provide: ProductService, useValue: Object.create(ProductService.prototype) as never },
			{
				provide: CategoryService,
				useFactory: (reader: CategoryPublicReadService) => ({
					findAll: () => reader.findAll(),
					findById: (id: string) => reader.findById(id),
					findBySlug: (slug: string) => reader.findBySlug(slug)
				}),
				inject: [CategoryPublicReadService]
			},
			LegacyCatalogWritePolicy,
			{ provide: APP_INTERCEPTOR, useClass: LegacyCatalogWriteInterceptor },
			{ provide: getConnectionToken(), useValue: mongoose.connection }
		]
	})
		.overrideGuard(JwtAuthGuard)
		.useValue(new HeaderRoleAuthGuard())
		.compile()
	const app = module.createNestApplication({ logger: false })
	app.enableCors({ origin: 'http://127.0.0.1:19100', credentials: true })
	app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
	const server = app.getHttpAdapter()
	server.get('/auth/me', (_request, response: { json: (body: unknown) => void }) =>
		response.json({
			message: 'OK',
			user: {
				id: 'admin-fixture',
				role: 'ADMIN',
				name: 'Test admin',
				email: 'admin@example.invalid',
				picture: null
			}
		})
	)
	server.get('/cart', (_request, response: { json: (body: unknown) => void }) =>
		response.json({ items: [], removed_items: [] })
	)
	let closing = false
	const close = async () => {
		if (closing) return
		closing = true
		await app.close()
		await dropTestDb(mongoose)
		process.exit(0)
	}
	process.on('SIGTERM', () => {
		void close()
	})
	process.on('SIGINT', () => {
		void close()
	})
	await app.listen(19101, '127.0.0.1')
	console.log('Category rehearsal API ready on 127.0.0.1:19101; disposable database only')
}
void main().catch(error => {
	console.error(error)
	process.exit(1)
})
