export interface StripeLike {
  paymentIntents: {
    create(request: { amount: number; currency: string; capture_method?: string }): Promise<{ id: string }>;
  };
}

export async function createPaymentIntent(stripe: StripeLike, amount: number) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Invalid amount');
  return stripe.paymentIntents.create({
    amount,
    currency: "usd",
  });
}
