import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { parseBody, requireMerchant } from '../http.js';
import { updateNotificationPreferencesSchema } from '../schemas.js';

type PreferenceRow = {
  payment_confirmed: boolean;
  payment_failed: boolean;
  payment_expired: boolean;
  credit_topup: boolean;
  ai_request_failed: boolean;
  sms_request_failed: boolean;
  webhook_failed: boolean;
  updated_at: Date;
};

/** All preferences default to enabled when the merchant has no stored row. */
async function loadPreferences(db: Database, merchantId: string) {
  const result = await db.query<PreferenceRow>(
    `SELECT payment_confirmed, payment_failed, payment_expired, credit_topup,
            ai_request_failed, sms_request_failed, webhook_failed, updated_at
       FROM merchant_notification_preferences WHERE merchant_id = $1`,
    [merchantId],
  );
  const row = result.rows[0];
  return {
    paymentConfirmed: row?.payment_confirmed ?? true,
    paymentFailed: row?.payment_failed ?? true,
    paymentExpired: row?.payment_expired ?? true,
    creditTopup: row?.credit_topup ?? true,
    aiRequestFailed: row?.ai_request_failed ?? true,
    smsRequestFailed: row?.sms_request_failed ?? true,
    webhookFailed: row?.webhook_failed ?? true,
    updatedAt: row?.updated_at ?? null,
  };
}

export const notificationPreferenceRoutes: FastifyPluginAsync<{ db: Database }> = async (app, { db }) => {
  app.get('/v1/notification-preferences', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    return reply.send({ preferences: await loadPreferences(db, merchant.id) });
  });

  app.put('/v1/notification-preferences', async (request, reply) => {
    const merchant = await requireMerchant(request, db);
    // `.strict()` rejects unknown fields, so a request can only set the known toggles.
    const body = parseBody(updateNotificationPreferencesSchema, request.body);
    await db.query(
      `INSERT INTO merchant_notification_preferences (merchant_id, payment_confirmed, payment_failed,
          payment_expired, credit_topup, ai_request_failed, sms_request_failed, webhook_failed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (merchant_id) DO UPDATE SET
         payment_confirmed = $2, payment_failed = $3, payment_expired = $4, credit_topup = $5,
         ai_request_failed = $6, sms_request_failed = $7, webhook_failed = $8, updated_at = now()`,
      [merchant.id, body.paymentConfirmed, body.paymentFailed, body.paymentExpired, body.creditTopup,
        body.aiRequestFailed, body.smsRequestFailed, body.webhookFailed],
    );
    return reply.send({ preferences: await loadPreferences(db, merchant.id) });
  });
};
