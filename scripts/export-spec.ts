import { createPartnerDocument } from '../src/modules/partner-api/partner-api.swagger'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { AppModule } from '../src/app.module'

async function exportSpec() {
	const app = await NestFactory.create<NestExpressApplication>(AppModule, {
		logger: false,
		preview: true
	})
	app.set('trust proxy', 1)

	const config = new DocumentBuilder()
		.setTitle('Fillando API')
		.setDescription('API документація')
		.setVersion('1.0')
		.addBearerAuth(
			{ type: 'http', scheme: 'bearer', bearerFormat: 'API token' },
			'partner-token'
		)
		.build()

	const document = SwaggerModule.createDocument(app, config)

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
