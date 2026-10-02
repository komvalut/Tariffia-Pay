import { config } from '../config.js';
import type { Database } from '../db.js';
import { HttpError } from '../errors.js';
import { hashApiKey } from '../security.js';

export type MerchantUsageCategory = 'general' | 'ai' | 'sms';

export type MerchantUsageLimits = {
  generalRequestsPerMinute: number | null;
  aiRequestsPerMinute: number | null;
  smsRequestsPerMinute: number | null;
};

export type EffectiveMerchantLimit = {
  limit: number;
  unlimited: boolean;
  source: 'default' | 'override';
};

export type MerchantUsageCheck = {
  exceeded: boolean;
  category: MerchantUsageCategory;
  limit: number | null;
  requestCount: number;
  retryAfterSeconds: number;
  windowStart: Date;
};

const limitColumns: Record<MerchantUsageCategory, 'general_requests_per_minute' | 'ai_requests_per_minute' | 'sms_requests_per_minute'> = {
  general: 'general_requests_per_minute',
  ai: 'ai_requests_per_minute',
  sms: 'sms_requests_per_minute',
};

const defaultLimits: Record<MerchantUsageCategory, number> = {
  general: config.MERCHANT_GENERAL_REQUESTS_PER_MINUTE,
  ai: config.MERCHANT_AI_REQUESTS_PER_MINUTE,
  sms: config.MERCHANT_SMS_REQUESTS_PER_MINUTE,
};

/**
 * Maps a request URL onto the merchant usage category. Merchant-scoped `/v1` routes are
 * `general` unless they are AI or SMS endpoints; admin, public and non-`/v1` routes are
 * not merchant usage and are never counted or limited here.
 */
export function merchantRequestCategory(url: string): MerchantUsageCategory | null {
  const path = (url.split('?')[0] ?? url).replace(/\/+$/, '');
  if (path === '/v1/admin' || path.startsWith('/v1/admin/')) return null;
  if (path === '/v1/public' || path.startsWith('/v1/public/')) return null;
  if (!path.startsWith('/v1')) return null;
  if (path === '/v1/ai' || path.startsWith('/v1/ai/')) return 'ai';
  if (path === '/v1/sms' || path.startsWith('/v1/sms/')) return 'sms';
  return 'general';
}

export class MerchantUsageService {
  constructor(
    private readonly db: Database,
    private readonly window: { windowMs: number } = { windowMs: 60_000 },
  ) {}

  /**
   * Resolves and rate-limits one incoming merchant request. Returns null when the request
   * is not a merchant-scoped API request (no valid merchant key, or an admin/public/
   * non-API URL); such requests are neither counted nor limited here.
   */
  async checkRequest(input: { authorization?: string; url: string }): Promise<MerchantUsageCheck | null> {
    const raw = input.authorization?.startsWith('Bearer ') ? input.authorization.slice(7) : null;
    if (!raw) return null;
    const category = merchantRequestCategory(input.url);
    if (!category) return null;
    const merchant = await this.db.query<{ id: string }>(
      `SELECT m.id
         FROM api_keys k JOIN merchants m ON m.id = k.merchant_id
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND m.status = 'active'`,
      [hashApiKey(raw)],
    );
    const merchantId = merchant.rows[0]?.id;
    if (!merchantId) return null;
    return this.checkAndCount({ merchantId, category });
  }

  /**
   * Atomically counts one request in the current fixed window and reports whether the
   * merchant's effective category limit is exceeded. The window row is seeded idempotently
   * and incremented by a single conditional `UPDATE ... WHERE request_count < cap`, which
   * takes a row lock in PostgreSQL; concurrent requests on the same merchant and window are
   * therefore serialized and can never overshoot the limit.
   */
  async checkAndCount(input: { merchantId: string; category: MerchantUsageCategory }): Promise<MerchantUsageCheck> {
    const windowMs = this.window.windowMs;
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    const effective = await this.effectiveLimit(input.merchantId, input.category);
    const cap = effective.unlimited ? 2_147_483_647 : effective.limit;
    await this.db.query(
      `INSERT INTO merchant_request_counters (merchant_id, category, window_start, request_count)
       VALUES ($1, $2, $3, 0)
       ON CONFLICT (merchant_id, category, window_start) DO NOTHING`,
      [input.merchantId, input.category, windowStart],
    );
    const updated = await this.db.query<{ request_count: number }>(
      `UPDATE merchant_request_counters
          SET request_count = request_count + 1, updated_at = now()
        WHERE merchant_id = $1 AND category = $2 AND window_start = $3 AND request_count < $4
        RETURNING request_count`,
      [input.merchantId, input.category, windowStart, cap],
    );
    let requestCount = updated.rows[0]?.request_count;
    let exceeded = false;
    if (requestCount === undefined) {
      exceeded = true;
      const current = await this.db.query<{ request_count: number }>(
        `SELECT request_count FROM merchant_request_counters
          WHERE merchant_id = $1 AND category = $2 AND window_start = $3`,
        [input.merchantId, input.category, windowStart],
      );
      requestCount = current.rows[0]?.request_count ?? cap;
    } else if (requestCount === 1) {
      await this.db.query(
        `DELETE FROM merchant_request_counters
          WHERE merchant_id = $1 AND category = $2 AND window_start < $3`,
        [input.merchantId, input.category, windowStart],
      );
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - Date.now()) / 1000));
    return {
      exceeded,
      category: input.category,
      limit: effective.unlimited ? null : effective.limit,
      requestCount,
      retryAfterSeconds,
      windowStart,
    };
  }

  /** The effective limit for one category: an explicit per-merchant value or the configured default. */
  async effectiveLimit(merchantId: string, category: MerchantUsageCategory): Promise<EffectiveMerchantLimit> {
    const override = await this.db.query<{
      general_requests_per_minute: number | null;
      ai_requests_per_minute: number | null;
      sms_requests_per_minute: number | null;
    }>(
      `SELECT general_requests_per_minute, ai_requests_per_minute, sms_requests_per_minute
         FROM merchant_usage_limits WHERE merchant_id = $1`,
      [merchantId],
    );
    const value = override.rows[0]?.[limitColumns[category]] ?? null;
    const limit = value ?? defaultLimits[category];
    return {
      limit,
      unlimited: limit === 0,
      source: value === null ? 'default' : 'override',
    };
  }

  /** Effective limits and current-window request counts for administrators. */
  async usageForMerchant(merchantId: string): Promise<{
    limits: Record<MerchantUsageCategory, EffectiveMerchantLimit>;
    counts: Record<MerchantUsageCategory, number>;
    windowStart: Date;
    windowResetAt: Date;
  }> {
    const categories: MerchantUsageCategory[] = ['general', 'ai', 'sms'];
    const limits = {} as Record<MerchantUsageCategory, EffectiveMerchantLimit>;
    for (const category of categories) {
      limits[category] = await this.effectiveLimit(merchantId, category);
    }
    const windowStart = this.currentWindowStart();
    const counters = await this.db.query<{ category: MerchantUsageCategory; request_count: number }>(
      `SELECT category, request_count FROM merchant_request_counters
        WHERE merchant_id = $1 AND window_start = $2`,
      [merchantId, windowStart],
    );
    const counts = { general: 0, ai: 0, sms: 0 } as Record<MerchantUsageCategory, number>;
    for (const row of counters.rows) counts[row.category] = row.request_count;
    return {
      limits,
      counts,
      windowStart,
      windowResetAt: new Date(windowStart.getTime() + this.window.windowMs),
    };
  }

  /** Lists every merchant with its effective limits and current-window usage. */
  async listUsage(): Promise<Array<{
    merchantId: string;
    merchant: string;
    email: string;
    limits: Record<MerchantUsageCategory, EffectiveMerchantLimit>;
    counts: Record<MerchantUsageCategory, number>;
    windowResetAt: Date;
  }>> {
    const merchants = await this.db.query<{ id: string; name: string; email: string }>(
      'SELECT id, name, email FROM merchants ORDER BY created_at ASC',
    );
    const usage = [];
    for (const merchant of merchants.rows) {
      const detail = await this.usageForMerchant(merchant.id);
      usage.push({
        merchantId: merchant.id,
        merchant: merchant.name,
        email: merchant.email,
        limits: detail.limits,
        counts: detail.counts,
        windowResetAt: detail.windowResetAt,
      });
    }
    return usage;
  }

  /** Replaces the per-merchant limit overrides. Null fields mean "use the default". */
  async updateLimits(merchantId: string, input: MerchantUsageLimits): Promise<MerchantUsageLimits> {
    const merchant = await this.db.query('SELECT id FROM merchants WHERE id = $1', [merchantId]);
    if (!merchant.rows[0]) throw new HttpError(404, 'Merchant not found', 'merchant_not_found');
    await this.db.query(
      `INSERT INTO merchant_usage_limits (merchant_id, general_requests_per_minute, ai_requests_per_minute, sms_requests_per_minute)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (merchant_id) DO UPDATE SET
         general_requests_per_minute = $2,
         ai_requests_per_minute = $3,
         sms_requests_per_minute = $4,
         updated_at = now()`,
      [merchantId, input.generalRequestsPerMinute, input.aiRequestsPerMinute, input.smsRequestsPerMinute],
    );
    return input;
  }

  private currentWindowStart(): Date {
    const windowMs = this.window.windowMs;
    return new Date(Math.floor(Date.now() / windowMs) * windowMs);
  }
}
