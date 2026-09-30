import { config } from './config.js';

export function checkoutUrlForPayment(paymentId: string): string {
  return new URL(`/p/${paymentId}`, config.PUBLIC_BASE_URL).toString();
}

export function checkoutQrUrlForPayment(paymentId: string): string {
  return new URL(`/p/${paymentId}/qr.png`, config.PUBLIC_BASE_URL).toString();
}
