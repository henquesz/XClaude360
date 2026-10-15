-- Rode isto uma vez no Supabase: SQL Editor > New query > colar > Run.
-- Cria a tabela de perfis (gamertag + avatar) ligada aos usuários do login (Authentication do Supabase).

create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  gamertag      text not null check (gamertag ~ '^[A-Za-z][A-Za-z0-9_ ]{2,14}$' and gamertag !~ '  ' and gamertag !~ ' $'),
  avatar_seed   text not null check (char_length(avatar_seed) between 1 and 64),
  avatar_colors text[] not null check (array_length(avatar_colors, 1) between 2 and 8),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Gamertag única sem diferenciar maiúsculas ("Vini" e "vini" não podem coexistir)
create unique index if not exists profiles_gamertag_unique on public.profiles (lower(gamertag));

-- Row Level Security: cada um só cria/edita o próprio perfil; logados podem ver os perfis dos outros
alter table public.profiles enable row level security;

drop policy if exists "profiles: leitura para logados" on public.profiles;
create policy "profiles: leitura para logados" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles: cria o próprio" on public.profiles;
create policy "profiles: cria o próprio" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);

drop policy if exists "profiles: edita o próprio" on public.profiles;
create policy "profiles: edita o próprio" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create or replace function public.profiles_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles
  for each row execute function public.profiles_touch_updated_at();

-- Usado pela tela de criação de perfil para avisar se a gamertag já existe enquanto a pessoa digita
create or replace function public.gamertag_available(tag text)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where lower(gamertag) = lower(trim(tag)) and id <> auth.uid());
$$;

revoke all on function public.gamertag_available(text) from public, anon;
grant execute on function public.gamertag_available(text) to authenticated;
