import type { PoolClient } from 'pg';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import type { MerchantContext } from '../http.js';
import type { CreateOrderInput } from '../schemas.js';
import { enqueueWebhookEvent } from '../webhooks/outbox.js';
import type { PaymentAdapterRegistry } from '../payment-adapters/registry.js';
import { PaymentAdapterError } from '../payment-adapters/errors.js';
import { hashRequest, newId } from '../security.js';
import type { PaymentCoreService } from './payment-core-service.js';
import type { PaymentLifecycleData, PaymentLifecycleHandler } from './payment-lifecycle.js';
import { addBillingInterval, type BillingInterval } from './billing-interval.js';

type PlanRecord = {
  id: string;
  merchant_id: string;
  name: string;
  description: string;
  amount: string;
  currency: string;
  billing_interval: BillingInterval;
  interval_count: number;
  trial_days: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

type SubscriptionRecord = {
  id: string;
  merchant_id: string;
  customer_id: string;
  plan_id: string;
  plan_name: string;
  payment_method: string;
  billing_mode: 'MANUAL' | 'AUTOMATIC';
  amount: string;
  currency: string;
  billing_interval: BillingInterval;
  interval_count: number;
  trial_days: number;
  status: 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'EXPIRED' | 'PAST_DUE';
  starts_at: Date;
  trial_ends_at: Date | null;
  current_period_start: Date;
  current_period_end: Date;
  next_billing_at: Date;
  ends_at: Date | null;
  created_at: Date;
  updated_at: Date;
  customer_name?: string | null;
  customer_email?: string | null;
};

type BillingCycleRecord = {
  id: string;
  subscription_id: string;
  cycle_number: number;
  period_start: Date;
  period_end: Date;
  amount: string;
  currency: string;
  status: 'CREATING' | 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';
  paid_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type BillingAttemptRecord = {
  id: string;
  subscription_id: string;
  billing_cycle_id: string;
  attempt_number: number;
  core_idempotency_key: string;
  order_id: string | null;
  payment_id: string | null;
  status: 'CREATING' | 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';
  failure_reason: string | null;
  created_at: Date;
  completed_at: Date | null;
};

const planSelect = `SELECT id, merchant_id, name, description, amount::text AS amount, currency,
  billing_interval, interval_count, trial_days, enabled, created_at, updated_at FROM subscription_plans`;

const subscriptionSelect = `SELECT s.id, s.merchant_id, s.customer_id, s.plan_id, s.plan_name, s.payment_method,
  s.billing_mode, s.amount::text AS amount, s.currency, s.billing_interval, s.interval_count, s.trial_days,
  s.status, s.starts_at, s.trial_ends_at, s.current_period_start, s.current_period_end,
  s.next_billing_at, s.ends_at, s.created_at, s.updated_at, c.name AS customer_name, c.email AS customer_email
  FROM subscriptions s JOIN customers c ON c.id = s.customer_id`;

export class SubscriptionService implements PaymentLifecycleHandler {
  constructor(
    private readonly db: Database,
    private readonly paymentCore: PaymentCoreService,
    private readonly adapters: PaymentAdapterRegistry,
  ) {}

  async createPlan(merchantId: string, input: {
    name: string; description: string; amount: string; currency: string; interval: BillingInterval;
    intervalCount: number; trialDays: number; enabled: boolean;
  }) {
    const result = await this.db.query<PlanRecord>(
      `INSERT INTO subscription_plans (id, merchant_id, name, description, amount, currency,
                                       billing_interval, interval_count, trial_days, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, merchant_id, name, description, amount::text AS amount, currency,
         billing_interval, interval_count, trial_days, enabled, created_at, updated_at`,
      [newId(), merchantId, input.name, input.description, input.amount, input.currency,
        input.interval, input.intervalCount, input.trialDays, input.enabled],
    );
    return { plan: planView(result.rows[0]!) };
  }

  async listPlans(merchantId: string) {
    const result = await this.db.query<PlanRecord>(
      `${planSelect} WHERE merchant_id = $1 ORDER BY created_at DESC, id DESC`, [merchantId],
    );
    return { plans: result.rows.map(planView) };
  }

  async updatePlan(merchantId: string, planId: string, input: Partial<{
    name: string; description: string; amount: string; currency: string; interval: BillingInterval;
    intervalCount: number; trialDays: number; enabled: boolean;
  }>) {
    const result = await this.db.query<PlanRecord>(
      `UPDATE subscription_plans SET
         name = COALESCE($3, name), description = COALESCE($4, description), amount = COALESCE($5, amount),
         currency = COALESCE($6, currency), billing_interval = COALESCE($7, billing_interval),
         interval_count = COALESCE($8, interval_count), trial_days = COALESCE($9, trial_days),
         enabled = COALESCE($10, enabled), updated_at = now()
       WHERE id = $1 AND merchant_id = $2
       RETURNING id, merchant_id, name, description, amount::text AS amount, currency,
         billing_interval, interval_count, trial_days, enabled, created_at, updated_at`,
      [planId, merchantId, input.name ?? null, input.description ?? null, input.amount ?? null,
        input.currency ?? null, input.interval ?? null, input.intervalCount ?? null, input.trialDays ?? null,
        input.enabled ?? null],
    );
    if (!result.rows[0]) throw new HttpError(404, 'Subscription plan not found', 'subscription_plan_not_found');
    return { plan: planView(result.rows[0]) };
  }

  async createSubscription(merchant: MerchantContext, input: {
    planId: string; customerId: string; adapter?: string; billingMode: 'MANUAL' | 'AUTOMATIC'; endsAt?: string;
  }, idempotencyKey: string) {
    this.validateIdempotencyKey(idempotencyKey);
    const selectedAdapter = this.selectPaymentAdapter(input.adapter);
    const manifest = selectedAdapter.manifest;
    if (input.billingMode === 'AUTOMATIC' && !manifest.capabilities.recurringPayments) {
      throw new HttpError(422, 'Selected payment method does not support automatic recurring billing', 'recurring_unavailable');
    }
    const keyHash = hashRequest({ scope: `merchant:${merchant.id}:POST:/v1/subscriptions`, key: idempotencyKey });
    const requestHash = hashRequest(input);
    const prepared = await this.db.transaction(async (client) => {
      const existing = await client.query<{ id: string; creation_request_hash: string }>(
        `SELECT id, creation_request_hash FROM subscriptions
          WHERE merchant_id = $1 AND creation_key_hash = $2 FOR UPDATE`,
        [merchant.id, keyHash],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].creation_request_hash !== requestHash) {
          throw new HttpError(409, 'Idempotency key was already used with different subscription data', 'idempotency_conflict');
        }
        const attempt = await this.findInitialAttempt(client, existing.rows[0].id);
        return {
          subscriptionId: existing.rows[0].id,
          attemptId: attempt && ['CREATING', 'PENDING'].includes(attempt.status) ? attempt.id : null,
        };
      }

      const planResult = await client.query<PlanRecord>(
        `${planSelect} WHERE id = $1 AND merchant_id = $2 AND enabled = true`, [input.planId, merchant.id],
      );
      const plan = planResult.rows[0];
      if (!plan) throw new HttpError(404, 'Enabled subscription plan not found', 'subscription_plan_not_found');
      const customer = await client.query('SELECT id FROM customers WHERE id = $1 AND merchant_id = $2', [input.customerId, merchant.id]);
      if (!customer.rows[0]) throw new HttpError(404, 'Customer not found for this merchant', 'customer_not_found');
      if (!manifest.capabilities.currencies.includes(plan.currency)) {
        throw new HttpError(422, 'Selected payment method does not support the plan currency', 'payment_method_currency_unsupported');
      }
      const now = new Date();
      const endsAt = input.endsAt ? new Date(input.endsAt) : null;
      if (endsAt && endsAt.getTime() <= now.getTime()) throw new HttpError(400, 'Subscription end date must be in the future', 'invalid_subscription_end_date');
      const trialEndsAt = plan.trial_days > 0 ? addBillingInterval(now, 'DAY', plan.trial_days) : null;
      const firstPeriodStart = trialEndsAt ?? now;
      const firstPeriodEnd = addBillingInterval(firstPeriodStart, plan.billing_interval, plan.interval_count);
      const subscriptionId = newId();
      const status = trialEndsAt ? 'ACTIVE' : 'PAST_DUE';
      await client.query(
        `INSERT INTO subscriptions (
           id, merchant_id, customer_id, plan_id, plan_name, payment_method, billing_mode, amount, currency,
           billing_interval, interval_count, trial_days, status, starts_at, trial_ends_at,
           current_period_start, current_period_end, next_billing_at, ends_at, creation_key_hash, creation_request_hash
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        [subscriptionId, merchant.id, input.customerId, plan.id, plan.name, selectedAdapter.id, input.billingMode,
          plan.amount, plan.currency, plan.billing_interval, plan.interval_count, plan.trial_days, status, now,
          trialEndsAt, firstPeriodStart, firstPeriodEnd, firstPeriodStart, endsAt, keyHash, requestHash],
      );
      await enqueueWebhookEvent({
        client, merchantId: merchant.id, eventType: 'subscription.created', resourceId: subscriptionId,
        data: {
          subscriptionId, customerId: input.customerId, planId: plan.id, planName: plan.name,
          paymentMethod: selectedAdapter.id, billingMode: input.billingMode, status,
          amount: plan.amount, currency: plan.currency, trialEndsAt: trialEndsAt?.toISOString() ?? null,
        },
      });
      let attemptId: string | null = null;
      if (!trialEndsAt) {
        attemptId = await this.insertCycleAndAttempt(client, {
          subscriptionId, merchantId: merchant.id, cycleNumber: 1, periodStart: firstPeriodStart,
          periodEnd: firstPeriodEnd, amount: plan.amount, currency: plan.currency, requestKeyHash: keyHash,
        });
      }
      return { subscriptionId, attemptId };
    });

    const paymentResult = prepared.attemptId
      ? await this.createPaymentForAttempt(merchant, prepared.attemptId)
      : null;
    const subscription = await this.getSubscription(merchant.id, prepared.subscriptionId);
    const billingCycles = await this.listBillingCycles(merchant.id, prepared.subscriptionId);
    return {
      subscription,
      billingCycles: billingCycles.billingCycles,
      ...(paymentResult ? paymentResult.body : { payment: null, order: null, checkoutUrl: null, qrUrl: null }),
      replayed: Boolean(paymentResult?.replayed),
    };
  }

  async listSubscriptions(merchantId: string) {
    const result = await this.db.query<SubscriptionRecord>(
      `${subscriptionSelect} WHERE s.merchant_id = $1 ORDER BY s.created_at DESC, s.id DESC`, [merchantId],
    );
    return { subscriptions: result.rows.map((row) => subscriptionView(row, this.adapters)) };
  }

  async getSubscription(merchantId: string, subscriptionId: string) {
    const result = await this.db.query<SubscriptionRecord>(
      `${subscriptionSelect} WHERE s.merchant_id = $1 AND s.id = $2`, [merchantId, subscriptionId],
    );
    const subscription = result.rows[0];
    if (!subscription) throw new HttpError(404, 'Subscription not found', 'subscription_not_found');
    return subscriptionView(subscription, this.adapters);
  }

  async listCustomerSubscriptions(merchantId: string, customerId: string) {
    const customer = await this.db.query('SELECT id FROM customers WHERE id = $1 AND merchant_id = $2', [customerId, merchantId]);
    if (!customer.rows[0]) throw new HttpError(404, 'Customer not found for this merchant', 'customer_not_found');
    const result = await this.db.query<SubscriptionRecord>(
      `${subscriptionSelect} WHERE s.merchant_id = $1 AND s.customer_id = $2 ORDER BY s.created_at DESC, s.id DESC`,
      [merchantId, customerId],
    );
    return { subscriptions: result.rows.map((row) => subscriptionView(row, this.adapters)) };
  }

  async listBillingCycles(merchantId: string, subscriptionId: string) {
    const owned = await this.db.query('SELECT id FROM subscriptions WHERE id = $1 AND merchant_id = $2', [subscriptionId, merchantId]);
    if (!owned.rows[0]) throw new HttpError(404, 'Subscription not found', 'subscription_not_found');
    const cycles = await this.db.query<BillingCycleRecord>(
      `SELECT id, subscription_id, cycle_number, period_start, period_end, amount::text AS amount,
              currency, status, paid_at, created_at, updated_at
         FROM subscription_billing_cycles WHERE subscription_id = $1 ORDER BY cycle_number DESC`,
      [subscriptionId],
    );
    const history = [];
    for (const cycle of cycles.rows) {
      const attempts = await this.db.query<BillingAttemptRecord>(
        `SELECT id, subscription_id, billing_cycle_id, attempt_number, core_idempotency_key,
                order_id, payment_id, status, failure_reason, created_at, completed_at
           FROM subscription_billing_attempts WHERE billing_cycle_id = $1 ORDER BY attempt_number DESC`,
        [cycle.id],
      );
      history.push({
        id: cycle.id, subscriptionId: cycle.subscription_id, cycleNumber: cycle.cycle_number,
        periodStart: cycle.period_start, periodEnd: cycle.period_end, amount: cycle.amount,
        currency: cycle.currency, status: cycle.status, paidAt: cycle.paid_at,
        attempts: attempts.rows.map(attemptView), createdAt: cycle.created_at,
      });
    }
    return { billingCycles: history };
  }

  async updateState(merchantId: string, subscriptionId: string, action: 'pause' | 'resume' | 'cancel') {
    const result = await this.db.transaction(async (client) => {
      const found = await client.query<{ id: string; status: SubscriptionRecord['status']; next_billing_at: Date; ends_at: Date | null }>(
        `SELECT id, status, next_billing_at, ends_at FROM subscriptions
          WHERE id = $1 AND merchant_id = $2 FOR UPDATE`, [subscriptionId, merchantId],
      );
      const current = found.rows[0];
      if (!current) throw new HttpError(404, 'Subscription not found', 'subscription_not_found');
      const now = new Date();
      let status = current.status;
      if (action === 'pause') {
        if (!['ACTIVE', 'PAST_DUE'].includes(current.status)) throw new HttpError(409, 'Subscription cannot be paused from its current state', 'invalid_subscription_state');
        status = 'PAUSED';
      } else if (action === 'resume') {
        if (current.status !== 'PAUSED') throw new HttpError(409, 'Only paused subscriptions can be resumed', 'invalid_subscription_state');
        status = current.ends_at && current.ends_at <= now ? 'EXPIRED' : current.next_billing_at <= now ? 'PAST_DUE' : 'ACTIVE';
      } else {
        if (['CANCELLED', 'EXPIRED'].includes(current.status)) throw new HttpError(409, 'Subscription is already terminal', 'invalid_subscription_state');
        status = 'CANCELLED';
      }
      await client.query(
        `UPDATE subscriptions SET status = $3, ends_at = CASE WHEN $3 = 'CANCELLED' THEN $4 ELSE ends_at END, updated_at = now()
          WHERE id = $1 AND merchant_id = $2`,
        [subscriptionId, merchantId, status, now],
      );
      const eventType = action === 'pause' ? 'subscription.paused'
        : action === 'resume' ? status === 'EXPIRED' ? 'subscription.expired' : 'subscription.resumed'
          : 'subscription.cancelled';
      await enqueueWebhookEvent({
        client, merchantId, eventType, resourceId: subscriptionId,
        data: { subscriptionId, status, changedAt: now.toISOString() },
      });
      return status;
    });
    return { subscription: await this.getSubscription(merchantId, subscriptionId), previousTransitionResult: result };
  }

  async renewManually(merchant: MerchantContext, subscriptionId: string, idempotencyKey: string) {
    this.validateIdempotencyKey(idempotencyKey);
    const requestKeyHash = hashRequest({ scope: `merchant:${merchant.id}:subscription:${subscriptionId}:renew`, key: idempotencyKey });
    const prepared = await this.db.transaction(async (client) => {
      const result = await client.query<SubscriptionRecord>(
        `${subscriptionSelect} WHERE s.id = $1 AND s.merchant_id = $2 FOR UPDATE`,
        [subscriptionId, merchant.id],
      );
      const subscription = result.rows[0];
      if (!subscription) throw new HttpError(404, 'Subscription not found', 'subscription_not_found');
      if (subscription.status === 'CANCELLED' || subscription.status === 'EXPIRED' || subscription.status === 'PAUSED') {
        throw new HttpError(409, 'Subscription cannot be billed in its current state', 'invalid_subscription_state');
      }
      if (subscription.ends_at && subscription.ends_at <= new Date()) {
        await this.expireSubscriptionInTransaction(client, subscription.id, subscription.merchant_id);
        return { expired: true as const, attemptId: null };
      }
      const existingAttempt = await client.query<{ id: string; status: BillingAttemptRecord['status'] }>(
        `SELECT id, status FROM subscription_billing_attempts
          WHERE subscription_id = $1 AND request_key_hash = $2`, [subscriptionId, requestKeyHash],
      );
      if (existingAttempt.rows[0]) return { expired: false as const, attemptId: existingAttempt.rows[0].id };

      const latestCycleResult = await client.query<BillingCycleRecord>(
        `SELECT id, subscription_id, cycle_number, period_start, period_end, amount::text AS amount,
                currency, status, paid_at, created_at, updated_at
           FROM subscription_billing_cycles WHERE subscription_id = $1 ORDER BY cycle_number DESC LIMIT 1`,
        [subscriptionId],
      );
      const latestCycle = latestCycleResult.rows[0];
      if (latestCycle && ['CREATING', 'PENDING'].includes(latestCycle.status)) {
        const currentAttempt = await client.query<{ id: string }>(
          `SELECT id FROM subscription_billing_attempts WHERE billing_cycle_id = $1
            ORDER BY attempt_number DESC LIMIT 1`, [latestCycle.id],
        );
        if (currentAttempt.rows[0]) return { expired: false as const, attemptId: currentAttempt.rows[0].id };
      }
      const now = new Date();
      if (subscription.next_billing_at > now) throw new HttpError(409, 'Subscription renewal is not due yet', 'subscription_renewal_not_due');

      let cycleId: string;
      let cycleNumber: number;
      let periodStart: Date;
      let periodEnd: Date;
      let attemptNumber: number;
      if (latestCycle && ['FAILED', 'EXPIRED'].includes(latestCycle.status)) {
        cycleId = latestCycle.id;
        cycleNumber = latestCycle.cycle_number;
        periodStart = latestCycle.period_start;
        periodEnd = latestCycle.period_end;
        const lastAttempt = await client.query<{ attempt_number: number }>(
          'SELECT attempt_number FROM subscription_billing_attempts WHERE billing_cycle_id = $1 ORDER BY attempt_number DESC LIMIT 1', [cycleId],
        );
        attemptNumber = (lastAttempt.rows[0]?.attempt_number ?? 0) + 1;
        await client.query(`UPDATE subscription_billing_cycles SET status = 'CREATING', updated_at = now() WHERE id = $1`, [cycleId]);
      } else {
        cycleNumber = (latestCycle?.cycle_number ?? 0) + 1;
        periodStart = subscription.next_billing_at;
        periodEnd = addBillingInterval(periodStart, subscription.billing_interval, subscription.interval_count);
        cycleId = newId();
        attemptNumber = 1;
        await client.query(
          `INSERT INTO subscription_billing_cycles (id, subscription_id, cycle_number, period_start, period_end,
                                                    amount, currency, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'CREATING')`,
          [cycleId, subscription.id, cycleNumber, periodStart, periodEnd, subscription.amount, subscription.currency],
        );
        await this.enqueueCycleCreated(client, subscription, cycleId, cycleNumber, periodStart, periodEnd);
      }
      const attemptId = await this.insertAttempt(client, subscription, cycleId, attemptNumber, requestKeyHash);
      await client.query(
        `UPDATE subscriptions SET status = 'PAST_DUE', updated_at = now() WHERE id = $1 AND status IN ('ACTIVE', 'PAST_DUE')`,
        [subscription.id],
      );
      return { expired: false as const, attemptId };
    });
    if (prepared.expired) throw new HttpError(409, 'Subscription has expired', 'subscription_expired');
    const paymentResult = prepared.attemptId ? await this.createPaymentForAttempt(merchant, prepared.attemptId) : null;
    const billingCycles = await this.listBillingCycles(merchant.id, subscriptionId);
    return {
      subscription: await this.getSubscription(merchant.id, subscriptionId),
      billingCycles: billingCycles.billingCycles,
      ...(paymentResult ? paymentResult.body : {}),
    };
  }

  async listAdminSubscriptions(limit: number) {
    const result = await this.db.query(
      `SELECT s.id, s.merchant_id AS "merchantId", m.name AS merchant, s.customer_id AS "customerId",
              c.name AS customer, s.plan_name AS "planName", s.payment_method AS "paymentMethod",
              s.billing_mode AS "billingMode", s.amount::text AS amount, s.currency, s.billing_interval AS interval,
              s.interval_count AS "intervalCount", s.status, s.next_billing_at AS "nextBillingAt",
              s.trial_ends_at AS "trialEndsAt", s.ends_at AS "endsAt", s.created_at AS "createdAt"
         FROM subscriptions s JOIN merchants m ON m.id = s.merchant_id JOIN customers c ON c.id = s.customer_id
        ORDER BY s.created_at DESC, s.id DESC LIMIT $1`, [limit],
    );
    return { subscriptions: result.rows };
  }

  async runAutomaticRenewals(): Promise<{ due: number; started: number }> {
    await this.expireEndedSubscriptions();
    const due = await this.db.query<{ id: string }>(
      `SELECT id FROM subscriptions WHERE status = 'ACTIVE' AND billing_mode = 'AUTOMATIC'
         AND next_billing_at <= now() AND (ends_at IS NULL OR ends_at > now())
       ORDER BY next_billing_at ASC LIMIT 50`,
    );
    let started = 0;
    for (const { id } of due.rows) {
      const attemptId = await this.prepareAutomaticAttempt(id);
      if (!attemptId) continue;
      const merchant = await this.getMerchantContextBySubscription(id);
      try {
        await this.createPaymentForAttempt(merchant, attemptId);
        started++;
      } catch {
        await this.failAttemptCreation(attemptId);
      }
    }
    return { due: due.rows.length, started };
  }

  async onPaymentConfirmed(client: PoolClient, payment: PaymentLifecycleData & { transactionId: string; transactionHash: string }): Promise<void> {
    const result = await client.query<{
      attempt_id: string; cycle_id: string; subscription_id: string; attempt_status: BillingAttemptRecord['status'];
      cycle_number: number; period_start: Date; period_end: Date; subscription_status: SubscriptionRecord['status'];
    }>(
      `SELECT a.id AS attempt_id, a.billing_cycle_id AS cycle_id, a.subscription_id, a.status AS attempt_status,
              c.cycle_number, c.period_start, c.period_end, s.status AS subscription_status
         FROM subscription_billing_attempts a
         JOIN subscription_billing_cycles c ON c.id = a.billing_cycle_id
         JOIN subscriptions s ON s.id = a.subscription_id
        WHERE a.payment_id = $1 AND s.merchant_id = $2 AND a.order_id = $3 FOR UPDATE`,
      [payment.paymentId, payment.merchantId, payment.orderId],
    );
    const row = result.rows[0];
    if (!row || row.attempt_status === 'PAID') return;
    await client.query(
      `UPDATE subscription_billing_attempts SET status = 'PAID', completed_at = now(), failure_reason = NULL
        WHERE id = $1`, [row.attempt_id],
    );
    await client.query(
      `UPDATE subscription_billing_cycles SET status = 'PAID', paid_at = now(), updated_at = now()
        WHERE id = $1`, [row.cycle_id],
    );
    await client.query(
      `UPDATE subscriptions SET
          status = CASE WHEN status IN ('CANCELLED', 'EXPIRED', 'PAUSED') THEN status ELSE 'ACTIVE' END,
          current_period_start = $2, current_period_end = $3, next_billing_at = $3, updated_at = now()
        WHERE id = $1`, [row.subscription_id, row.period_start, row.period_end],
    );
    await enqueueWebhookEvent({
      client, merchantId: payment.merchantId, eventType: 'subscription.billing_cycle.paid', resourceId: row.cycle_id,
      data: {
        subscriptionId: row.subscription_id, billingCycleId: row.cycle_id,
        paymentId: payment.paymentId, transactionId: payment.transactionId,
        cycleNumber: row.cycle_number, status: 'PAID',
      },
    });
    if (row.subscription_status === 'PAST_DUE') {
      await enqueueWebhookEvent({
        client, merchantId: payment.merchantId, eventType: 'subscription.activated', resourceId: row.subscription_id,
        data: { subscriptionId: row.subscription_id, billingCycleId: row.cycle_id, status: 'ACTIVE' },
      });
    }
  }

  async onPaymentFailed(client: PoolClient, payment: PaymentLifecycleData & { transactionId: string; transactionHash: string; reason: string }): Promise<void> {
    await this.finishBillingAttempt(client, payment, 'FAILED');
  }

  async onPaymentExpired(client: PoolClient, payment: PaymentLifecycleData): Promise<void> {
    await this.finishBillingAttempt(client, payment, 'EXPIRED');
  }

  private async finishBillingAttempt(
    client: PoolClient,
    payment: PaymentLifecycleData,
    status: 'FAILED' | 'EXPIRED',
  ): Promise<void> {
    const result = await client.query<{ id: string; billing_cycle_id: string; subscription_id: string; status: BillingAttemptRecord['status'] }>(
      `SELECT a.id, a.billing_cycle_id, a.subscription_id, a.status FROM subscription_billing_attempts a
        JOIN subscriptions s ON s.id = a.subscription_id
        WHERE a.payment_id = $1 AND a.order_id = $2 AND s.merchant_id = $3 FOR UPDATE`,
      [payment.paymentId, payment.orderId, payment.merchantId],
    );
    const attempt = result.rows[0];
    if (!attempt || ['PAID', 'FAILED', 'EXPIRED'].includes(attempt.status)) return;
    await client.query(
      `UPDATE subscription_billing_attempts SET status = $2, failure_reason = $3, completed_at = now() WHERE id = $1`,
      [attempt.id, status, status === 'FAILED' ? 'Payment verification failed' : 'Payment expired'],
    );
    await client.query(
      `UPDATE subscription_billing_cycles SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'PAID'`,
      [attempt.billing_cycle_id, status],
    );
    await client.query(
      `UPDATE subscriptions SET status = CASE WHEN status IN ('CANCELLED', 'EXPIRED', 'PAUSED') THEN status ELSE 'PAST_DUE' END,
                                updated_at = now() WHERE id = $1`, [attempt.subscription_id],
    );
    await enqueueWebhookEvent({
      client, merchantId: payment.merchantId, eventType: 'subscription.billing_cycle.failed', resourceId: attempt.billing_cycle_id,
      data: { subscriptionId: attempt.subscription_id, billingCycleId: attempt.billing_cycle_id, paymentId: payment.paymentId, status },
    });
    await enqueueWebhookEvent({
      client, merchantId: payment.merchantId, eventType: 'subscription.past_due', resourceId: attempt.subscription_id,
      data: { subscriptionId: attempt.subscription_id, billingCycleId: attempt.billing_cycle_id, status: 'PAST_DUE' },
    });
  }

  private async createPaymentForAttempt(merchant: MerchantContext, attemptId: string) {
    const result = await this.db.query<{
      attempt_id: string; subscription_id: string; cycle_id: string; cycle_number: number; attempt_number: number;
      core_idempotency_key: string; customer_id: string; amount: string; currency: string; payment_method: string;
      merchant_id: string; merchant_name: string; wallet_address: string; plan_name: string;
    }>(
      `SELECT a.id AS attempt_id, a.subscription_id, a.billing_cycle_id AS cycle_id, c.cycle_number,
              a.attempt_number, a.core_idempotency_key, s.customer_id, s.amount::text AS amount,
              s.currency, s.payment_method, s.merchant_id, m.name AS merchant_name, m.wallet_address,
              s.plan_name
         FROM subscription_billing_attempts a
         JOIN subscriptions s ON s.id = a.subscription_id
         JOIN subscription_billing_cycles c ON c.id = a.billing_cycle_id
         JOIN merchants m ON m.id = s.merchant_id
        WHERE a.id = $1 AND s.merchant_id = $2`, [attemptId, merchant.id],
    );
    const billing = result.rows[0];
    if (!billing) throw new HttpError(404, 'Subscription billing attempt not found', 'subscription_attempt_not_found');
    try {
      return await this.paymentCore.createPaymentLink({
        merchant: { id: billing.merchant_id, name: billing.merchant_name, wallet_address: billing.wallet_address },
        body: {
          customerId: billing.customer_id,
          description: `${billing.plan_name} subscription billing cycle ${billing.cycle_number}`,
          amount: billing.amount,
          currency: billing.currency,
          adapter: billing.payment_method,
          metadata: {
            purpose: 'subscription_billing', subscriptionId: billing.subscription_id,
            billingCycleId: billing.cycle_id, billingAttemptId: billing.attempt_id,
          },
        } as CreateOrderInput,
        idempotencyKey: billing.core_idempotency_key,
        scope: `merchant:${billing.merchant_id}:subscription:${billing.subscription_id}:cycle:${billing.cycle_number}:attempt:${billing.attempt_number}`,
        onPaymentCreated: async (client, payment) => {
          await client.query(
            `UPDATE subscription_billing_attempts SET status = 'PENDING', order_id = $2, payment_id = $3
              WHERE id = $1 AND status = 'CREATING'`, [billing.attempt_id, payment.orderId, payment.paymentId],
          );
          await client.query(
            `UPDATE subscription_billing_cycles SET status = 'PENDING', updated_at = now()
              WHERE id = $1 AND status = 'CREATING'`, [billing.cycle_id],
          );
          return {
            response: { subscriptionId: billing.subscription_id, billingCycleId: billing.cycle_id, billingAttemptId: billing.attempt_id },
            webhookData: {
              purpose: 'subscription_billing', subscriptionId: billing.subscription_id,
              billingCycleId: billing.cycle_id, billingAttemptId: billing.attempt_id,
            },
          };
        },
      });
    } catch (error) {
      await this.failAttemptCreation(billing.attempt_id);
      throw error;
    }
  }

  private async findInitialAttempt(client: PoolClient, subscriptionId: string): Promise<Pick<BillingAttemptRecord, 'id' | 'status'> | null> {
    const result = await client.query<Pick<BillingAttemptRecord, 'id' | 'status'>>(
      `SELECT a.id, a.status FROM subscription_billing_attempts a
        JOIN subscription_billing_cycles c ON c.id = a.billing_cycle_id
       WHERE a.subscription_id = $1 AND c.cycle_number = 1 AND a.attempt_number = 1`, [subscriptionId],
    );
    return result.rows[0] ?? null;
  }

  private async failAttemptCreation(attemptId: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const result = await client.query<{ id: string; subscription_id: string; billing_cycle_id: string; status: string }>(
        `SELECT id, subscription_id, billing_cycle_id, status FROM subscription_billing_attempts WHERE id = $1 FOR UPDATE`,
        [attemptId],
      );
      const attempt = result.rows[0];
      if (!attempt || attempt.status !== 'CREATING') return;
      await client.query(
        `UPDATE subscription_billing_attempts SET status = 'FAILED', failure_reason = 'Payment request could not be created', completed_at = now()
          WHERE id = $1`, [attempt.id],
      );
      await client.query(`UPDATE subscription_billing_cycles SET status = 'FAILED', updated_at = now() WHERE id = $1`, [attempt.billing_cycle_id]);
      await client.query(
        `UPDATE subscriptions SET status = CASE WHEN status IN ('CANCELLED', 'EXPIRED', 'PAUSED') THEN status ELSE 'PAST_DUE' END,
                                  updated_at = now() WHERE id = $1`, [attempt.subscription_id],
      );
      const sub = await client.query<{ merchant_id: string }>(
        'SELECT merchant_id FROM subscriptions WHERE id = $1', [attempt.subscription_id],
      );
      if (sub.rows[0]) {
        await enqueueWebhookEvent({
          client, merchantId: sub.rows[0].merchant_id, eventType: 'subscription.past_due', resourceId: attempt.subscription_id,
          data: { subscriptionId: attempt.subscription_id, billingCycleId: attempt.billing_cycle_id, status: 'PAST_DUE' },
        });
      }
    });
  }

  private async prepareAutomaticAttempt(subscriptionId: string): Promise<string | null> {
    return this.db.transaction(async (client) => {
      const result = await client.query<SubscriptionRecord>(
        `${subscriptionSelect} WHERE s.id = $1 FOR UPDATE`, [subscriptionId],
      );
      const subscription = result.rows[0];
      if (!subscription || subscription.status !== 'ACTIVE' || subscription.billing_mode !== 'AUTOMATIC' ||
          subscription.next_billing_at > new Date()) return null;
      if (subscription.ends_at && subscription.ends_at <= new Date()) {
        await this.expireSubscriptionInTransaction(client, subscription.id, subscription.merchant_id);
        return null;
      }
      const manifest = this.adapters.getManifest(subscription.payment_method);
      if (!manifest?.capabilities.recurringPayments || !this.adapters.isEnabled(subscription.payment_method)) {
        await client.query(`UPDATE subscriptions SET status = 'PAST_DUE', updated_at = now() WHERE id = $1`, [subscription.id]);
        await enqueueWebhookEvent({
          client, merchantId: subscription.merchant_id, eventType: 'subscription.past_due', resourceId: subscription.id,
          data: { subscriptionId: subscription.id, reason: 'Recurring payment method unavailable', status: 'PAST_DUE' },
        });
        return null;
      }
      const latestResult = await client.query<BillingCycleRecord>(
        `SELECT id, subscription_id, cycle_number, period_start, period_end, amount::text AS amount,
                currency, status, paid_at, created_at, updated_at
           FROM subscription_billing_cycles WHERE subscription_id = $1 ORDER BY cycle_number DESC LIMIT 1`,
        [subscription.id],
      );
      const latest = latestResult.rows[0];
      if (latest && ['CREATING', 'PENDING'].includes(latest.status)) {
        const attempt = await client.query<{ id: string }>(
          `SELECT id FROM subscription_billing_attempts WHERE billing_cycle_id = $1
            ORDER BY attempt_number DESC LIMIT 1`, [latest.id],
        );
        return attempt.rows[0]?.id ?? null;
      }
      if (latest && ['FAILED', 'EXPIRED'].includes(latest.status)) return null;
      const cycleNumber = (latest?.cycle_number ?? 0) + 1;
      const periodStart = subscription.next_billing_at;
      const periodEnd = addBillingInterval(periodStart, subscription.billing_interval, subscription.interval_count);
      return this.insertCycleAndAttempt(client, {
        subscriptionId: subscription.id, merchantId: subscription.merchant_id, cycleNumber,
        periodStart, periodEnd, amount: subscription.amount, currency: subscription.currency, requestKeyHash: null,
      });
    });
  }

  private async expireEndedSubscriptions(): Promise<void> {
    const result = await this.db.query<{ id: string; merchant_id: string }>(
      `SELECT id, merchant_id FROM subscriptions WHERE ends_at <= now()
        AND status IN ('ACTIVE', 'PAST_DUE', 'PAUSED') LIMIT 100`,
    );
    for (const subscription of result.rows) {
      await this.db.transaction((client) => this.expireSubscriptionInTransaction(client, subscription.id, subscription.merchant_id));
    }
  }

  private async expireSubscriptionInTransaction(client: PoolClient, subscriptionId: string, merchantId: string): Promise<void> {
    const changed = await client.query(
      `UPDATE subscriptions SET status = 'EXPIRED', updated_at = now()
        WHERE id = $1 AND merchant_id = $2 AND status IN ('ACTIVE', 'PAST_DUE', 'PAUSED') RETURNING id`,
      [subscriptionId, merchantId],
    );
    if (!changed.rows[0]) return;
    await enqueueWebhookEvent({
      client, merchantId, eventType: 'subscription.expired', resourceId: subscriptionId,
      data: { subscriptionId, status: 'EXPIRED' },
    });
  }

  private async getMerchantContextBySubscription(subscriptionId: string): Promise<MerchantContext> {
    const result = await this.db.query<MerchantContext>(
      `SELECT m.id, m.name, m.wallet_address FROM subscriptions s JOIN merchants m ON m.id = s.merchant_id WHERE s.id = $1`,
      [subscriptionId],
    );
    if (!result.rows[0]) throw new HttpError(404, 'Subscription not found', 'subscription_not_found');
    return result.rows[0];
  }

  private selectPaymentAdapter(adapterId?: string) {
    try {
      return adapterId ? this.adapters.getForNewPayments(adapterId) : this.adapters.getDefaultForNewPayments();
    } catch (error) {
      if (error instanceof PaymentAdapterError) {
        throw new HttpError(503, 'Selected subscription payment method is unavailable', 'adapter_unavailable');
      }
      throw error;
    }
  }

  private async insertCycleAndAttempt(client: PoolClient, input: {
    subscriptionId: string; merchantId: string; cycleNumber: number; periodStart: Date; periodEnd: Date;
    amount: string; currency: string; requestKeyHash: string | null;
  }): Promise<string> {
    const cycleId = newId();
    await client.query(
      `INSERT INTO subscription_billing_cycles (id, subscription_id, cycle_number, period_start, period_end,
                                                amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'CREATING')`,
      [cycleId, input.subscriptionId, input.cycleNumber, input.periodStart, input.periodEnd, input.amount, input.currency],
    );
    const attemptId = await this.insertAttempt(client, { id: input.subscriptionId }, cycleId, 1, input.requestKeyHash);
    await this.enqueueCycleCreated(client, {
      id: input.subscriptionId, merchant_id: input.merchantId, amount: input.amount, currency: input.currency,
    }, cycleId, input.cycleNumber, input.periodStart, input.periodEnd);
    return attemptId;
  }

  private async insertAttempt(
    client: PoolClient,
    subscription: Pick<SubscriptionRecord, 'id'>,
    cycleId: string,
    attemptNumber: number,
    requestKeyHash: string | null,
  ): Promise<string> {
    const attemptId = newId();
    const coreIdempotencyKey = hashRequest({ subscriptionId: subscription.id, cycleId, attemptId });
    await client.query(
      `INSERT INTO subscription_billing_attempts (id, subscription_id, billing_cycle_id, attempt_number,
          request_key_hash, core_idempotency_key, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'CREATING')`,
      [attemptId, subscription.id, cycleId, attemptNumber, requestKeyHash, coreIdempotencyKey],
    );
    return attemptId;
  }

  private async enqueueCycleCreated(
    client: PoolClient,
    subscription: Pick<SubscriptionRecord, 'id' | 'merchant_id' | 'amount' | 'currency'>,
    cycleId: string,
    cycleNumber: number,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<void> {
    await enqueueWebhookEvent({
      client, merchantId: subscription.merchant_id, eventType: 'subscription.billing_cycle.created', resourceId: cycleId,
      data: {
        subscriptionId: subscription.id, billingCycleId: cycleId, cycleNumber,
        amount: subscription.amount, currency: subscription.currency,
        periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(),
      },
    });
  }

  private validateIdempotencyKey(key: string): void {
    if (key.length < 8 || key.length > 128) throw new HttpError(400, 'Idempotency-Key must be 8-128 characters', 'invalid_idempotency_key');
  }
}

function planView(plan: PlanRecord) {
  return {
    id: plan.id, merchantId: plan.merchant_id, name: plan.name, description: plan.description,
    amount: plan.amount, currency: plan.currency, interval: plan.billing_interval,
    intervalCount: plan.interval_count, trialDays: plan.trial_days, enabled: plan.enabled,
    createdAt: plan.created_at, updatedAt: plan.updated_at,
  };
}

function subscriptionView(subscription: SubscriptionRecord, adapters: PaymentAdapterRegistry) {
  const manifest = adapters.getManifest(subscription.payment_method);
  return {
    id: subscription.id,
    merchantId: subscription.merchant_id,
    customerId: subscription.customer_id,
    customer: { name: subscription.customer_name ?? null, email: subscription.customer_email ?? null },
    planId: subscription.plan_id,
    planName: subscription.plan_name,
    paymentMethod: { id: subscription.payment_method, name: manifest?.name ?? subscription.payment_method },
    billingMode: subscription.billing_mode,
    automaticRenewalAvailable: Boolean(manifest?.capabilities.recurringPayments && adapters.isEnabled(subscription.payment_method)),
    amount: subscription.amount,
    currency: subscription.currency,
    interval: subscription.billing_interval,
    intervalCount: subscription.interval_count,
    trialDays: subscription.trial_days,
    status: subscription.status,
    startsAt: subscription.starts_at,
    trialEndsAt: subscription.trial_ends_at,
    currentPeriodStart: subscription.current_period_start,
    currentPeriodEnd: subscription.current_period_end,
    nextBillingAt: subscription.next_billing_at,
    endsAt: subscription.ends_at,
    createdAt: subscription.created_at,
    updatedAt: subscription.updated_at,
  };
}

function attemptView(attempt: BillingAttemptRecord) {
  return {
    id: attempt.id, billingCycleId: attempt.billing_cycle_id, attemptNumber: attempt.attempt_number,
    orderId: attempt.order_id, paymentId: attempt.payment_id, status: attempt.status,
    failureReason: attempt.failure_reason, createdAt: attempt.created_at, completedAt: attempt.completed_at,
  };
}
