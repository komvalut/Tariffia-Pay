import type { PoolClient } from 'pg';
import type { WebhookEventType } from '../schemas.js';
import { newId } from '../security.js';

export async function enqueueWebhookEvent(input: {
  client: PoolClient;
  merchantId: string;
  eventType: WebhookEventType;
  resourceId: string;
  data: Record<string, unknown>;
}): Promise<string> {
  const eventId = newId();
  const createdAt = new Date().toISOString();
  const payload = {
    id: eventId,
    type: input.eventType,
    createdAt,
    data: input.data,
  };
  await input.client.query(
    `INSERT INTO webhook_events (id, merchant_id, event_type, resource_id, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [eventId, input.merchantId, input.eventType, input.resourceId, JSON.stringify(payload)],
  );

  const endpoints = await input.client.query<{ id: string; events: string[] }>(
    `SELECT id, events FROM webhook_endpoints WHERE merchant_id = $1 AND enabled = true AND deleted_at IS NULL`,
    [input.merchantId],
  );
  for (const endpoint of endpoints.rows) {
    if (!endpoint.events.includes(input.eventType)) continue;
    await input.client.query(
      `INSERT INTO webhook_deliveries (id, endpoint_id, event_id, status, next_attempt_at)
       VALUES ($1, $2, $3, 'QUEUED', now())`,
      [newId(), endpoint.id, eventId],
    );
  }
  return eventId;
}
