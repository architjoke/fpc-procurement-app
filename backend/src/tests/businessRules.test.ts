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
import { detectAnomalies, getUtcDayRange } from '../services/anomaly.js';

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

  it('authenticates optional OCR references and reconciliation flags in sync payloads', () => {
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
      ocr_job_id: 'ocr-job-1',
      ocr_weight: 100,
      ocr_weight_reconciled: false,
    };
    const signature = signSyncPurchase(payload, 'device-secret');

    expect(verifySyncPurchaseSignature(payload, signature, 'device-secret')).toBe(true);
    expect(
      verifySyncPurchaseSignature(
        { ...payload, ocr_weight_reconciled: true },
        signature,
        'device-secret',
      ),
    ).toBe(false);
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

  it('uses UTC calendar-day boundaries for moisture anomaly comparisons', () => {
    const range = getUtcDayRange(new Date('2026-11-02T23:59:59.999Z'));

    expect(range.start.toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-11-03T00:00:00.000Z');
  });

  it('applies soybean and tur yield caps at exact, below, and above boundaries', () => {
    const base = {
      farmerId: 'farmer-boundary',
      centreId: 'centre-1',
      tareKg: 0,
      moisturePct: 20,
      landAcres: 1,
      recentPurchases: [],
      sameDayMoisture: [],
    };

    for (const [cropType, capKg] of [
      ['soybean', 1500],
      ['tur', 1000],
    ] as const) {
      expect(
        detectAnomalies({ ...base, cropType, grossKg: capKg - 0.1 }, new Date()).some(
          (anomaly) => anomaly.trigger === 'YIELD_CAP',
        ),
      ).toBe(false);
      expect(
        detectAnomalies({ ...base, cropType, grossKg: capKg }, new Date()).some(
          (anomaly) => anomaly.trigger === 'YIELD_CAP',
        ),
      ).toBe(false);
      expect(
        detectAnomalies({ ...base, cropType, grossKg: capKg + 0.1 }, new Date()).some(
          (anomaly) => anomaly.trigger === 'YIELD_CAP',
        ),
      ).toBe(true);
    }
  });

  it('uses an inclusive 60-minute repeat window and excludes future purchases', () => {
    const now = new Date('2026-11-02T10:00:00.000Z');
    const base = {
      farmerId: 'farmer-repeat',
      centreId: 'centre-1',
      grossKg: 500,
      tareKg: 10,
      moisturePct: 15,
      landAcres: 1,
      cropType: 'soybean' as const,
      sameDayMoisture: [],
    };
    const detectsRepeat = (ageMs: number) =>
      detectAnomalies(
        {
          ...base,
          recentPurchases: [
            {
              farmerId: 'farmer-repeat',
              centreId: 'centre-1',
              createdAt: new Date(now.getTime() - ageMs),
            },
          ],
        },
        now,
      ).some((anomaly) => anomaly.trigger === 'REPEATED_FARMER');

    expect(detectsRepeat(60 * 60 * 1000)).toBe(true);
    expect(detectsRepeat(60 * 60 * 1000 + 1)).toBe(false);
    expect(detectsRepeat(-1)).toBe(false);
  });

  it('checks centre-day moisture variation using the candidate as one of five readings', () => {
    const base = {
      farmerId: 'farmer-moisture',
      centreId: 'centre-1',
      grossKg: 500,
      tareKg: 10,
      landAcres: 1,
      cropType: 'soybean' as const,
      recentPurchases: [],
    };
    const triggers = (sameDayMoisture: number[], moisturePct: number) =>
      detectAnomalies({ ...base, sameDayMoisture, moisturePct }).some(
        (anomaly) => anomaly.trigger === 'MOISTURE_VARIANCE',
      );

    expect(triggers([12, 12, 12, 12], 12)).toBe(true);
    expect(triggers([12, 12, 12], 12)).toBe(false);
    expect(triggers([12, 12, 12, 12], 12.5)).toBe(false);
    expect(triggers([12, 12, 12, 12], 12.49)).toBe(true);
  });
});
