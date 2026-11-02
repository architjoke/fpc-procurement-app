export type SyncPurchaseFields = Pick<
  import('./offlineDb').QueuedPurchase,
  | 'uuid'
  | 'farmer_id'
  | 'centre_id'
  | 'crop_id'
  | 'grade'
  | 'gross_kg'
  | 'tare_kg'
  | 'moisture_pct'
  | 'device_timestamp'
  | 'nonce'
  | 'rate_per_quintal'
>;

const fields = [
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
] as const satisfies readonly (keyof SyncPurchaseFields)[];

export const canonicalizeSyncPurchase = (payload: SyncPurchaseFields): string =>
  fields
    .map((field) => {
      const value =
        field === 'device_timestamp'
          ? new Date(payload.device_timestamp).toISOString()
          : String(payload[field]);
      return `${field}=${encodeURIComponent(value)}`;
    })
    .join('|');

export const signSyncPurchase = async (
  payload: SyncPurchaseFields,
  secret: string,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(canonicalizeSyncPurchase(payload)),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
};
