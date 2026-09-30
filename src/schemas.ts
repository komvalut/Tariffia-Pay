import { z } from 'zod';

export const addressSchema = z.string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid EVM address')
  .refine((value) => value.toLowerCase() !== `0x${'0'.repeat(40)}`, 'Zero address cannot receive payments');
export const createMerchantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  walletAddress: addressSchema,
  apiKeyName: z.string().trim().min(1).max(80).default('Primary'),
});

export const createCustomerSchema = z.object({
  externalId: z.string().trim().min(1).max(128).optional(),
  email: z.string().trim().email().max(254).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  metadata: z.record(z.unknown()).default({}),
}).refine((value) => value.externalId || value.email, {
  message: 'externalId or email is required',
});

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const createOrderSchema = z.object({
  customerId: z.string().uuid().optional(),
  reference: z.string().trim().min(1).max(128).optional(),
  description: z.string().trim().min(1).max(500),
  amount: z.string().regex(/^(0|[1-9]\d{0,29})(\.\d{1,6})?$/, 'Amount must be a decimal with up to 30 integer and 6 fractional places'),
  currency: z.literal('USDC').default('USDC'),
  metadata: z.record(z.unknown()).default({}),
}).refine((value) => !/^0(?:\.0+)?$/.test(value.amount), {
  message: 'amount must be greater than zero',
  path: ['amount'],
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const verifyPaymentSchema = z.object({
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Transaction hash must be a 32-byte EVM hash'),
});

export const webhookEventTypes = [
  'payment.created',
  'payment.detected',
  'payment.confirmed',
  'payment.failed',
  'payment.expired',
  'order.paid',
  'credit.topup',
  'credit.deducted',
] as const;
export type WebhookEventType = typeof webhookEventTypes[number];

const webhookEventsSchema = z.array(z.enum(webhookEventTypes)).min(1).refine(
  (events) => new Set(events).size === events.length,
  'Webhook event types must not contain duplicates',
);
const webhookSecretSchema = z.string().min(32).max(256);

export const createWebhookSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.string().url().max(2048),
  events: webhookEventsSchema,
  secret: webhookSecretSchema,
});

export const updateWebhookSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  url: z.string().url().max(2048).optional(),
  events: webhookEventsSchema.optional(),
  secret: webhookSecretSchema.optional(),
  enabled: z.boolean().optional(),
}).refine((input) => Object.values(input).some((value) => value !== undefined), {
  message: 'At least one endpoint field must be provided',
});

const positiveDecimal = z.string()
  .regex(/^(0|[1-9]\d{0,29})(\.\d{1,6})?$/, 'Amount must be a decimal with up to 30 integer and 6 fractional places')
  .refine((value) => !/^0(?:\.0+)?$/.test(value), 'Amount must be greater than zero');

export const createCreditTopupSchema = z.object({
  customerId: z.string().uuid(),
  amount: positiveDecimal,
});

export const createCreditDeductionSchema = z.object({
  customerId: z.string().uuid(),
  amount: positiveDecimal,
  reference: z.string().trim().min(1).max(128).optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const updateCreditSettingsSchema = z.object({
  creditsPerUsdcRate: z.number().int().min(1).max(1_000_000),
  minimumTopupUsdc: positiveDecimal,
  maximumTopupUsdc: positiveDecimal,
});
