import { describe, expect, it } from 'vitest';
import { generateAndStoreSmsSlip, type SmsOutboxEntry } from '../services/sms.js';
import { buildMarathiSmsSlip } from '../utils/calculations.js';

const canonicalPurchases = [
  {
    purchaseId: 'purchase-sunil',
    slipNo: 'purchase-sunil',
    status: 'APPROVED',
    farmerName: 'Sunil Jadhav',
    cropName: 'Soybean',
    grossKg: 1250,
    tareKg: 18,
    moisturePct: 11.5,
    netKg: 1232,
    ratePerQuintal: 4850,
    amountPaise: 5975200,
    centreCode: 'C07',
  },
  {
    purchaseId: 'purchase-kamal',
    slipNo: 'purchase-kamal',
    status: 'APPROVED',
    farmerName: 'Kamal Shinde',
    cropName: 'Soybean',
    grossKg: 860,
    tareKg: 12,
    moisturePct: 14,
    netKg: 831,
    ratePerQuintal: 4850,
    amountPaise: 4030350,
    centreCode: 'C07',
  },
  {
    purchaseId: 'purchase-mohan',
    slipNo: 'purchase-mohan',
    status: 'APPROVED',
    farmerName: 'Mohan Biradar',
    cropName: 'Tur',
    grossKg: 640,
    tareKg: 10,
    moisturePct: 10,
    netKg: 630,
    ratePerQuintal: 7200,
    amountPaise: 4536000,
    centreCode: 'C12',
  },
] as const;

describe('Marathi SMS slips', () => {
  it.each([
    [
      canonicalPurchases[0],
      'रसीद purchase-sunil | शेतकरी: Sunil Jadhav | Soybean | सकल वजन: 1250.0 किलो | कच्चा वजन: 18.0 किलो | ओलावा: 11.5% | शुद्ध वजन: 1232.0 किलो | दर: ₹4850/क्विंटल | रक्कम: ₹59752.00 | केंद्र: C07',
    ],
    [
      canonicalPurchases[1],
      'रसीद purchase-kamal | शेतकरी: Kamal Shinde | Soybean | सकल वजन: 860.0 किलो | कच्चा वजन: 12.0 किलो | ओलावा: 14.0% | शुद्ध वजन: 831.0 किलो | दर: ₹4850/क्विंटल | रक्कम: ₹40303.50 | केंद्र: C07',
    ],
    [
      canonicalPurchases[2],
      'रसीद purchase-mohan | शेतकरी: Mohan Biradar | Tur | सकल वजन: 640.0 किलो | कच्चा वजन: 10.0 किलो | ओलावा: 10.0% | शुद्ध वजन: 630.0 किलो | दर: ₹7200/क्विंटल | रक्कम: ₹45360.00 | केंद्र: C12',
    ],
  ])('renders every field for the canonical seed purchase', (purchase, expected) => {
    expect(buildMarathiSmsSlip(purchase)).toBe(expected);
  });

  it('stores an approved purchase slip exactly once and does not create slips for flagged purchases', async () => {
    const stored = new Map<string, SmsOutboxEntry>();
    const upsertSmsOutbox = async (entry: SmsOutboxEntry) => {
      if (!stored.has(entry.purchaseId)) {
        stored.set(entry.purchaseId, entry);
      }
    };

    const first = await generateAndStoreSmsSlip(canonicalPurchases[0], { upsertSmsOutbox });
    const second = await generateAndStoreSmsSlip(canonicalPurchases[0], { upsertSmsOutbox });
    const flagged = await generateAndStoreSmsSlip(
      { ...canonicalPurchases[1], status: 'FLAGGED' },
      { upsertSmsOutbox },
    );

    expect(first).toContain('रसीद purchase-sunil');
    expect(second).toBe(first);
    expect(flagged).toBeNull();
    expect(stored.size).toBe(1);
    expect(stored.has('purchase-kamal')).toBe(false);
  });
});
