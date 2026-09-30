const paymentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Build a hosted checkout URL; this helper never authenticates or accepts an API key. */
export function checkoutUrlForPayment(paymentId: string, publicBaseUrl: string): string {
  if (!paymentIdPattern.test(paymentId)) throw new TypeError('paymentId must be a UUID');
  const base = new URL(publicBaseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new TypeError('Public checkout base URL must use HTTP(S) without credentials, query, or fragment');
  }
  return new URL(`/p/${encodeURIComponent(paymentId)}`, base).toString();
}

/** Navigate to a checkout URL returned by the server SDK. No merchant secret is used. */
export function openCheckout(
  checkoutUrl: string,
  target: Pick<Location, 'assign'> = window.location,
): void {
  const url = new URL(checkoutUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !/^\/p\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(url.pathname)) {
    throw new TypeError('Expected a Tariffia hosted checkout URL');
  }
  target.assign(url.toString());
}
