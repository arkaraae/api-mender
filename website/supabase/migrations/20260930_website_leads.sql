-- Run in YOUR Supabase project. These are website enquiries, not product accounts.
create table public.website_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  email text not null check (length(email) between 3 and 254),
  intent text not null check (intent in ('early','partner')),
  source text not null check (source in ('landing','demo')),
  name text check (length(name) <= 100),
  company text check (length(company) <= 120),
  apis text check (length(apis) <= 500),
  consent_version text not null,
  unique (email,intent)
);
alter table public.website_leads enable row level security;
revoke all on public.website_leads from anon, authenticated;
grant select, insert on public.website_leads to service_role;
-- View/export enquiries through your Supabase dashboard. No public read endpoint.
