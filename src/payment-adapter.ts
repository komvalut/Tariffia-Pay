export interface PaymentRequest {
  paymentId: string;
  amount: string;
  currency: string;
  recipient: string;
  expiresAt: string | null;
}

/** Adapter boundary: domain services depend on a payment request, not a chain SDK. */
export interface PaymentAdapter {
  readonly id: string;
  createRequest(input: PaymentRequest): Promise<Record<string, unknown>>;
  verifyTransaction(input: { paymentId: string; transactionHash: string }): Promise<{
    verified: boolean;
    reason?: string;
  }>;
}
