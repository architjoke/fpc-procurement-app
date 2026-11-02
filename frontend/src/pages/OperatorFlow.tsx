import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import axios from 'axios';
import { Link, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { api } from '../lib/api';
import { offlineDb, type QueuedPurchase, type SyncHistoryEntry } from '../lib/offlineDb';
import { useAuthStore } from '../lib/authStore';
import type { AuthSession } from '../lib/session';

interface Farmer {
  id: string;
  memberId: string;
  name: string;
  village: string;
  landAcres: number | string;
  centreId: string;
}

interface Price {
  id: string;
  cropId: string;
  grade: string;
  ratePerQuintal: number;
  effectiveDate: string;
  crop: { id: string; name: string };
}

interface PurchaseSnapshot {
  farmerId: string;
  cropId: string;
  grade: string;
  grossKg: number;
  tareKg: number;
  moisturePct: number;
  ratePerQuintal: number;
}

interface PurchaseRecord extends Omit<PurchaseSnapshot, 'ratePerQuintal'> {
  id: string;
  uuid: string;
  status: string;
  flagReason: string | null;
  netKg: number | string;
  rate: number;
  amountPaise: number;
  createdAt: string;
  photoUrl: string | null;
  farmer: { id: string; memberId: string; name: string; village?: string };
  crop: { id: string; name: string };
  centre: { id: string; code: string; village?: string };
}

interface SavedPurchase {
  id: string;
  status: 'SYNCED' | 'QUEUED' | 'FLAGGED';
  snapshot: PurchaseSnapshot;
  flagReason?: string;
  photoDataUrl?: string;
}

interface LocalPurchaseInfo {
  snapshot: PurchaseSnapshot;
  status: string;
  reason?: string;
  farmerName?: string;
  memberId?: string;
  cropName?: string;
}

const QueueContext = createContext<ReturnType<typeof useOfflineQueue> | null>(null);

const useQueue = () => {
  const queue = useContext(QueueContext);
  if (!queue) throw new Error('Operator queue context is missing.');
  return queue;
};

const formatRupees = (paise: number) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);

const CountUp = ({ value, precision = 0 }: { value: number; precision?: number }) => {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      setShown(value);
      return;
    }

    const start = performance.now();
    const from = shown;
    let frame = 0;
    const animate = (now: number) => {
      const progress = Math.min(1, (now - start) / 260);
      const eased = 1 - (1 - progress) ** 3;
      setShown(from + (value - from) * eased);
      if (progress < 1) frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <>
      {shown.toLocaleString('en-IN', {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
      })}
    </>
  );
};

const toNetWeight = (grossKg: number, tareKg: number, moisturePct: number): number => {
  const moistureDeduction = Math.max(0, Math.floor(moisturePct - 12));
  const adjusted = (grossKg - tareKg) * (1 - moistureDeduction / 100);
  return Math.round((adjusted + Number.EPSILON) * 10) / 10;
};

const toAmountPaise = (netKg: number, ratePerQuintal: number): number => {
  const tenths = Math.round(netKg * 10);
  return Math.round((tenths * ratePerQuintal) / 10);
};

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Unable to preview the selected image.'));
    };
    reader.onerror = () => reject(new Error('Unable to preview the selected image.'));
    reader.readAsDataURL(file);
  });

const loadReferences = async (session: AuthSession, active: () => boolean) => {
  const cacheKey = `${session.user.id}:${session.user.centreId ?? ''}`;
  const cached = await offlineDb.referenceData.get(cacheKey);
  const cachedFarmers: Farmer[] =
    cached?.farmers.map((farmer) => ({
      ...farmer,
      village: '',
      landAcres: 0,
      centreId: session.user.centreId ?? '',
    })) ?? [];
  const cachedPrices: Price[] =
    cached?.prices.map((price) => ({
      ...price,
      id: `${price.cropId}:${price.grade}`,
    })) ?? [];

  if (navigator.onLine) {
    const [farmerResponse, priceResponse] = await Promise.all([
      api.get<{ data: Farmer[] }>('/farmers'),
      api.get<{ data: Price[] }>('/price-board'),
    ]);
    if (active()) {
      await offlineDb.referenceData.put({
        key: cacheKey,
        farmers: farmerResponse.data.data.map(({ id, memberId, name }) => ({ id, memberId, name })),
        prices: priceResponse.data.data.map((price) => ({
          cropId: price.cropId,
          grade: price.grade,
          ratePerQuintal: price.ratePerQuintal,
          effectiveDate: price.effectiveDate,
          crop: price.crop,
        })),
      });
    }
    return { farmers: farmerResponse.data.data, prices: priceResponse.data.data };
  }
  return { farmers: cachedFarmers, prices: cachedPrices };
};

const OperatorShell = () => {
  const queue = useOfflineQueue();
  const session = useAuthStore((state) => state.session);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const updateOnline = () => setOnline(navigator.onLine);
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    return () => {
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  }, []);

  const pending = queue.entries.filter(
    (entry) => entry.status === 'QUEUED' || entry.status === 'SYNCING',
  );
  const rejected = queue.entries.filter((entry) => entry.status === 'REJECTED');
  const lastSynced = queue.entries.some((entry) => entry.status === 'SYNCED');

  return (
    <QueueContext.Provider value={queue}>
      <div className="operator-shell">
        <div className="operator-topline">
          <div>
            <p className="eyebrow">Centre operator</p>
            <span className="text-sm text-muted">{session?.user.email}</span>
          </div>
          <Link className="operator-new-link" to="/operator/find">
            Find farmer
          </Link>
        </div>
        <Outlet />
        <aside
          className={`sync-dock${online ? ' sync-dock-online' : ' sync-dock-offline'}`}
          aria-live="polite"
        >
          <div className="sync-dock-copy">
            <span className={`online-indicator${online ? '' : ' is-offline'}`} />
            <div>
              <strong>
                {!online
                  ? `Offline · ${pending.length} queued`
                  : pending.length
                    ? `${pending.length} waiting to sync`
                    : lastSynced
                      ? 'All caught up ✓'
                      : 'Online · ready to sync'}
              </strong>
              {queue.error && <small>{queue.error}</small>}
              {rejected.length > 0 && (
                <small>
                  {rejected.length} rejected item{rejected.length === 1 ? '' : 's'} need a retry.
                </small>
              )}
            </div>
          </div>
          <div className="sync-dock-actions">
            {rejected.slice(0, 2).map((entry) => (
              <button
                key={entry.uuid}
                type="button"
                className="sync-retry-link"
                onClick={() => void queue.retry(entry.uuid)}
                disabled={!online}
              >
                Retry
              </button>
            ))}
            <button
              type="button"
              className="sync-now-button"
              onClick={() => void queue.flush()}
              disabled={!online || pending.length === 0}
            >
              Sync now
            </button>
          </div>
        </aside>
      </div>
    </QueueContext.Provider>
  );
};

export const FindFarmerPage = () => {
  const session = useAuthStore((state) => state.session);
  const navigate = useNavigate();
  const [farmers, setFarmers] = useState<Farmer[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!session) return;
    let active = true;
    setLoading(true);
    setError('');
    void loadReferences(session, () => active)
      .then(({ farmers: result }) => {
        if (active) setFarmers(result);
      })
      .catch((loadError: unknown) => {
        console.error('Unable to load operator farmer references:', loadError);
        if (active) setError('Could not load farmers. Check your connection and retry.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session, reloadKey]);

  const filteredFarmers = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return farmers;
    return farmers.filter((farmer) =>
      [farmer.memberId, farmer.name, farmer.village].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }, [farmers, search]);

  const selectFarmer = (farmer: Farmer) => {
    sessionStorage.setItem('fpc-selected-farmer', farmer.id);
    navigate('/operator/purchase/new', { state: { farmer } });
  };

  return (
    <main className="operator-page">
      <header className="operator-page-heading">
        <p className="eyebrow">Procurement · Step 1</p>
        <h1 className="text-3xl font-bold tracking-tight text-ink">Find a farmer</h1>
        <p>Search by name, member ID, or village to start a purchase.</p>
      </header>
      <label className="search-field">
        <span className="sr-only">Search farmers</span>
        <span aria-hidden="true" className="search-icon">
          ⌕
        </span>
        <input
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search farmer or member ID"
          type="search"
          aria-label="Search farmers by name, member ID, or village"
        />
      </label>

      {error && (
        <div className="operator-error" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => setReloadKey((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {loading ? (
        <div className="farmer-grid" aria-label="Loading farmers">
          {[0, 1, 2].map((item) => (
            <div className="farmer-skeleton" key={item} />
          ))}
        </div>
      ) : !error && farmers.length === 0 ? (
        <div className="operator-empty">
          <span aria-hidden="true">⌂</span>
          <h2>No farmers found</h2>
          <p>This centre has no farmer records yet.</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => setReloadKey((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      ) : !error && filteredFarmers.length === 0 ? (
        <div className="operator-empty">
          <h2>No matching farmer</h2>
          <p>Try a different spelling, member ID, or village.</p>
        </div>
      ) : (
        <ul className="farmer-grid">
          {filteredFarmers.map((farmer, index) => (
            <li
              key={farmer.id}
              className="farmer-entry"
              style={{ animationDelay: `${Math.min(index, 6) * 35}ms` }}
            >
              <button
                type="button"
                className="farmer-card card-tilt"
                onClick={() => selectFarmer(farmer)}
              >
                <span className="farmer-avatar" aria-hidden="true">
                  {farmer.name.trim().charAt(0).toLocaleUpperCase()}
                </span>
                <span className="farmer-card-info">
                  <strong>{farmer.name}</strong>
                  <span>{farmer.memberId}</span>
                  <small>{farmer.village || 'Centre member'}</small>
                </span>
                <span className="farmer-card-arrow" aria-hidden="true">
                  →
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
};

export const PurchaseWizardPage = () => {
  const session = useAuthStore((state) => state.session);
  const queue = useQueue();
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as { farmer?: Farmer } | null;
  const [farmer, setFarmer] = useState<Farmer | null>(locationState?.farmer ?? null);
  const [farmers, setFarmers] = useState<Farmer[]>([]);
  const [prices, setPrices] = useState<Price[]>([]);
  const [referencesLoading, setReferencesLoading] = useState(true);
  const [referenceError, setReferenceError] = useState('');
  const [step, setStep] = useState(0);
  const [priceKey, setPriceKey] = useState('');
  const [grossKg, setGrossKg] = useState('');
  const [tareKg, setTareKg] = useState('');
  const [moisturePct, setMoisturePct] = useState('');
  const [ocrJobId, setOcrJobId] = useState('');
  const [ocrWeight, setOcrWeight] = useState<number | undefined>();
  const [ocrMoisture, setOcrMoisture] = useState<number | undefined>();
  const [weightConfirmed, setWeightConfirmed] = useState(false);
  const [moistureConfirmed, setMoistureConfirmed] = useState(false);
  const [ocrConfidence, setOcrConfidence] = useState<number | undefined>();
  const [photoPreview, setPhotoPreview] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState('');
  const [ocrMessage, setOcrMessage] = useState('');
  const [ocrLoading, setOcrLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [savedPurchase, setSavedPurchase] = useState<SavedPurchase | null>(null);
  const [savedSmsOpen, setSavedSmsOpen] = useState(false);

  useEffect(() => {
    if (!session) return;
    let active = true;
    setReferencesLoading(true);
    setReferenceError('');
    void loadReferences(session, () => active)
      .then(({ farmers: nextFarmers, prices: nextPrices }) => {
        if (!active) return;
        setFarmers(nextFarmers);
        setPrices(nextPrices);
        setFarmer((current) => {
          if (current) return current;
          const selectedFarmerId = sessionStorage.getItem('fpc-selected-farmer');
          const selectedFarmer = nextFarmers.find((item) => item.id === selectedFarmerId);
          return selectedFarmer ?? null;
        });
      })
      .catch((loadError: unknown) => {
        console.error('Unable to load purchase wizard references:', loadError);
        if (active)
          setReferenceError('Could not load current farmers and prices. Retry to continue.');
      })
      .finally(() => {
        if (active) setReferencesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session]);

  const activePrices = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return prices.filter((price) => price.effectiveDate.slice(0, 10) <= today);
  }, [prices]);
  const selectedPrice = activePrices.find((price) => `${price.cropId}:${price.grade}` === priceKey);

  const weightDiffers = ocrWeight !== undefined && Math.abs(Number(grossKg) - ocrWeight) > 0.0001;
  const moistureDiffers =
    ocrMoisture !== undefined && Math.abs(Number(moisturePct) - ocrMoisture) > 0.0001;
  const validWeight =
    grossKg.trim() !== '' &&
    tareKg.trim() !== '' &&
    Number.isFinite(Number(grossKg)) &&
    Number.isFinite(Number(tareKg)) &&
    Number(grossKg) > 0 &&
    Number(tareKg) >= 0 &&
    Number(tareKg) <= Number(grossKg) &&
    (ocrWeight === undefined || weightConfirmed);
  const validMoisture =
    moisturePct.trim() !== '' &&
    Number.isFinite(Number(moisturePct)) &&
    Number(moisturePct) >= 0 &&
    Number(moisturePct) <= 100 &&
    (ocrMoisture === undefined || moistureConfirmed);
  const canContinue =
    (step === 0 && Boolean(selectedPrice)) ||
    (step === 1 && validWeight) ||
    (step === 2 && validMoisture);

  const handleOcrUpload = async (file?: File) => {
    if (!file) return;
    setOcrMessage('');
    setOcrJobId('');
    setOcrWeight(undefined);
    setOcrMoisture(undefined);
    setOcrConfidence(undefined);
    setWeightConfirmed(false);
    setMoistureConfirmed(false);
    if (!file.type.startsWith('image/')) {
      setOcrMessage('Choose an image file. You can continue with manual entry.');
      return;
    }
    if (file.size > 1024 * 1024) {
      setOcrMessage('Image must be 1 MB or smaller. You can continue with manual entry.');
      return;
    }

    try {
      const dataUrl = await readAsDataUrl(file);
      setPhotoPreview(dataUrl);
      setPhotoDataUrl(dataUrl);
    } catch (previewError) {
      console.error('Could not preview the OCR photo:', previewError);
      setPhotoPreview('');
      setPhotoDataUrl('');
    }

    if (!navigator.onLine) {
      setOcrMessage('Offline: enter values manually. The purchase will sync when connected.');
      return;
    }

    setOcrLoading(true);
    const body = new FormData();
    body.append('image', file);
    try {
      const { data } = await api.post<{
        data: {
          jobId: string;
          parsedWeight: number | null;
          parsedMoisture: number | null;
          confidence: number;
        };
      }>('/ocr/parse', body);
      setOcrJobId(data.data.jobId);
      setOcrWeight(data.data.parsedWeight ?? undefined);
      setOcrMoisture(data.data.parsedMoisture ?? undefined);
      setOcrConfidence(data.data.confidence);
      if (data.data.parsedWeight !== null) setGrossKg(String(data.data.parsedWeight));
      if (data.data.parsedMoisture !== null) setMoisturePct(String(data.data.parsedMoisture));
      setOcrMessage('Review and explicitly confirm or reconcile each OCR reading.');
    } catch (ocrError) {
      const message =
        axios.isAxiosError(ocrError) && typeof ocrError.response?.data?.message === 'string'
          ? ocrError.response.data.message
          : 'Could not read image, please enter manually.';
      setOcrMessage(message);
      setOcrJobId('');
      setOcrWeight(undefined);
      setOcrMoisture(undefined);
    } finally {
      setOcrLoading(false);
    }
  };

  const netKg =
    grossKg !== '' && tareKg !== '' && moisturePct !== '' && Number(tareKg) <= Number(grossKg)
      ? toNetWeight(Number(grossKg), Number(tareKg), Number(moisturePct))
      : 0;
  const amountPaise = selectedPrice ? toAmountPaise(netKg, selectedPrice.ratePerQuintal) : 0;
  const snapshot: PurchaseSnapshot | null =
    farmer && selectedPrice
      ? {
          farmerId: farmer.id,
          cropId: selectedPrice.cropId,
          grade: selectedPrice.grade,
          grossKg: Number(grossKg),
          tareKg: Number(tareKg),
          moisturePct: Number(moisturePct),
          ratePerQuintal: selectedPrice.ratePerQuintal,
        }
      : null;

  const submitPurchase = async () => {
    if (!farmer || !selectedPrice || !snapshot || !validWeight || !validMoisture) return;
    setSaving(true);
    setSubmitError('');
    try {
      const result = await queue.createPurchase({
        farmerId: farmer.id,
        cropId: selectedPrice.cropId,
        grade: selectedPrice.grade,
        grossKg: snapshot.grossKg,
        tareKg: snapshot.tareKg,
        moisturePct: snapshot.moisturePct,
        ratePerQuintal: selectedPrice.ratePerQuintal,
        ...(ocrJobId ? { ocrJobId } : {}),
        ...(ocrWeight !== undefined ? { ocrWeight } : {}),
        ...(ocrMoisture !== undefined ? { ocrMoisture } : {}),
        ...(ocrWeight !== undefined ? { ocrWeightReconciled: weightConfirmed } : {}),
        ...(ocrMoisture !== undefined ? { ocrMoistureReconciled: moistureConfirmed } : {}),
      });
      setSavedPurchase({
        id: result.purchaseId ?? result.queueId ?? '',
        status:
          result.status === 'SAVED' ? 'SYNCED' : result.status === 'QUEUED' ? 'QUEUED' : 'FLAGGED',
        snapshot,
        ...(result.flagReason ? { flagReason: result.flagReason } : {}),
        ...(photoDataUrl ? { photoDataUrl } : {}),
      });
    } catch (saveError) {
      console.error('Unable to save operator purchase:', saveError);
      setSubmitError(
        axios.isAxiosError(saveError) && typeof saveError.response?.data?.message === 'string'
          ? saveError.response.data.message
          : saveError instanceof Error
            ? saveError.message
            : 'Could not save this purchase. Please retry.',
      );
    } finally {
      setSaving(false);
    }
  };

  const goToDetail = () => {
    if (!savedPurchase) return;
    navigate(`/operator/purchase/${encodeURIComponent(savedPurchase.id)}`, {
      state: {
        snapshot: savedPurchase.snapshot,
        photoDataUrl: savedPurchase.photoDataUrl,
        status: savedPurchase.status,
        flagReason: savedPurchase.flagReason,
      },
    });
  };

  if (referencesLoading) {
    return (
      <main className="operator-page">
        <div className="wizard-skeleton" aria-label="Loading purchase form" />
      </main>
    );
  }
  if (referenceError) {
    return (
      <main className="operator-page">
        <div className="operator-error" role="alert">
          <p>{referenceError}</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </main>
    );
  }
  if (!farmer) {
    return (
      <main className="operator-page">
        <div className="operator-empty">
          <h1>Select a farmer first</h1>
          <p>Choose the farmer for this purchase before entering weights.</p>
          <Link className="button primary" to="/operator/find">
            Find farmer
          </Link>
        </div>
      </main>
    );
  }

  if (savedPurchase) {
    return (
      <>
        <main className="operator-page">
          <section className="saved-card">
            <span className="saved-check" aria-hidden="true">
              ✓
            </span>
            <p className="eyebrow">Purchase saved</p>
            <h1 className="text-3xl font-bold">Saved ✓</h1>
            {savedPurchase.status === 'FLAGGED' ? (
              <p className="flag-banner" role="status">
                Under review by procurement manager. {savedPurchase.flagReason}
              </p>
            ) : savedPurchase.status === 'QUEUED' ? (
              <p className="success-message" role="status">
                Saved on this device. It will sync automatically when you reconnect.
              </p>
            ) : (
              <p className="success-message" role="status">
                Purchase synced successfully.
              </p>
            )}
            <div className="saved-actions">
              <button type="button" className="button primary press-depth" onClick={goToDetail}>
                View purchase
              </button>
              {savedPurchase.status === 'SYNCED' && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setSavedSmsOpen(true)}
                >
                  View SMS slip
                </button>
              )}
              <Link className="text-button" to="/operator/find">
                Start another purchase
              </Link>
            </div>
          </section>
        </main>
        {savedSmsOpen && (
          <SmsBottomSheet purchaseId={savedPurchase.id} onClose={() => setSavedSmsOpen(false)} />
        )}
      </>
    );
  }

  const steps = ['Crop & grade', 'Gross & tare', 'Moisture', 'Review'];

  return (
    <main className="operator-page">
      <header className="operator-page-heading">
        <Link className="back-link" to="/operator/find">
          ← Change farmer
        </Link>
        <p className="eyebrow">New purchase</p>
        <h1 className="text-3xl font-bold tracking-tight text-ink">Record procurement</h1>
        <div className="selected-farmer-chip">
          <span className="farmer-avatar farmer-avatar-small" aria-hidden="true">
            {farmer.name.charAt(0)}
          </span>
          <span>
            <strong>{farmer.name}</strong>
            <small>{farmer.memberId}</small>
          </span>
        </div>
      </header>

      <div className="wizard-progress" aria-label={`Step ${step + 1} of ${steps.length}`}>
        <div className="wizard-progress-track">
          <span style={{ transform: `scaleX(${(step + 1) / steps.length})` }} />
        </div>
        <span>
          Step {step + 1} of {steps.length} · {steps[step]}
        </span>
      </div>

      <section className="wizard-card">
        <div className="wizard-panel" key={step}>
          {step === 0 && (
            <div className="wizard-step">
              <div>
                <p className="eyebrow">Select current rate</p>
                <h2>Crop and grade</h2>
                <p>Choose the crop and grade using today’s price board.</p>
              </div>
              <label className="field-label">
                Crop · grade · rate
                <select
                  className="field-input min-h-14"
                  value={priceKey}
                  onChange={(event) => setPriceKey(event.target.value)}
                  required
                >
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
              {activePrices.length === 0 && (
                <p className="operator-empty-inline">No current crop rates are available.</p>
              )}
              {selectedPrice && (
                <div className="rate-highlight">
                  <span>Current price</span>
                  <strong className="numeric">₹{selectedPrice.ratePerQuintal}</strong>
                  <small>per quintal · Grade {selectedPrice.grade}</small>
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="wizard-step">
              <div>
                <p className="eyebrow">Scale reading</p>
                <h2>Gross and tare weight</h2>
                <p>Photograph the scale if available, or enter values manually.</p>
              </div>
              <label className="upload-control">
                <span aria-hidden="true">▧</span>
                <span>{photoPreview ? 'Choose a different photo' : 'Take or upload a photo'}</span>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(event) => void handleOcrUpload(event.target.files?.[0])}
                />
              </label>
              {photoPreview && (
                <div className="wizard-photo">
                  <img src={photoPreview} alt="Scale photo for this purchase" />
                  <div>
                    <strong>{ocrLoading ? 'Reading photo…' : 'Purchase photo'}</strong>
                    {ocrMessage && <small role="status">{ocrMessage}</small>}
                    {ocrConfidence !== undefined && (
                      <small>OCR confidence {Math.round(ocrConfidence * 100)}%</small>
                    )}
                  </div>
                </div>
              )}
              <div className="weight-input-grid">
                <label className="field-label">
                  Gross weight
                  <span className="numeric animated-reading">
                    {grossKg ? <CountUp value={Number(grossKg)} precision={1} /> : '—'}{' '}
                    <small>kg</small>
                  </span>
                  <input
                    className="field-input numeric"
                    type="number"
                    inputMode="decimal"
                    min="0.1"
                    step="0.1"
                    value={grossKg}
                    onChange={(event) => {
                      setGrossKg(event.target.value);
                      setWeightConfirmed(false);
                    }}
                    required
                  />
                </label>
                <label className="field-label">
                  Tare weight
                  <span className="numeric animated-reading">
                    {tareKg ? <CountUp value={Number(tareKg)} precision={1} /> : '—'}{' '}
                    <small>kg</small>
                  </span>
                  <input
                    className="field-input numeric"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.1"
                    value={tareKg}
                    onChange={(event) => setTareKg(event.target.value)}
                    required
                  />
                </label>
              </div>
              {ocrWeight !== undefined && (
                <label className="ocr-confirm-control">
                  <input
                    type="checkbox"
                    checked={weightConfirmed}
                    onChange={(event) => setWeightConfirmed(event.target.checked)}
                  />
                  {weightDiffers
                    ? 'I reconciled the typed gross weight with the OCR reading'
                    : `Confirm OCR gross weight (${ocrWeight} kg)`}
                </label>
              )}
              {weightDiffers && !weightConfirmed && (
                <p className="inline-reconcile" role="alert">
                  Value differs from OCR reading, please reconcile
                </p>
              )}
              {Number(tareKg) > Number(grossKg) && grossKg !== '' && tareKg !== '' && (
                <p className="inline-reconcile" role="alert">
                  Tare weight cannot exceed gross weight.
                </p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="wizard-step">
              <div>
                <p className="eyebrow">Quality reading</p>
                <h2>Moisture content</h2>
                <p>Enter the moisture percentage. Deductions apply above 12%.</p>
              </div>
              {photoPreview && (
                <div className="wizard-photo wizard-photo-small">
                  <img src={photoPreview} alt="Photo used for the OCR reading" />
                  <div>
                    <strong>Scale / moisture photo</strong>
                    {ocrConfidence !== undefined && (
                      <small>OCR confidence {Math.round(ocrConfidence * 100)}%</small>
                    )}
                  </div>
                </div>
              )}
              <label className="field-label moisture-field">
                Moisture
                <span className="numeric animated-reading">
                  {moisturePct ? <CountUp value={Number(moisturePct)} precision={1} /> : '—'}{' '}
                  <small>%</small>
                </span>
                <input
                  className="field-input numeric"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="100"
                  step="0.1"
                  value={moisturePct}
                  onChange={(event) => {
                    setMoisturePct(event.target.value);
                    setMoistureConfirmed(false);
                  }}
                  required
                />
              </label>
              {ocrMoisture !== undefined && (
                <label className="ocr-confirm-control">
                  <input
                    type="checkbox"
                    checked={moistureConfirmed}
                    onChange={(event) => setMoistureConfirmed(event.target.checked)}
                  />
                  {moistureDiffers
                    ? 'I reconciled the typed moisture with the OCR reading'
                    : `Confirm OCR moisture (${ocrMoisture}%)`}
                </label>
              )}
              {moistureDiffers && !moistureConfirmed && (
                <p className="inline-reconcile" role="alert">
                  Value differs from OCR reading, please reconcile
                </p>
              )}
            </div>
          )}

          {step === 3 && selectedPrice && (
            <div className="wizard-step">
              <div>
                <p className="eyebrow">Check before saving</p>
                <h2>Purchase summary</h2>
                <p>Verify the recorded values and estimated amount.</p>
              </div>
              <div className="purchase-summary-card">
                <div className="summary-farmer">
                  <span className="farmer-avatar" aria-hidden="true">
                    {farmer.name.charAt(0)}
                  </span>
                  <span>
                    <strong>{farmer.name}</strong>
                    <small>{farmer.memberId}</small>
                  </span>
                </div>
                <dl className="purchase-values">
                  <div>
                    <dt>Crop · grade</dt>
                    <dd>
                      {selectedPrice.crop.name} · {selectedPrice.grade}
                    </dd>
                  </div>
                  <div>
                    <dt>Gross · tare</dt>
                    <dd className="numeric">
                      <CountUp value={Number(grossKg)} precision={1} /> kg ·{' '}
                      <CountUp value={Number(tareKg)} precision={1} /> kg
                    </dd>
                  </div>
                  <div>
                    <dt>Moisture</dt>
                    <dd className="numeric">
                      <CountUp value={Number(moisturePct)} precision={1} />%
                    </dd>
                  </div>
                  <div>
                    <dt>Net weight</dt>
                    <dd className="numeric">
                      <CountUp value={netKg} precision={1} /> kg
                    </dd>
                  </div>
                  <div>
                    <dt>Rate</dt>
                    <dd className="numeric">₹{selectedPrice.ratePerQuintal}/quintal</dd>
                  </div>
                </dl>
                <div className="summary-total">
                  <span>Estimated amount</span>
                  <strong className="numeric text-4xl">
                    ₹<CountUp value={amountPaise / 100} precision={2} />
                  </strong>
                  <small>Calculated to the nearest paisa</small>
                </div>
              </div>
            </div>
          )}
        </div>

        {submitError && (
          <p className="operator-error-message" role="alert">
            {submitError}
          </p>
        )}
        <div className="wizard-actions">
          {step > 0 ? (
            <button
              type="button"
              className="button secondary"
              onClick={() => setStep((current) => current - 1)}
              disabled={saving}
            >
              Back
            </button>
          ) : (
            <Link to="/operator/find" className="button secondary">
              Cancel
            </Link>
          )}
          {step < 3 ? (
            <button
              type="button"
              className="button primary press-depth"
              onClick={() => setStep((current) => current + 1)}
              disabled={!canContinue || ocrLoading}
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              className="button primary press-depth"
              onClick={() => void submitPurchase()}
              disabled={saving || !validWeight || !validMoisture}
            >
              {saving ? 'Saving…' : 'Confirm purchase'}
            </button>
          )}
        </div>
      </section>
    </main>
  );
};

const SmsBottomSheet = ({ purchaseId, onClose }: { purchaseId: string; onClose: () => void }) => {
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let active = true;
    void api
      .get<{ data: { messageMarathi: string; status: string } }>(
        `/sms/${encodeURIComponent(purchaseId)}`,
      )
      .then(({ data }) => {
        if (active) setMessage(data.data.messageMarathi);
      })
      .catch((loadError: unknown) => {
        console.error('Unable to load SMS slip preview:', loadError);
        if (active) setError('Could not load this SMS slip. Please retry.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [purchaseId, retryCount]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setError('');
    } catch (copyError) {
      console.error('Unable to copy the SMS slip:', copyError);
      setError('Copy was unavailable. Select the slip text to copy it manually.');
    }
  };

  return (
    <div className="bottom-sheet-backdrop" onClick={onClose}>
      <section
        className="sms-bottom-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sms-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="bottom-sheet-handle" />
        <div className="section-heading">
          <div>
            <p className="eyebrow">Farmer receipt</p>
            <h2 id="sms-sheet-title">SMS slip preview</h2>
          </div>
          <button type="button" className="text-button" onClick={onClose}>
            Close
          </button>
        </div>
        {loading ? (
          <div className="sheet-skeleton" aria-label="Loading SMS slip" />
        ) : error ? (
          <div className="operator-error" role="alert">
            <p>{error}</p>
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setError('');
                setLoading(true);
                setRetryCount((count) => count + 1);
              }}
            >
              Reload
            </button>
          </div>
        ) : (
          <>
            <p className="sms-slip-text" lang="mr">
              {message}
            </p>
            <button
              type="button"
              className="button primary press-depth"
              onClick={() => void copy()}
            >
              {copied ? 'Copied ✓' : 'Copy SMS text'}
            </button>
          </>
        )}
      </section>
    </div>
  );
};

export const PurchaseDetailPage = () => {
  const { id = '' } = useParams();
  const session = useAuthStore((state) => state.session);
  const location = useLocation();
  const locationState = location.state as {
    snapshot?: PurchaseSnapshot;
    photoDataUrl?: string;
    status?: string;
    flagReason?: string;
  } | null;
  const [purchase, setPurchase] = useState<PurchaseRecord | null>(null);
  const [localInfo, setLocalInfo] = useState<LocalPurchaseInfo | null>(null);
  const [photoDataUrl, setPhotoDataUrl] = useState(locationState?.photoDataUrl ?? '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showSms, setShowSms] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    void (async () => {
      let snapshot = locationState?.snapshot;
      let localStatus = locationState?.status;
      let reason = locationState?.flagReason;
      let resolvedId = id;
      try {
        const [queued, history] = await Promise.all([
          offlineDb.purchases.get(id),
          offlineDb.syncHistory.get(id),
        ]);
        if (!snapshot && queued) {
          snapshot = {
            farmerId: queued.farmer_id,
            cropId: queued.crop_id,
            grade: queued.grade,
            grossKg: queued.gross_kg,
            tareKg: queued.tare_kg,
            moisturePct: queued.moisture_pct,
            ratePerQuintal: queued.rate_per_quintal,
          };
          localStatus = queued.syncStatus;
        }
        if (!snapshot && history?.snapshot) {
          snapshot = history.snapshot;
          localStatus = history.purchaseStatus;
          reason = history.reason;
        }
        if (history?.purchaseId) resolvedId = history.purchaseId;
        if (active && snapshot) {
          const referenceKey = `${session?.user.id}:${session?.user.centreId ?? ''}`;
          const references = await offlineDb.referenceData.get(referenceKey);
          const farmer = references?.farmers.find((entry) => entry.id === snapshot?.farmerId);
          const price = references?.prices.find(
            (entry) => entry.cropId === snapshot?.cropId && entry.grade === snapshot?.grade,
          );
          setLocalInfo({
            snapshot,
            status: localStatus ?? 'QUEUED',
            ...(reason ? { reason } : {}),
            ...(farmer ? { farmerName: farmer.name, memberId: farmer.memberId } : {}),
            ...(price ? { cropName: price.crop.name } : {}),
          });
        }
        if (active) setPhotoDataUrl(locationState?.photoDataUrl ?? '');

        let serverMatchFound = false;
        if (navigator.onLine) {
          const { data } = await api.get<{ data: PurchaseRecord[] }>('/purchases');
          const match = data.data.find(
            (entry) => entry.id === resolvedId || entry.uuid === id || entry.id === id,
          );
          if (active && match) {
            serverMatchFound = true;
            setPurchase(match);
            if (match.status === 'FLAGGED') setPhotoDataUrl('');
          }
        }
        if (active && !snapshot && !serverMatchFound) {
          setError(
            navigator.onLine
              ? 'Purchase was not found. Return to farmer search or retry.'
              : 'Purchase details are unavailable offline. Reconnect and retry.',
          );
        }
      } catch (loadError) {
        console.error('Unable to load purchase detail:', loadError);
        if (active && !snapshot) {
          setError('Could not load purchase details. Reconnect and retry.');
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [id, locationState, session?.user.id, session?.user.centreId]);

  if (loading) {
    return (
      <main className="operator-page">
        <div className="wizard-skeleton" aria-label="Loading purchase details" />
      </main>
    );
  }
  if (error && !purchase && !localInfo) {
    return (
      <main className="operator-page">
        <div className="operator-error" role="alert">
          <p>{error}</p>
          <button
            type="button"
            className="button secondary"
            onClick={() => window.location.reload()}
          >
            Retry
          </button>
        </div>
      </main>
    );
  }

  const snapshot = purchase ?? localInfo?.snapshot;
  if (!snapshot) {
    return <Navigate to="/operator/find" replace />;
  }
  const ratePerQuintal =
    purchase?.rate ??
    localInfo?.snapshot.ratePerQuintal ??
    locationState?.snapshot?.ratePerQuintal ??
    0;
  const status = purchase?.status ?? localInfo?.status ?? 'QUEUED';
  const flagReason = purchase?.flagReason ?? localInfo?.reason ?? locationState?.flagReason;
  const netKg = purchase
    ? Number(purchase.netKg)
    : toNetWeight(snapshot.grossKg, snapshot.tareKg, snapshot.moisturePct);
  const amountPaise = purchase?.amountPaise ?? toAmountPaise(netKg, ratePerQuintal);
  const cropName = purchase?.crop.name ?? localInfo?.cropName ?? 'Crop';
  const farmerName = purchase?.farmer.name ?? localInfo?.farmerName ?? 'Selected farmer';
  const memberId = purchase?.farmer.memberId ?? localInfo?.memberId ?? snapshot.farmerId;
  const centreCode = purchase?.centre.code ?? session?.user.centreId ?? '—';
  const syncedId = purchase?.id ?? (status === 'SYNCED' ? id : '');
  const isFlagged = status === 'FLAGGED';

  return (
    <main className="operator-page">
      <Link to="/operator/find" className="back-link">
        ← Find another farmer
      </Link>
      <article className={`slip-card${isFlagged ? ' slip-card-flagged' : ''}`}>
        {photoDataUrl && (
          <img className="slip-photo-layer" src={photoDataUrl} alt="Purchase scale photo" />
        )}
        <div className="slip-card-front">
          {isFlagged && (
            <div className="flagged-detail-banner" role="status">
              <strong>Under review by procurement manager</strong>
              {flagReason && <span>{flagReason}</span>}
            </div>
          )}
          <div className="slip-heading">
            <div>
              <p className="eyebrow">Purchase receipt</p>
              <h1 className="text-2xl font-bold">{farmerName}</h1>
              <p>
                {memberId} · {purchase?.centre.village ?? centreCode}
              </p>
            </div>
            <span className={`purchase-status-tag status-${status.toLowerCase()}`}>{status}</span>
          </div>
          <div className="slip-crop-line">
            <span>
              {cropName} · Grade {snapshot.grade}
            </span>
            <span>
              {purchase ? new Date(purchase.createdAt).toLocaleString() : 'Saved on this device'}
            </span>
          </div>
          <dl className="slip-values">
            <div>
              <dt>Gross weight</dt>
              <dd className="numeric">{snapshot.grossKg.toFixed(1)} kg</dd>
            </div>
            <div>
              <dt>Tare weight</dt>
              <dd className="numeric">{snapshot.tareKg.toFixed(1)} kg</dd>
            </div>
            <div>
              <dt>Moisture</dt>
              <dd className="numeric">{snapshot.moisturePct.toFixed(1)}%</dd>
            </div>
            <div>
              <dt>Net weight</dt>
              <dd className="numeric">{netKg.toFixed(1)} kg</dd>
            </div>
            <div>
              <dt>Rate</dt>
              <dd className="numeric">₹{ratePerQuintal}/quintal</dd>
            </div>
            <div className="slip-amount">
              <dt>Amount</dt>
              <dd className="numeric">{formatRupees(amountPaise)}</dd>
            </div>
            <div>
              <dt>Centre</dt>
              <dd>{centreCode}</dd>
            </div>
          </dl>
          {purchase?.photoUrl && !photoDataUrl && (
            <p className="photo-reference-note">Photo reference: {purchase.photoUrl}</p>
          )}
          {status === 'QUEUED' || status === 'SYNCING' ? (
            <p className="queued-detail-note">
              This purchase is saved locally and will sync when connected.
            </p>
          ) : null}
          {syncedId && !isFlagged && (
            <button
              type="button"
              className="button primary press-depth slip-sms-button"
              onClick={() => setShowSms(true)}
            >
              View SMS slip
            </button>
          )}
        </div>
      </article>
      {showSms && syncedId && (
        <SmsBottomSheet purchaseId={syncedId} onClose={() => setShowSms(false)} />
      )}
    </main>
  );
};

export const OperatorRoleGuard = ({ children }: { children: ReactNode }) => {
  const session = useAuthStore((state) => state.session);
  if (!session) return <Navigate to="/login" replace />;
  if (session.user.role !== 'centre_operator') return <Navigate to="/manager/review" replace />;
  return children;
};

export const OperatorRoutes = () => (
  <OperatorRoleGuard>
    <OperatorShell />
  </OperatorRoleGuard>
);
