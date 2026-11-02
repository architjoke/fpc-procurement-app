import { describe, expect, it } from 'vitest';
import {
  calculateAmountPaisa,
  calculateNetWeightKg,
  roundToOneDecimal,
} from '../utils/calculations.js';
import {
  canonicalizeSyncPurchase,
  signSyncPurchase,
  verifySyncPurchaseSignature,
} from '../utils/hmac.js';
import { detectAnomalies } from '../services/anomaly.js';

describe('business rules', () => {
  it('calculates net weight using the moisture deduction formula', () => {
    expect(calculateNetWeightKg(1250, 18, 11.5)).toBe(1232);
    expect(calculateNetWeightKg(860, 12, 14)).toBe(831);
    expect(calculateNetWeightKg(640, 10, 10)).toBe(630);
  });

  it('does not deduct moisture at or below 12%, including zero moisture', () => {
    expect(calculateNetWeightKg(100, 0, 12)).toBe(100);
    expect(calculateNetWeightKg(100, 0, 0)).toBe(100);
    expect(calculateNetWeightKg(100, 0, 12.9)).toBe(100);
  });

  it('rounds net weight after applying moisture deduction and before pricing', () => {
    const netWeightKg = calculateNetWeightKg(1.05, 0, 13);
    expect(netWeightKg).toBe(1);
    expect(calculateAmountPaisa(netWeightKg, 4850)).toBe(4850);
  });

  it('rejects invalid weights, including tare greater than gross', () => {
    expect(() => calculateNetWeightKg(10, 11, 12)).toThrow(RangeError);
    expect(() => calculateNetWeightKg(Number.NaN, 0, 12)).toThrow(RangeError);
    expect(() => calculateNetWeightKg(10, -1, 12)).toThrow(RangeError);
    expect(() => calculateNetWeightKg(10, 0, 101)).toThrow(RangeError);
  });

  it('rounds payment to paisa precision using integer paise', () => {
    expect(roundToOneDecimal(1232.04)).toBe(1232);
    expect(calculateAmountPaisa(1232, 4850)).toBe(5975200);
    expect(calculateAmountPaisa(831, 4850)).toBe(4030350);
    expect(calculateAmountPaisa(630, 7200)).toBe(4536000);
    expect(calculateAmountPaisa(1.1, 4850)).toBe(5335);
    expect(calculateAmountPaisa(0.1, 5)).toBe(1);
    expect(() => calculateAmountPaisa(-0.1, 4850)).toThrow(RangeError);
    expect(() => calculateAmountPaisa(100, 0)).toThrow(RangeError);
    expect(() => calculateAmountPaisa(Number.MAX_SAFE_INTEGER, 4850)).toThrow(RangeError);
  });

  it('canonicalizes and verifies signed sync purchases, rejecting tampered payloads', () => {
    const payload = {
      uuid: '37ba8d5b-d259-44d7-a187-5ea594f3cb9c',
      farmer_id: 'farmer-1',
      centre_id: 'centre-1',
      crop_id: 'crop-1',
      grade: 'A',
      gross_kg: 100,
      tare_kg: 5,
      moisture_pct: 12.5,
      device_timestamp: '2026-11-02T10:00:00Z',
      nonce: '0d61f20f-45bc-45d0-b190-4332fca73c22',
      rate_per_quintal: 4850,
    };
    const signature = signSyncPurchase(payload, 'device-secret');

    expect(canonicalizeSyncPurchase(payload)).toBe(
      'centre_id=centre-1|crop_id=crop-1|device_timestamp=2026-11-02T10%3A00%3A00.000Z|farmer_id=farmer-1|grade=A|gross_kg=100|moisture_pct=12.5|nonce=0d61f20f-45bc-45d0-b190-4332fca73c22|rate_per_quintal=4850|tare_kg=5|uuid=37ba8d5b-d259-44d7-a187-5ea594f3cb9c',
    );
    expect(verifySyncPurchaseSignature(payload, signature, 'device-secret')).toBe(true);
    expect(
      verifySyncPurchaseSignature({ ...payload, gross_kg: 101 }, signature, 'device-secret'),
    ).toBe(false);
    expect(verifySyncPurchaseSignature(payload, 'deadbeef', 'device-secret')).toBe(false);
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
