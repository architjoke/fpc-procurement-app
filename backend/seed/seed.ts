import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.syncLog.deleteMany({});
  await prisma.smsOutbox.deleteMany({});
  await prisma.paymentRunItem.deleteMany({});
  await prisma.paymentRun.deleteMany({});
  await prisma.ocrJob.deleteMany({});
  await prisma.auditTrail.deleteMany({});
  await prisma.purchase.deleteMany({});
  await prisma.priceBoard.deleteMany({});
  await prisma.farmer.deleteMany({});
  await prisma.crop.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.centre.deleteMany({});

  const centre1 = await prisma.centre.create({
    data: { name: 'Latur Centre 1', village: 'Latur', code: 'C07' },
  });
  const centre2 = await prisma.centre.create({
    data: { name: 'Ausa Centre', village: 'Ausa', code: 'C12' },
  });
  const centre3 = await prisma.centre.create({
    data: { name: 'Nilanga Centre', village: 'Nilanga', code: 'C19' },
  });

  const operator = await prisma.user.create({
    data: {
      email: 'operator@demo.in',
      passwordHash: await bcrypt.hash('demo123', 10),
      role: 'centre_operator',
      centreId: centre1.id,
    },
  });

  const manager = await prisma.user.create({
    data: {
      email: 'manager@demo.in',
      passwordHash: await bcrypt.hash('demo123', 10),
      role: 'office_manager',
    },
  });

  const soybean = await prisma.crop.create({ data: { name: 'Soybean', unit: 'kg' } });
  const tur = await prisma.crop.create({ data: { name: 'Tur', unit: 'kg' } });

  await prisma.priceBoard.createMany({
    data: [
      {
        cropId: soybean.id,
        grade: 'A',
        ratePerQuintal: 4850,
        effectiveDate: new Date(),
        setByUserId: manager.id,
      },
      {
        cropId: tur.id,
        grade: 'A',
        ratePerQuintal: 7200,
        effectiveDate: new Date(),
        setByUserId: manager.id,
      },
    ],
  });

  const farmerSunil = await prisma.farmer.create({
    data: {
      memberId: 'F-1001',
      name: 'Sunil Jadhav',
      village: 'Shirur',
      landAcres: 3,
      bankAccount: '123456789012',
      bankIfsc: 'SBIN0001234',
      consentGivenAt: new Date(),
      centreId: centre1.id,
    },
  });

  const farmerKamal = await prisma.farmer.create({
    data: {
      memberId: 'F-1002',
      name: 'Kamal Shinde',
      village: 'Nandur',
      landAcres: 2.5,
      bankAccount: '234567890123',
      bankIfsc: 'HDFC0002345',
      consentGivenAt: new Date(),
      centreId: centre1.id,
    },
  });

  const farmerMohan = await prisma.farmer.create({
    data: {
      memberId: 'F-1003',
      name: 'Mohan Biradar',
      village: 'Dahigaon',
      landAcres: 4,
      bankAccount: '345678901234',
      bankIfsc: 'ICIC0003456',
      consentGivenAt: new Date(),
      centreId: centre2.id,
    },
  });

  const samplePurchases = [
    {
      farmerId: farmerSunil.id,
      cropId: soybean.id,
      grade: 'A',
      grossKg: 1250.0,
      tareKg: 18.0,
      moisturePct: 11.5,
      rate: 4850,
    },
    {
      farmerId: farmerKamal.id,
      cropId: soybean.id,
      grade: 'A',
      grossKg: 860.0,
      tareKg: 12.0,
      moisturePct: 14.0,
      rate: 4850,
    },
    {
      farmerId: farmerMohan.id,
      cropId: tur.id,
      grade: 'A',
      grossKg: 640.0,
      tareKg: 10.0,
      moisturePct: 10.0,
      rate: 7200,
    },
  ];

  const createdPurchases: any[] = [];

  for (const purchase of samplePurchases) {
    const netKg = purchase.grossKg - purchase.tareKg;
    const moistureAdjustment = Math.max(0, Math.floor(purchase.moisturePct - 12));
    const adjustedNet = Number((netKg * (1 - moistureAdjustment / 100)).toFixed(1));
    const amountPaise = Math.round((adjustedNet / 100) * purchase.rate * 100);

    const created = await prisma.purchase.create({
      data: {
        uuid: `purchase-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        farmerId: purchase.farmerId,
        centreId: centre1.id,
        cropId: purchase.cropId,
        grade: purchase.grade,
        grossKg: purchase.grossKg,
        tareKg: purchase.tareKg,
        moisturePct: purchase.moisturePct,
        netKg: adjustedNet,
        rate: purchase.rate,
        amountPaise,
        status: 'SYNCED',
        photoUrl: '/ocr-sample-scale-1.jpg',
      },
      include: { farmer: true, crop: true, centre: true },
    });

    createdPurchases.push(created as any);

    await prisma.auditTrail.create({
      data: {
        actorUserId: operator.id,
        action: 'created_purchase',
        entityType: 'purchase',
        entityId: created.id,
        before: null,
        after: JSON.stringify({ amountPaise, status: 'SYNCED' }),
      },
    });
  }

  const paymentRun = await prisma.paymentRun.create({
    data: {
      runDate: new Date(),
      status: 'APPROVED',
      totalAmountPaise: createdPurchases.reduce((sum, purchase) => sum + purchase.amountPaise, 0),
      createdBy: manager.id,
    },
  });

  for (const purchase of createdPurchases) {
    await prisma.paymentRunItem.create({
      data: {
        paymentRunId: paymentRun.id,
        purchaseId: purchase.id,
        status: 'APPROVED',
      },
    });

    await prisma.smsOutbox.create({
      data: {
        purchaseId: purchase.id,
        phone: '+919876543210',
        messageMarathi: `रसीद ${purchase.farmer.memberId} | शेतकरी: ${purchase.farmer.name} | ${purchase.crop.name} | सकल वजन: ${purchase.grossKg.toString()} किलो | कच्चा वजन: ${purchase.tareKg.toString()} किलो | ओलावा: ${purchase.moisturePct.toString()}% | शुद्ध वजन: ${purchase.netKg.toString()} किलो | दर: ₹${purchase.rate}/क्विंटल | रक्कम: ₹${(purchase.amountPaise / 100).toFixed(2)} | केंद्र: ${purchase.centre.code}`,
        status: 'SENT',
      },
    });
  }

  console.log('Seed completed with sample purchase data');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
