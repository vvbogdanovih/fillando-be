import { Injectable, Logger } from '@nestjs/common'
import { Types } from 'mongoose'
import { PaymentStatus } from 'src/common/types/enums'
import { OrderRepository } from 'src/database/mongoose/repositories/order.repository'
import { EmailService } from 'src/modules/email/email.service'
import {
	decideTracking,
	npPhone,
	TRACKED_ORDER_STATUSES,
	TRACKING_WINDOW_DAYS
} from './delivery-tracking.rules'
import { NovaPostTrackingClient } from './nova-post-tracking.client'
import { planStatusChange, statusChangeUpdate } from '../helpers/order-status.rules'

const DAY_MS = 24 * 60 * 60 * 1000

export interface TrackingSummary {
	checked: number
	answered: number
	updated: number
	alerted: number
}

/**
 * Follows shipped parcels through Nova Post and moves their orders along (TD-0011): a received
 * parcel makes the order DELIVERED (COMPLETED when paid — and a cash-on-delivery parcel is paid
 * by being received, so its payment becomes PAID in the same write); a refusal or an expired
 * storage makes it RETURNING and emails the admin; a deleted or unknown TTN is only emailed.
 */
@Injectable()
export class DeliveryTrackingService {
	private readonly logger = new Logger(DeliveryTrackingService.name)
	private running = false

	constructor(
		private readonly orderRepository: OrderRepository,
		private readonly trackingClient: NovaPostTrackingClient,
		private readonly emailService: EmailService
	) {}

	get isRunning(): boolean {
		return this.running
	}

	async run(now: Date = new Date()): Promise<TrackingSummary> {
		this.running = true
		try {
			return await this.track(now)
		} finally {
			this.running = false
		}
	}

	private async track(now: Date): Promise<TrackingSummary> {
		const since = new Date(now.getTime() - TRACKING_WINDOW_DAYS * DAY_MS)
		const orders = await this.orderRepository.findTrackable(TRACKED_ORDER_STATUSES, since)
		const summary: TrackingSummary = {
			checked: orders.length,
			answered: 0,
			updated: 0,
			alerted: 0
		}
		if (orders.length === 0) return summary

		const statuses = await this.trackingClient.getStatuses(
			orders.map(order => ({
				ttn: order.nova_post_ttn as string,
				phone: npPhone(order.customer?.phone)
			}))
		)

		for (const order of orders) {
			const ttn = order.nova_post_ttn as string
			const status = statuses.get(ttn)
			if (!status) continue
			summary.answered += 1

			const decision = decideTracking(order, status.code)
			// Guarded on the statuses and TTN this pass read: an admin who changed any of them in
			// the meantime wins, and the next run starts from what they set. Payment is pinned too,
			// because whether a delivery settles to COMPLETED depends on it. Mongo here is
			// standalone, so this conditional write is the concurrency control there is.
			const guard = {
				_id: new Types.ObjectId(String(order._id)),
				order_status: order.order_status,
				payment_status: order.payment_status,
				nova_post_ttn: ttn
			}
			const trackingStatus = { code: status.code, text: status.text, checked_at: now }
			const wantsAlert =
				decision.kind === 'alert' || (decision.kind === 'update' && decision.alert)

			// One refusal is one email: the code is remembered once the mail went out. A failed
			// mail is not remembered and blocks the status move, so the next run tries both again
			// — moving to RETURNING first would take the order out of tracking unannounced.
			let alerted = false
			if (wantsAlert && order.nova_post_alerted_code !== status.code) {
				try {
					await this.emailService.sendDeliveryIssueAlert({
						orderNumber: order.order_number,
						ttn,
						statusCode: status.code,
						statusText: status.text,
						customerName: order.customer?.name ?? '',
						customerPhone: order.customer?.phone ?? ''
					})
					alerted = true
					summary.alerted += 1
				} catch (err) {
					this.logger.error(
						`Delivery issue alert for ${order.order_number} failed: ${(err as Error).message}`
					)
					await this.orderRepository.update(guard, {
						$set: { nova_post_status: trackingStatus }
					})
					continue
				}
			}

			const extra: Record<string, unknown> = { nova_post_status: trackingStatus }
			if (alerted) extra.nova_post_alerted_code = status.code

			if (decision.kind === 'update') {
				const plan = planStatusChange(
					order,
					{
						order_status: decision.nextStatus,
						...(decision.markPaid ? { payment_status: PaymentStatus.PAID } : {})
					},
					'tracker',
					{
						at: now,
						note: `НП ${status.code} «${status.text}»`
					}
				)
				const updated = await this.orderRepository.update(
					guard,
					statusChangeUpdate(plan, extra)
				)
				if (updated && plan.history.length > 0) {
					summary.updated += 1
					this.logger.log(
						`Order ${order.order_number}: ${order.order_status} → ${plan.order_status}${plan.set.payment_status ? `, payment ${order.payment_status} → ${plan.payment_status}` : ''} (НП ${status.code} «${status.text}»)`
					)
				}
				continue
			}

			await this.orderRepository.update(guard, { $set: extra })
		}

		return summary
	}
}
