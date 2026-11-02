import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { hashSync } from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { signSyncPurchase, type SyncPurchasePayload } from '../utils/hmac.js';

process.env.NODE_ENV = 'test';

const mockedPrisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  farmer: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  crop: { findUnique: vi.fn() },
  deviceSession: { create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
  syncNonce: { deleteMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  priceBoard: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  purchase: {
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  smsOutbox: { create: vi.fn() },
  auditTrail: { create: vi.fn(), findFirst: vi.fn() },
  syncLog: { create: vi.fn() },
  paymentRun: { create: vi.fn() },
  paymentRunItem: { create: vi.fn() },
  centre: { findMany: vi.fn() },
  $transaction: vi.fn(),
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
  mockedPrisma.$transaction.mockImplementation((callback) => callback(mockedPrisma));
});

const testDeviceSecret = 'test-device-secret';
const testDeviceId = 'device-session-1';
const createSyncItem = (
  overrides: Partial<SyncPurchasePayload> = {},
): SyncPurchasePayload & { hmac_signature: string } => {
  const payload: SyncPurchasePayload = {
    uuid: 'b2784f92-04f3-466d-8dd1-5014c4a26a5e',
    farmer_id: 'farmer-1',
    centre_id: 'centre-1',
    crop_id: 'soybean',
    grade: 'A',
    gross_kg: 500,
    tare_kg: 10,
    moisture_pct: 12,
    device_timestamp: new Date().toISOString(),
    nonce: '0d61f20f-45bc-45d0-b190-4332fca73c22',
    rate_per_quintal: 4850,
    ...overrides,
  };
  return { ...payload, hmac_signature: signSyncPurchase(payload, testDeviceSecret) };
};

const syncHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  'x-device-id': testDeviceId,
  'x-device-secret': testDeviceSecret,
});

const createOperatorToken = () =>
  jwt.sign(
    {
      sub: 'operator-1',
      email: 'operator@demo.in',
      role: 'centre_operator',
      centreId: 'centre-1',
      type: 'access',
    },
    process.env.JWT_SECRET!,
    { expiresIn: '15m' },
  );

const mockSyncDeviceSession = (lastAcceptedTimestamp: Date | null = null) => {
  mockedPrisma.deviceSession.findUnique.mockResolvedValue({
    deviceId: testDeviceId,
    userId: 'operator-1',
    deviceSecretHash: createHash('sha256').update(testDeviceSecret).digest('hex'),
    lastAcceptedTimestamp,
    revokedAt: null,
  });
};

describe('API flows', () => {
  it('logs in a demo operator and returns tokens', async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'operator@demo.in',
      passwordHash: hashSync('demo123', 10),
      role: 'centre_operator',
      centreId: 'centre-1',
    });
    mockedPrisma.deviceSession.create.mockResolvedValue({ deviceId: 'device-1' });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'operator@demo.in', password: 'demo123' });

    expect(response.status).toBe(200);
    expect(response.body.accessToken).toBeTruthy();
    expect(response.body.user.email).toBe('operator@demo.in');
    expect(response.body.device.deviceId).toBeTruthy();
    expect(response.body.device.deviceSecret).toBeTruthy();
    expect(mockedPrisma.deviceSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          deviceSecretHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
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

  it('lets authenticated operators read the shared price board', async () => {
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
    mockedPrisma.priceBoard.findMany.mockResolvedValue([{ id: 'price-1', ratePerQuintal: 4850 }]);

    const response = await request(app)
      .get('/api/v1/price-board')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(mockedPrisma.priceBoard.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: expect.any(Array) }),
    );
  });

  it('creates a daily price using registry API field names', async () => {
    const token = jwt.sign(
      { sub: 'manager-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );
    mockedPrisma.crop.findUnique.mockResolvedValue({ id: 'soybean' });
    mockedPrisma.priceBoard.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'price-1', ...data }),
    );

    const response = await request(app)
      .post('/api/v1/price-board')
      .set('Authorization', `Bearer ${token}`)
      .send({
        crop_id: 'soybean',
        grade: 'A',
        rate_per_quintal: 4850,
        effective_date: '2026-11-02',
      });

    expect(response.status).toBe(201);
    expect(mockedPrisma.priceBoard.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cropId: 'soybean',
          grade: 'A',
          ratePerQuintal: 4850,
          effectiveDate: new Date('2026-11-02T00:00:00.000Z'),
          setByUserId: 'manager-1',
        }),
      }),
    );
  });

  it('rejects invalid daily price data', async () => {
    const token = jwt.sign(
      { sub: 'manager-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );

    const response = await request(app)
      .post('/api/v1/price-board')
      .set('Authorization', `Bearer ${token}`)
      .send({ crop_id: 'soybean', grade: '', rate_per_quintal: -1 });

    expect(response.status).toBe(400);
    expect(mockedPrisma.priceBoard.create).not.toHaveBeenCalled();
  });

  it('returns a conflict if a crop grade already has a price that day', async () => {
    const token = jwt.sign(
      { sub: 'manager-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );
    mockedPrisma.crop.findUnique.mockResolvedValue({ id: 'soybean' });
    mockedPrisma.priceBoard.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Duplicate daily price', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const response = await request(app)
      .post('/api/v1/price-board')
      .set('Authorization', `Bearer ${token}`)
      .send({
        crop_id: 'soybean',
        grade: 'A',
        rate_per_quintal: 4850,
        effective_date: '2026-11-02',
      });

    expect(response.status).toBe(409);
  });

  it('updates daily price fields only for managers', async () => {
    const token = jwt.sign(
      { sub: 'manager-2', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );
    mockedPrisma.priceBoard.findUnique.mockResolvedValue({ id: 'price-1' });
    mockedPrisma.priceBoard.update.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'price-1', ...data }),
    );

    const response = await request(app)
      .put('/api/v1/price-board/price-1')
      .set('Authorization', `Bearer ${token}`)
      .send({ rate_per_quintal: 4900 });

    expect(response.status).toBe(200);
    expect(mockedPrisma.priceBoard.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'price-1' },
        data: { ratePerQuintal: 4900, setByUserId: 'manager-2' },
      }),
    );

    const operatorToken = jwt.sign(
      {
        sub: 'operator-1',
        email: 'operator@demo.in',
        role: 'centre_operator',
        centreId: 'centre-1',
        type: 'access',
      },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );
    const forbidden = await request(app)
      .put('/api/v1/price-board/price-1')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({ rate_per_quintal: 4900 });
    expect(forbidden.status).toBe(403);
  });

  it('rejects empty price updates and unknown price fields', async () => {
    const token = jwt.sign(
      { sub: 'manager-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );

    const empty = await request(app)
      .put('/api/v1/price-board/price-1')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(empty.status).toBe(400);

    const unknownField = await request(app)
      .put('/api/v1/price-board/price-1')
      .set('Authorization', `Bearer ${token}`)
      .send({ unexpected: 'value' });
    expect(unknownField.status).toBe(400);
    expect(mockedPrisma.priceBoard.update).not.toHaveBeenCalled();
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

  it('does not return a farmer from another centre to an operator', async () => {
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
    mockedPrisma.farmer.findFirst.mockResolvedValue(null);

    const response = await request(app)
      .get('/api/v1/farmers/farmer-outside-centre')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(mockedPrisma.farmer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'farmer-outside-centre', centreId: 'centre-1' },
      }),
    );
  });

  it('creates a farmer for the operator centre using registry field names', async () => {
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
    mockedPrisma.farmer.create.mockResolvedValue({
      id: 'farmer-2',
      memberId: 'F-2001',
      centreId: 'centre-1',
    });

    const response = await request(app)
      .post('/api/v1/farmers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        member_id: 'F-2001',
        name: 'Sakharam Pawar',
        village: 'Ausa',
        land_acres: 2.5,
        bank_account: '123456789012',
        bank_ifsc: 'SBIN0001234',
        consent_given_at: '2026-11-02T00:00:00.000Z',
        centre_id: 'centre-1',
      });

    expect(response.status).toBe(201);
    expect(mockedPrisma.farmer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          memberId: 'F-2001',
          landAcres: 2.5,
          centreId: 'centre-1',
        }),
      }),
    );
  });

  it('rejects invalid farmer input and cross-centre creation', async () => {
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
    const body = {
      memberId: 'F-2002',
      name: 'Anand Kale',
      village: 'Latur',
      landAcres: 2,
      bankAccount: '123456789012',
      bankIfsc: 'SBIN0001234',
      centreId: 'centre-2',
    };

    const invalid = await request(app)
      .post('/api/v1/farmers')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...body, landAcres: 0 });
    expect(invalid.status).toBe(400);

    const crossCentre = await request(app)
      .post('/api/v1/farmers')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    expect(crossCentre.status).toBe(403);
    expect(mockedPrisma.farmer.create).not.toHaveBeenCalled();
  });

  it('updates farmers only within the operator centre', async () => {
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
    mockedPrisma.farmer.findFirst.mockResolvedValue({
      id: 'farmer-1',
      centreId: 'centre-1',
    });
    mockedPrisma.farmer.update.mockResolvedValue({
      id: 'farmer-1',
      name: 'Updated Farmer',
      centreId: 'centre-1',
    });

    const response = await request(app)
      .put('/api/v1/farmers/farmer-1')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Updated Farmer' });

    expect(response.status).toBe(200);
    expect(mockedPrisma.farmer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'farmer-1', centreId: 'centre-1' },
      }),
    );
    expect(mockedPrisma.farmer.update).toHaveBeenCalledWith({
      where: { id: 'farmer-1' },
      data: { name: 'Updated Farmer' },
    });
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

  it('syncs a signed offline purchase and persists it as SYNCED', async () => {
    const token = createOperatorToken();
    const item = createSyncItem();
    mockSyncDeviceSession();
    mockedPrisma.syncNonce.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.syncNonce.findUnique.mockResolvedValue(null);
    mockedPrisma.syncNonce.create.mockResolvedValue({ id: 'nonce-1' });
    mockedPrisma.deviceSession.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.farmer.findFirst.mockResolvedValue({ id: 'farmer-1', centreId: 'centre-1' });
    mockedPrisma.crop.findUnique.mockResolvedValue({ id: 'soybean', name: 'Soybean' });
    mockedPrisma.priceBoard.findFirst.mockResolvedValue({ ratePerQuintal: 4850 });
    mockedPrisma.purchase.findFirst.mockResolvedValue(null);
    mockedPrisma.purchase.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'purchase-sync-1', ...data }),
    );
    mockedPrisma.syncLog.create.mockResolvedValue({ id: 'log-1' });

    const response = await request(app)
      .post('/api/v1/sync/purchases')
      .set(syncHeaders(token))
      .send([item]);

    expect(response.status).toBe(200);
    expect(response.body.accepted).toEqual([item.uuid]);
    expect(response.body.results).toEqual([
      expect.objectContaining({ uuid: item.uuid, status: 'SYNCED', purchase_status: 'SYNCED' }),
    ]);
    expect(mockedPrisma.purchase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          uuid: item.uuid,
          rate: 4850,
          netKg: 490,
          amountPaise: 2376500,
          status: 'SYNCED',
        }),
      }),
    );
    expect(mockedPrisma.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ purchaseUuid: item.uuid, status: 'ACCEPTED' }),
      }),
    );
  });

  it('rejects a tampered signed purchase and writes a rejection log', async () => {
    const token = createOperatorToken();
    const item = { ...createSyncItem(), gross_kg: 600 };
    mockSyncDeviceSession();
    mockedPrisma.syncNonce.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.syncLog.create.mockResolvedValue({ id: 'log-1' });

    const response = await request(app)
      .post('/api/v1/sync/purchases')
      .set(syncHeaders(token))
      .send([item]);

    expect(response.status).toBe(200);
    expect(response.body.rejected[0]).toEqual(
      expect.objectContaining({ uuid: item.uuid, reason: 'Invalid purchase HMAC signature.' }),
    );
    expect(mockedPrisma.purchase.create).not.toHaveBeenCalled();
    expect(mockedPrisma.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ purchaseUuid: item.uuid, status: 'REJECTED' }),
      }),
    );
  });

  it('rejects replayed nonces and out-of-order device timestamps', async () => {
    const token = createOperatorToken();
    const item = createSyncItem({
      device_timestamp: '2026-11-02T10:00:00.000Z',
    });
    mockSyncDeviceSession(new Date('2026-11-02T10:00:00.000Z'));
    mockedPrisma.syncNonce.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.syncNonce.findUnique.mockResolvedValue({ id: 'nonce-used' });
    mockedPrisma.syncLog.create.mockResolvedValue({ id: 'log-1' });

    const outOfOrder = await request(app)
      .post('/api/v1/sync/purchases')
      .set(syncHeaders(token))
      .send([item]);
    expect(outOfOrder.body.rejected[0].reason).toContain('timestamp');

    mockSyncDeviceSession();
    mockedPrisma.syncNonce.findUnique.mockResolvedValue({ id: 'nonce-used' });
    const replay = await request(app)
      .post('/api/v1/sync/purchases')
      .set(syncHeaders(token))
      .send([item]);
    expect(replay.body.rejected[0].reason).toBe('Nonce has already been used.');
    expect(mockedPrisma.purchase.create).not.toHaveBeenCalled();
  });

  it('persists duplicate farmer and changed-price conflicts as FLAGGED purchases', async () => {
    const token = createOperatorToken();
    const item = createSyncItem();
    mockSyncDeviceSession();
    mockedPrisma.syncNonce.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.syncNonce.findUnique.mockResolvedValue(null);
    mockedPrisma.syncNonce.create.mockResolvedValue({ id: 'nonce-1' });
    mockedPrisma.deviceSession.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.farmer.findFirst.mockResolvedValue({ id: 'farmer-1', centreId: 'centre-1' });
    mockedPrisma.crop.findUnique.mockResolvedValue({ id: 'soybean', name: 'Soybean' });
    mockedPrisma.priceBoard.findFirst.mockResolvedValue({ ratePerQuintal: 4900 });
    mockedPrisma.purchase.findFirst.mockResolvedValue({ id: 'recent-purchase' });
    mockedPrisma.purchase.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'purchase-flagged', ...data }),
    );
    mockedPrisma.auditTrail.create.mockResolvedValue({ id: 'audit-1' });
    mockedPrisma.syncLog.create.mockResolvedValue({ id: 'log-1' });

    const response = await request(app)
      .post('/api/v1/sync/purchases')
      .set(syncHeaders(token))
      .send([item]);

    expect(response.status).toBe(200);
    expect(response.body.results[0]).toEqual(
      expect.objectContaining({ status: 'SYNCED', purchase_status: 'FLAGGED' }),
    );
    expect(response.body.results[0].reason).toContain('Price changed');
    expect(response.body.results[0].reason).toContain('within the last 60 minutes');
    expect(mockedPrisma.purchase.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FLAGGED' }) }),
    );
    expect(mockedPrisma.auditTrail.create).toHaveBeenCalled();
    expect(mockedPrisma.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ purchaseUuid: item.uuid, status: 'ACCEPTED' }),
      }),
    );
  });

  it('rejects sync from another device user or with a bad device secret', async () => {
    const token = createOperatorToken();
    const item = createSyncItem();
    mockSyncDeviceSession();
    mockedPrisma.deviceSession.findUnique.mockResolvedValueOnce({
      deviceId: testDeviceId,
      userId: 'someone-else',
      deviceSecretHash: createHash('sha256').update(testDeviceSecret).digest('hex'),
      lastAcceptedTimestamp: null,
      revokedAt: null,
    });
    mockedPrisma.syncLog.create.mockResolvedValue({ id: 'log-1' });

    const wrongUser = await request(app)
      .post('/api/v1/sync/purchases')
      .set(syncHeaders(token))
      .send([item]);
    expect(wrongUser.status).toBe(401);

    mockSyncDeviceSession();
    const wrongSecret = await request(app)
      .post('/api/v1/sync/purchases')
      .set({ ...syncHeaders(token), 'x-device-secret': 'incorrect-secret' })
      .send([item]);
    expect(wrongSecret.status).toBe(401);
    expect(mockedPrisma.purchase.create).not.toHaveBeenCalled();
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

    mockedPrisma.farmer.findFirst.mockResolvedValue({
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
        ocrWeight: 1200,
      });

    expect(response.status).toBe(400);
    expect(response.body.message).toContain('OCR value differs');
  });

  it('creates online purchases with exact seed-row net weights and paisa amounts', async () => {
    const token = jwt.sign(
      {
        sub: 'operator-1',
        email: 'operator@demo.in',
        role: 'centre_operator',
        centreId: 'centre-1',
        type: 'access',
      },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );
    const farmerFixtures = {
      sunil: {
        id: 'sunil',
        memberId: 'F-1001',
        name: 'Sunil Jadhav',
        landAcres: 3,
        centreId: 'centre-1',
        centre: { code: 'C07' },
      },
      kamal: {
        id: 'kamal',
        memberId: 'F-1002',
        name: 'Kamal Shinde',
        landAcres: 2.5,
        centreId: 'centre-1',
        centre: { code: 'C07' },
      },
      mohan: {
        id: 'mohan',
        memberId: 'F-1003',
        name: 'Mohan Biradar',
        landAcres: 4,
        centreId: 'centre-1',
        centre: { code: 'C07' },
      },
    };
    mockedPrisma.farmer.findFirst.mockImplementation(({ where }) =>
      Promise.resolve(farmerFixtures[where.id as keyof typeof farmerFixtures] ?? null),
    );
    mockedPrisma.crop.findUnique.mockImplementation(({ where }) =>
      Promise.resolve({
        id: where.id,
        name: where.id === 'tur' ? 'Tur' : 'Soybean',
        unit: 'kg',
      }),
    );
    mockedPrisma.priceBoard.findFirst.mockImplementation(({ where }) =>
      Promise.resolve({
        ratePerQuintal: where.cropId === 'tur' ? 7200 : 4850,
      }),
    );
    mockedPrisma.purchase.findMany.mockResolvedValue([]);
    mockedPrisma.purchase.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: `purchase-${data.farmerId}`, ...data }),
    );
    mockedPrisma.smsOutbox.create.mockResolvedValue({ id: 'sms-1' });

    const examples = [
      {
        farmerId: 'sunil',
        cropId: 'soybean',
        grossKg: 1250,
        tareKg: 18,
        moisturePct: 11.5,
        netKg: 1232,
        amountPaise: 5975200,
      },
      {
        farmerId: 'kamal',
        cropId: 'soybean',
        grossKg: 860,
        tareKg: 12,
        moisturePct: 14,
        netKg: 831,
        amountPaise: 4030350,
      },
      {
        farmerId: 'mohan',
        cropId: 'tur',
        grossKg: 640,
        tareKg: 10,
        moisturePct: 10,
        netKg: 630,
        amountPaise: 4536000,
      },
    ];

    for (const example of examples) {
      const { netKg, amountPaise, ...purchaseInput } = example;
      const response = await request(app)
        .post('/api/v1/purchases')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...purchaseInput, grade: 'A' });

      expect(response.status).toBe(201);
      expect(response.body.data.netKg).toBe(example.netKg);
      expect(response.body.data.amountPaise).toBe(example.amountPaise);
      expect(response.body.data.status).toBe('DRAFT');
    }

    expect(mockedPrisma.purchase.create).toHaveBeenCalledTimes(3);
    expect(mockedPrisma.priceBoard.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          effectiveDate: { lte: expect.any(Date) },
        }),
      }),
    );
    expect(mockedPrisma.purchase.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockedPrisma.purchase.create.mock.invocationCallOrder[0]!,
    );
    expect(mockedPrisma.smsOutbox.create).toHaveBeenCalledTimes(3);
  });

  it('rejects tare greater than gross and does not persist the purchase', async () => {
    const token = jwt.sign(
      {
        sub: 'operator-1',
        email: 'operator@demo.in',
        role: 'centre_operator',
        centreId: 'centre-1',
        type: 'access',
      },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );

    const response = await request(app)
      .post('/api/v1/purchases')
      .set('Authorization', `Bearer ${token}`)
      .send({
        farmerId: 'farmer-1',
        cropId: 'soybean',
        grade: 'A',
        grossKg: 10,
        tareKg: 11,
        moisturePct: 12,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.fieldErrors.tareKg).toContain(
      'Tare weight cannot exceed gross weight.',
    );
    expect(mockedPrisma.purchase.create).not.toHaveBeenCalled();
  });

  it('requires an active daily board price and never accepts a client rate', async () => {
    const token = jwt.sign(
      {
        sub: 'operator-1',
        email: 'operator@demo.in',
        role: 'centre_operator',
        centreId: 'centre-1',
        type: 'access',
      },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );

    const withClientRate = await request(app)
      .post('/api/v1/purchases')
      .set('Authorization', `Bearer ${token}`)
      .send({
        farmerId: 'farmer-1',
        cropId: 'soybean',
        grade: 'A',
        grossKg: 10,
        tareKg: 1,
        moisturePct: 12,
        ratePerQuintal: 999999,
      });
    expect(withClientRate.status).toBe(400);

    mockedPrisma.farmer.findFirst.mockResolvedValue({
      id: 'farmer-1',
      memberId: 'F-1001',
      name: 'Sunil Jadhav',
      centreId: 'centre-1',
      centre: { code: 'C07' },
    });
    mockedPrisma.crop.findUnique.mockResolvedValue({ id: 'soybean', name: 'Soybean' });
    mockedPrisma.priceBoard.findFirst.mockResolvedValue(null);

    const withoutPrice = await request(app)
      .post('/api/v1/purchases')
      .set('Authorization', `Bearer ${token}`)
      .send({
        farmerId: 'farmer-1',
        cropId: 'soybean',
        grade: 'A',
        grossKg: 10,
        tareKg: 1,
        moisturePct: 12,
      });
    expect(withoutPrice.status).toBe(409);
    expect(mockedPrisma.purchase.create).not.toHaveBeenCalled();
  });

  it('scopes online purchase farmer lookup to the operator centre', async () => {
    const token = jwt.sign(
      {
        sub: 'operator-1',
        email: 'operator@demo.in',
        role: 'centre_operator',
        centreId: 'centre-1',
        type: 'access',
      },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );
    mockedPrisma.farmer.findFirst.mockResolvedValue(null);

    const response = await request(app)
      .post('/api/v1/purchases')
      .set('Authorization', `Bearer ${token}`)
      .send({
        farmerId: 'outside-farmer',
        cropId: 'soybean',
        grade: 'A',
        grossKg: 10,
        tareKg: 1,
        moisturePct: 12,
      });

    expect(response.status).toBe(404);
    expect(mockedPrisma.farmer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'outside-farmer', centreId: 'centre-1' },
      }),
    );
    expect(mockedPrisma.priceBoard.findFirst).not.toHaveBeenCalled();
  });

  it('flags repeat purchases without sending the SMS slip', async () => {
    const token = jwt.sign(
      {
        sub: 'operator-1',
        email: 'operator@demo.in',
        role: 'centre_operator',
        centreId: 'centre-1',
        type: 'access',
      },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );
    mockedPrisma.farmer.findFirst.mockResolvedValue({
      id: 'farmer-1',
      memberId: 'F-1001',
      name: 'Sunil Jadhav',
      landAcres: 3,
      centreId: 'centre-1',
      centre: { code: 'C07' },
    });
    mockedPrisma.crop.findUnique.mockResolvedValue({ id: 'soybean', name: 'Soybean' });
    mockedPrisma.priceBoard.findFirst.mockResolvedValue({ ratePerQuintal: 4850 });
    mockedPrisma.purchase.findMany
      .mockResolvedValueOnce([
        {
          farmerId: 'farmer-1',
          createdAt: new Date(Date.now() - 10 * 60 * 1000),
          centreId: 'centre-1',
        },
      ])
      .mockResolvedValueOnce([]);
    mockedPrisma.purchase.create.mockResolvedValue({
      id: 'purchase-new',
      status: 'DRAFT',
    });
    mockedPrisma.purchase.update.mockResolvedValue({
      id: 'purchase-new',
      status: 'FLAGGED',
    });
    mockedPrisma.auditTrail.create.mockResolvedValue({ id: 'audit-1' });

    const response = await request(app)
      .post('/api/v1/purchases')
      .set('Authorization', `Bearer ${token}`)
      .send({
        farmerId: 'farmer-1',
        cropId: 'soybean',
        grade: 'A',
        grossKg: 500,
        tareKg: 10,
        moisturePct: 12,
      });

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('FLAGGED');
    expect(response.body.anomalies).toEqual(
      expect.arrayContaining([expect.objectContaining({ trigger: 'REPEATED_FARMER' })]),
    );
    expect(mockedPrisma.auditTrail.create).toHaveBeenCalled();
    expect(mockedPrisma.smsOutbox.create).not.toHaveBeenCalled();
  });

  it('returns an explicit server error when purchase persistence fails', async () => {
    const token = jwt.sign(
      {
        sub: 'operator-1',
        email: 'operator@demo.in',
        role: 'centre_operator',
        centreId: 'centre-1',
        type: 'access',
      },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );
    mockedPrisma.farmer.findFirst.mockRejectedValue(new Error('database unavailable'));
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await request(app)
      .post('/api/v1/purchases')
      .set('Authorization', `Bearer ${token}`)
      .send({
        farmerId: 'farmer-1',
        cropId: 'soybean',
        grade: 'A',
        grossKg: 10,
        tareKg: 1,
        moisturePct: 12,
      });

    expect(response.status).toBe(500);
    expect(response.body.message).toBe('Unable to create purchase.');
    logError.mockRestore();
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
