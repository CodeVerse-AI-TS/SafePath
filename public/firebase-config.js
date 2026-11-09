/* ==========================================================================
   SafePath — Firebase configuration
   --------------------------------------------------------------------------
   SafePath works with NO configuration at all: leave this file as-is and the
   app runs in guest mode. Navigation, routing, hotspots, reports and the
   emergency "Call 112" button all work for guests.

   Signing in is OPTIONAL. To enable accounts + saved emergency contacts:

     1. Create a Firebase project  (see FIREBASE_SETUP.md)
     2. Enable Email/Password and Google sign-in
     3. Create a Firestore database
     4. Paste the config object Firebase gives you below
     5. Add this file's hosting domain under Auth → Settings → Authorised domains

   The apiKey is NOT a secret — it is a public project identifier and is meant
   to be shipped in client code. Your data is protected by the Firestore
   security rules in firestore.rules, not by hiding this key.
   ========================================================================== */
window.SAFEPATH_FIREBASE = {
  apiKey: 'AIzaSyAbFTQ8w_czd6gFUYC3w0YB_SAaWoL5YdU',
  authDomain: 'safepath-4ec9f.firebaseapp.com',
  projectId: 'safepath-4ec9f',
  storageBucket: 'safepath-4ec9f.firebasestorage.app',
  messagingSenderId: '446394587147',
  appId: '1:446394587147:web:4022e23838987bb6ad4f0e',
};

/* Optional: the region your Firestore database lives in. Leave blank for the
   default. Only needed if you created the database outside us-central1. */
window.SAFEPATH_FIRESTORE_REGION = '';
