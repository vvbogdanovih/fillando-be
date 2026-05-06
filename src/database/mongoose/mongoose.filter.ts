import { BadRequestException, Catch, ExceptionFilter } from '@nestjs/common'
import { MongoServerError } from 'mongodb'

@Catch(MongoServerError)
export class MongooseExceptionFilter implements ExceptionFilter {
	catch(exception: MongoServerError) {
		if (exception.code === 11000) {
			const field = Object.keys(exception.keyValue ?? {})[0] ?? 'field'
			const value = exception.keyValue?.[field]
			throw new BadRequestException(
				`Duplicate value for field: ${field}` + (value ? ` (${value})` : '')
			)
		}
	}
}
