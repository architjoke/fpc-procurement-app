export const getJwtSecret = (
  variableName: 'JWT_SECRET' | 'JWT_REFRESH_SECRET',
  developmentFallback: string,
): string => {
  const secret = process.env[variableName];
  if (secret) {
    return secret;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${variableName} must be configured in production.`);
  }

  return developmentFallback;
};
