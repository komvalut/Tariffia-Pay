export const paymentStatuses = [
  'CREATED', 'PENDING', 'DETECTED', 'VERIFYING', 'CONFIRMED', 'FAILED', 'EXPIRED', 'REFUNDED',
] as const;
export type PaymentStatus = typeof paymentStatuses[number];

export const orderStatuses = ['CREATED', 'PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED'] as const;
export type OrderStatus = typeof orderStatuses[number];

const paymentStatusLabels: Record<string, string> = {
  CREATED: 'Created',
  PENDING: 'Pending',
  DETECTED: 'Detected',
  VERIFYING: 'Verifying',
  CONFIRMED: 'Confirmed',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  REFUNDED: 'Refunded',
};

const orderStatusLabels: Record<string, string> = {
  CREATED: 'Created',
  PENDING: 'Pending',
  PAID: 'Paid',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
};

/** Human-readable payment status label; unknown or legacy values are returned unchanged. */
export function paymentStatusLabel(status: string): string {
  return paymentStatusLabels[status] ?? status;
}

/** Human-readable order status label; unknown or legacy values are returned unchanged. */
export function orderStatusLabel(status: string): string {
  return orderStatusLabels[status] ?? status;
}
