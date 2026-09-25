# [Demo] Add capture_method for simulated PaymentIntent contract

**Simulation:** This is a local artifact. No live Stripe change or GitHub PR is claimed.

## Evidence
The simulated contract at fixture://simulated-stripe-contract adds `capture_method` to `POST /v1/payment_intents` required fields. Snapshot SHA-256: 67784235e5ae9ea0ccedbdf274c86e65244c05d09fa47b95442e753043b98099.

## Impact
- src/payments.ts:9 stripe.paymentIntents.create

## Implementation
- Explicitly set `capture_method: "automatic"` to preserve immediate capture.
- Add regression test that fails against the prior code.

## Validation
- Regression before patch: failed
- Checks after patch: TypeScript syntax: pass; Contract regression: pass; tests/payments.test.cjs: pass; tests/contract.test.cjs: pass
- Base commit/content hash: fdb25bfe8f74d9be31baee11c6e9aeaec7c4b882bfe70dcd87cfc0f21322f6bd

## Uncertainty and rollback
The source change is simulated. Real Stripe API version applicability and production behavior have not been verified. Revert the code and test commit if needed. Human review is required before merge.
