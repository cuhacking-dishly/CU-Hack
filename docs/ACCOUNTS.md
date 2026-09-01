# Optional Dishly accounts (free tier)

Dishly is deliberately guest-first. If Supabase is absent or unavailable, recipe discovery, swiping, recipe details, and tab-local likes continue to work. Enabling accounts adds private cross-device saved recipes, notes, ratings, collections, JSON export, and self-service deletion.

## 1. Create the free project

1. Create a Supabase project on the Free plan. Do not enable a paid plan or add a payment method for Dishly.
2. Open the SQL editor and run `supabase/migrations/20260831000000_accounts_and_saved_recipes.sql` in full. For CLI development, `supabase db push` applies the same migration.
3. In Authentication → URL Configuration, set the site URL to `https://dishly.brandonjameschoi.com` and allow these redirects:
   - `https://dishly.brandonjameschoi.com/**`
   - `http://localhost:5173/**`
4. Email magic links work without Dishly storing passwords. To enable Google, configure Supabase's Google provider with Google OAuth credentials and use the callback URL shown by Supabase. Keep the Google client secret in Supabase, never in this repository.

## 2. Configure the backend

Copy the project URL and publishable key from Supabase API settings. Copy the secret key only for self-service account deletion.

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY=YOUR_SERVER_ONLY_SECRET_KEY
```

Put these values in `backend/.env` locally and in the Render service environment for production. Restart/redeploy the backend. Do not add Supabase values to Vercel: the frontend gets only the intentionally public URL/key through `GET /api/auth/config`.

Verify the endpoint:

```text
GET https://dishly-backend-mrm8.onrender.com/api/auth/config
```

It should return `enabled: true` and must never include `secretKey`.

## 3. Security and QA checks

- Run `supabase test db` to execute `supabase/tests/rls_contract.sql` against the local stack.
- Create two test accounts and confirm neither can select, update, or delete the other's rows. The migration enables RLS on every user table and defines separate operation policies.
- Confirm guest mode works in a private browser window before signing in.
- Like a recipe as a guest, sign in, and confirm it appears once in Saved Recipes.
- Add notes, a rating, and a collection; reload in another browser and confirm they persist.
- Download the account JSON and inspect it for the expected account only.
- Delete a test account and confirm its profile, recipes, collections, and memberships cascade away.

The free plan currently has usage limits and can pause inactive projects. Dishly treats an account-service outage as an optional-feature outage; it never turns that into a guest-app outage.
