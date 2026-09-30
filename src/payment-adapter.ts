export const paymentStates = ['PENDING', 'DETECTED', 'CONFIRMED', 'FAILED'] as const;
export type PaymentState = typeof paymentStates[number];

export type PaymentAdapterStatus = 'enabled' | 'disabled';
export type PaymentAdapterHealthStatus = 'healthy' | 'degraded' | 'unavailable';

export interface PaymentAdapterCapabilities {
  readonly paymentRequests: boolean;
  readonly transactionVerification: boolean;
  readonly statusPolling: boolean;
  readonly automaticDetection: boolean;
  readonly refunds: boolean;
  readonly paymentRequestFormat: 'wallet' | 'invoice';
  readonly currencies: readonly string[];
  readonly networks: readonly string[];
}

export interface PaymentAdapterManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly capabilities: PaymentAdapterCapabilities;
  readonly idempotency: {
    readonly paymentCreation: 'stable-key-required';
    readonly transactionVerification: 'network-and-transaction-id';
  };
}

export interface PaymentAdapterConfiguration {
  readonly enabled: boolean;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly isDefault?: boolean;
}

export interface PaymentAdapterHealth {
  readonly status: PaymentAdapterHealthStatus;
  readonly message: string;
}

export interface PaymentRequest {
  paymentId: string;
  idempotencyKey: string;
  amount: string;
  currency: string;
  recipient: string;
  description?: string;
  expiresAt: string | null;
}

export interface AdapterPaymentDetails {
  adapter: string;
  network: string;
  currency: string;
  recipientAddress: string;
  tokenAddress: string | null;
  amountBaseUnits: string;
  adapterData: Record<string, unknown>;
}

export interface PaymentVerificationInput {
  paymentId: string;
  transactionId: string;
  amount: string;
  amountBaseUnits: string;
  currency: string;
  network: string;
  recipientAddress: string;
  tokenAddress: string | null;
  adapterData: Readonly<Record<string, unknown>>;
  createdAt: Date;
}

export interface PaymentReceipt {
  transactionId: string;
  network: string;
  state: 'pending' | 'confirmed' | 'failed';
  amount: string;
  currency: string;
  recipient: string;
  confirmations: number;
  blockNumber: string | null;
}

export type PaymentVerificationResult =
  | { state: 'not_found' }
  | { state: 'pending'; detected: boolean; receipt: PaymentReceipt }
  | { state: 'rejected'; reason: string }
  | { state: 'failed'; reason: string; receipt: PaymentReceipt }
  | { state: 'verified'; receipt: PaymentReceipt };

export interface PaymentStatusPollResult {
  transactionId: string;
  result: PaymentVerificationResult;
}

/** Implementations own rail-specific configuration, request creation and verification. */
export interface PaymentAdapter {
  readonly id: string;
  readonly manifest: PaymentAdapterManifest;
  initialize(settings: Readonly<Record<string, unknown>>): Promise<void>;
  shutdown(): Promise<void>;
  health(): Promise<PaymentAdapterHealth>;
  normalizeTransactionId(transactionId: string): string;
  createRequest(input: PaymentRequest): Promise<AdapterPaymentDetails>;
  verifyTransaction(input: PaymentVerificationInput): Promise<PaymentVerificationResult>;
  pollPaymentStatus?(input: Omit<PaymentVerificationInput, 'transactionId'>): Promise<PaymentStatusPollResult | null>;
}
