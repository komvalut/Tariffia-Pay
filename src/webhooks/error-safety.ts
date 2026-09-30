export function safeWebhookTransportError(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : 'Error';
  return `Webhook transport failed (${name})`;
}

export function sanitizeStoredWebhookError(error: string | null, httpStatus: number | null): string | null {
  if (!error) return null;
  if (httpStatus !== null) return `Webhook receiver returned HTTP ${httpStatus}`;
  return 'Webhook delivery failed before an HTTP response';
}
