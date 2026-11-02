import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { hashSync } from 'bcryptjs';

process.env.NODE_ENV = 'test';

const mockedPrisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  farmer: { findUnique: vi.fn() },
  crop: { findUnique: vi.fn() },
  purchase: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  smsOutbox: { create: vi.fn() },
  auditTrail: { create: vi.fn() },
  syncLog: { create: vi.fn() },
  paymentRun: { create: vi.fn() },
  paymentRunItem: { create: vi.fn() },
  centre: { findMany: vi.fn() },
}));

vi.mock('../config/database.js', () => ({
  prisma: mockedPrisma,
}));

vi.mock('../services/ocr.js', () => ({
  OcrSpaceProvider: class {
    async parseImage() {
      return {
        weight: null,
        moisture: null,
        confidence: 0,
        rawText: 'OCR offline unavailable',
        source: 'fallback',
      };
    }
  },
}));

const { app } = await import('../server.js');

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = 'test-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
});

describe('API flows', () => {
  it('logs in a demo operator and returns tokens', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'operator@demo.in',
      passwordHash: hashSync('demo123', 10),
      role: 'centre_operator',
      centreId: 'centre-1',
    });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'operator@demo.in', password: 'demo123' });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.user.email).toBe('operator@demo.in');
  });

  it('blocks a purchase if the OCR mismatch is not reconciled', async () => {
    const token = jwt.sign(
      { sub: 'user-1', email: 'operator@demo.in', role: 'centre_operator', centreId: 'centre-1' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );

    mockedPrisma.farmer.findUnique.mockResolvedValue({
      id: 'farmer-1',
      memberId: 'F-1001',
      name: 'Sunil Jadhav',
      centreId: 'centre-1',
      centre: { code: 'C07' },
      landAcres: 3,
    });
    mockedPrisma.crop.findUnique.mockResolvedValue({ id: 'crop-1', name: 'Soybean', unit: 'kg' });
    mockedPrisma.purchase.findMany.mockResolvedValue([]);

    const response = await request(app)
      .post('/api/v1/purchases')
      .set('Authorization', `Bearer ${token}`)
      .send({
        farmerId: 'farmer-1',
        cropId: 'crop-1',
        grade: 'A',
        grossKg: 1250,
        tareKg: 18,
        moisturePct: 11.5,
        ratePerQuintal: 4850,
        ocrWeight: 1200,
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('OCR value differs');
  });

  it('approves a flagged purchase for manager review', async () => {
    const token = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );

    mockedPrisma.purchase.findUnique.mockResolvedValue({ id: 'purchase-1', status: 'FLAGGED' });
    mockedPrisma.purchase.update.mockResolvedValue({ id: 'purchase-1', status: 'APPROVED' });
    mockedPrisma.auditTrail.create.mockResolvedValue({ id: 'a1' });

    const response = await request(app)
      .patch('/api/v1/purchases/purchase-1/review')
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'approve', reason: 'Verified by manager.' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('APPROVED');
  });

  it('returns a clear OCR error path when the parser cannot read an image', async () => {
    const token = jwt.sign(
      { sub: 'user-1', email: 'operator@demo.in', role: 'centre_operator', centreId: 'centre-1' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );

    const response = await request(app)
      .post('/api/v1/ocr/parse')
      .set('Authorization', `Bearer ${token}`)
      .attach('image', Buffer.from('not-a-real-image'), {
        filename: 'test.jpg',
        contentType: 'image/jpeg',
      });

    expect(response.status).toBe(200);
    expect(response.body.message).toContain('OCR');
  });
});
