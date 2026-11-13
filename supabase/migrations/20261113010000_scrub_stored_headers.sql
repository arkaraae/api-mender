-- Scans before 2026-11-13 kept every literal request header a call set,
-- which could include credentials written into code. Keep only Accept,
-- Content-Type and version headers in stored scan results (the same rule
-- the scanner now applies).
update public.monitored_repositories r
set call_sites = (
  select coalesce(jsonb_agg(
    case when jsonb_typeof(c->'headers') = 'object' then
      jsonb_set(c, '{headers}', coalesce((
        select jsonb_object_agg(h.key, h.value) from jsonb_each(c->'headers') h
        where h.key ~ '^(accept|content-type|[a-z0-9-]*-version|openai-beta)$'
          and jsonb_typeof(h.value) = 'string' and char_length(h.value #>> '{}') <= 200
          and (h.value #>> '{}') !~* '(bearer\s|basic\s|sk_|rk_|pk_live|ghp_|gho_|github_pat_|xox[abpr]-|eyJ[A-Za-z0-9_-]{10,})'
      ), '{}'::jsonb))
    else c end order by ord), '[]'::jsonb)
  from jsonb_array_elements(r.call_sites) with ordinality as e(c, ord)
)
where jsonb_typeof(r.call_sites) = 'array' and r.call_sites::text ~* '"headers"';
