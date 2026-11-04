import { lazy, Suspense, useState, type FormEvent } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../lib/authStore';
import { api } from '../lib/api';
import type { AuthSession } from '../lib/session';

const GrainField = lazy(() => import('../components/GrainField'));

const LoginPage = () => {
  const navigate = useNavigate();
  const setSession = useAuthStore((state) => state.setSession);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const { data } = await api.post<AuthSession>('/auth/login', { email, password });
      setSession(data);
      navigate(data.user.role === 'centre_operator' ? '/operator/find' : '/manager/dashboard', {
        replace: true,
      });
    } catch (loginError) {
      const message =
        axios.isAxiosError(loginError) && typeof loginError.response?.data?.message === 'string'
          ? loginError.response.data.message
          : 'Unable to sign in. Check your connection and try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page relative isolate grid min-h-[calc(100vh-4rem)] place-items-center overflow-hidden px-4 py-8">
      <Suspense fallback={null}>
        <GrainField />
      </Suspense>
      <div className="login-glow login-glow-one" aria-hidden="true" />
      <div className="login-glow login-glow-two" aria-hidden="true" />
      <section className="login-card card-tilt relative z-10 w-full max-w-md rounded-3xl border border-white/80 bg-white/95 p-7 shadow-card backdrop-blur-md sm:p-9">
        <div className="mb-8">
          <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl bg-forest text-2xl text-white shadow-lg shadow-forest/20">
            <span aria-hidden="true">✳</span>
          </div>
          <p className="eyebrow mb-2">Farmers Payment Cooperative</p>
          <h1 className="text-3xl font-bold tracking-tight text-ink">Welcome back</h1>
          <p className="mt-2 text-sm leading-6 text-muted">
            Sign in to manage procurement at your centre.
          </p>
        </div>

        <form className="grid gap-5" onSubmit={(event) => void handleSubmit(event)}>
          <label className="field-label">
            Email address
            <input
              className="field-input min-h-12"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@cooperative.in"
              required
            />
          </label>
          <label className="field-label">
            Password
            <input
              className="field-input min-h-12"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          {error && (
            <p className="error rounded-xl bg-red-50 px-4 py-3 text-sm" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="button primary min-h-12 w-full press-depth"
            disabled={submitting}
          >
            {submitting ? 'Signing in…' : 'Sign in securely'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs leading-5 text-muted">
          Your role and centre access are verified securely.
        </p>
      </section>
    </main>
  );
};

export default LoginPage;
