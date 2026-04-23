import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { AppModule } from '../src/app.module'

async function exportSpec() {
	const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false })
	app.set('trust proxy', 1)

	const config = new DocumentBuilder()
		.setTitle('Urban Tab API')
		.setDescription('API документація')
		.setVersion('1.0')
		.build()

	const document = SwaggerModule.createDocument(app, config)

	const outputPath = join(process.cwd(), 'openapi.json')
	writeFileSync(outputPath, JSON.stringify(document, null, 2))
	console.log(`OpenAPI spec exported to ${outputPath}`)

	await app.close()
}

exportSpec()
