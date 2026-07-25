import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function requestId(): string {
  return `srv_req_${randomUUID().replaceAll('-', '')}`;
}

export function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function publicId(prefix: string, id: string | number | bigint): string {
  return `${prefix}_${String(id)}`;
}

export function parsePublicId(value: string, prefix: string): string {
  const match = new RegExp(`^${prefix}_(\\d+)$`).exec(value);
  if (!match) throw new Error(`Invalid ${prefix} id`);
  return match[1];
}
