import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

const paymentRunSchema = z.object({
  purchaseIds: z.array(z.string()).min(1),
});

router.post(
  '/',
  requireAuth,
  requireRole('office_manager'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { purchaseIds } = paymentRunSchema.parse(req.body);
      const purchases = (await prisma.purchase.findMany({
        where: { id: { in: purchaseIds } },
      })) as Array<{ id: string; amountPaise: number }>;

      const totalAmountPaise = purchases.reduce(
        (sum: number, purchase: { amountPaise: number }) => sum + purchase.amountPaise,
        0,
      );
      const run = await prisma.paymentRun.create({
        data: {
          runDate: new Date(),
          status: 'DRAFT',
          totalAmountPaise,
          createdBy: req.user?.id ?? '',
        },
      });

      await Promise.all(
        purchases.map((purchase: { id: string }) =>
          prisma.paymentRunItem.create({
            data: {
              paymentRunId: run.id,
              purchaseId: purchase.id,
              status: 'PENDING',
            },
          }),
        ),
      );

      return res.status(201).json({ data: { ...run, totalAmountPaise } });
    } catch (error) {
      return res
        .status(400)
        .json({ message: 'Unable to create payment run.', error: (error as Error).message });
    }
  },
);

router.get('/:id/export', requireAuth, requireRole('office_manager'), async (req, res) => {
  const parsedId = z.string().min(1).safeParse(req.params.id);
  if (!parsedId.success) {
    return res.status(400).json({ message: 'Invalid payment run id.' });
  }

  const run = await prisma.paymentRun.findUnique({
    where: { id: parsedId.data },
    include: { paymentItems: { include: { purchase: { include: { farmer: true } } } } },
  });

  if (!run) {
    return res.status(404).json({ message: 'Payment run not found.' });
  }

  const lines = [
    'member_id,farmer_name,amount_paise,status',
    ...run.paymentItems.map(
      (item: {
        purchase: { farmer: { memberId: string; name: string }; amountPaise: number };
        status: string;
      }) =>
        `${item.purchase.farmer.memberId},${item.purchase.farmer.name},${item.purchase.amountPaise},${item.status}`,
    ),
  ];

  return res.type('text/csv').send(lines.join('\n'));
});

export { router as paymentRunsRouter };
