import { describe, expect, it } from 'vitest';
import {
  calculateAmountPaisa,
  calculateNetWeightKg,
  roundToOneDecimal,
} from '../utils/calculations.js';
import { signPayload, verifySignature } from '../utils/hmac.js';
import { detectAnomalies } from '../services/anomaly.js';

describe('business rules', () => {
  it('calculates net weight using the moisture deduction formula', () => {
    expect(calculateNetWeightKg(1250, 18, 11.5)).toBe(1232);
    expect(calculateNetWeightKg(860, 12, 14)).toBe(831);
    expect(calculateNetWeightKg(640, 10, 10)).toBe(630);
  });

  it('rounds payment to paisa precision using integer paise', () => {
    expect(roundToOneDecimal(1232.04)).toBe(1232);
    expect(calculateAmountPaisa(1232, 4850)).toBe(5975200);
    expect(calculateAmountPaisa(831, 4850)).toBe(4030350);
    expect(calculateAmountPaisa(630, 7200)).toBe(4536000);
  });

  it('signs and verifies HMAC payloads', () => {
    const payload = { deviceId: 'c07-mobile', amountPaise: 4030350 };
    const signature = signPayload(payload, 'device-secret');
    expect(verifySignature(payload, signature, 'device-secret')).toBe(true);
    expect(verifySignature(payload, 'deadbeef', 'device-secret')).toBe(false);
  });

  it('detects each configured anomaly trigger', () => {
    expect(
      detectAnomalies({
        farmerId: 'f1',
        centreId: 'c1',
        grossKg: 2000,
        tareKg: 10,
        moisturePct: 15,
        landAcres: 1,
        cropType: 'soybean',
        recentPurchases: [
          { farmerId: 'f1', createdAt: new Date(Date.now() - 5 * 60 * 1000), centreId: 'c1' },
        ],
        sameDayMoisture: [14.1, 14.2, 14.1, 14.0, 14.2],
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ trigger: 'REPEATED_FARMER' })]));

    expect(
      detectAnomalies({
        farmerId: 'f2',
        centreId: 'c1',
        grossKg: 4000,
        tareKg: 10,
        moisturePct: 10,
        landAcres: 1,
        cropType: 'soybean',
        recentPurchases: [],
        sameDayMoisture: [10, 10, 10, 10, 10],
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ trigger: 'YIELD_CAP' })]));

    expect(
      detectAnomalies({
        farmerId: 'f3',
        centreId: 'c2',
        grossKg: 1000,
        tareKg: 10,
        moisturePct: 14,
        landAcres: 2,
        cropType: 'tur',
        recentPurchases: [],
        sameDayMoisture: [14.0, 14.1, 14.2, 14.1, 14.0],
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ trigger: 'MOISTURE_VARIANCE' })]));
  });
});
