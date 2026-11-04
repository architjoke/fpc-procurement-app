import { buildMarathiSmsSlip } from '../utils/calculations.js';

export interface SmsSlipInput {
  purchaseId: string;
  slipNo: string;
  status: string;
  farmerName: string;
  cropName: string;
  grossKg: number;
  tareKg: number;
  moisturePct: number;
  netKg: number;
  ratePerQuintal: number;
  amountPaise: number;
  centreCode: string;
}

export interface SmsOutboxEntry {
  purchaseId: string;
  phone: string;
  messageMarathi: string;
  status: 'SENT';
  sentAt: Date;
}

export interface SmsOutboxStore {
  upsertSmsOutbox: (entry: SmsOutboxEntry) => Promise<unknown>;
}

export const generateAndStoreSmsSlip = async (
  purchase: SmsSlipInput,
  store: SmsOutboxStore,
): Promise<string | null> => {
  if (purchase.status !== 'APPROVED' && purchase.status !== 'SYNCED') {
    return null;
  }

  const messageMarathi = buildMarathiSmsSlip({
    slipNo: purchase.slipNo,
    farmerName: purchase.farmerName,
    cropName: purchase.cropName,
    grossKg: purchase.grossKg,
    tareKg: purchase.tareKg,
    moisturePct: purchase.moisturePct,
    netKg: purchase.netKg,
    ratePerQuintal: purchase.ratePerQuintal,
    amountPaise: purchase.amountPaise,
    centreCode: purchase.centreCode,
  });

  await store.upsertSmsOutbox({
    purchaseId: purchase.purchaseId,
    phone: '0000000000',
    messageMarathi,
    status: 'SENT',
    sentAt: new Date(),
  });
  return messageMarathi;
};
