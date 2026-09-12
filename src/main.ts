import { createPartnerDocument } from './modules/partner-api/partner-api.swagger'
import { NestFactory } from '@nestjs/core'
import { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { ValidationPipe } from '@nestjs/common'
import { Logger } from 'nestjs-pino'
import { AppModule } from './app.module'
import { MongooseExceptionFilter } from './database/mongoose/mongoose.filter'
import { ENV } from './common/constants'
import cookieParser from 'cookie-parser'

async function bootstrap() {
	const app = await NestFactory.create<NestExpressApplication>(AppModule, {
		bufferLogs: true
	})
	app.set('trust proxy', 1)
	app.useLogger(app.get(Logger))
	app.useGlobalFilters(new MongooseExceptionFilter())
	app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }))
	app.useBodyParser('json', { limit: '10mb' })
	// LiqPay server-to-server callbacks arrive as application/x-www-form-urlencoded
	app.useBodyParser('urlencoded', { extended: true })
	app.use(cookieParser())
	app.enableCors({
		origin: ENV.FRONTEND_URL || 'http://localhost:9000',
		credentials: true,
		// Browsers hide every non-safelisted response header from JS. Without this the
		// frontend's file downloads (price list, order report, invoice) cannot read the
		// server-provided filename and silently fall back to a generic one.
		exposedHeaders: ['Content-Disposition', 'Retry-After']
	})
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
	SwaggerModule.setup('swagger', app, document)
	SwaggerModule.setup('partner-docs', app, createPartnerDocument(app), {
		jsonDocumentUrl: 'partner-openapi.json',
		swaggerOptions: { persistAuthorization: false }
	})

	await app.listen(ENV.PORT)
}
bootstrap()
