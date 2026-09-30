import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '../config.js';
import { HttpError } from '../errors.js';

export type WebhookResolvedAddress = { address: string; family: 4 | 6 };
export type WebhookTarget = { url: URL; addresses: WebhookResolvedAddress[] | null };
export type WebhookLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export function isPublicAddress(address: string): boolean {
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
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (version === 6) {
    const value = address.toLowerCase().split('%')[0]!;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isPublicAddress(mapped[1]!);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(value);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1]!, 16);
      const low = Number.parseInt(mappedHex[2]!, 16);
      return isPublicAddress(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`);
    }

    const ipv4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    let normalized = value;
    if (ipv4Tail) {
      const octets = ipv4Tail[1]!.split('.').map(Number);
      const high = ((octets[0]! << 8) | octets[1]!).toString(16);
      const low = ((octets[2]! << 8) | octets[3]!).toString(16);
      normalized = value.replace(ipv4Tail[1]!, `${high}:${low}`);
    }
    const halves = normalized.split('::');
    if (halves.length > 2) return false;
    const left = halves[0] ? halves[0]!.split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1]!.split(':') : [];
    const zeroCount = 8 - left.length - right.length;
    if ((halves.length === 1 && zeroCount !== 0) || (halves.length === 2 && zeroCount < 1)) return false;
    const groups = [...left, ...Array(halves.length === 2 ? zeroCount : 0).fill('0'), ...right];
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
    const first = Number.parseInt(groups[0]!, 16);
    const second = Number.parseInt(groups[1]!, 16);
    if (first < 0x2000 || first > 0x3fff) return false;
    if ((first === 0x2001 && second <= 0x01ff) ||
        (first === 0x2001 && second === 0x0db8) ||
        first === 0x2002 ||
        (first === 0x3fff && second <= 0x0fff)) return false;
    return true;
  }
  return false;
}

export async function resolveWebhookTarget(
  value: string,
  options: { production?: boolean; lookupHost?: WebhookLookup } = {},
): Promise<WebhookTarget> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'Webhook URL is invalid', 'invalid_webhook_url');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new HttpError(400, 'Webhook URL must be HTTP(S), without credentials or fragments', 'invalid_webhook_url');
  }
  const production = options.production ?? config.NODE_ENV === 'production';
  if (!production) return { url, addresses: null };
  if (url.protocol !== 'https:' || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) {
    throw new HttpError(400, 'Production webhooks require a public HTTPS URL', 'invalid_webhook_url');
  }
  const literalVersion = isIP(url.hostname.replace(/^\[|\]$/g, ''));
  let addresses: Array<{ address: string; family: number }>;
  if (literalVersion) {
    const address = url.hostname.replace(/^\[|\]$/g, '');
    if (!isPublicAddress(address)) {
      throw new HttpError(400, 'Webhook URL cannot target a private or reserved IP address', 'invalid_webhook_url');
    }
    addresses = [{ address, family: literalVersion }];
  } else {
    try {
      addresses = await (options.lookupHost ?? ((hostname) => lookup(hostname, { all: true, verbatim: true })))(url.hostname);
    } catch {
      throw new HttpError(400, 'Webhook URL host could not be resolved', 'invalid_webhook_url');
    }
    if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
      throw new HttpError(400, 'Webhook URL must resolve only to public IP addresses', 'invalid_webhook_url');
    }
  }
  return {
    url,
    addresses: addresses.map((item) => ({ address: item.address, family: item.family as 4 | 6 })),
  };
}

export async function validateWebhookUrl(value: string): Promise<string> {
  const target = await resolveWebhookTarget(value);
  return target.url.toString();
}
