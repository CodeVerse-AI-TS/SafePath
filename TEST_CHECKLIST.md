# SafePath — accounts & emergency test checklist

Two ways to check this work:

- **Automated:** `npm run test:auth` — 46 checks covering the whole flow below,
  with the Firebase SDK stubbed at the network boundary. Every line of
  `auth.js` and `auth-ui.js` under test is the real application code.
- **Manual:** the checklist below, against a real Firebase project
  (see `FIREBASE_SETUP.md`).

The manual pass matters because it exercises the parts a stub cannot: real
Firebase auth, real Firestore, and the real security rules.

---

## Before you start

```bash
npm run seed && npm run ds:build   # only if you have not already
npm start                          # http://localhost:3000
```

Have `public/firebase-config.js` filled in for the signed-in sections.
Use **two different email addresses** so you can prove data isolation.

---

## 1. Guest flow (no account)

| # | Step | Expected |
|---|---|---|
| 1.1 | Open the app in a fresh browser profile | A welcome card appears with **Sign in**, **Create account**, **Skip — continue as guest** |
| 1.2 | Press **Skip** | Card closes; the app is fully usable |
| 1.3 | Reload the page | The welcome card does **not** reappear |
| 1.4 | Go to **Safe Routes**, enter two Mysuru places, search | 3 route cards appear with safety scores |
| 1.5 | Toggle **Walk / Cycle / Drive** | Routes and scores update |
| 1.6 | Start navigation, then end it | Turn list, map and summary all work |
| 1.7 | Submit a report | The report appears on the map and in Live Alerts |
| 1.8 | Check the header | A **Sign in** button is present |
| 1.9 | Confirm no sign-in prompt blocked any step above | Nothing was ever gated |

**A guest must never be interrupted or blocked.**

## 2. Emergency as a guest

| # | Step | Expected |
|---|---|---|
| 2.1 | Go to **Live Alerts** | The Emergency panel is visible |
| 2.2 | Look at the contacts area | "Sign in to save emergency contacts", with a **Sign in** button |
| 2.3 | Look at the top of the emergency panel | **Call 112** is the first control; tappable, opens the dialler (`tel:112`) |
| 2.3b | Read below Call 112 | The heading "Choose how to alert your contacts" is present |
| 2.4 | Hold the panic button for 2 seconds | The alert flow runs and reports its real delivery status |
| 2.5 | Read the wording | It never claims a message was sent unless a channel was configured |
| 2.6 | Check nothing else on the page is disabled | Navigation, reports and the map all still work |

## 3. Create account

| # | Step | Expected |
|---|---|---|
| 3.1 | **Sign in → Create account**, enter a new email + password (6+ chars) | Account is created and you are signed in |
| 3.2 | Check Firebase console → Authentication → Users | The new user is listed |
| 3.3 | Try the same email again | "That email already has an account — try signing in." |
| 3.4 | Try a 3-character password | "Use a password of at least 6 characters." |
| 3.5 | Try `Continue with Google` | Google popup completes and signs you in |
| 3.6 | Check the header | Your name (or email) and an **Account** button replace **Sign in** |

## 4. Sign in / sign out

| # | Step | Expected |
|---|---|---|
| 4.1 | Sign out from **Account → Sign out** | Header shows **Sign in** again |
| 4.2 | Sign in with the same credentials | You are signed in; your contacts are still there |
| 4.3 | Sign in with a wrong password | "Email or password is incorrect." |
| 4.4 | Use **Forgot password?** with your email | A reset email arrives; the UI says a link is on its way |
| 4.5 | Reload while signed in | You stay signed in (session persists) |

## 5. Contacts — add, edit, delete

| # | Step | Expected |
|---|---|---|
| 5.1 | **Account → Emergency contacts** | The contacts sheet opens; limit shown as 5 |
| 5.1b | **Account → Privacy & my data** | The privacy note opens (this is the only route for a signed-in user) |
| 5.2 | Add "Amma / +91 98765 43210 / Mother" | The contact appears; the count reads 1; the form clears |
| 5.3 | Check Firestore → `users/<uid>/contacts` | One document with name, phone, relationship |
| 5.4 | Add a contact with phone `abc` | Rejected: "Use digits, spaces, +, - or brackets only." |
| 5.4b | Add a contact with phone `+91 58765 43210` (starts with 5) | Rejected: "An Indian mobile is 10 digits starting 6, 7, 8 or 9…" |
| 5.4c | Add a contact with phone `+1 415 555 2671` | Accepted and stored as `+14155552671` |
| 5.4d | Add a contact with phone `000000` | Rejected: "That is not a phone number." |
| 5.5 | Add a contact with a 1-character name | Rejected: "Enter a name (2–60 characters)." |
| 5.6 | Add a contact whose relationship is `<img src=x onerror=alert(1)>` | Saved and displayed as **literal text**; no dialog, no image element |
| 5.7 | Press **Edit** on a contact, change the name, save | The list shows the new name |
| 5.8 | Press **Delete** and confirm | The contact disappears; the count drops |
| 5.9 | Add contacts until you have 5, then try a 6th | The form is disabled and reads "You have reached the limit of 5 contacts. Delete one to add another." |
| 5.9b | Look above the form | The consent note "Only add people who know you're listing them." is shown |
| 5.9c | **Account → Privacy & my data → Delete all my contacts** | Every contact is removed, the account stays signed in, and the sheet reports "Deleted N contacts." |
| 5.10 | Reload the page and reopen contacts | Your contacts are still there |

## 6. Data isolation (the important one)

| # | Step | Expected |
|---|---|---|
| 6.1 | Sign out, then sign in as a **second** email address | The contacts list is empty |
| 6.2 | Add a contact to the second account | It saves under the second uid |
| 6.3 | Sign back in as the first account | You see only the first account's contacts |
| 6.4 | In the browser console, try to read another uid directly | Denied by the security rules |

   ```js
   // Paste in the console while signed in. Must be rejected.
   const { getFirestore, collection, getDocs } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
   const { getAuth } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
   const db = getFirestore();
   await getDocs(collection(db, 'users', 'SOME_OTHER_UID', 'contacts'));
   // → Missing or insufficient permissions.
   ```

## 7. Emergency with saved contacts

| # | Step | Expected |
|---|---|---|
| 7.1 | While signed in, go to **Live Alerts** | Your contacts are listed with **Text** and **WhatsApp** |
| 7.2 | Hold the panic button for 2 seconds | Your location is requested; the panel comes into view |
| 7.3 | Inspect the **Text** link | `sms:<number>?body=I need help. My location: https://maps.google.com/?q=…` |
| 7.4 | Inspect the **WhatsApp** link | `https://wa.me/<number>?text=` the same message |
| 7.5 | Tap **Text** on a phone | Your messaging app opens with the message and number pre-filled — you press send |
| 7.6 | Tap **WhatsApp** | WhatsApp opens with the message pre-filled |
| 7.7 | Read the panel wording | It states SafePath cannot send the message for you |
| 7.8 | Deny location permission, then hold again | The message says the location was unavailable instead of inventing one |
| 7.9 | Tap **Call 112** | The dialler opens with 112 |

## 8. Privacy and deletion

| # | Step | Expected |
|---|---|---|
| 8.1 | **Sign in → Read the privacy note** | The note opens and explains what is stored |
| 8.2 | Read it as a guest | It says guest use stores nothing about you |
| 8.3 | Sign in and open the privacy note | **Delete my account and data** is now visible |
| 8.4 | Press **Delete my account and data** and confirm | Contacts and account are removed; you are signed out |
| 8.5 | Check Firestore → `users/<uid>` | The contacts are gone |
| 8.6 | Check Authentication → Users | The user is gone |
| 8.7 | Check that no location trail was stored anywhere | Reports are area-level only; no trace collection exists |

## 9. Accessibility and mobile

| # | Step | Expected |
|---|---|---|
| 9.1 | Tab through the welcome card | Every button is reachable and shows a focus ring |
| 9.2 | Press **Escape** on any open sheet | The sheet closes |
| 9.3 | Click the backdrop of a sheet | The sheet closes |
| 9.4 | Resize to 320 px wide | The header wraps; buttons stay tappable |
| 9.5 | Enable "reduce motion" in the OS | Transitions are suppressed |
| 9.6 | Use a screen reader on the auth form | Labels and errors are announced |

---

## Automated coverage

```bash
npm run test:auth        # 46 checks: guest, sign-up, contacts, escaping,
                         # emergency links, sign-out, privacy, console
npm run test:all         # the full existing suite, to prove no regressions
```

The automated run intercepts `gstatic.com/firebasejs/*` and answers with a
minimal in-memory Firestore/Auth. That is the only stubbed part — the
validation, escaping, link building and rendering are the real modules.
