import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { parseBody, requireMerchant } from '../http.js';
import { updateMerchantSettingsSchema } from '../schemas.js';

const defaultCurrency = 'USDC';
const defaultTimezone = 'UTC';

type SettingsRow = {
  display_name: string | null;
  support_email: string | null;
  default_currency: string | null;
  timezone: string | null;
  updated_at: Date;
};

/** Non-sensitive settings with fallbacks to the merchant account name/email and defaults. */
async function loadSettings(db: Database, merchantId: string) {
  const account = await db.query<{ name: string; email: string }>(
    'SELECT name, email FROM merchants WHERE id = $1', [merchantId],
  );
  const result = await db.query<SettingsRow>(
    `SELECT display_name, support_email, default_currency, timezone, updated_at
       FROM merchant_settings WHERE merchant_id = $1`,
    [merchantId],
  );
  const row = result.rows[0];
  return {
    merchantId,
    displayName: row?.display_name ?? account.rows[0]?.name ?? null,
    supportEmail: row?.support_email ?? account.rows[0]?.email ?? null,
    defaultCurrency: row?.default_currency ?? defaultCurrency,
    timezone: row?.timezone ?? defaultTimezone,
    updatedAt: row?.updated_at ?? null,
  };
}

export const settingsRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/v1/settings', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    return reply.send({ settings: await loadSettings(db, merchant.id) });
  });

  app.put('/v1/settings', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    // `.strict()` rejects every field outside the four non-sensitive settings, so API keys,
    // wallet addresses, secrets, provider credentials and status can never be set here.
    const body = parseBody(updateMerchantSettingsSchema, request.body);
    await db.query(
      `INSERT INTO merchant_settings (merchant_id, display_name, support_email, default_currency, timezone)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (merchant_id) DO UPDATE SET
         display_name = $2, support_email = $3, default_currency = $4, timezone = $5, updated_at = now()`,
      [merchant.id, body.displayName, body.supportEmail, body.defaultCurrency, body.timezone],
    );
    return reply.send({ settings: await loadSettings(db, merchant.id) });
  });
};
