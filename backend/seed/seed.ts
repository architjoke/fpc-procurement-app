import bcrypt from 'bcryptjs';
import { Prisma, PrismaClient } from '@prisma/client';
import { calculateAmountPaisa, calculateNetWeightKg } from '../src/utils/calculations.js';

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

  const effectiveDate = new Date();
  effectiveDate.setUTCHours(0, 0, 0, 0);
  await prisma.priceBoard.createMany({
    data: [
      { cropId: soybean.id, grade: 'A', ratePerQuintal: 4850 },
      { cropId: soybean.id, grade: 'B', ratePerQuintal: 4700 },
      { cropId: soybean.id, grade: 'C', ratePerQuintal: 4500 },
      { cropId: tur.id, grade: 'A', ratePerQuintal: 7200 },
      { cropId: tur.id, grade: 'B', ratePerQuintal: 7000 },
      { cropId: tur.id, grade: 'C', ratePerQuintal: 6800 },
    ].map((price) => ({
      ...price,
      effectiveDate,
      setByUserId: manager.id,
    })),
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

  const additionalFarmers = [
    {
      memberId: 'F-1004',
      name: 'Shankar Pawar',
      village: 'Bori',
      landAcres: 3.2,
      centreId: centre1.id,
    },
    {
      memberId: 'F-1005',
      name: 'Laxman Deshmukh',
      village: 'Harangul',
      landAcres: 2.8,
      centreId: centre1.id,
    },
    {
      memberId: 'F-1006',
      name: 'Vitthal More',
      village: 'Murud',
      landAcres: 4.1,
      centreId: centre1.id,
    },
    {
      memberId: 'F-1007',
      name: 'Suresh Kale',
      village: 'Renapur',
      landAcres: 2.4,
      centreId: centre1.id,
    },
    {
      memberId: 'F-1008',
      name: 'Ramesh Patil',
      village: 'Bhatangali',
      landAcres: 5.0,
      centreId: centre1.id,
    },
    {
      memberId: 'F-1009',
      name: 'Dnyaneshwar Jadhav',
      village: 'Nitur',
      landAcres: 3.6,
      centreId: centre1.id,
    },
    {
      memberId: 'F-1010',
      name: 'Balu Shinde',
      village: 'Kasarshirshi',
      landAcres: 2.2,
      centreId: centre2.id,
    },
    {
      memberId: 'F-1011',
      name: 'Ganesh Biradar',
      village: 'Tawarja',
      landAcres: 4.3,
      centreId: centre2.id,
    },
    {
      memberId: 'F-1012',
      name: 'Maruti Gaikwad',
      village: 'Ausa',
      landAcres: 3.1,
      centreId: centre2.id,
    },
    {
      memberId: 'F-1013',
      name: 'Tukaram Mane',
      village: 'Ujani',
      landAcres: 5.4,
      centreId: centre2.id,
    },
    {
      memberId: 'F-1014',
      name: 'Ashok Wagh',
      village: 'Killari',
      landAcres: 2.7,
      centreId: centre2.id,
    },
    {
      memberId: 'F-1015',
      name: 'Pandurang Kadam',
      village: 'Makni',
      landAcres: 3.9,
      centreId: centre2.id,
    },
    {
      memberId: 'F-1016',
      name: 'Keshav Rathod',
      village: 'Nilanga',
      landAcres: 4.6,
      centreId: centre3.id,
    },
    {
      memberId: 'F-1017',
      name: 'Savita Jadhav',
      village: 'Aurad Shahajani',
      landAcres: 2.6,
      centreId: centre3.id,
    },
    {
      memberId: 'F-1018',
      name: 'Suman Shinde',
      village: 'Kasarsirsi',
      landAcres: 3.4,
      centreId: centre3.id,
    },
    {
      memberId: 'F-1019',
      name: 'Lata Pawar',
      village: 'Halgara',
      landAcres: 2.9,
      centreId: centre3.id,
    },
    {
      memberId: 'F-1020',
      name: 'Meena Kale',
      village: 'Nalegaon',
      landAcres: 4.2,
      centreId: centre3.id,
    },
  ];

  await prisma.farmer.createMany({
    data: additionalFarmers.map((farmer, index) => ({
      ...farmer,
      bankAccount: `${456789012300 + index}`,
      bankIfsc: ['SBIN0001234', 'HDFC0002345', 'ICIC0003456'][index % 3]!,
      consentGivenAt: new Date(),
    })),
  });

  const samplePurchases = [
    {
      farmerId: farmerSunil.id,
      centreId: centre1.id,
      cropId: soybean.id,
      grade: 'A',
      grossKg: 1250.0,
      tareKg: 18.0,
      moisturePct: 11.5,
      rate: 4850,
    },
    {
      farmerId: farmerKamal.id,
      centreId: centre1.id,
      cropId: soybean.id,
      grade: 'A',
      grossKg: 860.0,
      tareKg: 12.0,
      moisturePct: 14.0,
      rate: 4850,
    },
    {
      farmerId: farmerMohan.id,
      centreId: centre2.id,
      cropId: tur.id,
      grade: 'A',
      grossKg: 640.0,
      tareKg: 10.0,
      moisturePct: 10.0,
      rate: 7200,
    },
  ];

  type SeedPurchase = Prisma.PurchaseGetPayload<{
    include: { farmer: true; crop: true; centre: true };
  }>;
  const createdPurchases: SeedPurchase[] = [];

  for (const purchase of samplePurchases) {
    const adjustedNet = calculateNetWeightKg(
      purchase.grossKg,
      purchase.tareKg,
      purchase.moisturePct,
    );
    const amountPaise = calculateAmountPaisa(adjustedNet, purchase.rate);

    const created = await prisma.purchase.create({
      data: {
        uuid: `purchase-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        farmerId: purchase.farmerId,
        centreId: purchase.centreId,
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

    createdPurchases.push(created);

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
