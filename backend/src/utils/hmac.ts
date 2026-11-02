import crypto from 'crypto';

export interface SyncPurchasePayload {
  uuid: string;
  farmer_id: string;
  centre_id: string;
  crop_id: string;
  grade: string;
  gross_kg: number;
  tare_kg: number;
  moisture_pct: number;
  device_timestamp: string;
  nonce: string;
  rate_per_quintal: number;
  hmac_signature?: string;
}

const syncPurchaseFields = [
  'centre_id',
  'crop_id',
  'device_timestamp',
  'farmer_id',
  'grade',
  'gross_kg',
  'moisture_pct',
  'nonce',
  'rate_per_quintal',
  'tare_kg',
  'uuid',
] as const;

export const canonicalizeSyncPurchase = (payload: SyncPurchasePayload): string => {
  return syncPurchaseFields
    .map((field) => {
      const value =
        field === 'device_timestamp'
          ? new Date(payload.device_timestamp).toISOString()
          : String(payload[field]);
      return `${field}=${encodeURIComponent(value)}`;
    })
    .join('|');
};

export const signSyncPurchase = (payload: SyncPurchasePayload, secret: string): string => {
  return crypto
    .createHmac('sha256', secret)
    .update(canonicalizeSyncPurchase(payload), 'utf8')
    .digest('hex');
};

export const verifySyncPurchaseSignature = (
  payload: SyncPurchasePayload,
  signature: string,
  secret: string,
): boolean => {
  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    return false;
  }
  const expected = Buffer.from(signSyncPurchase(payload, secret), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return crypto.timingSafeEqual(expected, actual);
};

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
