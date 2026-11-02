import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { centreScope, requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

router.get('/:purchaseId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const parsedId = z.string().min(1).safeParse(req.params.purchaseId);
  if (!parsedId.success) {
    return res.status(400).json({ message: 'Invalid purchase id.' });
  }

  const purchase = await prisma.purchase.findFirst({
    where: { id: parsedId.data, ...centreScope(req.user!) },
    select: { id: true, status: true },
  });

  if (!purchase) {
    return res.status(404).json({ message: 'Purchase not found.' });
  }

  const slip = await prisma.smsOutbox.findUnique({
    where: { purchaseId: purchase.id },
    select: { messageMarathi: true, status: true },
  });
  if (!slip) {
    return res.status(409).json({
      message: `SMS slip is not available for a ${purchase.status.toLowerCase()} purchase.`,
    });
  }

  return res.json({ data: slip });
});

export { router as smsRouter };
