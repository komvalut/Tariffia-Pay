import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

export type EncryptedWebhookSecret = {
  ciphertext: string;
  nonce: string;
  authTag: string;
};

const encryptionKey = Buffer.from(config.WEBHOOK_ENCRYPTION_KEY, 'hex');

export function encryptWebhookSecret(secret: string): EncryptedWebhookSecret {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptWebhookSecret(encrypted: EncryptedWebhookSecret): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(encrypted.nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
