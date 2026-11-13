# Alerts, plans and new providers: setup

## Database
Apply `supabase/migrations/20261111000000_alerts_and_billing.sql` (staging first, then production).
It adds alert settings, notification history (with per-send claims so overlapping cron runs never double-send), plans (`billing_plans`: Free 3 repositories, Pro 50 —
change the rows to change the limits) and a trigger that holds every repository insert to the plan.

## Worker secrets (per environment)
| Secret | Purpose |
|---|---|
| `MENDER_SETTINGS_KEY` | `openssl rand -base64 32`. Encrypts Slack webhook URLs. Without it, Slack alerts are hidden. |
| `STRIPE_SECRET_KEY` | Stripe secret key (test key on staging). |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint below. |
| `STRIPE_PRICE_PRO` | Price ID (`price_…`) of the Pro subscription. |

```
npx wrangler secret put MENDER_SETTINGS_KEY --env staging
npx wrangler secret put STRIPE_SECRET_KEY --env staging
npx wrangler secret put STRIPE_WEBHOOK_SECRET --env staging
npx wrangler secret put STRIPE_PRICE_PRO --env staging
```

## Stripe
1. Create a product "Mend Pro" with a recurring price; copy its `price_…` ID.
2. Add a webhook endpoint `https://<site>/api/billing/webhook` for
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`; copy its signing secret.
3. Turn on the customer portal (Settings → Billing → Customer portal).

## GitHub App
For GitHub-issue alerts, add the **Issues: Read and write** permission to the App and accept it on
each installation. Without it, issue alerts are recorded as failed with that reason.

## Provider catalog
The nightly `Provider contract catalog` workflow now also syncs Stripe, OpenAI and Twilio from their
published spec repositories. Run it once by hand after merging (Actions → Provider contract catalog →
Run workflow) so findings for those providers start immediately.

## Automatic API discovery
Apply `supabase/migrations/20261111010000_api_auto_discovery.sql`. After that, nothing is added by hand:
every external API origin a scan finds is queued, and the catalog workflow (twice a day) looks for its
published OpenAPI description — the APIs.guru directory first, then `/openapi.json`, `/swagger.json` and
similar addresses on the API's host — keeping the one that matches the most endpoints the code calls.
Found descriptions are watched from then on; APIs with none are re-checked weekly, then monthly.
Private or internal hosts (IP addresses, `.internal`, `.local`, ports) are never requested. Which APIs a
workspace calls is visible only to that workspace's members.
