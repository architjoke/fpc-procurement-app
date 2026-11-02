import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database.js';
import { requireAuth, requireRole, type AuthenticatedRequest } from '../middleware/auth.js';
import { generatePaymentRunCsv } from '../services/paymentRunCsv.js';

const router = Router();

const purchaseIdsSchema = z
  .array(z.string().trim().min(1))
  .min(1)
  .superRefine((purchaseIds, context) => {
    if (new Set(purchaseIds).size !== purchaseIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Purchase IDs must be unique.',
      });
    }
  });

const paymentRunSchema = z.union([
  z.object({ purchase_ids: purchaseIdsSchema }).strict(),
  z.object({ purchaseIds: purchaseIdsSchema }).strict(),
]);

const listQuerySchema = z.object({
  status: z.enum(['DRAFT', 'APPROVED', 'EXPORTED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

class PaymentRunConflict extends Error {}

router.post(
  '/',
  requireAuth,
  requireRole('office_manager'),
  async (req: AuthenticatedRequest, res) => {
    const parsedBody = paymentRunSchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        message: 'Provide a non-empty list of unique purchase_ids.',
        error: parsedBody.error.flatten(),
      });
    }

    const purchaseIds =
      'purchase_ids' in parsedBody.data
        ? parsedBody.data.purchase_ids
        : parsedBody.data.purchaseIds;

    try {
      const purchases = await prisma.purchase.findMany({
        where: { id: { in: purchaseIds } },
        include: { paymentRunItems: { select: { id: true } } },
      });
      const purchaseById = new Map(purchases.map((purchase) => [purchase.id, purchase]));
      const ineligiblePurchaseIds = purchaseIds.filter((purchaseId) => {
        const purchase = purchaseById.get(purchaseId);
        return (
          !purchase || purchase.status !== 'APPROVED' || (purchase.paymentRunItems?.length ?? 0) > 0
        );
      });

      if (ineligiblePurchaseIds.length > 0) {
        return res.status(400).json({
          message: `Purchases are not eligible for a payment run: ${ineligiblePurchaseIds.join(', ')}.`,
          ineligiblePurchaseIds,
        });
      }

      const totalAmountPaise = purchases.reduce((sum, purchase) => sum + purchase.amountPaise, 0);
      if (!Number.isSafeInteger(totalAmountPaise)) {
        return res.status(400).json({ message: 'Payment run total exceeds safe paise precision.' });
      }

      const run = await prisma.paymentRun.create({
        data: {
          runDate: new Date(),
          status: 'DRAFT',
          totalAmountPaise,
          createdBy: req.user!.id,
          paymentItems: {
            create: purchases.map((purchase) => ({
              purchase: { connect: { id: purchase.id } },
              status: 'APPROVED',
            })),
          },
        },
        include: { paymentItems: true },
      });

      return res.status(201).json({ data: run });
    } catch (error) {
      console.error('Unable to create payment run:', error);
      return res.status(500).json({ message: 'Unable to create payment run.' });
    }
  },
);

router.get('/', requireAuth, requireRole('office_manager'), async (req, res) => {
  const parsedQuery = listQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({ message: 'Invalid payment run filters or pagination.' });
  }

  const { status, page, pageSize } = parsedQuery.data;
  const where = status ? { status } : {};

  try {
    const [data, total] = await Promise.all([
      prisma.paymentRun.findMany({
        where,
        include: { _count: { select: { paymentItems: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.paymentRun.count({ where }),
    ]);

    return res.json({
      data,
      pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    });
  } catch (error) {
    console.error('Unable to list payment runs:', error);
    return res.status(500).json({ message: 'Unable to list payment runs.' });
  }
});

router.patch(
  '/:id/approve',
  requireAuth,
  requireRole('office_manager'),
  async (req: AuthenticatedRequest, res) => {
    const parsedId = z.string().min(1).safeParse(req.params.id);
    if (!parsedId.success) {
      return res.status(400).json({ message: 'Invalid payment run id.' });
    }

    try {
      const run = await prisma.paymentRun.findUnique({ where: { id: parsedId.data } });
      if (!run) {
        return res.status(404).json({ message: 'Payment run not found.' });
      }
      if (run.status !== 'DRAFT') {
        return res.status(409).json({ message: 'Only draft payment runs can be approved.' });
      }

      const approved = await prisma.$transaction(async (transaction) => {
        const changed = await transaction.paymentRun.updateMany({
          where: { id: run.id, status: 'DRAFT' },
          data: { status: 'APPROVED' },
        });
        if (changed.count !== 1) {
          return null;
        }

        const updated = await transaction.paymentRun.findUnique({ where: { id: run.id } });
        if (!updated) {
          throw new Error('Approved payment run could not be reloaded.');
        }
        await transaction.auditTrail.create({
          data: {
            actorUserId: req.user!.id,
            action: 'payment_run_approve',
            entityType: 'payment_run',
            entityId: run.id,
            before: JSON.stringify({ status: 'DRAFT' }),
            after: JSON.stringify({ status: 'APPROVED' }),
          },
        });
        return updated;
      });

      if (!approved) {
        return res.status(409).json({ message: 'Payment run is no longer a draft.' });
      }

      return res.json({ data: approved, message: 'Payment run approved.' });
    } catch (error) {
      console.error('Unable to approve payment run:', error);
      return res.status(500).json({ message: 'Unable to approve payment run.' });
    }
  },
);

router.get(
  '/:id/export',
  requireAuth,
  requireRole('office_manager'),
  async (req: AuthenticatedRequest, res) => {
    const parsedId = z.string().min(1).safeParse(req.params.id);
    if (!parsedId.success) {
      return res.status(400).json({ message: 'Invalid payment run id.' });
    }

    try {
      const run = await prisma.paymentRun.findUnique({
        where: { id: parsedId.data },
        include: {
          paymentItems: {
            orderBy: { createdAt: 'asc' },
            include: { purchase: { include: { farmer: true } } },
          },
        },
      });

      if (!run) {
        return res.status(404).json({ message: 'Payment run not found.' });
      }
      if (run.status === 'DRAFT') {
        return res.status(409).json({ message: 'Approve the payment run before exporting it.' });
      }

      const csv = generatePaymentRunCsv(
        run.paymentItems.map((item) => ({
          id: item.purchase.id,
          amountPaise: item.purchase.amountPaise,
          farmer: {
            name: item.purchase.farmer.name,
            bankAccount: item.purchase.farmer.bankAccount,
            bankIfsc: item.purchase.farmer.bankIfsc,
          },
        })),
      );

      if (run.status === 'APPROVED') {
        await prisma.$transaction(async (transaction) => {
          const purchaseIds = run.paymentItems.map((item) => item.purchaseId);
          const paid = await transaction.purchase.updateMany({
            where: { id: { in: purchaseIds }, status: 'APPROVED' },
            data: { status: 'PAID' },
          });
          if (paid.count !== purchaseIds.length) {
            throw new PaymentRunConflict('One or more purchases are no longer approved.');
          }

          const exported = await transaction.paymentRun.updateMany({
            where: { id: run.id, status: 'APPROVED' },
            data: { status: 'EXPORTED' },
          });
          if (exported.count !== 1) {
            throw new PaymentRunConflict('Payment run is no longer approved.');
          }
          await transaction.auditTrail.create({
            data: {
              actorUserId: req.user?.id ?? null,
              action: 'payment_run_export',
              entityType: 'payment_run',
              entityId: run.id,
              before: JSON.stringify({ status: 'APPROVED' }),
              after: JSON.stringify({ status: 'EXPORTED', purchaseIds }),
            },
          });
        });
      }

      return res
        .status(200)
        .setHeader('Content-Disposition', `attachment; filename="payment-run-${run.id}.csv"`)
        .type('text/csv')
        .send(csv);
    } catch (error) {
      if (error instanceof PaymentRunConflict) {
        return res.status(409).json({ message: error.message });
      }
      console.error('Unable to export payment run:', error);
      return res.status(500).json({ message: 'Unable to export payment run.' });
    }
  },
);

router.get('/:id', requireAuth, requireRole('office_manager'), async (req, res) => {
  const parsedId = z.string().min(1).safeParse(req.params.id);
  if (!parsedId.success) {
    return res.status(400).json({ message: 'Invalid payment run id.' });
  }

  try {
    const run = await prisma.paymentRun.findUnique({
      where: { id: parsedId.data },
      include: {
        paymentItems: {
          orderBy: { createdAt: 'asc' },
          include: { purchase: { include: { farmer: true, crop: true } } },
        },
      },
    });
    if (!run) {
      return res.status(404).json({ message: 'Payment run not found.' });
    }

    return res.json({ data: run });
  } catch (error) {
    console.error('Unable to load payment run:', error);
    return res.status(500).json({ message: 'Unable to load payment run.' });
  }
});

export { router as paymentRunsRouter };
