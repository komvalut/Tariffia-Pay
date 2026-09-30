import { config } from '../config.js';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import type { DetectedUsdcTransfer } from '../adapters/usdc/base-usdc-adapter.js';
import type { PaymentVerificationService } from './payment-verification-service.js';

type CandidatePayment = {
  id: string;
  merchant_id: string;
  recipient_address: string;
  amount_base_units: string;
};

export interface UsdcTransferScanner {
  readonly id: string;
  readonly network: string;
  getBlockNumber(): Promise<bigint>;
  scanTransfers(fromBlock: bigint, toBlock: bigint): Promise<DetectedUsdcTransfer[]>;
}

export class UsdcPaymentDetector {
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly adapter: UsdcTransferScanner,
    private readonly verification: PaymentVerificationService,
  ) {}

  async pollOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.retryDetectedPayments();
      const head = await this.adapter.getBlockNumber();
      const saved = await this.db.query<{ last_scanned_block: string }>(
        `SELECT last_scanned_block::text FROM payment_scan_cursors WHERE network = $1`,
        [this.adapter.network],
      );
      const lookbackStart = head > BigInt(config.PAYMENT_SCAN_LOOKBACK_BLOCKS)
        ? head - BigInt(config.PAYMENT_SCAN_LOOKBACK_BLOCKS) + 1n
        : 0n;
      const cursorStart = saved.rows[0] ? BigInt(saved.rows[0].last_scanned_block) + 1n : lookbackStart;
      const fromBlock = saved.rows[0] ? cursorStart : lookbackStart;
      if (fromBlock > head) return;
      const toBlock = fromBlock + BigInt(config.PAYMENT_SCAN_BLOCK_RANGE) - 1n < head
        ? fromBlock + BigInt(config.PAYMENT_SCAN_BLOCK_RANGE) - 1n
        : head;

      const [transfers, pending] = await Promise.all([
        this.adapter.scanTransfers(fromBlock, toBlock),
        this.db.query<CandidatePayment>(
          `SELECT id, merchant_id, lower(recipient_address) AS recipient_address,
                  amount_base_units::text AS amount_base_units
             FROM payments
            WHERE adapter = $1 AND network = $2 AND status = 'PENDING'
            ORDER BY created_at ASC`,
          [this.adapter.id, this.adapter.network],
        ),
      ]);

      const candidates = new Map<string, CandidatePayment[]>();
      for (const payment of pending.rows) {
        const key = `${payment.recipient_address}:${payment.amount_base_units}`;
        const list = candidates.get(key) ?? [];
        list.push(payment);
        candidates.set(key, list);
      }

      for (const transfer of transfers) {
        const key = `${transfer.recipientAddress.toLowerCase()}:${transfer.amountBaseUnits.toString()}`;
        const list = candidates.get(key);
        if (!list?.length) continue;
        for (let index = 0; index < list.length; index++) {
          const payment = list[index]!;
          try {
            const result = await this.verification.process(payment.id, payment.merchant_id, transfer.transactionHash);
            if (result.status !== 'PENDING' || result.confirmations > 0) {
              list.splice(index, 1);
              break;
            }
          } catch (error) {
            if (error instanceof HttpError && [409, 422].includes(error.statusCode)) continue;
            throw error;
          }
        }
      }

      await this.db.query(
        `INSERT INTO payment_scan_cursors (network, last_scanned_block)
         VALUES ($1, $2)
         ON CONFLICT (network) DO UPDATE SET
           last_scanned_block = GREATEST(payment_scan_cursors.last_scanned_block, EXCLUDED.last_scanned_block),
           updated_at = now()`,
        [this.adapter.network, toBlock.toString()],
      );
    } finally {
      this.running = false;
    }
  }

  private async retryDetectedPayments(): Promise<void> {
    const result = await this.db.query<{ id: string; merchant_id: string; tx_hash: string }>(
      `SELECT id, merchant_id, tx_hash FROM payments
        WHERE adapter = $1 AND network = $2 AND status = 'DETECTED' AND tx_hash IS NOT NULL
        ORDER BY detected_at ASC`,
      [this.adapter.id, this.adapter.network],
    );
    for (const payment of result.rows) {
      try {
        await this.verification.process(payment.id, payment.merchant_id, payment.tx_hash);
      } catch (error) {
        if (error instanceof HttpError && [409, 422].includes(error.statusCode)) continue;
        throw error;
      }
    }
  }
}
