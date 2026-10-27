import { randomBytes } from 'crypto';

// 8 random bytes -> 11 base64url characters (64 bits, unguessable).
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}
