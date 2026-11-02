export const roundToOneDecimal = (value: number): number => Math.round(value * 10) / 10;

export const calculateNetWeightKg = (
  grossKg: number,
  tareKg: number,
  moisturePct: number,
): number => {
  const baseNet = grossKg - tareKg;
  const deductionPercent = Math.max(0, Math.floor(moisturePct - 12));
  const adjusted = baseNet * (1 - deductionPercent / 100);
  return roundToOneDecimal(adjusted);
};

export const toPaisa = (amount: number): number => Math.round(amount * 100);

export const calculateAmountPaisa = (netWeightKg: number, ratePerQuintal: number): number => {
  const amount = (netWeightKg / 100) * ratePerQuintal;
  return toPaisa(amount);
};

export const buildMarathiSmsSlip = (purchase: {
  farmerName: string;
  cropName: string;
  memberId: string;
  grossKg: number;
  tareKg: number;
  moisturePct: number;
  netKg: number;
  ratePerQuintal: number;
  amountPaise: number;
  centreCode: string;
}): string => {
  const amountInRupees = (purchase.amountPaise / 100).toFixed(2);
  return `रसीद ${purchase.memberId} | शेतकरी: ${purchase.farmerName} | ${purchase.cropName} | सकल वजन: ${purchase.grossKg.toFixed(1)} किलो | कच्चा वजन: ${purchase.tareKg.toFixed(1)} किलो | ओलावा: ${purchase.moisturePct.toFixed(1)}% | शुद्ध वजन: ${purchase.netKg.toFixed(1)} किलो | दर: ₹${purchase.ratePerQuintal}/क्विंटल | रक्कम: ₹${amountInRupees} | केंद्र: ${purchase.centreCode}`;
};
