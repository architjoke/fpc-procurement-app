import Dexie, { type EntityTable } from 'dexie';

export type QueueStatus = 'QUEUED' | 'SYNCING' | 'REJECTED';

export interface QueuedPurchase {
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
  ocr_job_id?: string;
  ocr_weight?: number;
  ocr_moisture?: number;
  ocr_weight_reconciled?: boolean;
  ocr_moisture_reconciled?: boolean;
  hmac_signature: string;
  syncStatus: QueueStatus;
  createdAt: string;
  lastError?: string;
}

export interface SyncHistoryEntry {
  uuid: string;
  status: 'SYNCED';
  purchaseStatus: 'SYNCED' | 'FLAGGED';
  purchaseId?: string;
  snapshot?: {
    farmerId: string;
    cropId: string;
    grade: string;
    grossKg: number;
    tareKg: number;
    moisturePct: number;
    ratePerQuintal: number;
  };
  reason?: string;
  updatedAt: string;
}

export interface CachedReferenceData {
  key: string;
  farmers: Array<{ id: string; memberId: string; name: string }>;
  prices: Array<{
    cropId: string;
    grade: string;
    ratePerQuintal: number;
    effectiveDate: string;
    crop: { id: string; name: string };
  }>;
}

class ProcurementDatabase extends Dexie {
  purchases!: EntityTable<QueuedPurchase, 'uuid'>;
  syncHistory!: EntityTable<SyncHistoryEntry, 'uuid'>;
  referenceData!: EntityTable<CachedReferenceData, 'key'>;

  constructor() {
    super('farmers-payment-app');
    this.version(1).stores({
      purchases: 'uuid, syncStatus, createdAt',
      syncHistory: 'uuid, updatedAt',
    });
    this.version(2).stores({
      purchases: 'uuid, syncStatus, createdAt',
      syncHistory: 'uuid, updatedAt',
      referenceData: 'key',
    });
  }
}

export const offlineDb = new ProcurementDatabase();
