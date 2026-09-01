-- Run after `supabase start` with: supabase test db
begin;
select plan(12);
select has_table('public', 'profiles');
select has_table('public', 'saved_recipes');
select has_table('public', 'collections');
select has_table('public', 'collection_recipes');
select ok((select relrowsecurity from pg_class where oid = 'public.profiles'::regclass), 'profiles RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.saved_recipes'::regclass), 'saved_recipes RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.collections'::regclass), 'collections RLS enabled');
select ok((select relrowsecurity from pg_class where oid = 'public.collection_recipes'::regclass), 'collection_recipes RLS enabled');
select policies_are('public', 'saved_recipes', array['saved_delete_own','saved_insert_own','saved_select_own','saved_update_own']);
select policies_are('public', 'collections', array['collections_delete_own','collections_insert_own','collections_select_own','collections_update_own']);
select policies_are('public', 'collection_recipes', array['memberships_delete_own','memberships_insert_own','memberships_select_own']);
select col_is_fk('public', 'saved_recipes', 'user_id');
select * from finish();
rollback;
