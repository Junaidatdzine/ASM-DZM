import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  browserPopupRedirectResolver,
  connectAuthEmulator,
  initializeAuth,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectStorageEmulator, getStorage } from 'firebase/storage';

/** Must match REGION in functions/src/config.ts. */
export const FUNCTIONS_REGION = 'us-central1';

export const usingEmulators = import.meta.env.VITE_USE_EMULATORS === '1';

const config = usingEmulators
  ? {
      // Offline demo project — never talks to production services.
      apiKey: 'demo-api-key',
      authDomain: 'demo-asm.firebaseapp.com',
      projectId: 'demo-asm',
      storageBucket: 'demo-asm.appspot.com',
      appId: 'demo-app-id',
    }
  : {
      apiKey: import.meta.env.VITE_FB_API_KEY,
      authDomain: import.meta.env.VITE_FB_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FB_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FB_STORAGE_BUCKET,
      messagingSenderId: import.meta.env.VITE_FB_MESSAGING_SENDER_ID,
      appId: import.meta.env.VITE_FB_APP_ID,
    };

export const app = initializeApp(config);

export const auth = initializeAuth(app, {
  persistence: browserLocalPersistence,
  popupRedirectResolver: browserPopupRedirectResolver,
});

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

export const functions = getFunctions(app, FUNCTIONS_REGION);
export const storage = getStorage(app);

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

if (usingEmulators) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  connectStorageEmulator(storage, '127.0.0.1', 9199);
}
