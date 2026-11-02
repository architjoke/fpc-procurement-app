import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { hashSync } from 'bcryptjs';

process.env.NODE_ENV = 'test';

const mockedPrisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  farmer: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  crop: { findUnique: vi.fn() },
  purchase: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  smsOutbox: { create: vi.fn() },
  auditTrail: { create: vi.fn(), findFirst: vi.fn() },
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
    const accessPayload = jwt.decode(response.body.accessToken) as jwt.JwtPayload;
    expect(accessPayload.exp! - accessPayload.iat!).toBe(15 * 60);
    const refreshPayload = jwt.decode(response.body.refreshToken) as jwt.JwtPayload;
    expect(refreshPayload.exp! - refreshPayload.iat!).toBe(7 * 24 * 60 * 60);
    expect(refreshPayload.type).toBe('refresh');
  });

  it('rejects invalid credentials', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'operator@demo.in',
      passwordHash: hashSync('demo123', 10),
      role: 'centre_operator',
      centreId: 'centre-1',
    });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'operator@demo.in', password: 'wrong-password' });

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid email or password.');
  });

  it('revokes refresh tokens on logout', async () => {
    const user = {
      id: 'user-1',
      email: 'operator@demo.in',
      passwordHash: hashSync('demo123', 10),
      role: 'centre_operator',
      centreId: 'centre-1',
    };
    const refreshToken = jwt.sign(
      { sub: user.id, type: 'refresh', jti: 'refresh-id-1' },
      process.env.JWT_REFRESH_SECRET!,
      { expiresIn: '7d' },
    );
    mockedPrisma.user.findUnique.mockResolvedValue(user);
    mockedPrisma.auditTrail.findFirst.mockResolvedValue(null);
    mockedPrisma.auditTrail.create.mockResolvedValue({ id: 'audit-1' });

    const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(refreshed.status).toBe(200);

    const logout = await request(app).post('/api/v1/auth/logout').send({ refreshToken });
    expect(logout.status).toBe(200);
    expect(mockedPrisma.auditTrail.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'refresh_token_revoked',
          entityId: 'refresh-id-1',
        }),
      }),
    );

    mockedPrisma.auditTrail.findFirst.mockResolvedValue({ id: 'audit-1' });
    const afterLogout = await request(app).post('/api/v1/auth/refresh').send({ refreshToken });
    expect(afterLogout.status).toBe(401);
  });

  it('blocks an operator from manager-only price updates', async () => {
    const token = jwt.sign(
      {
        sub: 'user-1',
        email: 'operator@demo.in',
        role: 'centre_operator',
        centreId: 'centre-1',
        type: 'access',
      },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );

    const response = await request(app)
      .post('/api/v1/price-board')
      .set('Authorization', `Bearer ${token}`)
      .send({ cropId: 'crop-1', grade: 'A', ratePerQuintal: 4850 });

    expect(response.status).toBe(403);
  });

  it('scopes an operator farmer query to their centre', async () => {
    const token = jwt.sign(
      {
        sub: 'user-1',
        email: 'operator@demo.in',
        role: 'centre_operator',
        centreId: 'centre-1',
        type: 'access',
      },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );
    mockedPrisma.farmer.findMany.mockResolvedValue([]);

    const response = await request(app)
      .get('/api/v1/farmers')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(mockedPrisma.farmer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { centreId: 'centre-1' } }),
    );
  });

  it('rate limits login attempts to five per minute per IP', async () => {
    let responseStatus = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: `unknown-${attempt}@demo.in`, password: 'wrong-password' });
      responseStatus = response.status;
    }

    expect(responseStatus).toBe(429);
  });

  it('blocks a purchase if the OCR mismatch is not reconciled', async () => {
    const token = jwt.sign(
      {
        sub: 'user-1',
        email: 'operator@demo.in',
        role: 'centre_operator',
        centreId: 'centre-1',
        type: 'access',
      },
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
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
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
      {
        sub: 'user-1',
        email: 'operator@demo.in',
        role: 'centre_operator',
        centreId: 'centre-1',
        type: 'access',
      },
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
