import { z } from 'zod';

export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid EVM address');
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
