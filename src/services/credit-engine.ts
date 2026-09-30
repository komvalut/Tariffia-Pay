import { formatUnits, parseUnits } from 'viem';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { newId } from '../security.js';
import { enqueueWebhookEvent } from '../webhooks/outbox.js';
import type { PaymentLifecycleData, PaymentLifecycleHandler } from './payment-lifecycle.js';
import { runIdempotently } from '../idempotency.js';

export type CreditSettings = {
  creditsPerUsdcRate: number;
  minimumTopupUsdc: string;
  maximumTopupUsdc: string;
};

type CreditAccount = { id: string; balance_units: string };

type PendingCreditTopup = {
  id: string;
  merchant_id: string;
  account_id: string;
  customer_id: string;
  order_id: string;
  payment_id: string;
  amount_usdc: string;
  credit_units: string;
  credits_per_usdc_rate: number;
  status: string;
};

export class CreditEngine implements PaymentLifecycleHandler {
  constructor(private readonly db: Database) {}

  async initialize(): Promise<void> {
    this.validateSettings({
      creditsPerUsdcRate: config.CREDITS_PER_USDC_RATE,
      minimumTopupUsdc: config.CREDIT_MINIMUM_TOPUP_USDC,
      maximumTopupUsdc: config.CREDIT_MAXIMUM_TOPUP_USDC,
    });
    await this.db.query(
      `INSERT INTO credit_settings (id, credits_per_usdc_rate, minimum_topup_usdc, maximum_topup_usdc)
       VALUES (1, $1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [config.CREDITS_PER_USDC_RATE, config.CREDIT_MINIMUM_TOPUP_USDC, config.CREDIT_MAXIMUM_TOPUP_USDC],
    );
  }

  async getSettings(): Promise<CreditSettings> {
    const result = await this.db.query<{
      credits_per_usdc_rate: number;
      minimum_topup_usdc: string;
      maximum_topup_usdc: string;
    }>(
      `SELECT credits_per_usdc_rate, minimum_topup_usdc::text AS minimum_topup_usdc,
              maximum_topup_usdc::text AS maximum_topup_usdc
         FROM credit_settings WHERE id = 1`,
    );
    return this.settingsFromRow(result.rows[0]);
  }

  async getSettingsInTransaction(client: PoolClient): Promise<CreditSettings> {
    const result = await client.query<{
      credits_per_usdc_rate: number;
      minimum_topup_usdc: string;
      maximum_topup_usdc: string;
    }>(
      `SELECT credits_per_usdc_rate, minimum_topup_usdc::text AS minimum_topup_usdc,
              maximum_topup_usdc::text AS maximum_topup_usdc
         FROM credit_settings WHERE id = 1`,
    );
    return this.settingsFromRow(result.rows[0]);
  }

  private settingsFromRow(settings: {
    credits_per_usdc_rate: number;
    minimum_topup_usdc: string;
    maximum_topup_usdc: string;
  } | undefined): CreditSettings {
    if (!settings) throw new Error('Credit settings have not been initialized');
    return {
      creditsPerUsdcRate: settings.credits_per_usdc_rate,
      minimumTopupUsdc: settings.minimum_topup_usdc,
      maximumTopupUsdc: settings.maximum_topup_usdc,
    };
  }

  async updateSettings(settings: CreditSettings): Promise<CreditSettings> {
    this.validateSettings(settings);
    const result = await this.db.query(
      `UPDATE credit_settings
          SET credits_per_usdc_rate = $1, minimum_topup_usdc = $2, maximum_topup_usdc = $3, updated_at = now()
        WHERE id = 1
        RETURNING credits_per_usdc_rate AS "creditsPerUsdcRate",
                  minimum_topup_usdc::text AS "minimumTopupUsdc", maximum_topup_usdc::text AS "maximumTopupUsdc"`,
      [settings.creditsPerUsdcRate, settings.minimumTopupUsdc, settings.maximumTopupUsdc],
    );
    return result.rows[0] as CreditSettings;
  }

  async getOrCreateAccount(merchantId: string, customerId: string): Promise<CreditAccount> {
    const customer = await this.db.query(
      'SELECT id FROM customers WHERE id = $1 AND merchant_id = $2',
      [customerId, merchantId],
    );
    if (!customer.rows[0]) throw new HttpError(404, 'Customer not found for this merchant', 'customer_not_found');
    return this.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO credit_accounts (id, merchant_id, customer_id) VALUES ($1, $2, $3)
         ON CONFLICT (merchant_id, customer_id) DO NOTHING`,
        [newId(), merchantId, customerId],
      );
      const account = await client.query<CreditAccount>(
        `SELECT id, balance_units::text AS balance_units FROM credit_accounts
          WHERE merchant_id = $1 AND customer_id = $2`,
        [merchantId, customerId],
      );
      if (!account.rows[0]) throw new Error('Could not initialize credit account');
      return account.rows[0];
    });
  }

  async deductCredits(input: {
    merchantId: string;
    customerId: string;
    amount: string;
    reference?: string;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
  }) {
    const account = await this.getOrCreateAccount(input.merchantId, input.customerId);
    const creditUnits = CreditEngine.parseCreditAmount(input.amount);
    if (creditUnits <= 0n) throw new HttpError(400, 'Credit amount must be greater than zero', 'invalid_credit_amount');
    const scope = `merchant:${input.merchantId}:POST:/v1/credits/deductions`;
    const idempotencyKey = `deduction:${input.idempotencyKey}`;
    return runIdempotently({
      db: this.db,
      scope,
      key: input.idempotencyKey,
      request: { customerId: input.customerId, amount: input.amount, reference: input.reference, metadata: input.metadata },
      work: async (client) => {
        const updated = await client.query<{ balance_units: string }>(
          `UPDATE credit_accounts
              SET balance_units = balance_units - $3, updated_at = now()
            WHERE id = $1 AND merchant_id = $2 AND balance_units >= $3
            RETURNING balance_units::text AS balance_units`,
          [account.id, input.merchantId, creditUnits.toString()],
        );
        if (!updated.rows[0]) throw new HttpError(409, 'Insufficient credits', 'insufficient_credits');
        const transactionId = newId();
        const reference = input.reference ?? transactionId;
        const balanceAfter = BigInt(updated.rows[0].balance_units);
        await client.query(
          `INSERT INTO credit_transactions (id, merchant_id, account_id, customer_id, transaction_type,
                                           credit_units, balance_after_units, reference, idempotency_key, metadata)
           VALUES ($1, $2, $3, $4, 'DEDUCTION', $5, $6, $7, $8, $9::jsonb)`,
          [transactionId, input.merchantId, account.id, input.customerId, creditUnits.toString(),
            balanceAfter.toString(), reference, idempotencyKey, JSON.stringify(input.metadata)],
        );
        await client.query(
          `INSERT INTO ledger_entries (id, merchant_id, entry_type, amount, currency, reference, metadata)
           VALUES ($1, $2, 'CREDIT_DEDUCTION', $3, 'CREDITS', $4, $5::jsonb)`,
          [newId(), input.merchantId, formatUnits(creditUnits, 6), transactionId,
            JSON.stringify({ customerId: input.customerId, creditTransactionId: transactionId, reference })],
        );
        await enqueueWebhookEvent({
          client,
          merchantId: input.merchantId,
          eventType: 'credit.deducted',
          resourceId: transactionId,
          data: {
            creditTransactionId: transactionId,
            creditAccountId: account.id,
            customerId: input.customerId,
            creditAmount: formatUnits(creditUnits, 6),
            balanceAfter: formatUnits(balanceAfter, 6),
            reference,
            metadata: input.metadata,
          },
        });
        return {
          status: 201,
          body: {
            transaction: {
              id: transactionId,
              accountId: account.id,
              customerId: input.customerId,
              type: 'DEDUCTION',
              amount: formatUnits(creditUnits, 6),
              balanceAfter: formatUnits(balanceAfter, 6),
              reference,
              metadata: input.metadata,
            },
          },
        };
      },
    });
  }

  async onPaymentConfirmed(client: PoolClient, payment: PaymentLifecycleData & { transactionHash: string }): Promise<void> {
    const result = await client.query<PendingCreditTopup>(
      `SELECT id, merchant_id, account_id, customer_id, order_id, payment_id,
              amount_usdc::text AS amount_usdc, credit_units::text AS credit_units,
              credits_per_usdc_rate, status
         FROM credit_topups WHERE payment_id = $1 AND merchant_id = $2 AND order_id = $3 FOR UPDATE`,
      [payment.paymentId, payment.merchantId, payment.orderId],
    );
    const topup = result.rows[0];
    if (!topup || topup.status === 'CREDITED') return;
    if (topup.status !== 'PENDING') throw new HttpError(409, `Credit top-up cannot be applied from status ${topup.status}`, 'invalid_credit_topup_state');
    if (payment.currency !== 'USDC' || parseUnits(topup.amount_usdc, 6) !== parseUnits(payment.amount, 6)) {
      throw new HttpError(409, 'Confirmed payment does not match the recorded USDC credit top-up', 'credit_topup_payment_mismatch');
    }

    const accountResult = await client.query<{ balance_units: string }>(
      `UPDATE credit_accounts SET balance_units = balance_units + $2, updated_at = now()
        WHERE id = $1 AND merchant_id = $3 RETURNING balance_units::text AS balance_units`,
      [topup.account_id, topup.credit_units, topup.merchant_id],
    );
    const account = accountResult.rows[0];
    if (!account) throw new Error('Credit account for confirmed top-up was not found');

    const transactionId = newId();
    const idempotencyKey = `topup:${topup.id}`;
    await client.query(
      `INSERT INTO credit_transactions (id, merchant_id, account_id, customer_id, transaction_type,
                                       credit_units, balance_after_units, reference, idempotency_key, metadata)
       VALUES ($1, $2, $3, $4, 'TOPUP', $5, $6, $7, $8, $9::jsonb)`,
      [transactionId, topup.merchant_id, topup.account_id, topup.customer_id, topup.credit_units,
        account.balance_units, payment.paymentId, idempotencyKey,
        JSON.stringify({ paymentId: payment.paymentId, amountUsdc: topup.amount_usdc, creditsPerUsdcRate: topup.credits_per_usdc_rate })],
    );
    await client.query(
      `UPDATE credit_topups SET status = 'CREDITED', credit_transaction_id = $2,
                                credited_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'PENDING'`,
      [topup.id, transactionId],
    );
    await client.query(
      `INSERT INTO ledger_entries (id, merchant_id, order_id, payment_id, entry_type, amount, currency, reference, metadata)
       VALUES ($1, $2, $3, $4, 'CREDIT_TOPUP', $5, 'CREDITS', $6, $7::jsonb)`,
      [newId(), topup.merchant_id, topup.order_id, topup.payment_id,
        formatUnits(BigInt(topup.credit_units), 6), transactionId,
        JSON.stringify({ customerId: topup.customer_id, paymentId: topup.payment_id,
          amountUsdc: topup.amount_usdc, creditsPerUsdcRate: topup.credits_per_usdc_rate })],
    );
    await enqueueWebhookEvent({
      client,
      merchantId: topup.merchant_id,
      eventType: 'credit.topup',
      resourceId: transactionId,
      data: {
        creditTransactionId: transactionId, creditAccountId: topup.account_id,
        customerId: topup.customer_id, paymentId: topup.payment_id,
        amountUsdc: topup.amount_usdc, creditAmount: formatUnits(BigInt(topup.credit_units), 6),
        balanceAfter: formatUnits(BigInt(account.balance_units), 6), status: 'CREDITED',
      },
    });
  }

  async onPaymentFailed(client: PoolClient, payment: PaymentLifecycleData): Promise<void> {
    await client.query(
      `UPDATE credit_topups SET status = 'FAILED', failure_reason = $2, updated_at = now()
        WHERE payment_id = $1 AND merchant_id = $3 AND order_id = $4 AND status = 'PENDING'`,
      [payment.paymentId, payment.reason ?? 'Payment failed', payment.merchantId, payment.orderId],
    );
  }

  async onPaymentExpired(client: PoolClient, payment: PaymentLifecycleData): Promise<void> {
    await client.query(
      `UPDATE credit_topups SET status = 'EXPIRED', failure_reason = 'Payment expired', updated_at = now()
        WHERE payment_id = $1 AND merchant_id = $2 AND order_id = $3 AND status = 'PENDING'`,
      [payment.paymentId, payment.merchantId, payment.orderId],
    );
  }

  static creditUnitsForUsdc(amountBaseUnits: bigint, creditsPerUsdcRate: number): bigint {
    return amountBaseUnits * BigInt(creditsPerUsdcRate);
  }

  static parseCreditAmount(amount: string): bigint {
    return parseUnits(amount, 6);
  }

  private validateSettings(settings: CreditSettings): void {
    if (!Number.isInteger(settings.creditsPerUsdcRate) || settings.creditsPerUsdcRate < 1) {
      throw new HttpError(400, 'creditsPerUsdcRate must be a positive integer', 'invalid_credit_settings');
    }
    const minimum = parseUnits(settings.minimumTopupUsdc, 6);
    const maximum = parseUnits(settings.maximumTopupUsdc, 6);
    if (minimum <= 0n || maximum < minimum) {
      throw new HttpError(400, 'Credit top-up limits are invalid', 'invalid_credit_settings');
    }
  }
}
