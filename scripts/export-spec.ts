import { createPartnerDocument } from '../src/modules/partner-api/partner-api.swagger'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { AppModule } from '../src/app.module'
import { buildOpenApiDocument } from '../src/common/swagger/openapi-document'

async function exportSpec() {
	const app = await NestFactory.create<NestExpressApplication>(AppModule, {
		logger: false,
		preview: true
	})
	app.set('trust proxy', 1)

	const document = buildOpenApiDocument(app)

	writeFileSync(
		join(process.cwd(), 'openapi-partner.json'),
		JSON.stringify(createPartnerDocument(app), null, 2)
	)
	const outputPath = join(process.cwd(), 'openapi.json')
	writeFileSync(outputPath, JSON.stringify(document, null, 2))
	console.log(`OpenAPI spec exported to ${outputPath}`)

	await app.close()
}

exportSpec()
