import { Router } from 'express';
import { prisma } from '../config/database.js';
import { centreScope, requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

router.get('/dashboard/summary', requireAuth, async (req: AuthenticatedRequest, res) => {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const scope = centreScope(req.user!);
  const centreFilter =
    req.user?.role === 'centre_operator' ? { id: req.user.centreId ?? undefined } : {};

  const [purchasesToday, pending, byCentre] = await Promise.all([
    prisma.purchase.count({ where: { ...scope, createdAt: { gte: startOfDay } } }),
    prisma.purchase.aggregate({
      _sum: { amountPaise: true },
      where: { ...scope, status: { in: ['DRAFT', 'FLAGGED', 'APPROVED'] } },
    }),
    prisma.centre.findMany({
      where: centreFilter,
      include: { purchases: true },
    }),
  ]);

  return res.json({
    data: {
      purchasesToday,
      pendingPaymentAmountPaise: pending._sum.amountPaise ?? 0,
      centres: byCentre.map((centre: { id: string; name: string; purchases: unknown[] }) => ({
        id: centre.id,
        name: centre.name,
        purchaseCount: centre.purchases.length,
      })),
    },
  });
});

export { router as dashboardRouter };
