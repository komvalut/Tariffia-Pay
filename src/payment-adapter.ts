export interface PaymentRequest {
  paymentId: string;
  amount: string;
  currency: string;
  recipient: string;
  expiresAt: string | null;
}

export interface AdapterPaymentDetails {
  adapter: string;
  network: string;
  currency: string;
  recipientAddress: string;
  tokenAddress: string;
  adapterData: Record<string, unknown>;
}

export interface PaymentVerificationInput {
  paymentId: string;
  transactionHash: string;
  amount: string;
  currency: string;
  network: string;
  recipientAddress: string;
  tokenAddress: string | null;
  createdAt: Date;
}

export type PaymentVerificationResult =
  | { state: 'not_found' }
  | { state: 'pending'; detected: boolean; confirmations: number; blockNumber?: bigint }
  | { state: 'rejected'; reason: string }
  | { state: 'verified'; confirmations: number; blockNumber: bigint };

/** Adapter boundary: domain services depend on a payment request, not a chain SDK. */
export interface PaymentAdapter {
  readonly id: string;
  createRequest(input: PaymentRequest): Promise<AdapterPaymentDetails>;
  verifyTransaction(input: PaymentVerificationInput): Promise<PaymentVerificationResult>;
}
