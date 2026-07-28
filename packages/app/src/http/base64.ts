import { z } from 'zod';

export const base64StringSchema = z
  .string()
  .refine(isBase64, 'Value must be valid padded or unpadded Base64.');

export function decodeBase64(value: string): Uint8Array {
  return Buffer.from(base64StringSchema.parse(value), 'base64');
}

function isBase64(value: string): boolean {
  if (value === '') return true;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/u.test(value);
}
