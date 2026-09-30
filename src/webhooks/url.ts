import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === undefined || b === undefined || c === undefined) return false;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (version === 6) {
    const value = address.toLowerCase().split('%')[0]!;
    if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
        /^fe[89ab]/.test(value) || value.startsWith('ff') || value.startsWith('2001:db8:') ||
        value.startsWith('64:ff9b:')) return false;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isPublicAddress(mapped[1]!);
    const mappedHex = /(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1]!, 16);
      const low = Number.parseInt(mappedHex[2]!, 16);
      return isPublicAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
    }
    return true;
  }
  return false;
}

export async function validateWebhookUrl(value: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'Webhook URL is invalid', 'invalid_webhook_url');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new HttpError(400, 'Webhook URL must be HTTP(S), without credentials or fragments', 'invalid_webhook_url');
  }
  if (config.NODE_ENV !== 'production') return url.toString();
  if (url.protocol !== 'https:' || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) {
    throw new HttpError(400, 'Production webhooks require a public HTTPS URL', 'invalid_webhook_url');
  }
  const literalVersion = isIP(url.hostname.replace(/^\[|\]$/g, ''));
  if (literalVersion) {
    if (!isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))) {
      throw new HttpError(400, 'Webhook URL cannot target a private or reserved IP address', 'invalid_webhook_url');
    }
  } else {
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookup(url.hostname, { all: true, verbatim: true });
    } catch {
      throw new HttpError(400, 'Webhook URL host could not be resolved', 'invalid_webhook_url');
    }
    if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
      throw new HttpError(400, 'Webhook URL must resolve only to public IP addresses', 'invalid_webhook_url');
    }
  }
  return url.toString();
}
