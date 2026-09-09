import { INestApplication } from '@nestjs/common'
import { createRbacApp, HttpMethod, send } from 'src/common/testing/rbac-harness'
import { Role } from 'src/common/types/enums'
import { CartController } from './cart.controller'
import { CartService } from './cart.service'

const resolved = () => jest.fn().mockResolvedValue({})

const cartService = {
	getCart: resolved(),
	mergeCart: resolved(),
	addItem: resolved(),
	updateItem: resolved(),
	removeItem: resolved(),
	clearCart: resolved()
}

/**
 * The whole controller carries a single class-level `@UseGuards(JwtAuthGuard)` — no
 * `RolesGuard`, no `@Roles`. The rule that encodes is "any authenticated caller, of any
 * role": this is the server-side cart of a logged-in shopper, keyed by `req.user.id`.
 *
 * `GET /cart` and `DELETE /cart` share a path, and so do `PATCH` and `DELETE` on
 * `/cart/items/:variantId`, so every method is listed on its own row.
 */
type CartRow = [
	method: HttpMethod,
	path: string,
	body: object | undefined,
	handler: jest.Mock,
	okStatus: number
]

const CART_ENDPOINTS: CartRow[] = [
	['get', '/cart', undefined, cartService.getCart, 200],
	['delete', '/cart', undefined, cartService.clearCart, 200],
	['post', '/cart/merge', { items: [] }, cartService.mergeCart, 201],
	['post', '/cart/items', { variant_id: 'v-1', quantity: 1 }, cartService.addItem, 201],
	['patch', '/cart/items/v-1', { quantity: 2 }, cartService.updateItem, 200],
	['delete', '/cart/items/v-1', undefined, cartService.removeItem, 200]
]

describe('CartController RBAC', () => {
	let app: INestApplication

	beforeAll(async () => {
		app = await createRbacApp({
			controllers: [CartController],
			providers: [{ provide: CartService, useValue: cartService }]
		})
	})

	afterAll(async () => {
		await app.close()
	})

	beforeEach(() => {
		jest.clearAllMocks()
	})

	/**
	 * A cart is somebody's shopping list tied to their user id. Without the guard `req.user`
	 * is undefined and every handler dereferences it, so dropping the class-level guard turns
	 * the module into a 500 machine at best and a cross-account read at worst.
	 */
	it.each(CART_ENDPOINTS)('%s %s → 401 without a token', async (method, path, body, handler) => {
		const res = await send(app, method, path, { body })

		expect(res.status).toBe(401)
		expect(handler).not.toHaveBeenCalled()
	})

	/**
	 * The mirror image of every other RBAC spec in this repo. Adding `RolesGuard` +
	 * `@Roles(Role.ADMIN)` here "for consistency with the other write endpoints" would lock
	 * every shopper out of their own cart — checkout included — while the 401 rows above
	 * stayed green. `RolesGuard` is default-deny, so even adding it *without* `@Roles` breaks
	 * these rows and nothing else.
	 */
	it.each(CART_ENDPOINTS)(
		'%s %s → passes for a plain USER',
		async (method, path, body, handler, okStatus) => {
			const res = await send(app, method, path, { role: Role.USER, body })

			expect(res.status).toBe(okStatus)
			expect(handler).toHaveBeenCalledTimes(1)
		}
	)

	/** An admin is also a shopper, and this is the row a missing `@Roles(...)` would fail. */
	it.each(CART_ENDPOINTS)(
		'%s %s → passes for ADMIN as well',
		async (method, path, body, handler, okStatus) => {
			const res = await send(app, method, path, { role: Role.ADMIN, body })

			expect(res.status).toBe(okStatus)
			expect(handler).toHaveBeenCalledTimes(1)
		}
	)

	/**
	 * With the guards listed in the wrong order a `RolesGuard` added here would answer 403 to
	 * an anonymous caller and 403 to a real ADMIN alike; 401-without-a-token paired with the
	 * ADMIN row above is what distinguishes a correct chain from a swapped one.
	 */
	it('answers 401, not 403, when no token is present at all', async () => {
		const res = await send(app, 'get', '/cart')

		expect(res.status).toBe(401)
	})

	/**
	 * Every handler `return`s the service promise. Dropping that `return` still answers 2xx,
	 * so the status rows above stay green while the storefront receives an empty body and
	 * renders an empty cart over items the server is actually holding.
	 */
	it('answers with the cart the service resolved', async () => {
		const cart = { items: [{ variant_id: 'v-1', quantity: 2 }], total: 700 }
		cartService.getCart.mockResolvedValueOnce(cart)

		const res = await send(app, 'get', '/cart', { role: Role.USER })

		expect(res.body).toEqual(cart)
	})

	describe('the caller may only reach their own cart', () => {
		/**
		 * Every handler reads `(req.user as JWTPayload).id`. Taking the id from the body or the
		 * params instead would let one shopper read, edit and empty another's cart, and the
		 * status-code rows above would not notice. `u1` is the harness's authenticated caller.
		 */
		it('reads the cart of the authenticated caller, ignoring a spoofed query', async () => {
			await send(app, 'get', '/cart?user_id=someone-else', { role: Role.USER })

			expect(cartService.getCart).toHaveBeenCalledWith('u1')
		})

		/**
		 * Two items with distinct quantities above 1 on purpose. This row is also the merge
		 * payload's only pass-through assertion, and a one-item, quantity-1 fixture cannot tell
		 * the whole guest cart from a truncated one, nor from one whose quantities were all
		 * reset to 1 — both silently drop items a shopper collected before logging in.
		 */
		it('merges into the cart of the authenticated caller, not the id in the body', async () => {
			const body = {
				user_id: 'someone-else',
				items: [
					{ variant_id: 'v-1', quantity: 2 },
					{ variant_id: 'v-2', quantity: 5 }
				]
			}

			await send(app, 'post', '/cart/merge', { role: Role.USER, body })

			expect(cartService.mergeCart).toHaveBeenCalledWith('u1', body)
		})

		it('adds to the cart of the authenticated caller, not the id in the body', async () => {
			const body = { user_id: 'someone-else', variant_id: 'v-1', quantity: 2 }

			await send(app, 'post', '/cart/items', { role: Role.USER, body })

			expect(cartService.addItem).toHaveBeenCalledWith('u1', body)
		})

		it('updates the item in the cart of the authenticated caller, keeping the variant from the path', async () => {
			const body = { user_id: 'someone-else', quantity: 3 }

			await send(app, 'patch', '/cart/items/v-42', { role: Role.USER, body })

			expect(cartService.updateItem).toHaveBeenCalledWith('u1', 'v-42', body)
		})

		it('removes the item from the cart of the authenticated caller, keeping the variant from the path', async () => {
			await send(app, 'delete', '/cart/items/v-42', { role: Role.USER })

			expect(cartService.removeItem).toHaveBeenCalledWith('u1', 'v-42')
		})

		it('clears the cart of the authenticated caller only', async () => {
			await send(app, 'delete', '/cart?user_id=someone-else', { role: Role.USER })

			expect(cartService.clearCart).toHaveBeenCalledWith('u1')
		})
	})

	/**
	 * No handler in this module is public: a guest cart lives in the browser's localStorage
	 * and is pushed to the server by `POST /cart/merge` after login. Any route answering
	 * something other than 401 anonymously is an unauthenticated cart endpoint.
	 */
	it('leaves no route of the module open to an anonymous caller', async () => {
		const statuses: number[] = []
		for (const [method, path, body] of CART_ENDPOINTS) {
			statuses.push((await send(app, method, path, { body })).status)
		}

		expect(statuses).toEqual([401, 401, 401, 401, 401, 401])
	})
})
