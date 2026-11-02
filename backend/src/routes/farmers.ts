import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const farmerSchema = z.object({
  memberId: z.string().min(3),
  name: z.string().min(2),
  village: z.string().min(2),
  landAcres: z.coerce.number().positive(),
  bankAccount: z.string().min(8),
  bankIfsc: z.string().min(8),
  centreId: z.string(),
  consentGivenAt: z.string().datetime().optional(),
});

router.get('/', requireAuth, async (_req, res) => {
  const farmers = await prisma.farmer.findMany({ include: { centre: true } });
  return res.json({ data: farmers });
});

router.get('/:id', requireAuth, async (req, res) => {
  const farmer = await prisma.farmer.findUnique({
    where: { id: req.params.id },
    include: { centre: true },
  });

  if (!farmer) {
    return res.status(404).json({ message: 'Farmer not found.' });
  }

  return res.json({ data: farmer });
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const input = farmerSchema.parse(req.body);
    const farmer = await prisma.farmer.create({
      data: {
        memberId: input.memberId,
        name: input.name,
        village: input.village,
        landAcres: input.landAcres,
        bankAccount: input.bankAccount,
        bankIfsc: input.bankIfsc,
        consentGivenAt: new Date(input.consentGivenAt ?? new Date()),
        centreId: input.centreId,
      },
    });

    return res.status(201).json({ data: farmer });
  } catch (error) {
    return res
      .status(400)
      .json({ message: 'Invalid farmer data.', error: (error as Error).message });
  }
});

export { router as farmersRouter };
