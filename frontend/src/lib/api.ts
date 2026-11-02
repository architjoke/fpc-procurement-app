import axios from 'axios';
import { useAuthStore } from './authStore';
import { getSession } from './session';

const baseURL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api/v1';
const api = axios.create({
  baseURL,
  timeout: 15_000,
});
const refreshClient = axios.create({ baseURL, timeout: 15_000 });
let refreshInFlight: Promise<string> | null = null;

api.interceptors.request.use((config) => {
  const session = getSession();
  if (session?.accessToken) {
    config.headers.Authorization = `Bearer ${session.accessToken}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!axios.isAxiosError(error) || error.response?.status !== 401) {
      return Promise.reject(error);
    }

    const request = error.config;
    const session = getSession();
    if (
      !request ||
      request.url?.includes('/auth/login') ||
      request.url?.includes('/auth/refresh') ||
      request.url?.includes('/auth/logout') ||
      !session?.refreshToken
    ) {
      return Promise.reject(error);
    }

    const retryState = request as typeof request & { _retried?: boolean };
    if (retryState._retried) return Promise.reject(error);
    retryState._retried = true;
    try {
      refreshInFlight ??= refreshClient
        .post<{ accessToken: string }>('/auth/refresh', {
          refreshToken: session.refreshToken,
        })
        .then(({ data }) => {
          useAuthStore.getState().setSession({ ...session, accessToken: data.accessToken });
          return data.accessToken;
        })
        .finally(() => {
          refreshInFlight = null;
        });

      const accessToken = await refreshInFlight;
      request.headers.Authorization = `Bearer ${accessToken}`;
      return await api(request);
    } catch (refreshError) {
      useAuthStore.getState().clearSession();
      if (typeof window !== 'undefined') window.location.assign('/login');
      return Promise.reject(refreshError);
    }
  },
);

export { api };
