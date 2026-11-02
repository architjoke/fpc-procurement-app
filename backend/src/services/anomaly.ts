export type AnomalyTrigger = 'YIELD_CAP' | 'REPEATED_FARMER' | 'MOISTURE_VARIANCE';

export interface AnomalyCheck {
  trigger: AnomalyTrigger;
  reason: string;
}

export const detectAnomalies = (input: {
  farmerId: string;
  centreId: string;
  grossKg: number;
  tareKg: number;
  moisturePct: number;
  landAcres: number;
  cropType: 'soybean' | 'tur';
  recentPurchases: Array<{ farmerId: string; createdAt: Date; centreId: string }>;
  sameDayMoisture: number[];
}): AnomalyCheck[] => {
  const anomalies: AnomalyCheck[] = [];
  const netKg = input.grossKg - input.tareKg;
  const capKg = input.cropType === 'soybean' ? 1500 * input.landAcres : 1000 * input.landAcres;

  if (netKg > capKg) {
    anomalies.push({
      trigger: 'YIELD_CAP',
      reason: 'Weight exceeds configured yield cap for the farmer land area.',
    });
  }

  const hasRecentPurchase = input.recentPurchases.some((purchase) => {
    const diffMinutes = (Date.now() - new Date(purchase.createdAt).getTime()) / 60000;
    return purchase.farmerId === input.farmerId && diffMinutes <= 60;
  });

  if (hasRecentPurchase) {
    anomalies.push({
      trigger: 'REPEATED_FARMER',
      reason: 'Same farmer has a purchase logged within the last 60 minutes.',
    });
  }

  if (input.sameDayMoisture.length >= 5) {
    const values = [...input.sameDayMoisture];
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max - min < 0.5) {
      anomalies.push({
        trigger: 'MOISTURE_VARIANCE',
        reason:
          'Moisture readings vary by less than 0.5 percentage points across multiple entries.',
      });
    }
  }

  return anomalies;
};
