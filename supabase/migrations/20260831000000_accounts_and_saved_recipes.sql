-- Dishly optional accounts. Guests never touch these tables; authenticated
-- users are isolated by PostgreSQL row-level security on every operation.
create extension if not exists pgcrypto;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 100),
  avatar_url text not null default '' check (char_length(avatar_url) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.saved_recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'spoonacular' check (provider = 'spoonacular'),
  provider_recipe_id text not null check (provider_recipe_id ~ '^[1-9][0-9]{0,31}$'),
  recipe_snapshot jsonb not null check (jsonb_typeof(recipe_snapshot) = 'object'),
  personal_notes text not null default '' check (char_length(personal_notes) <= 2000),
  rating smallint check (rating between 1 and 5),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, provider_recipe_id),
  unique (id, user_id)
);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create table public.collection_recipes (
  user_id uuid not null references auth.users(id) on delete cascade,
  collection_id uuid not null,
  saved_recipe_id uuid not null,
  added_at timestamptz not null default now(),
  primary key (collection_id, saved_recipe_id),
  foreign key (collection_id, user_id) references public.collections(id, user_id) on delete cascade,
  foreign key (saved_recipe_id, user_id) references public.saved_recipes(id, user_id) on delete cascade
);

create index saved_recipes_user_created_idx on public.saved_recipes(user_id, created_at desc);
create index collections_user_name_idx on public.collections(user_id, name);
create index collection_recipes_user_idx on public.collection_recipes(user_id);

create function public.set_updated_at() returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger saved_recipes_set_updated_at before update on public.saved_recipes for each row execute function public.set_updated_at();
create trigger collections_set_updated_at before update on public.collections for each row execute function public.set_updated_at();

create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''), coalesce(new.raw_user_meta_data ->> 'avatar_url', ''));
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.saved_recipes enable row level security;
alter table public.collections enable row level security;
alter table public.collection_recipes enable row level security;

revoke all on public.profiles, public.saved_recipes, public.collections, public.collection_recipes from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.saved_recipes, public.collections, public.collection_recipes to authenticated;

create policy profiles_select_own on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy saved_select_own on public.saved_recipes for select to authenticated using ((select auth.uid()) = user_id);
create policy saved_insert_own on public.saved_recipes for insert to authenticated with check ((select auth.uid()) = user_id);
create policy saved_update_own on public.saved_recipes for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy saved_delete_own on public.saved_recipes for delete to authenticated using ((select auth.uid()) = user_id);

create policy collections_select_own on public.collections for select to authenticated using ((select auth.uid()) = user_id);
create policy collections_insert_own on public.collections for insert to authenticated with check ((select auth.uid()) = user_id);
create policy collections_update_own on public.collections for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy collections_delete_own on public.collections for delete to authenticated using ((select auth.uid()) = user_id);

create policy memberships_select_own on public.collection_recipes for select to authenticated using ((select auth.uid()) = user_id);
create policy memberships_insert_own on public.collection_recipes for insert to authenticated with check ((select auth.uid()) = user_id);
create policy memberships_delete_own on public.collection_recipes for delete to authenticated using ((select auth.uid()) = user_id);

comment on table public.saved_recipes is 'Authenticated Dishly recipe snapshots; RLS isolates every user.';
