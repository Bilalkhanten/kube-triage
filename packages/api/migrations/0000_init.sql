-- Incident store and append-only audit log.

create table incidents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by text not null,
  namespace text not null,
  service text,
  window_from timestamptz not null,
  window_to timestamptz not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  severity text not null check (severity in ('none', 'info', 'warning', 'critical')),
  title text not null,
  timeline jsonb not null
);

create index incidents_created_at_idx on incidents (created_at desc, id desc);
create index incidents_namespace_idx on incidents (namespace, created_at desc);

create table audit_log (
  seq bigserial primary key,
  at timestamptz not null,
  actor text not null,
  role text not null,
  action text not null,
  target text,
  outcome text not null check (outcome in ('success', 'denied', 'error')),
  detail jsonb not null default '{}'::jsonb,
  prev_hash text not null,
  hash text not null
);

-- Rows can be added but never changed or removed, whoever the database user is.
create function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end
$$;

create trigger audit_log_no_update_delete
  before update or delete on audit_log
  for each row execute function audit_log_immutable();

create trigger audit_log_no_truncate
  before truncate on audit_log
  for each statement execute function audit_log_immutable();
