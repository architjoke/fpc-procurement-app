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
    count: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  ocrJob: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  smsOutbox: { create: vi.fn(), upsert: vi.fn(), findUnique: vi.fn() },
  auditTrail: { create: vi.fn(), findFirst: vi.fn() },
  syncLog: { create: vi.fn() },
  paymentRun: {
    count: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  paymentRunItem: { create: vi.fn() },
  centre: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock('../config/database.js', () => ({
  prisma: mockedPrisma,
}));

const { app } = await import('../server.js');

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JWT_SECRET = 'test-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  process.env.OCR_PROVIDER = 'mock';
  process.env.OCR_MOCK_TEXT = '';
  process.env.OCR_MOCK_CONFIDENCE = '0';
  process.env.OCR_MOCK_FAIL = 'false';
  mockedPrisma.$transaction.mockImplementation((callback) => callback(mockedPrisma));
  mockedPrisma.purchase.findMany.mockResolvedValue([]);
  mockedPrisma.smsOutbox.upsert.mockResolvedValue({ id: 'sms-1' });
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

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
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
      .set(authHeaders(token))
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

    const response = await request(app).get('/api/v1/price-board').set(authHeaders(token));

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

    const response = await request(app).post('/api/v1/price-board').set(authHeaders(token)).send({
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
      .set(authHeaders(token))
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

    const response = await request(app).post('/api/v1/price-board').set(authHeaders(token)).send({
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
      .set(authHeaders(token))
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
      .set(authHeaders(operatorToken))
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
      .set(authHeaders(token))
      .send({});
    expect(empty.status).toBe(400);

    const unknownField = await request(app)
      .put('/api/v1/price-board/price-1')
      .set(authHeaders(token))
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

    const response = await request(app).get('/api/v1/farmers').set(authHeaders(token));

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
      .set(authHeaders(token));

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

    const response = await request(app).post('/api/v1/farmers').set(authHeaders(token)).send({
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
      .set(authHeaders(token))
      .send({ ...body, landAcres: 0 });
    expect(invalid.status).toBe(400);

    const crossCentre = await request(app)
      .post('/api/v1/farmers')
      .set(authHeaders(token))
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
      .set(authHeaders(token))
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

  it('syncs a signed offline purchase as APPROVED for payment eligibility', async () => {
    const token = createOperatorToken();
    const item = createSyncItem();
    mockSyncDeviceSession();
    mockedPrisma.syncNonce.deleteMany.mockResolvedValue({ count: 0 });
    mockedPrisma.syncNonce.findUnique.mockResolvedValue(null);
    mockedPrisma.syncNonce.create.mockResolvedValue({ id: 'nonce-1' });
    mockedPrisma.deviceSession.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.farmer.findFirst.mockResolvedValue({
      id: 'farmer-1',
      name: 'Sunil Jadhav',
      centreId: 'centre-1',
      landAcres: 2,
      centre: { code: 'C07' },
    });
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
      expect.objectContaining({
        uuid: item.uuid,
        status: 'SYNCED',
        purchase_status: 'APPROVED',
        purchase_id: 'purchase-sync-1',
      }),
    ]);
    expect(mockedPrisma.purchase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          uuid: item.uuid,
          rate: 4850,
          netKg: 490,
          amountPaise: 2376500,
          status: 'APPROVED',
        }),
      }),
    );
    expect(mockedPrisma.syncLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ purchaseUuid: item.uuid, status: 'ACCEPTED' }),
      }),
    );
    expect(mockedPrisma.smsOutbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { purchaseId: 'purchase-sync-1' },
        create: expect.objectContaining({
          purchaseId: 'purchase-sync-1',
          status: 'SENT',
          messageMarathi: expect.stringContaining('रसीद'),
        }),
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
    mockedPrisma.farmer.findFirst.mockResolvedValue({
      id: 'farmer-1',
      name: 'Sunil Jadhav',
      centreId: 'centre-1',
      landAcres: 2,
      centre: { code: 'C07' },
    });
    mockedPrisma.crop.findUnique.mockResolvedValue({ id: 'soybean', name: 'Soybean' });
    mockedPrisma.priceBoard.findFirst.mockResolvedValue({ ratePerQuintal: 4900 });
    mockedPrisma.purchase.findMany
      .mockResolvedValueOnce([
        { farmerId: 'farmer-1', createdAt: new Date(), centreId: 'centre-1' },
      ])
      .mockResolvedValueOnce([]);
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
    expect(mockedPrisma.smsOutbox.upsert).not.toHaveBeenCalled();
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

    const response = await request(app).post('/api/v1/purchases').set(authHeaders(token)).send({
      farmerId: 'farmer-1',
      cropId: 'crop-1',
      grade: 'A',
      grossKg: 1250,
      tareKg: 18,
      moisturePct: 11.5,
      ocrWeight: 1200,
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('OCR_MISMATCH');
    expect(response.body.message).toContain('reconcile');
  });

  it('checks typed values against stored OCR readings even when the client omits the prefill', async () => {
    const token = createOperatorToken();
    mockedPrisma.ocrJob.findFirst.mockResolvedValue({
      id: 'ocr-job-1',
      parsedWeight: 1250,
      parsedMoisture: 11.5,
      confidence: 0.91,
      imageUrl: 'sha256:abc123',
    });

    const response = await request(app).post('/api/v1/purchases').set(syncHeaders(token)).send({
      farmerId: 'farmer-1',
      cropId: 'crop-1',
      grade: 'A',
      grossKg: 1200,
      tareKg: 18,
      moisturePct: 11.5,
      ocrJobId: 'ocr-job-1',
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('OCR_MISMATCH');
    expect(mockedPrisma.purchase.create).not.toHaveBeenCalled();
  });

  it('creates a purchase with confidence and photo reference from its OCR job', async () => {
    const token = createOperatorToken();
    const job = {
      id: 'ocr-job-1',
      operatorId: 'operator-1',
      status: 'COMPLETED',
      parsedWeight: 1250,
      parsedMoisture: 11.5,
      confidence: 0.91,
      imageUrl: 'sha256:abc123',
    };
    mockedPrisma.ocrJob.findFirst.mockResolvedValue(job);
    mockedPrisma.ocrJob.update.mockResolvedValue({ ...job, purchaseId: 'purchase-ocr-1' });
    mockedPrisma.farmer.findFirst.mockResolvedValue({
      id: 'farmer-1',
      memberId: 'F-1001',
      name: 'Sunil Jadhav',
      centreId: 'centre-1',
      centre: { code: 'C07' },
      landAcres: 3,
    });
    mockedPrisma.crop.findUnique.mockResolvedValue({ id: 'crop-1', name: 'Soybean', unit: 'kg' });
    mockedPrisma.priceBoard.findFirst.mockResolvedValue({ ratePerQuintal: 4850 });
    mockedPrisma.purchase.findMany.mockResolvedValue([]);
    mockedPrisma.purchase.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'purchase-ocr-1', ...data }),
    );
    const response = await request(app).post('/api/v1/purchases').set(syncHeaders(token)).send({
      farmerId: 'farmer-1',
      cropId: 'crop-1',
      grade: 'A',
      grossKg: 1240,
      tareKg: 18,
      moisturePct: 11.5,
      ocrJobId: job.id,
      ocrWeight: 1250,
      ocrMoisture: 11.5,
      ocrWeightReconciled: true,
    });

    expect(response.status).toBe(201);
    expect(mockedPrisma.purchase.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ocrConfidence: 0.91,
          photoUrl: 'sha256:abc123',
        }),
      }),
    );
    expect(mockedPrisma.ocrJob.update).toHaveBeenCalledWith({
      where: { id: job.id },
      data: { purchaseId: 'purchase-ocr-1' },
    });
  });

  it('does not self-flag new online purchases and preserves exact seed-row calculations', async () => {
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
        .set(authHeaders(token))
        .send({ ...purchaseInput, grade: 'A' });

      expect(response.status).toBe(201);
      expect(response.body.data.netKg).toBe(example.netKg);
      expect(response.body.data.amountPaise).toBe(example.amountPaise);
      expect(response.body.data.status).toBe('APPROVED');
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
    expect(mockedPrisma.smsOutbox.upsert).toHaveBeenCalledTimes(3);
    expect(mockedPrisma.smsOutbox.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          purchaseId: 'purchase-sunil',
          status: 'SENT',
          messageMarathi: expect.stringContaining('रसीद'),
        }),
      }),
    );
  });

  it('returns the stored Marathi slip and does not invent slips for flagged purchases', async () => {
    const token = createOperatorToken();
    const message = 'रसीद purchase-1 | शेतकरी: Sunil Jadhav';
    mockedPrisma.purchase.findFirst.mockResolvedValueOnce({
      id: 'purchase-1',
      status: 'SYNCED',
    });
    mockedPrisma.smsOutbox.findUnique.mockResolvedValueOnce({
      messageMarathi: message,
      status: 'SENT',
    });

    const preview = await request(app).get('/api/v1/sms/purchase-1').set(authHeaders(token));

    expect(preview.status).toBe(200);
    expect(preview.body.data).toEqual({ messageMarathi: message, status: 'SENT' });
    expect(mockedPrisma.smsOutbox.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { purchaseId: 'purchase-1' } }),
    );

    mockedPrisma.purchase.findFirst.mockResolvedValueOnce({
      id: 'purchase-flagged',
      status: 'FLAGGED',
    });
    mockedPrisma.smsOutbox.findUnique.mockResolvedValueOnce(null);

    const flagged = await request(app).get('/api/v1/sms/purchase-flagged').set(authHeaders(token));

    expect(flagged.status).toBe(409);
    expect(flagged.body.message).toContain('flagged purchase');
    expect(flagged.body.data).toBeUndefined();
  });

  it('flags online purchases over the configured yield cap and records the reason', async () => {
    const token = createOperatorToken();
    mockedPrisma.farmer.findFirst.mockResolvedValue({
      id: 'farmer-large',
      memberId: 'F-2001',
      name: 'Kisan Patil',
      landAcres: 1,
      centreId: 'centre-1',
      centre: { code: 'C07' },
    });
    mockedPrisma.crop.findUnique.mockResolvedValue({ id: 'soybean', name: 'Soybean' });
    mockedPrisma.priceBoard.findFirst.mockResolvedValue({ ratePerQuintal: 4850 });
    mockedPrisma.purchase.findMany.mockResolvedValue([]);
    mockedPrisma.purchase.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'purchase-over-cap', ...data }),
    );
    mockedPrisma.auditTrail.create.mockResolvedValue({ id: 'audit-flag' });

    const response = await request(app).post('/api/v1/purchases').set(syncHeaders(token)).send({
      farmerId: 'farmer-large',
      cropId: 'soybean',
      grade: 'A',
      grossKg: 1500.1,
      tareKg: 0,
      moisturePct: 10,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('FLAGGED');
    expect(response.body.flagReason).toContain('YIELD_CAP');
    expect(mockedPrisma.purchase.update).not.toHaveBeenCalled();
    expect(mockedPrisma.auditTrail.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'flagged_purchase',
          after: expect.stringContaining('soybean yield cap'),
        }),
      }),
    );
    expect(mockedPrisma.smsOutbox.upsert).not.toHaveBeenCalled();
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

    const response = await request(app).post('/api/v1/purchases').set(authHeaders(token)).send({
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
      .set(authHeaders(token))
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

    const withoutPrice = await request(app).post('/api/v1/purchases').set(authHeaders(token)).send({
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

    const response = await request(app).post('/api/v1/purchases').set(authHeaders(token)).send({
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
      status: 'FLAGGED',
    });
    mockedPrisma.auditTrail.create.mockResolvedValue({ id: 'audit-1' });

    const response = await request(app).post('/api/v1/purchases').set(authHeaders(token)).send({
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
    expect(mockedPrisma.purchase.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FLAGGED' }) }),
    );
    expect(mockedPrisma.auditTrail.create).toHaveBeenCalled();
    expect(mockedPrisma.smsOutbox.upsert).not.toHaveBeenCalled();
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

    const response = await request(app).post('/api/v1/purchases').set(authHeaders(token)).send({
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
      .set(authHeaders(token))
      .send({ action: 'approve', reason: 'Verified by manager.' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('APPROVED');
    expect(mockedPrisma.auditTrail.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'purchase_approve',
          after: JSON.stringify({ status: 'APPROVED', reason: 'Verified by manager.' }),
        }),
      }),
    );
  });

  it('rejects a flagged purchase with the manager reason and blocks operators', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    const operatorToken = createOperatorToken();
    mockedPrisma.purchase.findUnique.mockResolvedValue({
      id: 'purchase-flagged',
      status: 'FLAGGED',
      flagReason: 'YIELD_CAP',
    });
    mockedPrisma.purchase.update.mockResolvedValue({
      id: 'purchase-flagged',
      status: 'REJECTED',
    });
    mockedPrisma.auditTrail.create.mockResolvedValue({ id: 'audit-reject' });

    const rejected = await request(app)
      .patch('/api/v1/purchases/purchase-flagged/review')
      .set(syncHeaders(managerToken))
      .send({ action: 'reject', reason: 'Verified duplicate transaction.' });
    expect(rejected.status).toBe(200);
    expect(rejected.body.data.status).toBe('REJECTED');
    expect(mockedPrisma.auditTrail.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'purchase_reject',
          after: JSON.stringify({ status: 'REJECTED', reason: 'Verified duplicate transaction.' }),
        }),
      }),
    );

    const blocked = await request(app)
      .patch('/api/v1/purchases/purchase-flagged/review')
      .set(syncHeaders(operatorToken))
      .send({ action: 'approve', reason: 'Not allowed.' });
    expect(blocked.status).toBe(403);
  });

  it('lists flagged purchases for managers with pagination and blocks operators', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    const operatorToken = createOperatorToken();
    mockedPrisma.purchase.findMany.mockResolvedValue([{ id: 'flagged-1', status: 'FLAGGED' }]);
    mockedPrisma.purchase.count.mockResolvedValue(1);

    const response = await request(app)
      .get('/api/v1/purchases?status=FLAGGED&page=1&pageSize=10')
      .set(syncHeaders(managerToken));
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.pagination).toEqual({ page: 1, pageSize: 10, total: 1, pages: 1 });
    expect(mockedPrisma.purchase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'FLAGGED' }, skip: 0, take: 10 }),
    );

    const blocked = await request(app)
      .get('/api/v1/purchases?status=FLAGGED')
      .set(syncHeaders(operatorToken));
    expect(blocked.status).toBe(403);
  });

  it('requires a non-empty reason when reviewing flagged purchases', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    const response = await request(app)
      .patch('/api/v1/purchases/purchase-flagged/review')
      .set(syncHeaders(managerToken))
      .send({ action: 'reject', reason: '  ' });
    expect(response.status).toBe(400);
  });

  it('excludes flagged purchases from payment-run eligibility', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    mockedPrisma.purchase.findMany.mockResolvedValue([
      { id: 'purchase-flagged', status: 'FLAGGED', amountPaise: 10000 },
    ]);

    const response = await request(app)
      .post('/api/v1/payment-runs')
      .set(authHeaders(managerToken))
      .send({ purchase_ids: ['purchase-flagged'] });

    expect(response.status).toBe(400);
    expect(response.body.ineligiblePurchaseIds).toEqual(['purchase-flagged']);
    expect(mockedPrisma.paymentRun.create).not.toHaveBeenCalled();
  });

  it('creates a draft payment run with approved line items and exact paise total', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    mockedPrisma.purchase.findMany.mockResolvedValue([
      { id: 'purchase-1', status: 'APPROVED', amountPaise: 10001, paymentRunItems: [] },
      { id: 'purchase-2', status: 'APPROVED', amountPaise: 20002, paymentRunItems: [] },
    ]);
    mockedPrisma.paymentRun.create.mockImplementation(({ data }) =>
      Promise.resolve({ id: 'run-1', ...data, paymentItems: data.paymentItems.create }),
    );

    const response = await request(app)
      .post('/api/v1/payment-runs')
      .set(authHeaders(managerToken))
      .send({ purchase_ids: ['purchase-1', 'purchase-2'] });

    expect(response.status).toBe(201);
    expect(response.body.data.totalAmountPaise).toBe(30003);
    expect(mockedPrisma.paymentRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DRAFT',
          totalAmountPaise: 30003,
          paymentItems: {
            create: [
              { purchase: { connect: { id: 'purchase-1' } }, status: 'APPROVED' },
              { purchase: { connect: { id: 'purchase-2' } }, status: 'APPROVED' },
            ],
          },
        }),
      }),
    );
  });

  it('rejects mixed-status and missing purchases with an ineligible ID list', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    mockedPrisma.purchase.findMany.mockResolvedValue([
      { id: 'purchase-flagged', status: 'FLAGGED', amountPaise: 10000, paymentRunItems: [] },
    ]);

    const response = await request(app)
      .post('/api/v1/payment-runs')
      .set(authHeaders(managerToken))
      .send({ purchase_ids: ['purchase-flagged', 'purchase-missing'] });

    expect(response.status).toBe(400);
    expect(response.body.ineligiblePurchaseIds).toEqual(['purchase-flagged', 'purchase-missing']);
    expect(mockedPrisma.paymentRun.create).not.toHaveBeenCalled();
  });

  it('does not include purchases already assigned to another run', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    mockedPrisma.purchase.findMany.mockResolvedValue([
      {
        id: 'purchase-in-run',
        status: 'APPROVED',
        amountPaise: 10000,
        paymentRunItems: [{ id: 'existing-item' }],
      },
    ]);

    const response = await request(app)
      .post('/api/v1/payment-runs')
      .set(authHeaders(managerToken))
      .send({ purchase_ids: ['purchase-in-run'] });

    expect(response.status).toBe(400);
    expect(response.body.ineligiblePurchaseIds).toEqual(['purchase-in-run']);
    expect(mockedPrisma.paymentRun.create).not.toHaveBeenCalled();
  });

  it('lists payment runs with status filtering and pagination', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    mockedPrisma.paymentRun.findMany.mockResolvedValue([{ id: 'run-1', status: 'APPROVED' }]);
    mockedPrisma.paymentRun.count.mockResolvedValue(5);

    const response = await request(app)
      .get('/api/v1/payment-runs?status=APPROVED&page=2&pageSize=2')
      .set(authHeaders(managerToken));

    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({ page: 2, pageSize: 2, total: 5, pages: 3 });
    expect(mockedPrisma.paymentRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'APPROVED' }, skip: 2, take: 2 }),
    );
  });

  it('returns payment run line items with farmer and crop details', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    mockedPrisma.paymentRun.findUnique.mockResolvedValue({
      id: 'run-1',
      status: 'APPROVED',
      paymentItems: [
        {
          id: 'item-1',
          status: 'APPROVED',
          purchase: {
            id: 'purchase-1',
            status: 'PAID',
            farmer: { memberId: 'F-1001', name: 'Sunil Jadhav' },
            crop: { name: 'Soybean' },
          },
        },
      ],
    });

    const response = await request(app)
      .get('/api/v1/payment-runs/run-1')
      .set(authHeaders(managerToken));

    expect(response.status).toBe(200);
    expect(response.body.data.paymentItems[0]).toEqual(
      expect.objectContaining({
        status: 'APPROVED',
        purchase: expect.objectContaining({
          status: 'PAID',
          farmer: expect.objectContaining({ name: 'Sunil Jadhav' }),
          crop: expect.objectContaining({ name: 'Soybean' }),
        }),
      }),
    );
  });

  it('approves draft payment runs and writes an audit entry', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    mockedPrisma.paymentRun.findUnique
      .mockResolvedValueOnce({ id: 'run-1', status: 'DRAFT' })
      .mockResolvedValueOnce({ id: 'run-1', status: 'APPROVED' });
    mockedPrisma.paymentRun.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.auditTrail.create.mockResolvedValue({ id: 'audit-run-1' });

    const response = await request(app)
      .patch('/api/v1/payment-runs/run-1/approve')
      .set(authHeaders(managerToken));

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('APPROVED');
    expect(mockedPrisma.auditTrail.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'payment_run_approve',
          entityId: 'run-1',
        }),
      }),
    );
  });

  it('exports approved runs as downloadable CSV and marks purchases paid', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    mockedPrisma.paymentRun.findUnique.mockResolvedValue({
      id: 'run-1',
      status: 'APPROVED',
      paymentItems: [
        {
          purchaseId: 'purchase-1',
          purchase: {
            id: 'purchase-1',
            amountPaise: 5975200,
            farmer: {
              name: 'Sunil Jadhav',
              bankAccount: '123456789012',
              bankIfsc: 'SBIN0001234',
            },
          },
        },
      ],
    });
    mockedPrisma.purchase.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.paymentRun.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.auditTrail.create.mockResolvedValue({ id: 'audit-export-1' });

    const response = await request(app)
      .get('/api/v1/payment-runs/run-1/export')
      .set(authHeaders(managerToken));

    expect(response.status).toBe(200);
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="payment-run-run-1.csv"',
    );
    expect(response.text).toBe(
      'sequence_no,beneficiary_name,account_number,ifsc,amount_in_paise,payment_reference,purpose_code\r\n' +
        '1,"Sunil Jadhav","123456789012","SBIN0001234",5975200,"PROC-purchase-1",AGRI_PROCUREMENT\r\n',
    );
    expect(mockedPrisma.purchase.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['purchase-1'] }, status: 'APPROVED' },
      data: { status: 'PAID' },
    });
    expect(mockedPrisma.paymentRun.updateMany).toHaveBeenCalledWith({
      where: { id: 'run-1', status: 'APPROVED' },
      data: { status: 'EXPORTED' },
    });
  });

  it('does not export a draft payment run', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    mockedPrisma.paymentRun.findUnique.mockResolvedValue({
      id: 'run-1',
      status: 'DRAFT',
      paymentItems: [],
    });

    const response = await request(app)
      .get('/api/v1/payment-runs/run-1/export')
      .set(authHeaders(managerToken));

    expect(response.status).toBe(409);
    expect(mockedPrisma.purchase.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.paymentRun.updateMany).not.toHaveBeenCalled();
  });

  it('blocks re-export of an already exported payment run', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    mockedPrisma.paymentRun.findUnique.mockResolvedValue({
      id: 'run-1',
      status: 'EXPORTED',
      paymentItems: [
        {
          purchaseId: 'purchase-1',
          purchase: {
            id: 'purchase-1',
            amountPaise: 5975200,
            farmer: {
              name: 'Sunil Jadhav',
              bankAccount: '123456789012',
              bankIfsc: 'SBIN0001234',
            },
          },
        },
      ],
    });

    const response = await request(app)
      .get('/api/v1/payment-runs/run-1/export')
      .set(authHeaders(managerToken));

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('Payment run already exported.');
    expect(mockedPrisma.purchase.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.paymentRun.updateMany).not.toHaveBeenCalled();
  });

  it('creates, approves, and exports a run end to end', async () => {
    const managerToken = jwt.sign(
      { sub: 'mgr-1', email: 'manager@demo.in', role: 'office_manager', type: 'access' },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    const headers = authHeaders(managerToken);
    const purchase = {
      id: 'purchase-e2e',
      status: 'APPROVED',
      amountPaise: 4030350,
      paymentRunItems: [],
    };
    mockedPrisma.purchase.findMany.mockResolvedValue([purchase]);
    mockedPrisma.paymentRun.create.mockResolvedValue({
      id: 'run-e2e',
      status: 'DRAFT',
      totalAmountPaise: purchase.amountPaise,
      paymentItems: [{ purchaseId: purchase.id, status: 'APPROVED' }],
    });

    const created = await request(app)
      .post('/api/v1/payment-runs')
      .set(headers)
      .send({ purchase_ids: [purchase.id] });
    expect(created.status).toBe(201);
    expect(created.body.data.totalAmountPaise).toBe(4030350);

    mockedPrisma.paymentRun.findUnique
      .mockResolvedValueOnce({ id: 'run-e2e', status: 'DRAFT' })
      .mockResolvedValueOnce({ id: 'run-e2e', status: 'APPROVED' })
      .mockResolvedValueOnce({
        id: 'run-e2e',
        status: 'APPROVED',
        paymentItems: [
          {
            purchaseId: purchase.id,
            purchase: {
              id: purchase.id,
              amountPaise: purchase.amountPaise,
              farmer: {
                name: 'Kamal Pawar',
                bankAccount: '9876543210',
                bankIfsc: 'SBIN0004321',
              },
            },
          },
        ],
      });
    mockedPrisma.paymentRun.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.purchase.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.auditTrail.create.mockResolvedValue({ id: 'audit-e2e' });

    const approved = await request(app).patch('/api/v1/payment-runs/run-e2e/approve').set(headers);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');

    const exported = await request(app).get('/api/v1/payment-runs/run-e2e/export').set(headers);
    expect(exported.status).toBe(200);
    expect(exported.text).toContain('"Kamal Pawar","9876543210","SBIN0004321",4030350');
    expect(mockedPrisma.purchase.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'PAID' } }),
    );
    expect(mockedPrisma.paymentRun.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'EXPORTED' } }),
    );
  });

  it('blocks operators from every payment-run endpoint', async () => {
    const operatorToken = createOperatorToken();
    const headers = authHeaders(operatorToken);
    const responses = await Promise.all([
      request(app)
        .post('/api/v1/payment-runs')
        .set(headers)
        .send({ purchase_ids: ['p1'] }),
      request(app).get('/api/v1/payment-runs').set(headers),
      request(app).get('/api/v1/payment-runs/run-1').set(headers),
      request(app).patch('/api/v1/payment-runs/run-1/approve').set(headers),
      request(app).get('/api/v1/payment-runs/run-1/export').set(headers),
    ]);

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
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

    mockedPrisma.ocrJob.create.mockResolvedValue({ id: 'ocr-failed-1' });
    const response = await request(app)
      .post('/api/v1/ocr/parse')
      .set(authHeaders(token))
      .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        filename: 'test.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('OCR_UNREADABLE');
    expect(response.body.message).toContain('enter manually');
  });

  it('parses image text, persists a completed job, and returns parsed readings', async () => {
    const token = createOperatorToken();
    process.env.OCR_MOCK_TEXT = 'Gross weight: 1250 kg\nMoisture: 12,5%';
    process.env.OCR_MOCK_CONFIDENCE = '0.91';
    mockedPrisma.ocrJob.create.mockResolvedValue({ id: 'ocr-job-success' });

    const response = await request(app)
      .post('/api/v1/ocr/parse')
      .set(syncHeaders(token))
      .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        filename: 'test.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      jobId: 'ocr-job-success',
      parsedWeight: 1250,
      parsedMoisture: 12.5,
      confidence: 0.91,
    });
    expect(mockedPrisma.ocrJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operatorId: 'operator-1',
          rawOcrText: 'Gross weight: 1250 kg\nMoisture: 12,5%',
          status: 'COMPLETED',
        }),
      }),
    );
  });

  it('returns a graceful OCR_UNAVAILABLE response when the provider throws', async () => {
    const token = createOperatorToken();
    process.env.OCR_MOCK_FAIL = 'true';
    mockedPrisma.ocrJob.create.mockResolvedValue({ id: 'ocr-provider-failed' });

    const response = await request(app)
      .post('/api/v1/ocr/parse')
      .set(syncHeaders(token))
      .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
        filename: 'test.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('OCR_UNAVAILABLE');
    expect(response.body.data.jobId).toBe('ocr-provider-failed');
    expect(mockedPrisma.ocrJob.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it('rejects uploads over 1 MB and non-image content', async () => {
    const token = createOperatorToken();
    const tooLarge = await request(app)
      .post('/api/v1/ocr/parse')
      .set(syncHeaders(token))
      .attach('image', Buffer.alloc(1024 * 1024 + 1, 0), {
        filename: 'large.png',
        contentType: 'image/png',
      });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body.code).toBe('OCR_IMAGE_TOO_LARGE');

    const invalid = await request(app)
      .post('/api/v1/ocr/parse')
      .set(syncHeaders(token))
      .attach('image', Buffer.from('not an image'), {
        filename: 'not-image.txt',
        contentType: 'text/plain',
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('OCR_INVALID_UPLOAD');
  });
});
