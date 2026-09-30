import { useState, type FormEvent } from 'react';
import { Button } from './Button';

type Intent = 'early' | 'partner';
export function LeadForm({ intent, onIntentChange, source = 'landing' }: { intent: Intent; onIntentChange: (intent: Intent) => void; source?: 'landing' | 'demo' }) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setState('saving');
    try {
      const response = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), name: form.get('name'), company: form.get('company'), apis: form.get('apis'), website: form.get('website'), intent, source, consent: form.get('consent') === 'on' }) });
      if (!response.ok) throw new Error(response.status === 503 ? 'Signups are not open yet. Your details have not been saved. Please try again later.' : 'We could not save your request. Please check your email and try again.');
      setState('saved');
    } catch (error) { setState('error'); setMessage(error instanceof Error ? error.message : 'Please try again.'); }
  }
  if (state === 'saved') return <div role="status" className="py-10"><p className="text-success">✓ Request received</p><h3 className="mt-3 text-2xl font-semibold">Thanks for your interest.</h3><p className="mt-3 text-muted-foreground">We’ll use your email to follow up about API Mender. This does not create a product account.</p></div>;
  const field = 'mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm';
  return <form onSubmit={submit} className="space-y-5">
    <div className="flex gap-1 rounded-md bg-muted p-1" aria-label="Interest type"><Button className="flex-1 px-2" variant={intent === 'early' ? 'primary' : 'quiet'} onClick={() => onIntentChange('early')}>Early access</Button><Button className="flex-1 px-2" variant={intent === 'partner' ? 'primary' : 'quiet'} onClick={() => onIntentChange('partner')}>Design partner</Button></div>
    <p className="text-sm text-muted-foreground">{intent === 'partner' ? 'Help shape the product with feedback from your team.' : 'Get in touch about trying API Mender on your own code.'}</p>
    <label className="block text-sm font-medium">Email<input className={field} type="email" name="email" autoComplete="email" required maxLength={254} /></label>
    <details><summary className="cursor-pointer text-sm text-muted-foreground">Add a little context (optional)</summary><div className="mt-4 space-y-4"><label className="block text-sm">Name<input className={field} name="name" autoComplete="name" maxLength={100}/></label><label className="block text-sm">Company<input className={field} name="company" autoComplete="organization" maxLength={120}/></label><label className="block text-sm">Which APIs do you use?<input className={field} name="apis" placeholder="Stripe, AWS, OpenAI…" maxLength={500}/></label></div></details>
    <div hidden aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off"/></label></div>
    <label className="flex items-start gap-3 text-xs leading-5 text-muted-foreground"><input type="checkbox" name="consent" required className="mt-1"/>You may contact me about API Mender early access or research. My submitted details will be stored for that follow-up.</label>
    {state === 'error' && <p role="alert" className="text-sm text-destructive">{message}</p>}
    <Button className="w-full" type="submit" disabled={state === 'saving'}>{state === 'saving' ? 'Saving…' : intent === 'partner' ? 'Become a design partner →' : 'Request early access →'}</Button>
  </form>;
}
