import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { authRouter } from './routes/auth.js';
import { farmersRouter } from './routes/farmers.js';
import { priceBoardRouter } from './routes/priceBoard.js';
import { purchasesRouter } from './routes/purchases.js';
import { ocrRouter } from './routes/ocr.js';
import { syncRouter } from './routes/sync.js';
import { dashboardRouter } from './routes/dashboard.js';
import { paymentRunsRouter } from './routes/paymentRuns.js';
import { smsRouter } from './routes/sms.js';

const app = express();
const port = env.PORT;

app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/farmers', farmersRouter);
app.use('/api/v1/price-board', priceBoardRouter);
app.use('/api/v1/purchases', purchasesRouter);
app.use('/api/v1/ocr', ocrRouter);
app.use('/api/v1/sync', syncRouter);
app.use('/api/v1', dashboardRouter);
app.use('/api/v1/payment-runs', paymentRunsRouter);
app.use('/api/v1/sms', smsRouter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

if (env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`Backend listening on http://localhost:${port}`);
  });
}

export { app };
