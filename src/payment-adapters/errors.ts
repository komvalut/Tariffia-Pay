export type PaymentAdapterErrorCode =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'unavailable'
  | 'operation_failed'
  | 'invalid_response';

export type PaymentAdapterOperation = 'initialize' | 'create_request' | 'verify_transaction' | 'health';

export class PaymentAdapterError extends Error {
  constructor(
    readonly code: PaymentAdapterErrorCode,
    readonly operation: PaymentAdapterOperation,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PaymentAdapterError';
  }
}

export function normalizeAdapterError(error: unknown, operation: PaymentAdapterOperation): PaymentAdapterError {
  if (error instanceof PaymentAdapterError) return error;
  return new PaymentAdapterError(
    operation === 'initialize' ? 'invalid_configuration' : 'unavailable',
    operation,
    operation === 'initialize' ? 'Payment adapter configuration is invalid' : 'Payment adapter is temporarily unavailable',
    operation !== 'initialize',
    error instanceof Error ? { cause: error } : undefined,
  );
}
