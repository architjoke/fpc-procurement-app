import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });
const effectiveDateSchema = z.union([dateOnlySchema, z.string().datetime({ offset: true })]);

const normalizePriceBoardInput = (input: unknown): unknown => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }

  const values = input as Record<string, unknown>;
  return {
    cropId: values.cropId ?? values.crop_id,
    grade: values.grade,
    ratePerQuintal: values.ratePerQuintal ?? values.rate_per_quintal,
    effectiveDate: values.effectiveDate ?? values.effective_date,
  };
};

const priceBoardFields = {
  cropId: z.string().min(1),
  grade: z.string().trim().min(1).max(20),
  ratePerQuintal: z.coerce.number().int().positive().finite(),
  effectiveDate: effectiveDateSchema.optional(),
};
const createSchema = z.object(priceBoardFields).strict();
const updateSchema = z
  .object({
    cropId: priceBoardFields.cropId.optional(),
    grade: priceBoardFields.grade.optional(),
    ratePerQuintal: priceBoardFields.ratePerQuintal.optional(),
    effectiveDate: effectiveDateSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided.',
  });
const idSchema = z.string().min(1);

const normalizeEffectiveDate = (input: string | undefined): Date => {
  const datePart = input?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  return new Date(`${datePart}T00:00:00.000Z`);
};

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

router.get('/', requireAuth, async (_req, res) => {
  try {
    const entries = await prisma.priceBoard.findMany({
      include: { crop: true },
      orderBy: [{ effectiveDate: 'desc' }, { cropId: 'asc' }, { grade: 'asc' }],
    });
    return res.json({ data: entries });
  } catch (error) {
    console.error('Unable to fetch price board:', error);
    return res.status(500).json({ message: 'Unable to fetch price board.' });
  }
});

router.post(
  '/',
  requireAuth,
  requireRole('office_manager'),
  async (req: AuthenticatedRequest, res) => {
    const parsed = createSchema.safeParse(normalizePriceBoardInput(req.body));
    if (!parsed.success) {
      return res
        .status(400)
        .json({ message: 'Invalid price board entry.', error: parsed.error.flatten() });
    }

    try {
      const input = parsed.data;
      const crop = await prisma.crop.findUnique({
        where: { id: input.cropId },
        select: { id: true },
      });
      if (!crop) {
        return res.status(404).json({ message: 'Crop not found.' });
      }

      const entry = await prisma.priceBoard.create({
        data: {
          ...input,
          effectiveDate: normalizeEffectiveDate(input.effectiveDate),
          setByUserId: req.user!.id,
        },
        include: { crop: true },
      });
      return res.status(201).json({ data: entry });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return res.status(409).json({
          message: 'A price already exists for this crop, grade, and effective date.',
        });
      }
      console.error('Unable to create price board entry:', error);
      return res.status(500).json({ message: 'Unable to create price board entry.' });
    }
  },
);

router.put(
  '/:id',
  requireAuth,
  requireRole('office_manager'),
  async (req: AuthenticatedRequest, res) => {
    const id = idSchema.safeParse(req.params.id);
    const parsed = updateSchema.safeParse(normalizePriceBoardInput(req.body));
    if (!id.success || !parsed.success) {
      return res.status(400).json({
        message: 'Invalid price board update.',
        error: {
          id: id.success ? undefined : id.error.flatten(),
          fields: parsed.success ? undefined : parsed.error.flatten(),
        },
      });
    }

    try {
      const existing = await prisma.priceBoard.findUnique({ where: { id: id.data } });
      if (!existing) {
        return res.status(404).json({ message: 'Price board entry not found.' });
      }
      if (parsed.data.cropId !== undefined) {
        const crop = await prisma.crop.findUnique({
          where: { id: parsed.data.cropId },
          select: { id: true },
        });
        if (!crop) {
          return res.status(404).json({ message: 'Crop not found.' });
        }
      }

      const input = parsed.data;
      const updated = await prisma.priceBoard.update({
        where: { id: existing.id },
        data: {
          ...(input.cropId !== undefined ? { cropId: input.cropId } : {}),
          ...(input.grade !== undefined ? { grade: input.grade } : {}),
          ...(input.ratePerQuintal !== undefined ? { ratePerQuintal: input.ratePerQuintal } : {}),
          ...(input.effectiveDate !== undefined
            ? { effectiveDate: normalizeEffectiveDate(input.effectiveDate) }
            : {}),
          setByUserId: req.user!.id,
        },
        include: { crop: true },
      });
      return res.json({ data: updated });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return res.status(409).json({
          message: 'A price already exists for this crop, grade, and effective date.',
        });
      }
      console.error('Unable to update price board entry:', error);
      return res.status(500).json({ message: 'Unable to update price board entry.' });
    }
  },
);

export { router as priceBoardRouter };
