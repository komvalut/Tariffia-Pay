import { formatUnits } from 'viem';
import type { PoolClient } from 'pg';
import { HttpError } from '../errors.js';
import { newId } from '../security.js';

/**
 * Atomically deducts usage credits inside the caller's transaction: a conditional
 * `balance >= amount` update on the already-locked credit account, the DEDUCTION credit
 * transaction and the separate CREDITS ledger entry. Shared by the AI and SMS gateways
 * so both services settle through the single existing credit/ledger architecture.
 * Callers own their usage records and webhook events.
 */
export async function deductUsageCreditsInTransaction(client: PoolClient, input: {
  merchantId: string;
  customerId: string;
  accountId: string;
  creditUnits: bigint;
  reference: string;
  idempotencyKey: string;
  transactionMetadata: Record<string, unknown>;
}): Promise<{ transactionId: string; balanceAfter: bigint; creditAmount: string }> {
  if (input.creditUnits <= 0n) {
    throw new HttpError(409, 'Usage pricing must produce a positive customer charge', 'zero_usage_price');
  }
  const balanceResult = await client.query<{ balance_units: string }>(
    `UPDATE credit_accounts SET balance_units = balance_units - $2, updated_at = now()
      WHERE id = $1 AND balance_units >= $2 RETURNING balance_units::text AS balance_units`,
    [input.accountId, input.creditUnits.toString()],
  );
  if (!balanceResult.rows[0]) throw new HttpError(409, 'Insufficient credits', 'insufficient_credits');

  const transactionId = newId();
  const balanceAfter = BigInt(balanceResult.rows[0].balance_units);
  await client.query(
    `INSERT INTO credit_transactions (id, merchant_id, account_id, customer_id, transaction_type,
                                     credit_units, balance_after_units, reference, idempotency_key, metadata)
     VALUES ($1, $2, $3, $4, 'DEDUCTION', $5, $6, $7, $8, $9::jsonb)`,
    [transactionId, input.merchantId, input.accountId, input.customerId, input.creditUnits.toString(),
      balanceAfter.toString(), input.reference, input.idempotencyKey, JSON.stringify(input.transactionMetadata)],
  );
  await client.query(
    `INSERT INTO ledger_entries (id, merchant_id, entry_type, amount, currency, reference, metadata)
     VALUES ($1, $2, 'CREDIT_DEDUCTION', $3, 'CREDITS', $4, $5::jsonb)`,
    [newId(), input.merchantId, formatUnits(input.creditUnits, 6), transactionId,
      JSON.stringify({ customerId: input.customerId, creditTransactionId: transactionId, ...input.transactionMetadata })],
  );
  return { transactionId, balanceAfter, creditAmount: formatUnits(input.creditUnits, 6) };
}
