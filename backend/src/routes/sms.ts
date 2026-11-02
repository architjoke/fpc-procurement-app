import { Router } from 'express';
import { prisma } from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/:purchaseId', requireAuth, async (req, res) => {
  const purchase = await prisma.purchase.findUnique({
    where: { id: req.params.purchaseId },
    include: { farmer: true, crop: true, centre: true },
  });

  if (!purchase) {
    return res.status(404).json({ message: 'Purchase not found.' });
  }

  const message = `रसीद ${purchase.farmer.memberId} | शेतकरी: ${purchase.farmer.name} | ${purchase.crop.name} | सकल वजन: ${purchase.grossKg.toNumber().toFixed(1)} किलो | कच्चा वजन: ${purchase.tareKg.toNumber().toFixed(1)} किलो | ओलावा: ${purchase.moisturePct.toNumber().toFixed(1)}% | शुद्ध वजन: ${purchase.netKg.toNumber().toFixed(1)} किलो | दर: ₹${purchase.rate}/क्विंटल | रक्कम: ₹${(purchase.amountPaise / 100).toFixed(2)} | केंद्र: ${purchase.centre.code}`;

  return res.json({ data: { message, status: 'SENT' } });
});

export { router as smsRouter };
