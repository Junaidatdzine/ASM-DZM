import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from './errors';
import { ASC_MASTER_KEY } from '../config';

const KEY_VERSION = 1;

function masterKey(): Buffer {
  const hex = ASC_MASTER_KEY.value().trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new AppError('internal', 'Server encryption key is misconfigured.');
  }
  return Buffer.from(hex, 'hex');
}

export interface Encrypted {
  v: number;
  iv: string; // base64
  ct: string; // base64
  tag: string; // base64
}

/** AES-256-GCM with the storeId as AAD — a ciphertext can't be replayed onto another store. */
export function encryptSecret(plaintext: string, storeId: string): Encrypted {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  cipher.setAAD(Buffer.from(storeId, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: KEY_VERSION,
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(enc: Encrypted, storeId: string): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(enc.iv, 'base64'));
    decipher.setAAD(Buffer.from(storeId, 'utf8'));
    decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(enc.ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new AppError('internal', 'Could not decrypt the store’s API key. It may need to be re-entered.');
  }
}
