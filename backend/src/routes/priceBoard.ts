import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

const priceBoardSchema = z.object({
  cropId: z.string(),
  grade: z.string().min(1),
  ratePerQuintal: z.coerce.number().int().positive(),
  effectiveDate: z.string().datetime().optional(),
});

router.get('/', requireAuth, async (_req, res) => {
  const entries = await prisma.priceBoard.findMany({ include: { crop: true } });
  res.json({ data: entries });
});

router.post(
  '/',
  requireAuth,
  requireRole('office_manager'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const input = priceBoardSchema.parse(req.body);
      const bid = await prisma.priceBoard.create({
        data: {
          cropId: input.cropId,
          grade: input.grade,
          ratePerQuintal: input.ratePerQuintal,
          effectiveDate: new Date(input.effectiveDate ?? new Date()),
          setByUserId: req.user?.id ?? '',
        },
      });
      res.status(201).json({ data: bid });
    } catch (error) {
      res
        .status(400)
        .json({ message: 'Invalid price board entry.', error: (error as Error).message });
    }
  },
);

export { router as priceBoardRouter };
