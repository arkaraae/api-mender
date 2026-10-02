create table public.managed_apis (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z][a-z0-9-]{2,60}$'),
  title text not null check (char_length(title) between 1 and 120),
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);
create index managed_apis_workspace_idx on public.managed_apis(workspace_id);
create table public.managed_api_versions (
  id uuid primary key default gen_random_uuid(),
  api_id uuid not null references public.managed_apis(id) on delete cascade,
  version integer not null check (version between 1 and 1000000),
  identity_field text not null check (identity_field ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$' and identity_field <> 'sku'),
  change_note text not null default '' check (char_length(change_note) <= 1000),
  published_by uuid not null references auth.users(id),
  published_at timestamptz not null default now(),
  unique(api_id,version)
);
create index managed_api_versions_latest_idx on public.managed_api_versions(api_id,version desc);
create table public.managed_api_products (
  id uuid primary key default gen_random_uuid(),
  api_id uuid not null references public.managed_apis(id) on delete cascade,
  sku text not null check (sku ~ '^[A-Za-z0-9_-]{1,40}$'),
  name text not null check (char_length(name) between 1 and 120),
  amount_cents integer not null check (amount_cents between 1 and 100000000),
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  unique(api_id,sku)
);
create index managed_api_products_api_idx on public.managed_api_products(api_id);
alter table public.managed_apis enable row level security;
alter table public.managed_api_versions enable row level security;
alter table public.managed_api_products enable row level security;
grant select on public.managed_apis,public.managed_api_versions,public.managed_api_products to anon;
grant select,insert,update on public.managed_apis,public.managed_api_products to authenticated;
grant delete on public.managed_api_products to authenticated;
grant select,insert on public.managed_api_versions to authenticated;
create policy managed_apis_public_read on public.managed_apis for select to anon,authenticated using (is_public);
create policy managed_apis_owner_read on public.managed_apis for select to authenticated using (exists (select 1 from public.workspaces w where w.id=workspace_id and w.owner_id=(select auth.uid())));
create policy managed_apis_owner_insert on public.managed_apis for insert to authenticated with check (exists (select 1 from public.workspaces w where w.id=workspace_id and w.owner_id=(select auth.uid())));
create policy managed_apis_owner_update on public.managed_apis for update to authenticated using (exists (select 1 from public.workspaces w where w.id=workspace_id and w.owner_id=(select auth.uid()))) with check (exists (select 1 from public.workspaces w where w.id=workspace_id and w.owner_id=(select auth.uid())));
create policy managed_api_versions_public_read on public.managed_api_versions for select to anon,authenticated using (exists (select 1 from public.managed_apis a where a.id=api_id and a.is_public));
create policy managed_api_versions_owner_read on public.managed_api_versions for select to authenticated using (exists (select 1 from public.managed_apis a join public.workspaces w on w.id=a.workspace_id where a.id=api_id and w.owner_id=(select auth.uid())));
create policy managed_api_versions_owner_insert on public.managed_api_versions for insert to authenticated with check (published_by=(select auth.uid()) and exists (select 1 from public.managed_apis a join public.workspaces w on w.id=a.workspace_id where a.id=api_id and w.owner_id=(select auth.uid())));
create policy managed_api_products_public_read on public.managed_api_products for select to anon,authenticated using (active and exists (select 1 from public.managed_apis a where a.id=api_id and a.is_public));
create policy managed_api_products_owner_read on public.managed_api_products for select to authenticated using (exists (select 1 from public.managed_apis a join public.workspaces w on w.id=a.workspace_id where a.id=api_id and w.owner_id=(select auth.uid())));
create policy managed_api_products_owner_insert on public.managed_api_products for insert to authenticated with check (exists (select 1 from public.managed_apis a join public.workspaces w on w.id=a.workspace_id where a.id=api_id and w.owner_id=(select auth.uid())));
create policy managed_api_products_owner_update on public.managed_api_products for update to authenticated using (exists (select 1 from public.managed_apis a join public.workspaces w on w.id=a.workspace_id where a.id=api_id and w.owner_id=(select auth.uid()))) with check (exists (select 1 from public.managed_apis a join public.workspaces w on w.id=a.workspace_id where a.id=api_id and w.owner_id=(select auth.uid())));
create policy managed_api_products_owner_delete on public.managed_api_products for delete to authenticated using (exists (select 1 from public.managed_apis a join public.workspaces w on w.id=a.workspace_id where a.id=api_id and w.owner_id=(select auth.uid())));
