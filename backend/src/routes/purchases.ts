import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database.js';
import {
  centreScope,
  requireAuth,
  requireRole,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { calculateAmountPaisa, calculateNetWeightKg } from '../utils/calculations.js';
import { detectAnomalies, getUtcDayRange } from '../services/anomaly.js';
import { getOcrMismatchFields } from '../services/purchaseOcr.js';
import { generateAndStoreSmsSlip } from '../services/sms.js';

const router = Router();

const createPurchaseSchema = z
  .object({
    farmerId: z.string().min(1),
    cropId: z.string().min(1),
    grade: z.string().trim().min(1).max(20),
    grossKg: z.coerce.number().positive().finite(),
    tareKg: z.coerce.number().min(0).finite(),
    moisturePct: z.coerce.number().min(0).max(100).finite(),
    deviceSignature: z.string().optional(),
    deviceTimestamp: z.string().datetime({ offset: true }).optional(),
    ocrWeight: z.coerce.number().positive().finite().optional(),
    ocrMoisture: z.coerce.number().min(0).max(100).finite().optional(),
    ocrJobId: z.string().min(1).optional(),
    ocrWeightReconciled: z.boolean().optional(),
    ocrMoistureReconciled: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.tareKg > input.grossKg) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tareKg'],
        message: 'Tare weight cannot exceed gross weight.',
      });
    }
  });

const reviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().trim().min(1, 'A review reason is required.'),
});

router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  const status = z
    .enum(['DRAFT', 'SYNCED', 'FLAGGED', 'APPROVED', 'REJECTED', 'PAID'])
    .optional()
    .safeParse(req.query.status);
  if (!status.success) {
    return res.status(400).json({ message: 'Invalid purchase status filter.' });
  }
  if (status.data === 'FLAGGED' && req.user!.role !== 'office_manager') {
    return res
      .status(403)
      .json({ message: 'Manager access is required to review flagged purchases.' });
  }

  if (status.data === 'FLAGGED') {
    const pagination = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .safeParse(req.query);
    if (!pagination.success) {
      return res.status(400).json({ message: 'Invalid pagination parameters.' });
    }

    const { page, pageSize } = pagination.data;
    const where = { status: 'FLAGGED' as const };
    const [data, total] = await Promise.all([
      prisma.purchase.findMany({
        where,
        include: {
          farmer: true,
          centre: true,
          crop: true,
          ocrJobs: { select: { id: true, imageData: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.purchase.count({ where }),
    ]);
    return res.json({
      data,
      pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    });
  }

  const where = {
    ...centreScope(req.user!),
    ...(status.data ? { status: status.data } : {}),
    ...(status.data === 'APPROVED' ? { paymentRunItems: { none: {} } } : {}),
  };
  const purchases = await prisma.purchase.findMany({
    where,
    include: { farmer: true, centre: true, crop: true },
    orderBy: { createdAt: 'desc' },
  });
  return res.json({ data: purchases });
});

router.post(
  '/',
  requireAuth,
  requireRole('centre_operator'),
  async (req: AuthenticatedRequest, res) => {
    const parsedInput = createPurchaseSchema.safeParse(req.body);
    if (!parsedInput.success) {
      return res.status(400).json({
        message: 'Invalid purchase payload.',
        error: parsedInput.error.flatten(),
      });
    }

    try {
      const input = parsedInput.data;
      const hasOcrValues = input.ocrWeight !== undefined || input.ocrMoisture !== undefined;
      const ocrJob = input.ocrJobId
        ? await prisma.ocrJob.findFirst({
            where: {
              id: input.ocrJobId,
              operatorId: req.user!.id,
              status: 'COMPLETED',
            },
          })
        : null;
      if (input.ocrJobId && !ocrJob) {
        return res.status(400).json({
          code: 'OCR_JOB_INVALID',
          message: 'OCR result is unavailable. Scan the image again or enter values manually.',
        });
      }
      if (!ocrJob && hasOcrValues) {
        const mismatches = getOcrMismatchFields(input);
        if (mismatches.length > 0) {
          return res.status(400).json({
            code: 'OCR_MISMATCH',
            message: 'Value differs from OCR reading, please reconcile.',
            fields: mismatches,
          });
        }
        return res.status(400).json({
          code: 'OCR_JOB_REQUIRED',
          message: 'OCR job reference is required when using prefilled values.',
        });
      }
      if (
        ocrJob &&
        ((input.ocrWeight !== undefined &&
          (ocrJob.parsedWeight === null ||
            Math.abs(Number(ocrJob.parsedWeight) - input.ocrWeight) > 0.0001)) ||
          (input.ocrMoisture !== undefined &&
            (ocrJob.parsedMoisture === null ||
              Math.abs(Number(ocrJob.parsedMoisture) - input.ocrMoisture) > 0.0001)))
      ) {
        return res.status(400).json({
          code: 'OCR_JOB_MISMATCH',
          message: 'OCR values do not match the stored scan. Scan the image again.',
        });
      }
      if (ocrJob) {
        const mismatches = getOcrMismatchFields({
          grossKg: input.grossKg,
          moisturePct: input.moisturePct,
          ...(ocrJob.parsedWeight !== null ? { ocrWeight: Number(ocrJob.parsedWeight) } : {}),
          ...(ocrJob.parsedMoisture !== null ? { ocrMoisture: Number(ocrJob.parsedMoisture) } : {}),
          ...(input.ocrWeightReconciled !== undefined
            ? { ocrWeightReconciled: input.ocrWeightReconciled }
            : {}),
          ...(input.ocrMoistureReconciled !== undefined
            ? { ocrMoistureReconciled: input.ocrMoistureReconciled }
            : {}),
        });
        if (mismatches.length > 0) {
          return res.status(400).json({
            code: 'OCR_MISMATCH',
            message: 'Value differs from OCR reading, please reconcile.',
            fields: mismatches,
          });
        }
      }

      const farmer = await prisma.farmer.findFirst({
        where: { id: input.farmerId, centreId: req.user!.centreId ?? '' },
        include: { centre: true },
      });
      if (!farmer) {
        return res.status(404).json({ message: 'Farmer not found.' });
      }

      const crop = await prisma.crop.findUnique({ where: { id: input.cropId } });
      if (!crop) {
        return res.status(404).json({ message: 'Crop not found.' });
      }

      const effectiveDate = new Date();
      effectiveDate.setUTCHours(0, 0, 0, 0);
      const price = await prisma.priceBoard.findFirst({
        where: {
          cropId: input.cropId,
          grade: input.grade,
          effectiveDate: { lte: effectiveDate },
        },
        orderBy: { effectiveDate: 'desc' },
      });
      if (!price) {
        return res.status(409).json({
          message: 'No active price is configured for this crop and grade.',
        });
      }

      const recentPurchases = await prisma.purchase.findMany({
        where: {
          farmerId: input.farmerId,
          createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
        select: { farmerId: true, createdAt: true, centreId: true },
      });

      const { start: dayStart, end: dayEnd } = getUtcDayRange(
        input.deviceTimestamp ? new Date(input.deviceTimestamp) : new Date(),
      );
      const sameDayMoisture = await prisma.purchase.findMany({
        where: {
          centreId: farmer.centreId,
          OR: [
            { deviceTimestamp: { gte: dayStart, lt: dayEnd } },
            { deviceTimestamp: null, createdAt: { gte: dayStart, lt: dayEnd } },
          ],
        },
        select: { moisturePct: true },
      });

      const rate = price.ratePerQuintal;
      const net = calculateNetWeightKg(input.grossKg, input.tareKg, input.moisturePct);
      const amountPaise = calculateAmountPaisa(net, rate);
      const anomalies = detectAnomalies({
        farmerId: input.farmerId,
        centreId: farmer.centreId,
        grossKg: input.grossKg,
        tareKg: input.tareKg,
        moisturePct: input.moisturePct,
        landAcres: Number(farmer.landAcres),
        cropType: crop.name.toLowerCase().includes('tur') ? 'tur' : 'soybean',
        recentPurchases: recentPurchases.map(
          (purchase: { farmerId: string; createdAt: Date; centreId: string }) => ({
            farmerId: purchase.farmerId,
            createdAt: purchase.createdAt,
            centreId: purchase.centreId,
          }),
        ),
        sameDayMoisture: sameDayMoisture.map((purchase) => Number(purchase.moisturePct)),
      });
      const flagReason =
        anomalies.length > 0
          ? anomalies.map((anomaly) => `${anomaly.trigger}: ${anomaly.reason}`).join(' ')
          : null;
      const purchaseId = uuidv4();
      const purchaseStatus = anomalies.length > 0 ? 'FLAGGED' : 'SYNCED';

      const purchase = await prisma.$transaction(async (transaction) => {
        const createdPurchase = await transaction.purchase.create({
          data: {
            uuid: purchaseId,
            farmerId: input.farmerId,
            centreId: farmer.centreId,
            cropId: input.cropId,
            grade: input.grade,
            grossKg: input.grossKg,
            tareKg: input.tareKg,
            moisturePct: input.moisturePct,
            netKg: net,
            rate,
            amountPaise,
            status: purchaseStatus,
            flagReason,
            deviceSignature: input.deviceSignature ?? null,
            deviceTimestamp: input.deviceTimestamp ? new Date(input.deviceTimestamp) : null,
            photoUrl: ocrJob?.imageUrl ?? null,
            ocrConfidence: ocrJob?.confidence ?? null,
          },
          include: { farmer: true, centre: true, crop: true },
        });
        if (ocrJob) {
          await transaction.ocrJob.update({
            where: { id: ocrJob.id },
            data: { purchaseId: createdPurchase.id },
          });
        }
        await generateAndStoreSmsSlip(
          {
            purchaseId: createdPurchase.id,
            slipNo: purchaseId,
            status: createdPurchase.status,
            farmerName: farmer.name,
            cropName: crop.name,
            grossKg: input.grossKg,
            tareKg: input.tareKg,
            moisturePct: input.moisturePct,
            netKg: net,
            ratePerQuintal: rate,
            amountPaise,
            centreCode: farmer.centre.code,
          },
          {
            upsertSmsOutbox: (entry) =>
              transaction.smsOutbox.upsert({
                where: { purchaseId: entry.purchaseId },
                update: {},
                create: entry,
              }),
          },
        );
        return createdPurchase;
      });

      if (anomalies.length > 0) {
        await prisma.auditTrail.create({
          data: {
            actorUserId: req.user?.id ?? null,
            action: 'flagged_purchase',
            entityType: 'purchase',
            entityId: purchase.id,
            before: JSON.stringify({ status: 'SYNCED' }),
            after: JSON.stringify({ status: 'FLAGGED', reason: flagReason, reasons: anomalies }),
          },
        });

        return res.status(201).json({
          data: purchase,
          anomalies,
          flagReason,
          message: 'Purchase flagged for review.',
        });
      }

      return res.status(201).json({ data: purchase, message: 'Purchase synced.' });
    } catch (error) {
      if (error instanceof RangeError) {
        return res.status(400).json({ message: error.message });
      }
      console.error('Unable to create purchase:', error);
      return res.status(500).json({ message: 'Unable to create purchase.' });
    }
  },
);

router.patch(
  '/:id/review',
  requireAuth,
  requireRole('office_manager'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const parsedId = z.string().min(1).safeParse(req.params.id);
      if (!parsedId.success) {
        return res.status(400).json({ message: 'Invalid purchase id.' });
      }
      const parsedBody = reviewSchema.safeParse(req.body);
      if (!parsedBody.success) {
        return res.status(400).json({
          message: 'A review action and reason are required.',
          error: parsedBody.error.flatten(),
        });
      }
      const { action, reason } = parsedBody.data;
      const purchase = await prisma.purchase.findUnique({ where: { id: parsedId.data } });

      if (!purchase) {
        return res.status(404).json({ message: 'Purchase not found.' });
      }

      if (purchase.status !== 'FLAGGED') {
        return res.status(409).json({ message: 'Only flagged purchases can be reviewed.' });
      }
      const nextStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';

      const updated = await prisma.purchase.update({
        where: { id: purchase.id },
        data: { status: nextStatus, flagReason: purchase.flagReason },
      });

      await prisma.auditTrail.create({
        data: {
          actorUserId: req.user?.id ?? null,
          action: `purchase_${action}`,
          entityType: 'purchase',
          entityId: updated.id,
          before: JSON.stringify({ status: purchase.status }),
          after: JSON.stringify({ status: nextStatus, reason }),
        },
      });

      return res.json({ data: updated, message: `Purchase ${action}d.` });
    } catch (error) {
      console.error('Purchase review failed:', error);
      return res.status(500).json({ message: 'Purchase review failed.' });
    }
  },
);

export { router as purchasesRouter };
