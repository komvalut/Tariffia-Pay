import { z } from 'zod';
import { aiProviderKinds } from './ai-provider.js';

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
  currency: z.string().trim().regex(/^[A-Z][A-Z0-9]{2,11}$/).default('USDC'),
  adapter: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  metadata: z.record(z.unknown()).default({}),
}).refine((value) => !/^0(?:\.0+)?$/.test(value.amount), {
  message: 'amount must be greater than zero',
  path: ['amount'],
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const verifyPaymentSchema = z.object({
  transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Transaction hash must be a 32-byte EVM hash').optional(),
  transactionId: z.string().trim().min(1).max(512).optional(),
}).refine((value) => Boolean(value.transactionHash) !== Boolean(value.transactionId), {
  message: 'Provide exactly one of transactionHash or transactionId',
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
  'ai.usage.recorded',
  'invoice.issued',
  'receipt.issued',
  'subscription.created',
  'subscription.activated',
  'subscription.paused',
  'subscription.resumed',
  'subscription.cancelled',
  'subscription.past_due',
  'subscription.expired',
  'subscription.billing_cycle.created',
  'subscription.billing_cycle.paid',
  'subscription.billing_cycle.failed',
  'ai.request.completed',
  'ai.request.failed',
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

const subscriptionInterval = z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']);
export const createSubscriptionPlanSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(''),
  amount: positiveDecimal,
  currency: z.string().trim().regex(/^[A-Z][A-Z0-9]{2,11}$/).default('USDC'),
  interval: subscriptionInterval,
  intervalCount: z.number().int().min(1).max(12).default(1),
  trialDays: z.number().int().min(0).max(365).default(0),
  enabled: z.boolean().default(true),
}).strict();

export const updateSubscriptionPlanSchema = createSubscriptionPlanSchema.partial().strict()
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'At least one plan field must be provided',
  });

export const createSubscriptionSchema = z.object({
  planId: z.string().uuid(),
  customerId: z.string().uuid(),
  adapter: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  billingMode: z.enum(['MANUAL', 'AUTOMATIC']).default('MANUAL'),
  endsAt: z.string().datetime().optional(),
}).strict();

export const subscriptionActionSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel']),
}).strict();

export const manualSubscriptionRenewalSchema = z.object({}).strict();

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

const aiSlug = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const aiUsdRate = z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,8})?$/);

export const createAiProviderSchema = z.object({
  slug: aiSlug,
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  integration: z.enum(aiProviderKinds).default('openai-compatible'),
  timeoutMs: z.number().int().min(1000).max(120_000).optional(),
}).strict();

export const updateAiProviderSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((input) => Object.values(input).some((value) => value !== undefined), {
  message: 'At least one provider field must be provided',
});

const aiChatRole = z.enum(['system', 'user', 'assistant']);
const aiChatMessage = z.object({
  role: aiChatRole,
  content: z.string().min(1).max(16_000),
}).strict();

export const aiChatCompletionSchema = z.object({
  requestId: z.string().trim().min(8).max(128),
  customerId: z.string().uuid(),
  provider: aiSlug,
  model: aiSlug,
  messages: z.array(aiChatMessage).min(1).max(64),
  maxOutputTokens: z.number().int().min(1).max(4096).optional(),
  temperature: z.number().min(0).max(2).optional(),
  metadata: z.record(z.unknown()).default({}),
}).strict();

export const createAiModelSchema = z.object({
  slug: aiSlug,
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(false),
  pricingMode: z.enum(['PER_REQUEST', 'PER_1K_TOKENS', 'PER_REQUEST_AND_TOKENS']),
  providerCostPerRequestUsd: aiUsdRate.default('0'),
  customerPricePerRequestUsd: aiUsdRate.nullable().default(null),
  providerInputCostPer1kUsd: aiUsdRate.default('0'),
  customerInputPricePer1kUsd: aiUsdRate.nullable().default(null),
  providerOutputCostPer1kUsd: aiUsdRate.default('0'),
  customerOutputPricePer1kUsd: aiUsdRate.nullable().default(null),
  markupBps: z.number().int().min(0).max(100_000).default(0),
  providerModel: z.string().trim().min(1).max(120).optional(),
  maxOutputTokens: z.number().int().min(1).max(4096).default(512),
}).strict();

export const updateAiModelSchema = createAiModelSchema;

export const recordAiUsageSchema = z.object({
  requestId: z.string().trim().min(8).max(128),
  customerId: z.string().uuid(),
  provider: aiSlug,
  model: aiSlug,
  inputTokens: z.number().int().min(0).max(1_000_000_000_000).default(0),
  outputTokens: z.number().int().min(0).max(1_000_000_000_000).default(0),
  metadata: z.record(z.unknown()).default({}),
}).strict();
