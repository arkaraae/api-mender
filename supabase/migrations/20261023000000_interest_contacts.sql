-- Public-site contacts are private to the API Mender team. Only the server's
-- Supabase secret key can call the write function or read the table.
create table if not exists public.interest_contacts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 100),
  email text not null unique check (char_length(email) between 3 and 200 and email = lower(email)),
  interest text not null default '' check (interest in ('', 'use', 'collaborate', 'invest', 'feedback', 'other')),
  message text not null default '' check (char_length(message) <= 1000)
);

create index if not exists interest_contacts_created_at_idx on public.interest_contacts (created_at desc);
alter table public.interest_contacts enable row level security;
revoke all on public.interest_contacts from anon, authenticated;

create or replace function public.save_interest_contact(
  p_name text,
  p_email text,
  p_interest text default '',
  p_message text default ''
) returns uuid
language plpgsql
set search_path = ''
as $$
declare saved_id uuid;
begin
  insert into public.interest_contacts (name, email, interest, message)
  values (p_name, lower(p_email), p_interest, p_message)
  on conflict (email) do update set
    updated_at = now(),
    name = excluded.name,
    interest = case when excluded.interest <> '' then excluded.interest else public.interest_contacts.interest end,
    message = case when excluded.message <> '' then excluded.message else public.interest_contacts.message end
  returning id into saved_id;
  return saved_id;
end;
$$;

revoke all on function public.save_interest_contact(text, text, text, text) from public, anon, authenticated;
grant execute on function public.save_interest_contact(text, text, text, text) to service_role;
