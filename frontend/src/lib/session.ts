export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  device?: {
    deviceId: string;
    deviceSecret: string;
  };
  user: {
    id: string;
    email: string;
    role: 'centre_operator' | 'office_manager';
    centreId: string | null;
  };
}

const storageKey = 'fpc-auth-session';

export const getSession = (): AuthSession | null => {
  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as AuthSession;
  } catch {
    localStorage.removeItem(storageKey);
    return null;
  }
};

export const saveSession = (session: AuthSession): void => {
  localStorage.setItem(storageKey, JSON.stringify(session));
};

export const clearSession = (): void => {
  localStorage.removeItem(storageKey);
};
