import { liveQuery } from 'dexie';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { offlineDb, type QueuedPurchase, type SyncHistoryEntry } from '../lib/offlineDb';
import { getSession } from '../lib/session';
import { signSyncPurchase } from '../lib/syncSignature';

export interface PurchaseDraft {
  farmerId: string;
  cropId: string;
  grade: string;
  grossKg: number;
  tareKg: number;
  moisturePct: number;
  ratePerQuintal: number;
  ocrJobId?: string;
  ocrWeight?: number;
  ocrMoisture?: number;
  ocrWeightReconciled?: boolean;
  ocrMoistureReconciled?: boolean;
}

export interface SyncStatusEntry {
  uuid: string;
  status: 'QUEUED' | 'SYNCING' | 'SYNCED' | 'REJECTED' | 'FLAGGED';
  reason?: string;
}

interface SyncResponse {
  results: Array<{
    uuid: string;
    status: 'SYNCED' | 'REJECTED';
    purchase_status?: 'SYNCED' | 'FLAGGED';
    reason?: string;
  }>;
}

const makeSignedEntry = async (
  draft: PurchaseDraft,
  uuid: string = crypto.randomUUID(),
  createdAt = new Date().toISOString(),
): Promise<QueuedPurchase> => {
  const session = getSession();
  if (!session?.device || !session.user.centreId) {
    throw new Error('Log in as a centre operator on this device to capture purchases.');
  }

  const payload = {
    uuid,
    farmer_id: draft.farmerId,
    centre_id: session.user.centreId,
    crop_id: draft.cropId,
    grade: draft.grade,
    gross_kg: draft.grossKg,
    tare_kg: draft.tareKg,
    moisture_pct: draft.moisturePct,
    device_timestamp: new Date().toISOString(),
    nonce: crypto.randomUUID(),
    rate_per_quintal: draft.ratePerQuintal,
    ...(draft.ocrJobId ? { ocr_job_id: draft.ocrJobId } : {}),
    ...(draft.ocrWeight !== undefined ? { ocr_weight: draft.ocrWeight } : {}),
    ...(draft.ocrMoisture !== undefined ? { ocr_moisture: draft.ocrMoisture } : {}),
    ...(draft.ocrWeightReconciled !== undefined
      ? { ocr_weight_reconciled: draft.ocrWeightReconciled }
      : {}),
    ...(draft.ocrMoistureReconciled !== undefined
      ? { ocr_moisture_reconciled: draft.ocrMoistureReconciled }
      : {}),
  };

  return {
    ...payload,
    hmac_signature: await signSyncPurchase(payload, session.device.deviceSecret),
    syncStatus: 'QUEUED',
    createdAt,
  };
};

const readStatuses = async (): Promise<SyncStatusEntry[]> => {
  const [queued, history] = await Promise.all([
    offlineDb.purchases.orderBy('createdAt').toArray(),
    offlineDb.syncHistory.orderBy('updatedAt').reverse().limit(20).toArray(),
  ]);
  return [
    ...queued.map((entry) => ({
      uuid: entry.uuid,
      status: entry.syncStatus,
      reason: entry.lastError,
    })),
    ...history.map((entry: SyncHistoryEntry) => ({
      uuid: entry.uuid,
      status: entry.purchaseStatus === 'FLAGGED' ? ('FLAGGED' as const) : entry.status,
      reason:
        entry.purchaseStatus === 'FLAGGED'
          ? (entry.reason ?? 'Synced and flagged for manager review.')
          : entry.reason,
    })),
  ];
};

export const useOfflineQueue = () => {
  const [entries, setEntries] = useState<SyncStatusEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const syncing = useRef(false);

  const refresh = useCallback(async () => {
    setEntries(await readStatuses());
  }, []);

  const flush = useCallback(async () => {
    if (!navigator.onLine || syncing.current) {
      return;
    }
    const session = getSession();
    if (!session?.device) {
      return;
    }

    syncing.current = true;
    setError(null);
    try {
      const queued = await offlineDb.purchases
        .where('syncStatus')
        .equals('QUEUED')
        .sortBy('createdAt');
      if (queued.length === 0) {
        return;
      }

      await offlineDb.purchases.bulkPut(
        queued.map((entry) => ({ ...entry, syncStatus: 'SYNCING' as const })),
      );
      await refresh();

      for (let offset = 0; offset < queued.length; offset += 100) {
        const batch = queued.slice(offset, offset + 100);
        let response: { data: SyncResponse };
        try {
          response = await api.post<SyncResponse>(
            '/sync/purchases',
            batch.map(
              ({
                uuid,
                farmer_id,
                centre_id,
                crop_id,
                grade,
                gross_kg,
                tare_kg,
                moisture_pct,
                device_timestamp,
                nonce,
                rate_per_quintal,
                ocr_job_id,
                ocr_weight,
                ocr_moisture,
                ocr_weight_reconciled,
                ocr_moisture_reconciled,
                hmac_signature,
              }) => ({
                uuid,
                farmer_id,
                centre_id,
                crop_id,
                grade,
                gross_kg,
                tare_kg,
                moisture_pct,
                device_timestamp,
                nonce,
                rate_per_quintal,
                ...(ocr_job_id ? { ocr_job_id } : {}),
                ...(ocr_weight !== undefined ? { ocr_weight } : {}),
                ...(ocr_moisture !== undefined ? { ocr_moisture } : {}),
                ...(ocr_weight_reconciled !== undefined ? { ocr_weight_reconciled } : {}),
                ...(ocr_moisture_reconciled !== undefined ? { ocr_moisture_reconciled } : {}),
                hmac_signature,
              }),
            ),
            {
              headers: {
                'x-device-id': session.device.deviceId,
                'x-device-secret': session.device.deviceSecret,
              },
            },
          );
        } catch (requestError) {
          if (!axios.isAxiosError(requestError)) {
            throw requestError;
          }
          const failureMessage = requestError.response
            ? `Sync server returned HTTP ${requestError.response.status}.`
            : 'Sync connection failed. Will retry when online.';
          await offlineDb.purchases.bulkPut(
            queued.slice(offset).map((entry) => ({
              ...entry,
              syncStatus: 'QUEUED' as const,
              lastError: failureMessage,
            })),
          );
          if (navigator.onLine) {
            setError(`${failureMessage} Queued purchases remain saved for retry.`);
          }
          break;
        }

        const resultsById = new Map(response.data.results.map((result) => [result.uuid, result]));
        for (const queuedEntry of batch) {
          const result = resultsById.get(queuedEntry.uuid);
          if (!result) {
            await offlineDb.purchases.put({
              ...queuedEntry,
              syncStatus: 'QUEUED',
              lastError: 'Server did not return a result for this entry.',
            });
          } else if (result.status === 'SYNCED') {
            await offlineDb.transaction(
              'rw',
              offlineDb.purchases,
              offlineDb.syncHistory,
              async () => {
                await offlineDb.purchases.delete(queuedEntry.uuid);
                await offlineDb.syncHistory.put({
                  uuid: queuedEntry.uuid,
                  status: 'SYNCED',
                  purchaseStatus: result.purchase_status ?? 'SYNCED',
                  reason: result.reason,
                  updatedAt: new Date().toISOString(),
                });
              },
            );
          } else {
            await offlineDb.purchases.put({
              ...queuedEntry,
              syncStatus: 'REJECTED',
              lastError: result.reason ?? 'Server rejected this purchase.',
            });
          }
        }
      }
    } catch (syncError) {
      console.error('Unable to flush offline purchases:', syncError);
      setError('Unable to sync offline purchases. Saved entries are retained.');
      const syncingEntries = await offlineDb.purchases
        .where('syncStatus')
        .equals('SYNCING')
        .toArray();
      await offlineDb.purchases.bulkPut(
        syncingEntries.map((entry) => ({ ...entry, syncStatus: 'QUEUED' as const })),
      );
    } finally {
      syncing.current = false;
      await refresh();
    }
  }, [refresh]);

  const createPurchase = useCallback(
    async (
      draft: PurchaseDraft,
    ): Promise<{ status: 'SAVED' | 'QUEUED' | 'FLAGGED'; flagReason?: string }> => {
      setError(null);
      const session = getSession();
      if (!session?.accessToken || !session.user.centreId) {
        throw new Error('Log in as a centre operator before creating a purchase.');
      }

      if (!navigator.onLine) {
        const entry = await makeSignedEntry(draft);
        await offlineDb.purchases.put(entry);
        await refresh();
        return { status: 'QUEUED' };
      }

      try {
        const response = await api.post<{
          data: { status: string; flagReason?: string | null };
        }>('/purchases', {
          farmerId: draft.farmerId,
          cropId: draft.cropId,
          grade: draft.grade,
          grossKg: draft.grossKg,
          tareKg: draft.tareKg,
          moisturePct: draft.moisturePct,
          ...(draft.ocrJobId ? { ocrJobId: draft.ocrJobId } : {}),
          ...(draft.ocrWeight !== undefined ? { ocrWeight: draft.ocrWeight } : {}),
          ...(draft.ocrMoisture !== undefined ? { ocrMoisture: draft.ocrMoisture } : {}),
          ...(draft.ocrWeightReconciled !== undefined
            ? { ocrWeightReconciled: draft.ocrWeightReconciled }
            : {}),
          ...(draft.ocrMoistureReconciled !== undefined
            ? { ocrMoistureReconciled: draft.ocrMoistureReconciled }
            : {}),
        });
        return response.data.data.status === 'FLAGGED'
          ? {
              status: 'FLAGGED',
              ...(response.data.data.flagReason
                ? { flagReason: response.data.data.flagReason }
                : {}),
            }
          : { status: 'SAVED' };
      } catch (requestError) {
        if (!axios.isAxiosError(requestError)) {
          throw requestError;
        }
        if (requestError.response) {
          throw requestError;
        }
        const entry = await makeSignedEntry(draft);
        await offlineDb.purchases.put(entry);
        await refresh();
        return { status: 'QUEUED' };
      }
    },
    [refresh],
  );

  const retry = useCallback(
    async (uuid: string) => {
      const current = await offlineDb.purchases.get(uuid);
      if (!current) {
        return;
      }
      const refreshed = await makeSignedEntry(
        {
          farmerId: current.farmer_id,
          cropId: current.crop_id,
          grade: current.grade,
          grossKg: current.gross_kg,
          tareKg: current.tare_kg,
          moisturePct: current.moisture_pct,
          ratePerQuintal: current.rate_per_quintal,
          ...(current.ocr_job_id ? { ocrJobId: current.ocr_job_id } : {}),
          ...(current.ocr_weight !== undefined ? { ocrWeight: current.ocr_weight } : {}),
          ...(current.ocr_moisture !== undefined ? { ocrMoisture: current.ocr_moisture } : {}),
          ...(current.ocr_weight_reconciled !== undefined
            ? { ocrWeightReconciled: current.ocr_weight_reconciled }
            : {}),
          ...(current.ocr_moisture_reconciled !== undefined
            ? { ocrMoistureReconciled: current.ocr_moisture_reconciled }
            : {}),
        },
        current.uuid,
        current.createdAt,
      );
      await offlineDb.purchases.put(refreshed);
      await refresh();
      await flush();
    },
    [flush, refresh],
  );

  useEffect(() => {
    const subscription = liveQuery(readStatuses).subscribe({
      next: setEntries,
      error: (liveError) => {
        console.error('Unable to read offline queue:', liveError);
        setError('Unable to read local offline purchases.');
      },
    });
    const handleOnline = () => void flush();
    window.addEventListener('online', handleOnline);
    const intervalId = window.setInterval(() => void flush(), 15_000);
    void flush();

    return () => {
      subscription.unsubscribe();
      window.removeEventListener('online', handleOnline);
      window.clearInterval(intervalId);
    };
  }, [flush]);

  return { entries, error, createPurchase, flush, retry };
};
