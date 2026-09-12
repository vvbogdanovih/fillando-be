import { ENV } from 'src/common/constants'
import { INestApplication } from '@nestjs/common'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { PartnerApiModule } from './partner-api.module'
export function createPartnerDocument(app: INestApplication) {
	return SwaggerModule.createDocument(
		app,
		new DocumentBuilder()
			.setTitle('Fillando Partner API')
			.setDescription(
				'Наявність товарів за артикулом. У Authorize вставте API-токен, виданий Fillando. Одинична та пакетна перевірка (до 100 артикулів). Спільний ліміт обох ендпойнтів: 60 запитів за хвилину на токен, 300 на IP. Залишки довідкові, без резервування. stock_updated_at — останнє оновлення, а не гарантія актуальності. Авторизація через Authorization: Bearer <token>.'
			)
			.setVersion('1.0.0')
			.addBearerAuth(
				{ type: 'http', scheme: 'bearer', bearerFormat: 'API token' },
				'partner-token'
			)
			.addServer(ENV.PUBLIC_API_URL.replace(/\/$/, ''))
			.build(),
		{ include: [PartnerApiModule] }
	)
}
