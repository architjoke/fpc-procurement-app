import {
  MAX_YIELD_KG_PER_ACRE,
  MOISTURE_VARIANCE_LIMIT_PERCENTAGE_POINTS,
  MOISTURE_VARIANCE_MINIMUM_ENTRIES,
  REPEAT_PURCHASE_WINDOW_MINUTES,
} from '../config/anomalyThresholds.js';

export const getUtcDayRange = (date: Date): { start: Date; end: Date } => {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
};

export type AnomalyTrigger = 'YIELD_CAP' | 'REPEATED_FARMER' | 'MOISTURE_VARIANCE';

export interface AnomalyCheck {
  trigger: AnomalyTrigger;
  reason: string;
}

export const detectAnomalies = (
  input: {
    farmerId: string;
    centreId: string;
    grossKg: number;
    tareKg: number;
    moisturePct: number;
    landAcres: number;
    cropType: 'soybean' | 'tur';
    recentPurchases: Array<{ farmerId: string; createdAt: Date; centreId: string }>;
    sameDayMoisture: number[];
  },
  now = new Date(),
): AnomalyCheck[] => {
  const anomalies: AnomalyCheck[] = [];
  const netKg = input.grossKg - input.tareKg;
  const capKg = MAX_YIELD_KG_PER_ACRE[input.cropType] * input.landAcres;

  if (netKg > capKg) {
    anomalies.push({
      trigger: 'YIELD_CAP',
      reason: `Net weight ${netKg.toFixed(1)} kg exceeds the ${input.cropType} yield cap of ${capKg.toFixed(1)} kg for ${input.landAcres} acres.`,
    });
  }

  const hasRecentPurchase = input.recentPurchases.some((purchase) => {
    const ageMs = now.getTime() - new Date(purchase.createdAt).getTime();
    return (
      purchase.farmerId === input.farmerId &&
      ageMs >= 0 &&
      ageMs <= REPEAT_PURCHASE_WINDOW_MINUTES * 60 * 1000
    );
  });

  if (hasRecentPurchase) {
    anomalies.push({
      trigger: 'REPEATED_FARMER',
      reason: 'Same farmer has a purchase logged within the last 60 minutes.',
    });
  }

  const values = [...input.sameDayMoisture, input.moisturePct];
  if (values.length >= MOISTURE_VARIANCE_MINIMUM_ENTRIES) {
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max - min < MOISTURE_VARIANCE_LIMIT_PERCENTAGE_POINTS) {
      anomalies.push({
        trigger: 'MOISTURE_VARIANCE',
        reason:
          'Moisture readings vary by less than 0.5 percentage points across multiple entries.',
      });
    }
  }

  return anomalies;
};
