import { create } from 'zustand';
import {
  clearSession as clearStoredSession,
  getSession,
  saveSession,
  type AuthSession,
} from './session';

interface AuthState {
  session: AuthSession | null;
  setSession: (session: AuthSession) => void;
  clearSession: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  session: getSession(),
  setSession: (session) => {
    saveSession(session);
    set({ session });
  },
  clearSession: () => {
    clearStoredSession();
    set({ session: null });
  },
}));
