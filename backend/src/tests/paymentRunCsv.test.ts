import { describe, expect, it } from 'vitest';
import { generatePaymentRunCsv } from '../services/paymentRunCsv.js';

describe('payment run CSV', () => {
  it('uses the bank upload columns and preserves integer paise amounts', () => {
    const csv = generatePaymentRunCsv([
      {
        id: 'purchase-1',
        amountPaise: 5_975_200,
        farmer: {
          name: 'Sunil Jadhav',
          bankAccount: '123456789012',
          bankIfsc: 'SBIN0001234',
        },
      },
    ]);

    expect(csv).toBe(
      'sequence_no,beneficiary_name,account_number,ifsc,amount_in_paise,payment_reference,purpose_code\r\n' +
        '1,"Sunil Jadhav","123456789012","SBIN0001234",5975200,"PROC-purchase-1",AGRI_PROCUREMENT\r\n',
    );
    const [row] = csv.split('\r\n').slice(1);
    expect(row?.split(',')[4]).toBe('5975200');
  });

  it('escapes CSV quotes and rejects unsafe amounts', () => {
    const purchase = {
      id: 'purchase-2',
      amountPaise: 100,
      farmer: {
        name: 'Kamal "K" Pawar',
        bankAccount: '123',
        bankIfsc: 'IFSC0001',
      },
    };

    expect(generatePaymentRunCsv([purchase])).toContain('"Kamal ""K"" Pawar"');
    expect(() => generatePaymentRunCsv([{ ...purchase, amountPaise: Number.NaN }])).toThrow(
      RangeError,
    );
  });
});
