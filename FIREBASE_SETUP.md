# SafePath — Firebase setup (optional accounts)

SafePath works with **no account and no Firebase**. This guide is only needed
if you want to turn on the optional "save emergency contacts" feature.

Nothing in this guide is required for navigation. If you stop halfway, or
skip it entirely, the app still works — guests get every navigation feature
and a working **Call 112** button.

---

## 1. Create the project

1. Go to <https://console.firebase.google.com/> and click **Add project**.
2. Name it (e.g. `safepath`). Google Analytics is optional — you can skip it.
3. Wait for the project to be created, then **Continue**.

## 2. Register a web app

1. On the project overview, click the **web** icon (`</>`).
2. Nickname it `SafePath web`. **Do not** tick Firebase Hosting.
3. Click **Register app**. Firebase shows a `firebaseConfig` object:

   ```js
   const firebaseConfig = {
     apiKey: "AIza…",
     authDomain: "safepath-xxxxx.firebaseapp.com",
     projectId: "safepath-xxxxx",
     storageBucket: "safepath-xxxxx.appspot.com",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abcdef"
   };
   ```

4. Paste those values into **`public/firebase-config.js`**, replacing the
   `YOUR_…` placeholders. Leave the file as-is to keep running as a guest.

> The `apiKey` is **not a secret**. It identifies your project publicly and is
> meant to ship in browser code. Your data is protected by the Firestore
> security rules, not by hiding this key.

## 3. Enable sign-in methods

1. **Build → Authentication → Get started**.
2. **Sign-in method** tab → enable **Email/Password** → **Save**.
3. Still on **Sign-in method**, enable **Google**:
   - Pick a support email.
   - **Save**.
4. Go to the **Settings** tab → **Authorised domains** → **Add domain**.
   Add every hostname you serve the app from, for example:
   - `localhost` (already present — needed for local testing)
   - `your-app.example.com`
   - your `*.prod-runtime.all-hands.dev` preview host, if you use one

   Google sign-in fails with `auth/unauthorized-domain` until the domain is
   listed here.

## 4. Create the database

1. **Build → Firestore Database → Create database**.
2. Choose **Production mode** (the rules below replace the defaults).
3. Pick a location close to your users (e.g. `asia-south1` for India).
4. Click **Create**.

   If you chose a region other than the default, set it in
   `public/firebase-config.js`:

   ```js
   window.SAFEPATH_FIRESTORE_REGION = 'asia-south1';
   ```

## 5. Deploy the security rules

The rules in `firestore.rules` are what stop one user reading another user's
contacts. **Without them the database is either wide open or unusable.**

Paste them by hand:

1. **Firestore Database → Rules** tab.
2. Replace the contents with the whole of `firestore.rules`.
3. Click **Publish**.

Or deploy from the command line:

```bash
npm install -g firebase-tools
firebase login
firebase init firestore      # point it at this repo; keep the rules filename
firebase deploy --only firestore:rules
```

### What the rules allow

| Path | Who | What |
|---|---|---|
| `users/{uid}` | only that user | read/write their own profile |
| `users/{uid}/contacts/{id}` | only that user | read, create, update, delete their own contacts |
| anything else | nobody | denied by default |

Each contact write is also shape-checked: only `name`, `phone`,
`relationship` and `created_at` are accepted, with length limits. A client
cannot stuff arbitrary fields into the collection.

## 6. Test it

Restart the server (`npm start`) so the browser picks up the new
`firebase-config.js`, then open the app and:

1. Click **Sign in** in the header.
2. **Create account** with a real email you can access.
3. Check the Firebase console → **Authentication → Users** — your user appears.
4. **Account → Emergency contacts → Add contact**. Check
   **Firestore Database → Data** — the document is at
   `users/<your-uid>/contacts/<id>`.
5. Sign out and back in. The contact is still there.

Full manual checklist: `TEST_CHECKLIST.md`.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Accounts are not configured on this deployment." | `firebase-config.js` still has `YOUR_…` placeholders. |
| `auth/unauthorized-domain` | The hostname is not in **Authentication → Settings → Authorised domains**. |
| `auth/operation-not-allowed` | Email/Password or Google is not enabled in the **Sign-in method** tab. |
| "Permission denied — check your Firestore security rules." | The rules were not published, or were replaced by the permissive defaults. |
| `auth/requires-recent-login` on delete | Firebase asks for a fresh sign-in before account deletion. Sign out, sign in, then delete. |
| Contacts vanish on reload | The security rules are blocking reads — republish `firestore.rules`. |

---

## How this works in the app

- `public/firebase-config.js` — your project keys. Guest mode when unset.
- `public/auth.js` — Firebase Auth + Firestore calls. Loads the SDK **lazily**,
  only when someone asks to sign in, so guests never download it.
- `public/auth-ui.js` — welcome card, header, contacts manager, emergency panel.
- `firestore.rules` — the access control that actually protects user data.

## Production notes

- **Rate limiting and abuse:** Firebase Auth already throttles repeated failed
  sign-ins. If you expose the app publicly, also enable **App Check** to stop
  scripted abuse of your Firestore quota.
- **Email verification:** `auth.js` does not require a verified email. Add
  `sendEmailVerification` after `signUp` if you need it.
- **Deleting the account** removes the user's contact documents first, then
  the account. If the account deletion is interrupted, the contacts are
  already gone, so no orphaned personal data is left behind.
- **Data location:** pick the Firestore region deliberately. Cross-border
  storage of personal data may have legal implications where you operate.
