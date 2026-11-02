import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { signPayload, verifySignature } from '../utils/hmac.js';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

const syncBatchSchema = z.object({
  deviceId: z.string().min(3),
  items: z.array(
    z.object({
      uuid: z.string(),
      farmerId: z.string(),
      cropId: z.string(),
      grade: z.string(),
      grossKg: z.coerce.number().positive(),
      tareKg: z.coerce.number().min(0),
      moisturePct: z.coerce.number().min(0),
      netKg: z.coerce.number().positive(),
      rate: z.coerce.number().int().positive(),
      amountPaise: z.coerce.number().int().positive(),
      deviceSignature: z.string().optional(),
      deviceTimestamp: z.string().datetime().optional(),
    }),
  ),
});

router.post(
  '/purchases',
  requireAuth,
  requireRole('centre_operator'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const payload = syncBatchSchema.parse(req.body);
      const signature = req.headers['x-device-signature'] as string | undefined;
      const _expected = signPayload(payload, process.env.JWT_SECRET ?? 'device-secret');

      if (
        !signature ||
        !verifySignature(payload, signature, process.env.JWT_SECRET ?? 'device-secret')
      ) {
        return res.status(401).json({ message: 'Invalid sync signature.' });
      }

      const accepted: string[] = [];
      const rejected: { uuid: string; reason: string }[] = [];

      for (const item of payload.items) {
        const farmer = await prisma.farmer.findFirst({
          where: { id: item.farmerId, centreId: req.user?.centreId ?? '' },
        });

        if (!farmer) {
          const reason = 'Farmer does not belong to this centre.';
          rejected.push({ uuid: item.uuid, reason });
          await prisma.syncLog.create({
            data: {
              purchaseUuid: item.uuid,
              deviceId: payload.deviceId,
              status: 'REJECTED',
              reason,
            },
          });
          continue;
        }

        const isDuplicate = await prisma.purchase.findFirst({
          where: {
            farmerId: item.farmerId,
            createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
          },
        });

        if (isDuplicate) {
          rejected.push({
            uuid: item.uuid,
            reason: 'Duplicate farmer within one hour; flagged for review.',
          });
          await prisma.syncLog.create({
            data: {
              purchaseUuid: item.uuid,
              deviceId: payload.deviceId,
              status: 'REJECTED',
              reason: 'Duplicate farmer within one hour.',
            },
          });
          continue;
        }

        const purchase = await prisma.purchase.create({
          data: {
            uuid: item.uuid,
            farmerId: item.farmerId,
            centreId: req.user?.centreId ?? '',
            cropId: item.cropId,
            grade: item.grade,
            grossKg: item.grossKg,
            tareKg: item.tareKg,
            moisturePct: item.moisturePct,
            netKg: item.netKg,
            rate: item.rate,
            amountPaise: item.amountPaise,
            status: 'SYNCED',
            deviceSignature: item.deviceSignature ?? null,
            deviceTimestamp: item.deviceTimestamp ? new Date(item.deviceTimestamp) : null,
          },
        });

        accepted.push(purchase.uuid);
        await prisma.syncLog.create({
          data: {
            purchaseUuid: purchase.uuid,
            deviceId: payload.deviceId,
            status: 'ACCEPTED',
            reason: 'Accepted by sync endpoint.',
          },
        });
      }

      return res.status(200).json({ accepted, rejected });
    } catch (error) {
      return res
        .status(400)
        .json({ message: 'Sync request rejected.', error: (error as Error).message });
    }
  },
);

export { router as syncRouter };
