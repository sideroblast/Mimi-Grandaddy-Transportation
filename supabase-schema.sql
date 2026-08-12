create extension if not exists pgcrypto;

create table if not exists public.family_members (
  email text primary key,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  person text not null check (person in ('Mimi','Grandaddy')),
  title text not null,
  event_date date not null,
  event_time time not null,
  location text,
  notes text,
  driver_user_id uuid references auth.users(id) on delete set null,
  driver_name text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


alter table public.family_members enable row level security;
alter table public.events enable row level security;

create or replace function public.is_family_member()
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.family_members f where lower(f.email)=lower(coalesce(auth.jwt()->>'email','')));
$$;
revoke all on function public.is_family_member() from public;
grant execute on function public.is_family_member() to authenticated;

create policy "read own family record" on public.family_members for select to authenticated
using (public.is_family_member() and lower(email)=lower(auth.jwt()->>'email'));
create policy "update own family name" on public.family_members for update to authenticated
using (public.is_family_member() and lower(email)=lower(auth.jwt()->>'email'))
with check (public.is_family_member() and lower(email)=lower(auth.jwt()->>'email'));

create policy "family read events" on public.events for select to authenticated using (public.is_family_member());
create policy "family add events" on public.events for insert to authenticated with check (public.is_family_member());
create policy "family edit events" on public.events for update to authenticated using (public.is_family_member()) with check (public.is_family_member());
create policy "family delete events" on public.events for delete to authenticated using (public.is_family_member());

alter publication supabase_realtime add table public.events;

-- Replace these examples with your relatives' actual emails, then run the INSERT separately.
-- insert into public.family_members(email,display_name) values
-- ('you@example.com','Sara'),
-- ('relative@example.com','Jennifer')
-- on conflict(email) do nothing;
