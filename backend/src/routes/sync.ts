import { createHash, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';
import { calculateAmountPaisa, calculateNetWeightKg } from '../utils/calculations.js';
import { verifySyncPurchaseSignature, type SyncPurchasePayload } from '../utils/hmac.js';
import { getOcrMismatchFields } from '../services/purchaseOcr.js';
import { detectAnomalies, getUtcDayRange } from '../services/anomaly.js';

const router = Router();
const nonceTtlMs = 24 * 60 * 60 * 1000;

const queuedPurchaseSchema = z
  .object({
    uuid: z.string().uuid(),
    farmer_id: z.string().min(1),
    centre_id: z.string().min(1),
    crop_id: z.string().min(1),
    grade: z.string().trim().min(1).max(20),
    gross_kg: z.number().positive().finite(),
    tare_kg: z.number().min(0).finite(),
    moisture_pct: z.number().min(0).max(100).finite(),
    device_timestamp: z.string().datetime({ offset: true }),
    nonce: z.string().uuid(),
    rate_per_quintal: z.number().int().positive().finite(),
    ocr_job_id: z.string().min(1).optional(),
    ocr_weight: z.number().positive().finite().optional(),
    ocr_moisture: z.number().min(0).max(100).finite().optional(),
    ocr_weight_reconciled: z.boolean().optional(),
    ocr_moisture_reconciled: z.boolean().optional(),
    hmac_signature: z.string().regex(/^[a-f0-9]{64}$/i),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.tare_kg > item.gross_kg) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tare_kg'],
        message: 'Tare weight cannot exceed gross weight.',
      });
    }
  });

const batchSchema = z.array(queuedPurchaseSchema).min(1).max(100);

const hashSecret = (secret: string): Buffer => createHash('sha256').update(secret, 'utf8').digest();

const matchesSecretHash = (secret: string, storedHash: string): boolean => {
  if (!/^[a-f0-9]{64}$/i.test(storedHash)) {
    return false;
  }
  return timingSafeEqual(hashSecret(secret), Buffer.from(storedHash, 'hex'));
};

const isNonceConflict = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const logRejection = async (
  item: SyncPurchasePayload,
  deviceId: string,
  reason: string,
): Promise<void> => {
  await prisma.syncLog.create({
    data: {
      purchaseUuid: item.uuid,
      deviceId,
      status: 'REJECTED',
      reason,
    },
  });
};

router.post(
  '/purchases',
  requireAuth,
  requireRole('centre_operator'),
  async (req: AuthenticatedRequest, res) => {
    const parsedBatch = batchSchema.safeParse(req.body);
    const deviceId = req.header('x-device-id') ?? '';
    const deviceSecret = req.header('x-device-secret') ?? '';

    if (!parsedBatch.success) {
      return res.status(400).json({
        message: 'Invalid sync batch.',
        error: parsedBatch.error.flatten(),
      });
    }

    const items = parsedBatch.data;
    if (!deviceId || !deviceSecret) {
      return res.status(401).json({ message: 'Device credentials are required.' });
    }

    try {
      const session = await prisma.deviceSession.findUnique({ where: { deviceId } });
      if (
        !session ||
        session.userId !== req.user!.id ||
        session.revokedAt !== null ||
        !matchesSecretHash(deviceSecret, session.deviceSecretHash)
      ) {
        await Promise.all(
          items.map((item) => logRejection(item, deviceId, 'Invalid device session credentials.')),
        );
        return res.status(401).json({ message: 'Invalid device session credentials.' });
      }

      await prisma.syncNonce.deleteMany({ where: { expiresAt: { lte: new Date() } } });

      const results: Array<{
        uuid: string;
        status: 'SYNCED' | 'REJECTED';
        purchase_status?: 'SYNCED' | 'FLAGGED';
        reason?: string;
      }> = [];

      for (const item of items) {
        if (!verifySyncPurchaseSignature(item, item.hmac_signature, deviceSecret)) {
          const reason = 'Invalid purchase HMAC signature.';
          await logRejection(item, deviceId, reason);
          results.push({ uuid: item.uuid, status: 'REJECTED', reason });
          continue;
        }

        try {
          const result = await prisma.$transaction(
            async (transaction) => {
              const currentSession = await transaction.deviceSession.findUnique({
                where: { deviceId },
              });
              if (!currentSession || currentSession.revokedAt !== null) {
                const reason = 'Device session is revoked or unavailable.';
                await transaction.syncLog.create({
                  data: { purchaseUuid: item.uuid, deviceId, status: 'REJECTED', reason },
                });
                return { status: 'REJECTED' as const, reason };
              }

              const timestamp = new Date(item.device_timestamp);
              if (
                currentSession.lastAcceptedTimestamp &&
                timestamp <= currentSession.lastAcceptedTimestamp
              ) {
                const reason = 'Device timestamp is not newer than the last accepted timestamp.';
                await transaction.syncLog.create({
                  data: { purchaseUuid: item.uuid, deviceId, status: 'REJECTED', reason },
                });
                return { status: 'REJECTED' as const, reason };
              }

              const usedNonce = await transaction.syncNonce.findUnique({
                where: { deviceId_nonce: { deviceId, nonce: item.nonce } },
              });
              if (usedNonce) {
                const reason = 'Nonce has already been used.';
                await transaction.syncLog.create({
                  data: { purchaseUuid: item.uuid, deviceId, status: 'REJECTED', reason },
                });
                return { status: 'REJECTED' as const, reason };
              }

              if (item.centre_id !== req.user!.centreId) {
                const reason = 'Purchase centre does not match the operator centre.';
                await transaction.syncLog.create({
                  data: { purchaseUuid: item.uuid, deviceId, status: 'REJECTED', reason },
                });
                return { status: 'REJECTED' as const, reason };
              }

              const farmer = await transaction.farmer.findFirst({
                where: { id: item.farmer_id, centreId: req.user!.centreId },
                select: { id: true, centreId: true, landAcres: true },
              });
              if (!farmer) {
                const reason = 'Farmer does not belong to this centre.';
                await transaction.syncLog.create({
                  data: { purchaseUuid: item.uuid, deviceId, status: 'REJECTED', reason },
                });
                return { status: 'REJECTED' as const, reason };
              }

              const hasOcrData =
                item.ocr_job_id !== undefined ||
                item.ocr_weight !== undefined ||
                item.ocr_moisture !== undefined;
              const ocrJob =
                hasOcrData && item.ocr_job_id
                  ? await transaction.ocrJob.findFirst({
                      where: {
                        id: item.ocr_job_id,
                        operatorId: req.user!.id,
                        status: 'COMPLETED',
                      },
                    })
                  : null;
              if (item.ocr_job_id && !ocrJob) {
                const reason =
                  'OCR_JOB_INVALID: scan is unavailable; capture the purchase manually.';
                await transaction.syncLog.create({
                  data: { purchaseUuid: item.uuid, deviceId, status: 'REJECTED', reason },
                });
                return { status: 'REJECTED' as const, reason };
              }
              if (!ocrJob && hasOcrData) {
                const clientMismatches = getOcrMismatchFields({
                  grossKg: item.gross_kg,
                  moisturePct: item.moisture_pct,
                  ...(item.ocr_weight !== undefined ? { ocrWeight: item.ocr_weight } : {}),
                  ...(item.ocr_moisture !== undefined ? { ocrMoisture: item.ocr_moisture } : {}),
                  ...(item.ocr_weight_reconciled !== undefined
                    ? { ocrWeightReconciled: item.ocr_weight_reconciled }
                    : {}),
                  ...(item.ocr_moisture_reconciled !== undefined
                    ? { ocrMoistureReconciled: item.ocr_moisture_reconciled }
                    : {}),
                });
                const reason =
                  clientMismatches.length > 0
                    ? `OCR_MISMATCH: reconcile ${clientMismatches.join(', ')} before saving.`
                    : 'OCR_JOB_INVALID: scan is unavailable; capture the purchase manually.';
                await transaction.syncLog.create({
                  data: { purchaseUuid: item.uuid, deviceId, status: 'REJECTED', reason },
                });
                return { status: 'REJECTED' as const, reason };
              }
              if (
                ocrJob &&
                ((item.ocr_weight !== undefined &&
                  (ocrJob.parsedWeight === null ||
                    Math.abs(Number(ocrJob.parsedWeight) - item.ocr_weight) > 0.0001)) ||
                  (item.ocr_moisture !== undefined &&
                    (ocrJob.parsedMoisture === null ||
                      Math.abs(Number(ocrJob.parsedMoisture) - item.ocr_moisture) > 0.0001)))
              ) {
                const reason =
                  'OCR_JOB_MISMATCH: submitted OCR values do not match the stored scan.';
                await transaction.syncLog.create({
                  data: { purchaseUuid: item.uuid, deviceId, status: 'REJECTED', reason },
                });
                return { status: 'REJECTED' as const, reason };
              }
              if (ocrJob) {
                const ocrMismatches = getOcrMismatchFields({
                  grossKg: item.gross_kg,
                  moisturePct: item.moisture_pct,
                  ...(ocrJob.parsedWeight !== null
                    ? { ocrWeight: Number(ocrJob.parsedWeight) }
                    : {}),
                  ...(ocrJob.parsedMoisture !== null
                    ? { ocrMoisture: Number(ocrJob.parsedMoisture) }
                    : {}),
                  ...(item.ocr_weight_reconciled !== undefined
                    ? { ocrWeightReconciled: item.ocr_weight_reconciled }
                    : {}),
                  ...(item.ocr_moisture_reconciled !== undefined
                    ? { ocrMoistureReconciled: item.ocr_moisture_reconciled }
                    : {}),
                });
                if (ocrMismatches.length > 0) {
                  const reason = `OCR_MISMATCH: reconcile ${ocrMismatches.join(', ')} before saving.`;
                  await transaction.syncLog.create({
                    data: { purchaseUuid: item.uuid, deviceId, status: 'REJECTED', reason },
                  });
                  return { status: 'REJECTED' as const, reason };
                }
              }

              const crop = await transaction.crop.findUnique({
                where: { id: item.crop_id },
              });
              if (!crop) {
                const reason = 'Crop does not exist.';
                await transaction.syncLog.create({
                  data: { purchaseUuid: item.uuid, deviceId, status: 'REJECTED', reason },
                });
                return { status: 'REJECTED' as const, reason };
              }

              const effectiveDate = new Date();
              effectiveDate.setUTCHours(0, 0, 0, 0);
              const currentPrice = await transaction.priceBoard.findFirst({
                where: {
                  cropId: item.crop_id,
                  grade: item.grade,
                  effectiveDate: { lte: effectiveDate },
                },
                orderBy: { effectiveDate: 'desc' },
              });
              if (!currentPrice) {
                const reason = 'No active price is configured for this crop and grade.';
                await transaction.syncLog.create({
                  data: { purchaseUuid: item.uuid, deviceId, status: 'REJECTED', reason },
                });
                return { status: 'REJECTED' as const, reason };
              }

              const conflicts: string[] = [];
              if (currentPrice.ratePerQuintal !== item.rate_per_quintal) {
                conflicts.push(
                  `Price changed while queued (queued ${item.rate_per_quintal}, current ${currentPrice.ratePerQuintal}).`,
                );
              }

              const recentPurchases = await transaction.purchase.findMany({
                where: {
                  farmerId: item.farmer_id,
                  createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
                },
                select: { farmerId: true, createdAt: true, centreId: true },
              });
              const { start: dayStart, end: dayEnd } = getUtcDayRange(timestamp);
              const sameDayPurchases = await transaction.purchase.findMany({
                where: {
                  centreId: item.centre_id,
                  OR: [
                    { deviceTimestamp: { gte: dayStart, lt: dayEnd } },
                    { deviceTimestamp: null, createdAt: { gte: dayStart, lt: dayEnd } },
                  ],
                },
                select: { moisturePct: true },
              });
              const anomalyChecks = detectAnomalies({
                farmerId: item.farmer_id,
                centreId: item.centre_id,
                grossKg: item.gross_kg,
                tareKg: item.tare_kg,
                moisturePct: item.moisture_pct,
                landAcres: Number(farmer.landAcres),
                cropType: crop.name.toLowerCase().includes('tur') ? 'tur' : 'soybean',
                recentPurchases: recentPurchases.map(
                  (purchase: { farmerId: string; createdAt: Date; centreId: string }) => ({
                    farmerId: purchase.farmerId,
                    createdAt: purchase.createdAt,
                    centreId: purchase.centreId,
                  }),
                ),
                sameDayMoisture: sameDayPurchases.map((purchase) => Number(purchase.moisturePct)),
              });
              conflicts.push(
                ...anomalyChecks.map((anomaly) => `${anomaly.trigger}: ${anomaly.reason}`),
              );

              const timestampUpdate = await transaction.deviceSession.updateMany({
                where: {
                  deviceId,
                  lastAcceptedTimestamp: currentSession.lastAcceptedTimestamp,
                },
                data: { lastAcceptedTimestamp: timestamp },
              });
              if (timestampUpdate.count !== 1) {
                const reason = 'Device timestamp raced with another sync request.';
                await transaction.syncLog.create({
                  data: { purchaseUuid: item.uuid, deviceId, status: 'REJECTED', reason },
                });
                return { status: 'REJECTED' as const, reason };
              }

              const netKg = calculateNetWeightKg(item.gross_kg, item.tare_kg, item.moisture_pct);
              const amountPaise = calculateAmountPaisa(netKg, item.rate_per_quintal);
              const purchaseStatus = conflicts.length > 0 ? 'FLAGGED' : 'SYNCED';

              await transaction.syncNonce.create({
                data: {
                  deviceId,
                  nonce: item.nonce,
                  expiresAt: new Date(Date.now() + nonceTtlMs),
                },
              });

              const purchase = await transaction.purchase.create({
                data: {
                  uuid: item.uuid,
                  farmerId: item.farmer_id,
                  centreId: item.centre_id,
                  cropId: item.crop_id,
                  grade: item.grade,
                  grossKg: item.gross_kg,
                  tareKg: item.tare_kg,
                  moisturePct: item.moisture_pct,
                  netKg,
                  rate: item.rate_per_quintal,
                  amountPaise,
                  status: purchaseStatus,
                  flagReason: conflicts.length > 0 ? conflicts.join(' ') : null,
                  deviceSignature: item.hmac_signature,
                  deviceTimestamp: timestamp,
                  ocrConfidence: ocrJob?.confidence ?? null,
                  photoUrl: ocrJob?.imageUrl ?? null,
                },
              });
              if (ocrJob) {
                await transaction.ocrJob.update({
                  where: { id: ocrJob.id },
                  data: { purchaseId: purchase.id },
                });
              }

              if (conflicts.length > 0) {
                await transaction.auditTrail.create({
                  data: {
                    actorUserId: req.user!.id,
                    action: 'flagged_purchase',
                    entityType: 'purchase',
                    entityId: purchase.id,
                    before: JSON.stringify({ status: 'SYNCED' }),
                    after: JSON.stringify({
                      status: 'FLAGGED',
                      reason: conflicts.join(' '),
                      reasons: conflicts,
                    }),
                  },
                });
              }

              const reason =
                conflicts.length > 0
                  ? `Accepted as FLAGGED for manager review: ${conflicts.join(' ')}`
                  : 'Accepted and synced.';
              await transaction.syncLog.create({
                data: {
                  purchaseUuid: item.uuid,
                  deviceId,
                  status: 'ACCEPTED',
                  reason,
                },
              });
              return {
                status: 'SYNCED' as const,
                purchaseStatus:
                  purchase.status === 'FLAGGED' ? ('FLAGGED' as const) : ('SYNCED' as const),
                reason,
              };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );

          results.push({
            uuid: item.uuid,
            status: result.status,
            ...(result.status === 'SYNCED' ? { purchase_status: result.purchaseStatus } : {}),
            reason: result.reason,
          });
        } catch (error) {
          const reason = isNonceConflict(error)
            ? 'Nonce has already been used.'
            : error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
              ? 'Purchase UUID has already been used.'
              : 'Unable to persist this purchase; retry sync.';
          await logRejection(item, deviceId, reason);
          results.push({ uuid: item.uuid, status: 'REJECTED', reason });
          if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
            console.error('Purchase sync item failed:', error);
          }
        }
      }

      return res.status(200).json({
        results,
        accepted: results
          .filter((result) => result.status === 'SYNCED')
          .map((result) => result.uuid),
        rejected: results.filter((result) => result.status === 'REJECTED'),
      });
    } catch (error) {
      console.error('Unable to process purchase sync batch:', error);
      return res.status(500).json({ message: 'Unable to process sync batch.' });
    }
  },
);

export { router as syncRouter };
