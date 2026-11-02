import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { centreScope, requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

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

const farmerUpdateSchema = farmerSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one field must be provided.',
});
const farmerIdSchema = z.string().min(1);

const normalizeFarmerInput = (input: unknown): unknown => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }

  const values = input as Record<string, unknown>;
  const aliases: Record<string, string> = {
    member_id: 'memberId',
    land_acres: 'landAcres',
    bank_account: 'bankAccount',
    bank_ifsc: 'bankIfsc',
    consent_given_at: 'consentGivenAt',
    centre_id: 'centreId',
  };
  const normalized = { ...values };

  for (const [apiName, fieldName] of Object.entries(aliases)) {
    if (normalized[fieldName] === undefined && values[apiName] !== undefined) {
      normalized[fieldName] = values[apiName];
    }
    delete normalized[apiName];
  }

  return normalized;
};

const farmerData = (input: z.infer<typeof farmerSchema>) => ({
  memberId: input.memberId,
  name: input.name,
  village: input.village,
  landAcres: input.landAcres,
  bankAccount: input.bankAccount,
  bankIfsc: input.bankIfsc,
  consentGivenAt: new Date(input.consentGivenAt ?? new Date()),
  centreId: input.centreId,
});

router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  const farmers = await prisma.farmer.findMany({
    where: centreScope(req.user!),
    include: { centre: true },
  });
  return res.json({ data: farmers });
});

router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const parsedId = farmerIdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    return res.status(400).json({ message: 'Invalid farmer id.', error: parsedId.error.flatten() });
  }

  const farmer = await prisma.farmer.findFirst({
    where: { id: parsedId.data, ...centreScope(req.user!) },
    include: { centre: true },
  });

  if (!farmer) {
    return res.status(404).json({ message: 'Farmer not found.' });
  }

  return res.json({ data: farmer });
});

router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  const parsed = farmerSchema.safeParse(normalizeFarmerInput(req.body));
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid farmer data.', error: parsed.error.flatten() });
  }

  const input = parsed.data;
  if (req.user?.role === 'centre_operator' && input.centreId !== req.user.centreId) {
    return res.status(403).json({ message: 'Cannot create a farmer for another centre.' });
  }

  const farmer = await prisma.farmer.create({ data: farmerData(input) });
  return res.status(201).json({ data: farmer });
});

router.put('/:id', requireAuth, async (req: AuthenticatedRequest, res) => {
  const parsedId = farmerIdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    return res.status(400).json({ message: 'Invalid farmer id.', error: parsedId.error.flatten() });
  }

  const parsed = farmerUpdateSchema.safeParse(normalizeFarmerInput(req.body));
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid farmer data.', error: parsed.error.flatten() });
  }

  const farmer = await prisma.farmer.findFirst({
    where: { id: parsedId.data, ...centreScope(req.user!) },
  });
  if (!farmer) {
    return res.status(404).json({ message: 'Farmer not found.' });
  }

  const input = parsed.data;
  if (
    req.user?.role === 'centre_operator' &&
    input.centreId !== undefined &&
    input.centreId !== req.user.centreId
  ) {
    return res.status(403).json({ message: 'Cannot move a farmer to another centre.' });
  }

  const updated = await prisma.farmer.update({
    where: { id: farmer.id },
    data: {
      ...(input.memberId !== undefined ? { memberId: input.memberId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.village !== undefined ? { village: input.village } : {}),
      ...(input.landAcres !== undefined ? { landAcres: input.landAcres } : {}),
      ...(input.bankAccount !== undefined ? { bankAccount: input.bankAccount } : {}),
      ...(input.bankIfsc !== undefined ? { bankIfsc: input.bankIfsc } : {}),
      ...(input.consentGivenAt !== undefined
        ? { consentGivenAt: new Date(input.consentGivenAt) }
        : {}),
      ...(input.centreId !== undefined ? { centreId: input.centreId } : {}),
    },
  });

  return res.json({ data: updated });
});

export { router as farmersRouter };
