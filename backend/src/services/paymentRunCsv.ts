export interface PaymentRunCsvPurchase {
  id: string;
  amountPaise: number;
  farmer: {
    name: string;
    bankAccount: string;
    bankIfsc: string;
  };
}

const csvCell = (value: string): string => `"${value.replace(/"/g, '""')}"`;

export const generatePaymentRunCsv = (purchases: PaymentRunCsvPurchase[]): string => {
  const rows = [
    'sequence_no,beneficiary_name,account_number,ifsc,amount_in_paise,payment_reference,purpose_code',
    ...purchases.map((purchase, index) => {
      if (!Number.isSafeInteger(purchase.amountPaise) || purchase.amountPaise < 0) {
        throw new RangeError(`Purchase ${purchase.id} has an invalid paise amount.`);
      }

      return [
        String(index + 1),
        csvCell(purchase.farmer.name),
        csvCell(purchase.farmer.bankAccount),
        csvCell(purchase.farmer.bankIfsc),
        String(purchase.amountPaise),
        csvCell(`PROC-${purchase.id}`),
        'AGRI_PROCUREMENT',
      ].join(',');
    }),
  ];

  return `${rows.join('\r\n')}\r\n`;
};
