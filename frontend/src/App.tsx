import { useEffect, useMemo, useState } from 'react';
import { Link, Route, Routes, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { api } from './lib/api';
import { getSession, saveSession, clearSession, type AuthSession } from './lib/session';
import { useOfflineQueue } from './hooks/useOfflineQueue';
import { offlineDb } from './lib/offlineDb';

interface Farmer {
  id: string;
  memberId: string;
  name: string;
}

interface Crop {
  id: string;
  name: string;
}

interface Price {
  cropId: string;
  grade: string;
  ratePerQuintal: number;
  effectiveDate: string;
  crop: Crop;
}

interface OcrResponse {
  data: {
    jobId: string;
    parsedWeight: number | null;
    parsedMoisture: number | null;
    confidence: number;
    photoReference: string;
  };
}

interface OcrFailure {
  code?: string;
  message?: string;
}

const Home = () => (
  <main className="shell">
    <section className="card hero">
      <p className="eyebrow">Procurement and payment</p>
      <h1>Farmers Payment App</h1>
      <p>Capture purchases online or queue them securely for sync when connectivity returns.</p>
      <div className="actions">
        <Link to="/login" className="button primary">
          Open login
        </Link>
        <Link to="/purchases" className="button secondary">
          Capture purchase
        </Link>
      </div>
    </section>
  </main>
);

const Login = ({ onLogin }: { onLogin: (session: AuthSession) => void }) => {
  const [email, setEmail] = useState('operator@demo.in');
  const [password, setPassword] = useState('demo123');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const { data } = await api.post<AuthSession>('/auth/login', { email, password });
      saveSession(data);
      onLogin(data);
    } catch {
      setError('Login failed. Check your connection and credentials, then try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="shell narrow">
      <section className="card">
        <h2>Login</h2>
        <form className="stack" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button primary full-width" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
};

const PurchaseCapture = ({ session }: { session: AuthSession | null }) => {
  const { entries, error: queueError, createPurchase, flush, retry } = useOfflineQueue();
  const [farmers, setFarmers] = useState<Farmer[]>([]);
  const [prices, setPrices] = useState<Price[]>([]);
  const [farmerId, setFarmerId] = useState('');
  const [priceId, setPriceId] = useState('');
  const [grossKg, setGrossKg] = useState('');
  const [tareKg, setTareKg] = useState('');
  const [moisturePct, setMoisturePct] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [photoPreview, setPhotoPreview] = useState('');
  const [ocrJobId, setOcrJobId] = useState('');
  const [ocrWeight, setOcrWeight] = useState<number | undefined>();
  const [ocrMoisture, setOcrMoisture] = useState<number | undefined>();
  const [ocrConfidence, setOcrConfidence] = useState<number | undefined>();
  const [weightConfirmed, setWeightConfirmed] = useState(false);
  const [moistureConfirmed, setMoistureConfirmed] = useState(false);
  const [ocrMessage, setOcrMessage] = useState('');
  const [ocrLoading, setOcrLoading] = useState(false);

  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!session?.accessToken || session.user.role !== 'centre_operator') {
      return;
    }
    let active = true;
    const cacheKey = `${session.user.id}:${session.user.centreId ?? ''}`;
    setLoading(true);
    const loadReferenceData = async () => {
      const cached = await offlineDb.referenceData.get(cacheKey);
      if (active && cached) {
        setFarmers(cached.farmers);
        setPrices(cached.prices);
        setFarmerId((current) => current || cached.farmers[0]?.id || '');
        setLoading(false);
      }

      try {
        const [farmerResponse, priceResponse] = await Promise.all([
          api.get<{ data: Farmer[] }>('/farmers'),
          api.get<{ data: Price[] }>('/price-board'),
        ]);
        if (!active) return;
        const nextFarmers = farmerResponse.data.data;
        const nextPrices = priceResponse.data.data;
        await offlineDb.referenceData.put({
          key: cacheKey,
          farmers: nextFarmers,
          prices: nextPrices,
        });
        setFarmers(nextFarmers);
        setPrices(nextPrices);
        setFarmerId((current) => current || nextFarmers[0]?.id || '');
      } catch {
        if (active && !cached) {
          setError(
            'Could not load farmers and current price board. Connect once to enable offline capture.',
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    };
    void loadReferenceData().catch((loadError: unknown) => {
      console.error('Unable to load cached purchase reference data:', loadError);
      if (active) {
        setError('Could not load local or current purchase reference data.');
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [session?.accessToken, session?.user.id, session?.user.centreId, session?.user.role]);

  const activePrices = useMemo(() => {
    const unique = new Map<string, Price>();
    const today = new Date().toISOString().slice(0, 10);
    for (const price of prices) {
      if (
        price.effectiveDate.slice(0, 10) <= today &&
        !unique.has(`${price.cropId}:${price.grade}`)
      ) {
        unique.set(`${price.cropId}:${price.grade}`, price);
      }
    }
    return [...unique.values()];
  }, [prices]);
  const selectedPrice = activePrices.find((price) => `${price.cropId}:${price.grade}` === priceId);

  const handleImageSelected = async (file?: File) => {
    if (!file) return;
    setError('');
    setNotice('');
    setOcrMessage('');
    setOcrJobId('');
    setOcrWeight(undefined);
    setOcrMoisture(undefined);
    setOcrConfidence(undefined);
    setWeightConfirmed(false);
    setMoistureConfirmed(false);
    setPhotoPreview(URL.createObjectURL(file));
    setOcrLoading(true);

    const formData = new FormData();
    formData.append('image', file);
    try {
      const { data } = await api.post<OcrResponse>('/ocr/parse', formData);
      setOcrJobId(data.data.jobId);
      setOcrWeight(data.data.parsedWeight ?? undefined);
      setOcrMoisture(data.data.parsedMoisture ?? undefined);
      setOcrConfidence(data.data.confidence);
      if (data.data.parsedWeight !== null) setGrossKg(String(data.data.parsedWeight));
      if (data.data.parsedMoisture !== null) setMoisturePct(String(data.data.parsedMoisture));
      setOcrMessage('Review and explicitly confirm each OCR-prefilled value.');
    } catch (ocrError) {
      const failure: OcrFailure | undefined =
        axios.isAxiosError(ocrError) && ocrError.response?.data
          ? (ocrError.response.data as OcrFailure)
          : undefined;
      if (failure?.code?.startsWith('OCR_')) {
        setOcrMessage(failure.message ?? 'Could not read image, please enter manually.');
      } else {
        setOcrMessage('Could not read image, please enter manually.');
      }
    } finally {
      setOcrLoading(false);
    }
  };

  const weightDiffers = ocrWeight !== undefined && Math.abs(Number(grossKg) - ocrWeight) > 0.0001;
  const moistureDiffers =
    ocrMoisture !== undefined && Math.abs(Number(moisturePct) - ocrMoisture) > 0.0001;
  const ocrNeedsConfirmation =
    (ocrWeight !== undefined && !weightConfirmed) ||
    (ocrMoisture !== undefined && !moistureConfirmed);
  const ocrUnreconciled =
    (weightDiffers && !weightConfirmed) || (moistureDiffers && !moistureConfirmed);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!selectedPrice || !farmerId) {
      setError('Select a farmer and a current crop price before saving.');
      return;
    }
    if (ocrNeedsConfirmation || ocrUnreconciled) {
      setError(
        ocrUnreconciled
          ? 'Value differs from OCR reading, please reconcile.'
          : 'Confirm each OCR-prefilled value before saving.',
      );
      return;
    }
    try {
      const result = await createPurchase({
        farmerId,
        cropId: selectedPrice.cropId,
        grade: selectedPrice.grade,
        grossKg: Number(grossKg),
        tareKg: Number(tareKg),
        moisturePct: Number(moisturePct),
        ratePerQuintal: selectedPrice.ratePerQuintal,
        ...(ocrJobId ? { ocrJobId } : {}),
        ...(ocrWeight !== undefined ? { ocrWeight } : {}),
        ...(ocrMoisture !== undefined ? { ocrMoisture } : {}),
        ...(weightDiffers ? { ocrWeightReconciled: weightConfirmed } : {}),
        ...(moistureDiffers ? { ocrMoistureReconciled: moistureConfirmed } : {}),
      });
      setNotice(result === 'QUEUED' ? 'Saved securely for offline sync.' : 'Purchase saved.');
      setGrossKg('');
      setTareKg('');
      setMoisturePct('');
      setOcrJobId('');
      setOcrWeight(undefined);
      setOcrMoisture(undefined);
      setOcrConfidence(undefined);
      setWeightConfirmed(false);
      setMoistureConfirmed(false);
      setPhotoPreview('');
      setOcrMessage('');
    } catch (submitError) {
      const failure: OcrFailure | undefined =
        axios.isAxiosError(submitError) && submitError.response?.data
          ? (submitError.response.data as OcrFailure)
          : undefined;
      setError(
        failure?.code === 'OCR_MISMATCH'
          ? (failure.message ?? 'Value differs from OCR reading, please reconcile.')
          : submitError instanceof Error
            ? submitError.message
            : 'Unable to save purchase.',
      );
    }
  };

  if (!session) {
    return (
      <main className="shell">
        <section className="card">
          <h2>Sign in required</h2>
          <p>Log in as a centre operator to capture purchases.</p>
          <Link className="button primary" to="/login">
            Go to login
          </Link>
        </section>
      </main>
    );
  }
  if (session.user.role !== 'centre_operator') {
    return (
      <main className="shell">
        <section className="card">
          <h2>Operator access required</h2>
          <p>Offline purchase capture is available to centre operators.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Offline-ready entry</p>
            <h2>Capture purchase</h2>
          </div>
          <span className={isOnline ? 'connection online' : 'connection offline'}>
            {isOnline ? 'Online' : 'Offline'}
          </span>
        </div>
        {loading ? (
          <p>Loading farmers and prices…</p>
        ) : (
          <form className="form-grid" onSubmit={(event) => void handleSubmit(event)}>
            <label className="full-span">
              Scale or moisture photo
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => void handleImageSelected(event.target.files?.[0])}
                disabled={ocrLoading}
              />
            </label>
            <label>
              Farmer
              <select
                value={farmerId}
                onChange={(event) => setFarmerId(event.target.value)}
                required
              >
                <option value="">Select farmer</option>
                {farmers.map((farmer) => (
                  <option key={farmer.id} value={farmer.id}>
                    {farmer.memberId} — {farmer.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Crop and grade
              <select value={priceId} onChange={(event) => setPriceId(event.target.value)} required>
                <option value="">Select crop and grade</option>
                {activePrices.map((price) => (
                  <option
                    key={`${price.cropId}:${price.grade}`}
                    value={`${price.cropId}:${price.grade}`}
                  >
                    {price.crop.name} · Grade {price.grade} · ₹{price.ratePerQuintal}/quintal
                  </option>
                ))}
              </select>
            </label>
            <div
              className={
                photoPreview
                  ? 'ocr-capture-group full-span with-photo'
                  : 'ocr-capture-group full-span'
              }
            >
              {photoPreview && (
                <div className="ocr-photo">
                  <img src={photoPreview} alt="Uploaded scale or moisture reading" />
                  <div>
                    {ocrLoading ? (
                      <p>Reading image…</p>
                    ) : (
                      <>
                        {ocrMessage && <p role="status">{ocrMessage}</p>}
                        {ocrConfidence !== undefined && (
                          <small>OCR confidence: {Math.round(ocrConfidence * 100)}%</small>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
              <div className="ocr-reading-inputs">
                <div className="ocr-value-field">
                  <label htmlFor="gross-weight">Gross weight (kg)</label>
                  <input
                    id="gross-weight"
                    type="number"
                    step="0.1"
                    min="0.1"
                    value={grossKg}
                    onChange={(event) => {
                      setGrossKg(event.target.value);
                      setWeightConfirmed(false);
                    }}
                    required
                  />
                  {ocrWeight !== undefined && (
                    <label className="ocr-confirm">
                      <input
                        type="checkbox"
                        checked={weightConfirmed}
                        onChange={(event) => setWeightConfirmed(event.target.checked)}
                      />
                      {weightDiffers
                        ? 'I reconciled the entered weight with the OCR reading'
                        : 'I confirm the OCR-prefilled weight'}
                    </label>
                  )}
                  {weightDiffers && !weightConfirmed && (
                    <small className="error">
                      Value differs from OCR reading, please reconcile.
                    </small>
                  )}
                </div>
                <div className="ocr-value-field">
                  <label htmlFor="moisture-percent">Moisture (%)</label>
                  <input
                    id="moisture-percent"
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={moisturePct}
                    onChange={(event) => {
                      setMoisturePct(event.target.value);
                      setMoistureConfirmed(false);
                    }}
                    required
                  />
                  {ocrMoisture !== undefined && (
                    <label className="ocr-confirm">
                      <input
                        type="checkbox"
                        checked={moistureConfirmed}
                        onChange={(event) => setMoistureConfirmed(event.target.checked)}
                      />
                      {moistureDiffers
                        ? 'I reconciled the entered moisture with the OCR reading'
                        : 'I confirm the OCR-prefilled moisture'}
                    </label>
                  )}
                  {moistureDiffers && !moistureConfirmed && (
                    <small className="error">
                      Value differs from OCR reading, please reconcile.
                    </small>
                  )}
                </div>
              </div>
            </div>
            <label>
              Tare weight (kg)
              <input
                type="number"
                step="0.1"
                min="0"
                value={tareKg}
                onChange={(event) => setTareKg(event.target.value)}
                required
              />
            </label>
            {error && (
              <p className="error full-span" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="success full-span" role="status">
                {notice}
              </p>
            )}
            <button type="submit" className="button primary full-span" disabled={loading}>
              Save purchase
            </button>
          </form>
        )}
      </section>
      <section className="card queue-card">
        <div className="section-heading">
          <h2>Sync queue</h2>
          <button className="button secondary" onClick={() => void flush()}>
            Sync now
          </button>
        </div>
        {queueError && (
          <p className="error" role="alert">
            {queueError}
          </p>
        )}
        {entries.length === 0 ? (
          <p>No queued or recently synced purchases.</p>
        ) : (
          <ul className="sync-list">
            {entries.map((entry) => (
              <li key={entry.uuid}>
                <div>
                  <strong>{entry.uuid.slice(0, 8)}</strong>
                  {entry.reason && <small>{entry.reason}</small>}
                </div>
                <span className={`sync-status ${entry.status.toLowerCase()}`}>{entry.status}</span>
                {entry.status === 'REJECTED' && (
                  <button className="text-button" onClick={() => void retry(entry.uuid)}>
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
};

export default function App() {
  const [session, setSession] = useState<AuthSession | null>(() => getSession());
  const navigate = useNavigate();

  const logout = async () => {
    if (session?.refreshToken) {
      try {
        await api.post('/auth/logout', { refreshToken: session.refreshToken });
      } catch {
        // Local sign-out must still work when offline.
      }
    }
    clearSession();
    setSession(null);
    navigate('/');
  };

  return (
    <div>
      <nav className="topbar">
        <Link to="/">Home</Link>
        <Link to="/login">Login</Link>
        <Link to="/purchases">Capture purchase</Link>
        {session && (
          <button className="text-button" onClick={() => void logout()}>
            Sign out
          </button>
        )}
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route
          path="/login"
          element={
            <Login
              onLogin={(nextSession) => {
                setSession(nextSession);
                navigate('/purchases');
              }}
            />
          }
        />
        <Route path="/purchases" element={<PurchaseCapture session={session} />} />
      </Routes>
    </div>
  );
}
