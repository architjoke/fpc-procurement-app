import crypto from 'crypto';

export const signPayload = (payload: unknown, secret: string): string => {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');
};

export const verifySignature = (payload: unknown, signature: string, secret: string): boolean => {
  const expected = Buffer.from(signPayload(payload, secret), 'hex');
  const actual = Buffer.from(signature, 'hex');

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, actual);
};
