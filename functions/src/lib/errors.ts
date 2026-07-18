import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';

/** Domain error carrying a user-facing message and a callable error code. */
export class AppError extends Error {
  constructor(
    public code: FunctionsErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }

  toHttpsError(): HttpsError {
    return new HttpsError(this.code, this.message, this.details);
  }
}

export const notSignedIn = () => new AppError('unauthenticated', 'You must be signed in.');
export const notPermitted = (what = 'do this') =>
  new AppError('permission-denied', `You don’t have permission to ${what}.`);
export const accountDisabled = () =>
  new AppError('permission-denied', 'Your account has been disabled. Contact an admin.');
export const notFound = (what: string) => new AppError('not-found', `${what} was not found.`);
export const invalid = (message: string, details?: Record<string, unknown>) =>
  new AppError('invalid-argument', message, details);
