import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { api } from './lib/api';
import { getSession, saveSession, clearSession, type AuthSession } from './lib/session';
import { useAuthStore } from './lib/authStore';
import LoginPage from './pages/LoginPage';
import {
  FindFarmerPage,
  OperatorRoutes,
  PurchaseDetailPage,
  PurchaseWizardPage,
} from './pages/OperatorFlow';
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

interface FlaggedPurchase {
  id: string;
  flagReason: string | null;
  createdAt: string;
  amountPaise: number;
  farmer: { memberId: string; name: string };
  crop: { name: string };
  photoUrl: string | null;
  ocrJobs: Array<{ id: string; imageData: string | null }>;
}

interface ApprovedPurchase {
  id: string;
  grade: string;
  netKg: number | string;
  amountPaise: number;
  farmer: { memberId: string; name: string };
  crop: { name: string };
}

interface PaymentRunSummary {
  id: string;
  status: 'DRAFT' | 'APPROVED' | 'EXPORTED';
  runDate: string;
  totalAmountPaise: number;
  _count?: { paymentItems: number };
}

interface PaymentRunDetail extends Omit<PaymentRunSummary, '_count'> {
  paymentItems: Array<{
    id: string;
    status: string;
    purchase: {
      id: string;
      grade: string;
      netKg: number | string;
      amountPaise: number;
      status: string;
      farmer: { memberId: string; name: string };
      crop: { name: string };
    };
  }>;
}

interface PriceBoardEntry extends Price {
  id: string;
}

interface DashboardSummary {
  purchasesToday: number;
  pendingPaymentAmountPaise: number;
  centres: Array<{ id: string; name: string; purchaseCount: number }>;
}

interface PriceDraft {
  cropId: string;
  grade: string;
  ratePerQuintal: string;
  effectiveDate: string;
}

const formatPaise = (amountPaise: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amountPaise / 100);

const ManagerReview = () => {
  const [purchases, setPurchases] = useState<FlaggedPurchase[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState('');
  const [error, setError] = useState('');

  const loadFlagged = async (targetPage: number) => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get<{
        data: FlaggedPurchase[];
        pagination: { pages: number };
      }>('/purchases', { params: { status: 'FLAGGED', page: targetPage, pageSize: 20 } });
      setPurchases(data.data);
      setPages(data.pagination.pages);
      setPage(targetPage);
    } catch (loadError) {
      console.error('Unable to load flagged purchases:', loadError);
      setError('Could not load flagged purchases. Please retry.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadFlagged(1);
  }, []);

  const review = async (purchaseId: string, action: 'approve' | 'reject') => {
    const reason = reasons[purchaseId]?.trim();
    if (!reason) {
      setError('Enter a review reason before approving or rejecting a purchase.');
      return;
    }
    setActingId(purchaseId);
    setError('');
    try {
      await api.patch(`/purchases/${purchaseId}/review`, { action, reason });
      setReasons((current) => {
        const next = { ...current };
        delete next[purchaseId];
        return next;
      });
      await loadFlagged(page);
    } catch (reviewError) {
      console.error('Unable to review flagged purchase:', reviewError);
      setError('Could not save this review. Please retry.');
    } finally {
      setActingId('');
    }
  };

  return (
    <main className="shell">
      <section className="card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Manager review</p>
            <h2>Flagged purchases</h2>
          </div>
          <button className="button secondary" onClick={() => void loadFlagged(page)}>
            Refresh
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {loading ? (
          <p>Loading flagged purchases…</p>
        ) : purchases.length === 0 ? (
          <p>No purchases are waiting for review.</p>
        ) : (
          <ul className="review-list">
            {purchases.map((purchase) => (
              <li key={purchase.id} className="review-item">
                {purchase.ocrJobs.find((job) => job.imageData)?.imageData && (
                  <img
                    className="review-thumbnail"
                    src={purchase.ocrJobs.find((job) => job.imageData)?.imageData ?? ''}
                    alt={`OCR image for ${purchase.farmer.name}`}
                  />
                )}
                <div className="review-details">
                  <strong>
                    {purchase.farmer.memberId} — {purchase.farmer.name}
                  </strong>
                  <span>
                    {purchase.crop.name} · ₹{(purchase.amountPaise / 100).toFixed(2)}
                  </span>
                  <small>{purchase.flagReason ?? 'Flagged for manager review.'}</small>
                  <label>
                    Review reason
                    <input
                      value={reasons[purchase.id] ?? ''}
                      onChange={(event) =>
                        setReasons((current) => ({ ...current, [purchase.id]: event.target.value }))
                      }
                      required
                      placeholder="Required for approval or rejection"
                    />
                  </label>
                  <div className="actions review-actions">
                    <button
                      className="button primary"
                      disabled={actingId === purchase.id}
                      onClick={() => void review(purchase.id, 'approve')}
                    >
                      Approve
                    </button>
                    <button
                      className="button danger"
                      disabled={actingId === purchase.id}
                      onClick={() => void review(purchase.id, 'reject')}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {pages > 1 && (
          <div className="actions">
            <button
              className="button secondary"
              disabled={page <= 1}
              onClick={() => void loadFlagged(page - 1)}
            >
              Previous
            </button>
            <span>
              Page {page} of {pages}
            </span>
            <button
              className="button secondary"
              disabled={page >= pages}
              onClick={() => void loadFlagged(page + 1)}
            >
              Next
            </button>
          </div>
        )}
      </section>
    </main>
  );
};

const ManagerDashboard = () => {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadSummary = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get<{ data: DashboardSummary }>('/dashboard/summary');
      setSummary(data.data);
    } catch (loadError) {
      console.error('Unable to load manager dashboard:', loadError);
      setError('Could not load the dashboard. Please retry.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSummary();
  }, []);

  return (
    <main className="shell">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Operations overview</p>
          <h1>Manager dashboard</h1>
        </div>
        <button className="button secondary" onClick={() => void loadSummary()} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">Loading dashboard…</p>
      ) : !summary ? (
        <p>The dashboard summary is unavailable.</p>
      ) : (
        <>
          <section className="dashboard-metrics" aria-label="Procurement summary">
            <article className="card dashboard-stat">
              <p className="eyebrow">Purchases today</p>
              <strong className="dashboard-value">
                {summary.purchasesToday.toLocaleString('en-IN')}
              </strong>
            </article>
            <article className="card dashboard-stat">
              <p className="eyebrow">Pending payment</p>
              <strong className="dashboard-value">
                {formatPaise(summary.pendingPaymentAmountPaise)}
              </strong>
            </article>
          </section>
          <section className="card dashboard-centres">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Centre activity</p>
                <h2>Procurement by centre</h2>
              </div>
            </div>
            {summary.centres.length === 0 ? (
              <p>No centres are configured yet.</p>
            ) : (
              <ul className="centre-summary-list">
                {summary.centres.map((centre) => (
                  <li key={centre.id}>
                    <strong>{centre.name}</strong>
                    <span>{centre.purchaseCount.toLocaleString('en-IN')} purchases</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
};

const ManagerPriceBoard = () => {
  const [entries, setEntries] = useState<PriceBoardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState<PriceDraft>({
    cropId: '',
    grade: '',
    ratePerQuintal: '',
    effectiveDate: new Date().toISOString().slice(0, 10),
  });
  const [editDraft, setEditDraft] = useState<PriceDraft | null>(null);

  const loadEntries = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get<{ data: PriceBoardEntry[] }>('/price-board');
      setEntries(data.data);
      setDraft((current) => ({
        ...current,
        cropId: current.cropId || data.data[0]?.cropId || '',
      }));
    } catch (loadError) {
      console.error('Unable to load manager price board:', loadError);
      setError('Could not load the price board. Please retry.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadEntries();
  }, []);

  const crops = Array.from(new Map(entries.map((entry) => [entry.cropId, entry.crop])).values());

  const getRequestError = (requestError: unknown, fallback: string) =>
    axios.isAxiosError(requestError) && typeof requestError.response?.data?.message === 'string'
      ? requestError.response.data.message
      : fallback;

  const createEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.post('/price-board', {
        cropId: draft.cropId,
        grade: draft.grade,
        ratePerQuintal: Number(draft.ratePerQuintal),
        effectiveDate: draft.effectiveDate,
      });
      setDraft((current) => ({ ...current, grade: '', ratePerQuintal: '' }));
      setNotice('Price added to the board.');
      await loadEntries();
    } catch (requestError) {
      console.error('Unable to create price board entry:', requestError);
      setError(getRequestError(requestError, 'Could not add this price. Please retry.'));
    } finally {
      setSaving(false);
    }
  };

  const startEditing = (entry: PriceBoardEntry) => {
    setEditingId(entry.id);
    setEditDraft({
      cropId: entry.cropId,
      grade: entry.grade,
      ratePerQuintal: String(entry.ratePerQuintal),
      effectiveDate: new Date(entry.effectiveDate).toISOString().slice(0, 10),
    });
    setError('');
    setNotice('');
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingId || !editDraft) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await api.put(`/price-board/${editingId}`, {
        cropId: editDraft.cropId,
        grade: editDraft.grade,
        ratePerQuintal: Number(editDraft.ratePerQuintal),
        effectiveDate: editDraft.effectiveDate,
      });
      setEditingId('');
      setEditDraft(null);
      setNotice('Price updated.');
      await loadEntries();
    } catch (requestError) {
      console.error('Unable to update price board entry:', requestError);
      setError(getRequestError(requestError, 'Could not update this price. Please retry.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="shell">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Manager controls</p>
          <h1>Daily price board</h1>
          <p>
            Set a crop and grade rate for an effective date. A date can have only one rate per crop
            and grade.
          </p>
        </div>
        <button className="button secondary" onClick={() => void loadEntries()} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="success" role="status">
          {notice}
        </p>
      )}
      <section className="card price-board-form">
        <h2>Add a price</h2>
        {loading ? (
          <p role="status">Loading crops and current prices…</p>
        ) : crops.length === 0 ? (
          <p>No crops are available from the current price board.</p>
        ) : (
          <form className="form-grid" onSubmit={(event) => void createEntry(event)}>
            <label>
              Crop
              <select
                value={draft.cropId}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, cropId: event.target.value }))
                }
                required
              >
                {crops.map((crop) => (
                  <option key={crop.id} value={crop.id}>
                    {crop.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Grade
              <input
                value={draft.grade}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, grade: event.target.value }))
                }
                maxLength={20}
                required
              />
            </label>
            <label>
              Rate per quintal (₹)
              <input
                type="number"
                min="1"
                step="1"
                value={draft.ratePerQuintal}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, ratePerQuintal: event.target.value }))
                }
                required
              />
            </label>
            <label>
              Effective date
              <input
                type="date"
                value={draft.effectiveDate}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, effectiveDate: event.target.value }))
                }
                required
              />
            </label>
            <button type="submit" className="button primary full-span" disabled={saving}>
              {saving ? 'Saving…' : 'Add price'}
            </button>
          </form>
        )}
      </section>
      <section className="card price-board-list">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Current and scheduled rates</p>
            <h2>Price entries</h2>
          </div>
        </div>
        {loading ? (
          <p role="status">Loading price entries…</p>
        ) : entries.length === 0 ? (
          <p>No prices are configured yet.</p>
        ) : (
          <ul className="price-entry-list">
            {entries.map((entry) => (
              <li key={entry.id} className="price-entry">
                {editingId === entry.id && editDraft ? (
                  <form className="price-edit-form" onSubmit={(event) => void saveEdit(event)}>
                    <label>
                      Crop
                      <select
                        value={editDraft.cropId}
                        onChange={(event) =>
                          setEditDraft((current) =>
                            current ? { ...current, cropId: event.target.value } : current,
                          )
                        }
                      >
                        {crops.map((crop) => (
                          <option key={crop.id} value={crop.id}>
                            {crop.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Grade
                      <input
                        value={editDraft.grade}
                        onChange={(event) =>
                          setEditDraft((current) =>
                            current ? { ...current, grade: event.target.value } : current,
                          )
                        }
                        maxLength={20}
                        required
                      />
                    </label>
                    <label>
                      Rate per quintal (₹)
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={editDraft.ratePerQuintal}
                        onChange={(event) =>
                          setEditDraft((current) =>
                            current ? { ...current, ratePerQuintal: event.target.value } : current,
                          )
                        }
                        required
                      />
                    </label>
                    <label>
                      Effective date
                      <input
                        type="date"
                        value={editDraft.effectiveDate}
                        onChange={(event) =>
                          setEditDraft((current) =>
                            current ? { ...current, effectiveDate: event.target.value } : current,
                          )
                        }
                        required
                      />
                    </label>
                    <div className="actions price-entry-actions">
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => setEditingId('')}
                      >
                        Cancel
                      </button>
                      <button type="submit" className="button primary" disabled={saving}>
                        {saving ? 'Saving…' : 'Save changes'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div>
                      <strong>
                        {entry.crop.name} · Grade {entry.grade}
                      </strong>
                      <small>Effective {new Date(entry.effectiveDate).toLocaleDateString()}</small>
                    </div>
                    <strong>{formatPaise(entry.ratePerQuintal * 100)} / quintal</strong>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => startEditing(entry)}
                    >
                      Edit
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
};

const PaymentManagement = () => {
  const [eligiblePurchases, setEligiblePurchases] = useState<ApprovedPurchase[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [runs, setRuns] = useState<PaymentRunSummary[]>([]);
  const [runPage, setRunPage] = useState(1);
  const [runPages, setRunPages] = useState(1);
  const [runDetail, setRunDetail] = useState<PaymentRunDetail | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  const loadEligible = async () => {
    try {
      const { data } = await api.get<{ data: ApprovedPurchase[] }>('/purchases', {
        params: { status: 'APPROVED' },
      });
      setEligiblePurchases(data.data);
      setSelectedIds((current) => current.filter((id) => data.data.some((item) => item.id === id)));
    } catch (loadError) {
      console.error('Unable to load payment-eligible purchases:', loadError);
      setError('Could not load approved purchases. Please retry.');
    }
  };

  const loadRuns = async (targetPage: number) => {
    try {
      const { data } = await api.get<{
        data: PaymentRunSummary[];
        pagination: { pages: number };
      }>('/payment-runs', { params: { page: targetPage, pageSize: 10 } });
      setRuns(data.data);
      setRunPages(data.pagination.pages);
      setRunPage(targetPage);
    } catch (loadError) {
      console.error('Unable to load payment runs:', loadError);
      setError('Could not load payment runs. Please retry.');
    }
  };

  const loadDetail = async (runId: string) => {
    try {
      const { data } = await api.get<{ data: PaymentRunDetail }>(`/payment-runs/${runId}`);
      setRunDetail(data.data);
    } catch (loadError) {
      console.error('Unable to load payment run details:', loadError);
      setError('Could not load the payment run. Please retry.');
    }
  };

  useEffect(() => {
    void Promise.all([loadEligible(), loadRuns(1)]).finally(() => setLoading(false));
  }, []);

  const selectedTotal = eligiblePurchases
    .filter((purchase) => selectedIds.includes(purchase.id))
    .reduce((total, purchase) => total + purchase.amountPaise, 0);

  const togglePurchase = (purchaseId: string) => {
    setSelectedIds((current) =>
      current.includes(purchaseId)
        ? current.filter((id) => id !== purchaseId)
        : [...current, purchaseId],
    );
  };

  const createRun = async () => {
    setWorking(true);
    setError('');
    try {
      const { data } = await api.post<{ data: PaymentRunSummary }>('/payment-runs', {
        purchase_ids: selectedIds,
      });
      setSelectedIds([]);
      setConfirming(false);
      await Promise.all([loadEligible(), loadRuns(1), loadDetail(data.data.id)]);
    } catch (createError) {
      console.error('Unable to create payment run:', createError);
      setError('Could not create the payment run. Refresh and check purchase eligibility.');
    } finally {
      setWorking(false);
    }
  };

  const approveRun = async () => {
    if (!runDetail) return;
    setWorking(true);
    setError('');
    try {
      await api.patch(`/payment-runs/${runDetail.id}/approve`);
      await Promise.all([loadDetail(runDetail.id), loadRuns(runPage)]);
    } catch (approveError) {
      console.error('Unable to approve payment run:', approveError);
      setError('Could not approve this payment run. Please refresh and retry.');
    } finally {
      setWorking(false);
    }
  };

  const exportRun = async () => {
    if (!runDetail) return;
    setWorking(true);
    setError('');
    try {
      const { data } = await api.get<Blob>(`/payment-runs/${runDetail.id}/export`, {
        responseType: 'blob',
      });
      const url = URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = url;
      link.download = `payment-run-${runDetail.id}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      await Promise.all([loadDetail(runDetail.id), loadRuns(runPage), loadEligible()]);
    } catch (exportError) {
      console.error('Unable to export payment run:', exportError);
      setError('Could not export this payment run. Please retry.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="shell">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="payment-grid">
        <section className="card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Payment preparation</p>
              <h2>Approved purchases</h2>
            </div>
            <button
              className="button secondary"
              onClick={() => void loadEligible()}
              disabled={working}
            >
              Refresh
            </button>
          </div>
          {loading ? (
            <p>Loading approved purchases…</p>
          ) : eligiblePurchases.length === 0 ? (
            <p>No approved purchases are eligible for a payment run.</p>
          ) : (
            <ul className="payment-purchase-list">
              {eligiblePurchases.map((purchase) => (
                <li key={purchase.id} className="payment-purchase">
                  <label className="payment-purchase-choice">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(purchase.id)}
                      onChange={() => togglePurchase(purchase.id)}
                    />
                    <span>
                      <strong>
                        {purchase.farmer.memberId} — {purchase.farmer.name}
                      </strong>
                      <small>
                        {purchase.crop.name} · Grade {purchase.grade} ·{' '}
                        {Number(purchase.netKg).toFixed(1)} kg
                      </small>
                    </span>
                    <strong>{formatPaise(purchase.amountPaise)}</strong>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {selectedIds.length > 0 && (
            <div className="payment-summary">
              <p>
                Selected: <strong>{selectedIds.length} purchases</strong> · Total:{' '}
                <strong>{formatPaise(selectedTotal)}</strong>
              </p>
              <button
                className="button primary"
                onClick={() => setConfirming(true)}
                disabled={working}
              >
                Review payment run
              </button>
            </div>
          )}
          {confirming && (
            <div className="confirmation-panel">
              <h3>Confirm payment run</h3>
              <p>
                This run includes {selectedIds.length} purchases totaling{' '}
                <strong>{formatPaise(selectedTotal)}</strong>.
              </p>
              <div className="actions">
                <button
                  className="button secondary"
                  onClick={() => setConfirming(false)}
                  disabled={working}
                >
                  Cancel
                </button>
                <button
                  className="button primary"
                  onClick={() => void createRun()}
                  disabled={working}
                >
                  {working ? 'Creating…' : 'Confirm and create'}
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Run history</p>
              <h2>Payment runs</h2>
            </div>
            <button className="button secondary" onClick={() => void loadRuns(runPage)}>
              Refresh
            </button>
          </div>
          {loading ? (
            <p>Loading payment runs…</p>
          ) : runs.length === 0 ? (
            <p>No payment runs have been created.</p>
          ) : (
            <ul className="payment-run-list">
              {runs.map((run) => (
                <li key={run.id}>
                  <button
                    className={`payment-run-link${runDetail?.id === run.id ? ' selected' : ''}`}
                    onClick={() => void loadDetail(run.id)}
                  >
                    <span>
                      <strong>{run.id}</strong>
                      <small>
                        {new Date(run.runDate).toLocaleDateString()} ·{' '}
                        {run._count?.paymentItems ?? 0} purchases
                      </small>
                    </span>
                    <span>
                      <strong>{formatPaise(run.totalAmountPaise)}</strong>
                      <small className={`run-status ${run.status.toLowerCase()}`}>
                        {run.status}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {runPages > 1 && (
            <div className="actions">
              <button
                className="button secondary"
                disabled={runPage <= 1}
                onClick={() => void loadRuns(runPage - 1)}
              >
                Previous
              </button>
              <span>
                Page {runPage} of {runPages}
              </span>
              <button
                className="button secondary"
                disabled={runPage >= runPages}
                onClick={() => void loadRuns(runPage + 1)}
              >
                Next
              </button>
            </div>
          )}
        </section>
      </div>

      {runDetail && (
        <section className="card payment-run-detail">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Payment run detail</p>
              <h2>{runDetail.id}</h2>
              <p>
                {runDetail.status} · {formatPaise(runDetail.totalAmountPaise)}
              </p>
            </div>
            <div className="actions">
              {runDetail.status === 'DRAFT' && (
                <button
                  className="button primary"
                  onClick={() => void approveRun()}
                  disabled={working}
                >
                  Approve run
                </button>
              )}
              {(runDetail.status === 'APPROVED' || runDetail.status === 'EXPORTED') && (
                <button
                  className="button secondary"
                  onClick={() => void exportRun()}
                  disabled={working}
                >
                  {runDetail.status === 'EXPORTED' ? 'Download CSV again' : 'Export CSV'}
                </button>
              )}
            </div>
          </div>
          {runDetail.paymentItems.length === 0 ? (
            <p>This payment run has no line items.</p>
          ) : (
            <ul className="payment-line-list">
              {runDetail.paymentItems.map((item) => (
                <li key={item.id}>
                  <div>
                    <strong>
                      {item.purchase.farmer.memberId} — {item.purchase.farmer.name}
                    </strong>
                    <small>
                      {item.purchase.crop.name} · Grade {item.purchase.grade} ·{' '}
                      {Number(item.purchase.netKg).toFixed(1)} kg
                    </small>
                  </div>
                  <strong>{formatPaise(item.purchase.amountPaise)}</strong>
                  <span className={`run-status ${item.purchase.status.toLowerCase()}`}>
                    {item.purchase.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
};

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
  const [flaggedReason, setFlaggedReason] = useState('');
  const [smsPurchaseId, setSmsPurchaseId] = useState('');
  const [smsPreviewOpen, setSmsPreviewOpen] = useState(false);
  const [smsMessage, setSmsMessage] = useState('');
  const [smsError, setSmsError] = useState('');
  const [smsLoading, setSmsLoading] = useState(false);
  const [smsCopied, setSmsCopied] = useState(false);
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

  const openSmsSlip = async (purchaseId: string) => {
    setSmsPreviewOpen(true);
    setSmsLoading(true);
    setSmsError('');
    setSmsMessage('');
    setSmsCopied(false);
    try {
      const { data } = await api.get<{
        data: { messageMarathi: string; status: string };
      }>(`/sms/${encodeURIComponent(purchaseId)}`);
      setSmsMessage(data.data.messageMarathi);
    } catch (previewError) {
      setSmsError(
        axios.isAxiosError(previewError) && previewError.response?.data?.message
          ? String(previewError.response.data.message)
          : 'Unable to load the SMS slip.',
      );
    } finally {
      setSmsLoading(false);
    }
  };

  const copySmsSlip = async () => {
    try {
      await navigator.clipboard.writeText(smsMessage);
      setSmsCopied(true);
      setSmsError('');
    } catch (copyError) {
      console.error('Unable to copy SMS slip:', copyError);
      setSmsError('Could not copy the slip. Select and copy the text manually.');
    }
  };

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
      setSmsPurchaseId(result.status === 'SAVED' ? (result.purchaseId ?? '') : '');
      setNotice(
        result.status === 'QUEUED'
          ? 'Saved securely for offline sync.'
          : result.status === 'FLAGGED'
            ? 'Purchase saved and flagged for manager review.'
            : 'Purchase saved.',
      );
      setFlaggedReason(result.status === 'FLAGGED' ? (result.flagReason ?? '') : '');
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
            {flaggedReason && (
              <p className="flag-banner" role="status">
                Under review by procurement manager. {flaggedReason}
              </p>
            )}
            {notice && (
              <p className="success full-span" role="status">
                {notice}
              </p>
            )}
            {smsPurchaseId && (
              <button
                type="button"
                className="button secondary full-span"
                onClick={() => void openSmsSlip(smsPurchaseId)}
              >
                View SMS Slip
              </button>
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
                {entry.status === 'FLAGGED' && (
                  <strong className="flag-banner">Under review by procurement manager</strong>
                )}
                {entry.status === 'REJECTED' && (
                  <button className="text-button" onClick={() => void retry(entry.uuid)}>
                    Retry
                  </button>
                )}
                {entry.status === 'SYNCED' && entry.purchaseId && (
                  <button
                    className="text-button"
                    onClick={() => {
                      if (entry.purchaseId) void openSmsSlip(entry.purchaseId);
                    }}
                  >
                    View SMS Slip
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      {smsPreviewOpen && (
        <div className="modal-backdrop" onClick={() => setSmsPreviewOpen(false)}>
          <section
            className="card sms-preview"
            role="dialog"
            aria-modal="true"
            aria-labelledby="sms-preview-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="section-heading">
              <h2 id="sms-preview-title">SMS Slip Preview</h2>
              <button
                type="button"
                className="text-button"
                onClick={() => setSmsPreviewOpen(false)}
              >
                Close
              </button>
            </div>
            {smsLoading ? (
              <p>Loading SMS slip…</p>
            ) : smsError ? (
              <p className="error" role="alert">
                {smsError}
              </p>
            ) : (
              <>
                <p className="sms-preview-message" lang="mr">
                  {smsMessage}
                </p>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void copySmsSlip()}
                >
                  {smsCopied ? 'Copied' : 'Copy'}
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </main>
  );
};

export default function App() {
  const session = useAuthStore((state) => state.session);
  const clearAuthSession = useAuthStore((state) => state.clearSession);
  const navigate = useNavigate();

  const logout = async () => {
    if (session?.refreshToken) {
      try {
        await api.post('/auth/logout', { refreshToken: session.refreshToken });
      } catch {
        // Local sign-out must still work when offline.
      }
    }
    clearAuthSession();
    navigate('/');
  };

  const operatorHome = session
    ? session.user.role === 'centre_operator'
      ? '/operator/find'
      : '/manager/dashboard'
    : '/login';

  return (
    <div>
      <nav className="topbar">
        <Link to="/">Home</Link>
        {!session && <Link to="/login">Login</Link>}
        {session?.user.role === 'centre_operator' && <Link to="/operator/find">Find farmer</Link>}
        {session?.user.role === 'office_manager' && (
          <>
            <Link to="/manager/dashboard">Dashboard</Link>
            <Link to="/manager/review">Flagged review</Link>
            <Link to="/manager/prices">Price board</Link>
            <Link to="/manager/payments">Payment runs</Link>
          </>
        )}
        {session && (
          <button className="text-button" onClick={() => void logout()}>
            Sign out
          </button>
        )}
      </nav>
      <Routes>
        <Route path="/" element={session ? <Navigate to={operatorHome} replace /> : <Home />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/operator" element={<OperatorRoutes />}>
          <Route index element={<Navigate to="find" replace />} />
          <Route path="find" element={<FindFarmerPage />} />
          <Route path="purchase/new" element={<PurchaseWizardPage />} />
          <Route path="purchase/:id" element={<PurchaseDetailPage />} />
        </Route>
        <Route path="/manager" element={<ManagerRoleGuard />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<ManagerDashboard />} />
          <Route path="review" element={<ManagerReview />} />
          <Route path="prices" element={<ManagerPriceBoard />} />
          <Route path="payments" element={<PaymentManagement />} />
        </Route>
        <Route path="/purchases" element={<Navigate to={operatorHome} replace />} />
        <Route path="/review" element={<Navigate to="/manager/review" replace />} />
        <Route path="/payments" element={<Navigate to="/manager/payments" replace />} />
      </Routes>
    </div>
  );
}

const ManagerRoleGuard = () => {
  const session = useAuthStore((state) => state.session);
  if (!session) return <Navigate to="/login" replace />;
  if (session.user.role !== 'office_manager') return <Navigate to="/operator/find" replace />;
  return <Outlet />;
};
