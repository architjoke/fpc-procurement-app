export const roundToOneDecimal = (value: number): number => {
  if (!Number.isFinite(value)) {
    throw new RangeError('Weight must be a finite number.');
  }
  return Math.round((value + Number.EPSILON) * 10) / 10;
};

export const calculateNetWeightKg = (
  grossKg: number,
  tareKg: number,
  moisturePct: number,
): number => {
  if (
    !Number.isFinite(grossKg) ||
    !Number.isFinite(tareKg) ||
    !Number.isFinite(moisturePct) ||
    grossKg <= 0 ||
    tareKg < 0 ||
    tareKg > grossKg ||
    moisturePct < 0 ||
    moisturePct > 100
  ) {
    throw new RangeError('Gross, tare, and moisture values are invalid.');
  }

  const baseNet = grossKg - tareKg;
  const deductionPercent = Math.max(0, Math.floor(moisturePct - 12));
  const adjusted = baseNet * (1 - deductionPercent / 100);
  return roundToOneDecimal(adjusted);
};

export const calculateAmountPaisa = (netWeightKg: number, ratePerQuintal: number): number => {
  if (
    !Number.isFinite(netWeightKg) ||
    !Number.isFinite(ratePerQuintal) ||
    netWeightKg < 0 ||
    ratePerQuintal <= 0 ||
    !Number.isInteger(ratePerQuintal)
  ) {
    throw new RangeError('Net weight and rate are invalid.');
  }

  const netWeightTenths = Math.round(netWeightKg * 10);
  if (!Number.isSafeInteger(netWeightTenths)) {
    throw new RangeError('Net weight exceeds safe decimal precision.');
  }
  const amountPaise = Math.round((netWeightTenths * ratePerQuintal) / 10);
  if (!Number.isSafeInteger(amountPaise)) {
    throw new RangeError('Calculated amount exceeds safe paisa precision.');
  }
  return amountPaise;
};

export const buildMarathiSmsSlip = (purchase: {
  slipNo: string;
  farmerName: string;
  cropName: string;
  grossKg: number;
  tareKg: number;
  moisturePct: number;
  netKg: number;
  ratePerQuintal: number;
  amountPaise: number;
  centreCode: string;
}): string => {
  const amountInRupees = (purchase.amountPaise / 100).toFixed(2);
  return `रसीद ${purchase.slipNo} | शेतकरी: ${purchase.farmerName} | ${purchase.cropName} | सकल वजन: ${purchase.grossKg.toFixed(1)} किलो | कच्चा वजन: ${purchase.tareKg.toFixed(1)} किलो | ओलावा: ${purchase.moisturePct.toFixed(1)}% | शुद्ध वजन: ${purchase.netKg.toFixed(1)} किलो | दर: ₹${purchase.ratePerQuintal}/क्विंटल | रक्कम: ₹${amountInRupees} | केंद्र: ${purchase.centreCode}`;
};
