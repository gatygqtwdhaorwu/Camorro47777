-- حساب تجريبي: demo@camorro.app / Demo123!
insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role)
values (
  '00000000-0000-0000-0000-0000-000000000001',
  'demo@camorro.app',
  crypt('Demo123!', gen_salt('bf')),   -- ⚠️ في Supabase يُدار عبر Auth، أنشئه من لوحة Auth بدلاً من SQL
  now(),
  '{"provider":"email","providers":["email"]}',
  '{"username":"demo"}',
  'authenticated',
  'authenticated'
) on conflict (id) do nothing;

insert into public.users (id, username, email, email_verified)
values ('00000000-0000-0000-0000-0000-000000000001', 'demo', 'demo@camorro.app', true)
on conflict (id) do nothing;
