import { ArgumentsHost, HttpStatus } from '@nestjs/common'
import { MongoServerError } from 'mongodb'
import { MongooseExceptionFilter } from './mongoose.filter'

/**
 * The filter used to `throw` its `BadRequestException`. An exception thrown from `catch()` does
 * not re-enter Nest's pipeline — it escapes to the Express error handler — so a duplicate `slug`
 * reached the admin as a bare 500 with no field name in it, which is the opposite of why this
 * filter exists.
 */
const buildHost = () => {
	const response = { status: jest.fn().mockReturnThis(), json: jest.fn() }
	const host = {
		switchToHttp: () => ({ getResponse: () => response })
	} as unknown as ArgumentsHost
	return { host, response }
}

const duplicateKeyError = (keyValue: Record<string, unknown>) => {
	const error = new MongoServerError({ message: 'E11000 duplicate key error' })
	error.code = 11000
	error.keyValue = keyValue
	return error
}

describe('MongooseExceptionFilter', () => {
	it('answers 400 and names the duplicated field and value', () => {
		const { host, response } = buildHost()

		new MongooseExceptionFilter().catch(duplicateKeyError({ slug: 'pla-silk-candy' }), host)

		expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST)
		expect(response.json).toHaveBeenCalledWith(
			expect.objectContaining({
				statusCode: HttpStatus.BAD_REQUEST,
				message: 'Duplicate value for field: slug (pla-silk-candy)'
			})
		)
	})

	it('does not throw out of catch — the response is written, not raised', () => {
		const { host } = buildHost()

		expect(() =>
			new MongooseExceptionFilter().catch(duplicateKeyError({ sku: 'FL-000157' }), host)
		).not.toThrow()
	})

	it('still answers something for any other driver error, instead of hanging the request', () => {
		const { host, response } = buildHost()
		const other = new MongoServerError({ message: 'boom' })
		other.code = 121

		new MongooseExceptionFilter().catch(other, host)

		expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR)
		expect(response.json).toHaveBeenCalled()
	})
})
