export interface PurchaseOcrValues {
  grossKg: number;
  moisturePct: number;
  ocrWeight?: number;
  ocrMoisture?: number;
  ocrWeightReconciled?: boolean;
  ocrMoistureReconciled?: boolean;
}

export const getOcrMismatchFields = (values: PurchaseOcrValues): string[] => {
  const mismatches: string[] = [];
  if (
    values.ocrWeight !== undefined &&
    Math.abs(values.grossKg - values.ocrWeight) > 0.0001 &&
    values.ocrWeightReconciled !== true
  ) {
    mismatches.push('grossKg');
  }
  if (
    values.ocrMoisture !== undefined &&
    Math.abs(values.moisturePct - values.ocrMoisture) > 0.0001 &&
    values.ocrMoistureReconciled !== true
  ) {
    mismatches.push('moisturePct');
  }
  return mismatches;
};
