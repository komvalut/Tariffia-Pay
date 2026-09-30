export type LightningBitcoinNetwork = 'mainnet' | 'testnet' | 'signet';
export type LightningProviderPaymentState = 'pending' | 'settled' | 'expired' | 'cancelled';

export interface LightningInvoiceRequest {
  paymentId: string;
  idempotencyKey: string;
  amountMsat: string;
  memo: string;
  network: LightningBitcoinNetwork;
  expiresAt: string;
}

/** Safe invoice data returned to the customer-facing payment flow. */
export interface LightningInvoice {
  paymentRequest: string;
  paymentHash: string;
  amountMsat: string;
  network: LightningBitcoinNetwork;
  expiresAt: string;
  providerReference?: string;
}

export interface LightningProviderPayment {
  paymentHash: string;
  amountMsat: string;
  network: LightningBitcoinNetwork;
  state: LightningProviderPaymentState;
}

/** Boundary for a future LND/CLN/LDK-backed implementation. */
export interface LightningProvider {
  createInvoice(input: LightningInvoiceRequest): Promise<LightningInvoice>;
  getPayment(paymentHash: string, network: LightningBitcoinNetwork): Promise<LightningProviderPayment | null>;
  health(): Promise<{ available: boolean }>;
  shutdown(): Promise<void>;
}
