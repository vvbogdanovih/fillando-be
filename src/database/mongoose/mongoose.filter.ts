import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common'
import type { Response } from 'express'
import { MongoServerError } from 'mongodb'

/**
 * Turns a driver-level Mongo error into an answer the admin can act on.
 *
 * The filter must **write** the response rather than throw one. An exception thrown from
 * `catch()` does not re-enter Nest's pipeline — it escapes to the Express error handler, which
 * answers a bare 500. That is how a duplicate `slug` used to surface as an unexplained server
 * error instead of the 400 this filter was written to produce. For the same reason every other
 * `MongoServerError` gets an explicit 500 here: returning without writing leaves the request
 * hanging until the client times out.
 */
@Catch(MongoServerError)
export class MongooseExceptionFilter implements ExceptionFilter {
	private readonly logger = new Logger(MongooseExceptionFilter.name)

	catch(exception: MongoServerError, host: ArgumentsHost) {
		const response = host.switchToHttp().getResponse<Response>()

		if (exception.code === 11000) {
			const field = Object.keys(exception.keyValue ?? {})[0] ?? 'field'
			const value = exception.keyValue?.[field]
			const message = `Duplicate value for field: ${field}` + (value ? ` (${value})` : '')

			response.status(HttpStatus.BAD_REQUEST).json({
				statusCode: HttpStatus.BAD_REQUEST,
				message,
				error: 'Bad Request'
			})
			return
		}

		this.logger.error(`Unhandled MongoServerError ${exception.code}: ${exception.message}`)
		response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
			statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
			message: 'Internal server error',
			error: 'Internal Server Error'
		})
	}
}
