import type { PoolClient } from 'pg';

export type PaymentLifecycleData = {
  paymentId: string;
  merchantId: string;
  orderId: string;
  amount: string;
  currency: string;
  network: string;
  transactionHash?: string;
  reason?: string;
};

export interface PaymentLifecycleHandler {
  onPaymentConfirmed?(client: PoolClient, payment: PaymentLifecycleData & { transactionHash: string }): Promise<void>;
  onPaymentFailed?(client: PoolClient, payment: PaymentLifecycleData & { transactionHash: string; reason: string }): Promise<void>;
  onPaymentExpired?(client: PoolClient, payment: PaymentLifecycleData): Promise<void>;
}
