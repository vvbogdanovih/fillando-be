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
	app.use(cookieParser())
	app.enableCors({
		origin: ENV.FRONTEND_URL || 'http://localhost:9000',
		credentials: true
	})
	const config = new DocumentBuilder()
		.setTitle('Urban Tab API')
		.setDescription('API документація')
		.setVersion('1.0')
		.build()
	const document = SwaggerModule.createDocument(app, config)
	SwaggerModule.setup('swagger', app, document)

	await app.listen(ENV.PORT)
}
bootstrap()
