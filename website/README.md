# API Mender demo website

This is the separate public landing page and guided demo at [code-sync-bot.lovable.app](https://code-sync-bot.lovable.app/). Visitors can explore a five-step **simulated** Stripe change without signing in, then leave contact details for follow-up. The example is based on the team's fixture; it does not scan a visitor's repository, run live validation, or open a GitHub pull request.

This app uses TanStack Start and runs separately from the Next.js product in the repository root. It does not replace the existing `/`, `/live`, or `/demo` routes. The contact form writes to a separate Supabase project through a server-only secret; credentials are not in this repository. See `.env.example` for the required setting names and `supabase/migrations/20260930_website_leads.sql` for the contact table.

The website's standalone GitHub home is [jwww-gh/api-mender-front-end](https://github.com/jwww-gh/api-mender-front-end). This folder brings the same code into the team repository for review; keeping the two copies aligned is a follow-up task until the team chooses one source of truth.

## Run independently

From this `website/` directory, use Node.js 24+:

```sh
npm install
npm run dev
```

The guided demo works without database credentials. For a local contact-form test, put `LEADS_DB_URL` and `LEADS_DB_SECRET_KEY` in a local `.env.local`; never commit their values. Verification: `node --test tests/leads.test.ts`, `npx tsc --noEmit`, and `npm run build`.
