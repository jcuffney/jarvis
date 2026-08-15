import { timingSafeEqual } from 'node:crypto';

export function isAuthorized(authHeader: string | undefined, token: string): boolean {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const given = Buffer.from(authHeader.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
