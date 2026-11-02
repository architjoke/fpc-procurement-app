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
import {
  buildMarathiSmsSlip,
  calculateAmountPaisa,
  calculateNetWeightKg,
} from '../utils/calculations.js';
import { detectAnomalies } from '../services/anomaly.js';

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
    photoUrl: z.string().optional(),
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
  reason: z.string().optional(),
});

router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  const status = req.query.status as string | undefined;
  const purchases = await prisma.purchase.findMany({
    where: { ...centreScope(req.user!), ...(status ? { status: status as never } : {}) },
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
      if (input.ocrWeight != null && Math.abs(input.grossKg - input.ocrWeight) > 0.1) {
        return res.status(400).json({
          message: 'OCR value differs from the entered weight. Please reconcile before saving.',
        });
      }

      if (input.ocrMoisture != null && Math.abs(input.moisturePct - input.ocrMoisture) > 0.1) {
        return res.status(400).json({
          message: 'OCR value differs from the entered moisture. Please reconcile before saving.',
        });
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
      });

      const sameDayMoisture = await prisma.purchase.findMany({
        where: {
          centreId: farmer.centreId,
          createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        },
        select: { moisturePct: true },
      });

      const rate = price.ratePerQuintal;
      const net = calculateNetWeightKg(input.grossKg, input.tareKg, input.moisturePct);
      const amountPaise = calculateAmountPaisa(net, rate);
      const purchaseId = uuidv4();
      const purchaseStatus = 'DRAFT';

      const purchase = await prisma.purchase.create({
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
          deviceSignature: input.deviceSignature ?? null,
          deviceTimestamp: input.deviceTimestamp ? new Date(input.deviceTimestamp) : null,
          photoUrl: input.photoUrl ?? null,
          ocrConfidence: input.ocrWeight != null ? 0.92 : null,
        },
        include: { farmer: true, centre: true, crop: true },
      });

      const anomalies = detectAnomalies({
        farmerId: input.farmerId,
        centreId: farmer.centreId,
        grossKg: input.grossKg,
        tareKg: input.tareKg,
        moisturePct: input.moisturePct,
        landAcres: Number(farmer.landAcres),
        cropType: crop.name.toLowerCase().includes('tur') ? 'tur' : 'soybean',
        recentPurchases: recentPurchases.map(
          (p: { farmerId: string; createdAt: Date; centreId: string }) => ({
            farmerId: p.farmerId,
            createdAt: p.createdAt,
            centreId: p.centreId,
          }),
        ),
        sameDayMoisture: sameDayMoisture.map((p) => Number(p.moisturePct)),
      });

      if (anomalies.length > 0) {
        const flaggedPurchase = await prisma.purchase.update({
          where: { id: purchase.id },
          data: { status: 'FLAGGED' },
        });

        await prisma.auditTrail.create({
          data: {
            actorUserId: req.user?.id ?? null,
            action: 'flagged_purchase',
            entityType: 'purchase',
            entityId: flaggedPurchase.id,
            before: JSON.stringify({ status: 'DRAFT' }),
            after: JSON.stringify({ status: 'FLAGGED', reasons: anomalies }),
          },
        });

        return res.status(201).json({
          data: flaggedPurchase,
          anomalies,
          message: 'Purchase flagged for review.',
        });
      }

      const smsText = buildMarathiSmsSlip({
        memberId: farmer.memberId,
        farmerName: farmer.name,
        cropName: crop.name,
        grossKg: input.grossKg,
        tareKg: input.tareKg,
        moisturePct: input.moisturePct,
        netKg: net,
        ratePerQuintal: rate,
        amountPaise: amountPaise,
        centreCode: farmer.centre.code,
      });

      await prisma.smsOutbox.create({
        data: {
          purchaseId: purchase.id,
          phone: '0000000000',
          messageMarathi: smsText,
          status: 'QUEUED',
        },
      });

      return res.status(201).json({ data: purchase, message: 'Purchase created.' });
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
      const { action, reason } = reviewSchema.parse(req.body);
      const purchase = await prisma.purchase.findUnique({ where: { id: parsedId.data } });

      if (!purchase) {
        return res.status(404).json({ message: 'Purchase not found.' });
      }

      const nextStatus = action === 'approve' ? 'APPROVED' : 'DRAFT';

      const updated = await prisma.purchase.update({
        where: { id: purchase.id },
        data: { status: nextStatus },
      });

      await prisma.auditTrail.create({
        data: {
          actorUserId: req.user?.id ?? null,
          action: `purchase_${action}`,
          entityType: 'purchase',
          entityId: updated.id,
          before: JSON.stringify({ status: purchase.status }),
          after: JSON.stringify({ status: nextStatus, reason: reason ?? null }),
        },
      });

      return res.json({ data: updated, message: `Purchase ${action}d.` });
    } catch (error) {
      return res.status(400).json({ message: 'Review failed.', error: (error as Error).message });
    }
  },
);

export { router as purchasesRouter };
