-- ============================================================
-- كامورو على Supabase — نفّذ هذا الملف في: SQL Editor
-- ============================================================

create extension if not exists "pgcrypto";

-- 1) جدول المستخدمين (يرتبط بـ auth.users)
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  email text unique not null,
  bio text not null default '',
  avatar_url text not null default '',
  email_verified boolean not null default false,
  is_private boolean not null default false,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- 2) إنشاء ملف المستخدم تلقائياً عند التسجيل
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, username, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- 3) المنشورات
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  media_url text not null,
  media_type text not null default 'image',
  caption text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_posts_user on public.posts (user_id, created_at desc);

-- 4) الإعجابات
create table if not exists public.likes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (post_id, user_id)
);

-- 5) التعليقات
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_comments_post on public.comments (post_id, created_at desc);

-- 6) المتابعة
create table if not exists public.follows (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid not null references public.users(id) on delete cascade,
  following_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'accepted', -- accepted / pending
  created_at timestamptz not null default now(),
  unique (follower_id, following_id)
);

-- 7) القصص
create table if not exists public.stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  media_url text not null,
  media_type text not null default 'image',
  created_at timestamptz not null default now()
);
create index if not exists idx_stories_user on public.stories (user_id, created_at desc);

-- 8) المحادثات
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_a text not null,
  user_b text not null,
  created_at timestamptz not null default now(),
  unique (user_a, user_b)
);

-- 9) الرسائل
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id text not null,
  body text not null default '',
  media_url text not null default '',
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_messages_conv on public.messages (conversation_id, created_at asc);

-- 10) الإشعارات
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  actor_id uuid not null references public.users(id) on delete cascade,
  type text not null, -- like / comment / follow / follow_request
  post_id uuid references public.posts(id) on delete cascade,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_notif_user on public.notifications (user_id, created_at desc);

-- 11) سجل الإدارة
create table if not exists public.admin_logs (
  id bigserial primary key,
  admin_name text not null,
  action text not null,
  target_type text not null default '',
  target_id text not null default '',
  details text not null default '',
  created_at timestamptz not null default now()
);

-- 12) RLS (أمان على مستوى الصف)
alter table public.users enable row level security;
alter table public.posts enable row level security;
alter table public.likes enable row level security;
alter table public.comments enable row level security;
alter table public.follows enable row level security;
alter table public.stories enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.notifications enable row level security;
alter table public.admin_logs enable row level security;

drop policy if exists "users_select" on public.users;
create policy "users_select" on public.users for select using (true);
drop policy if exists "users_update_own" on public.users;
create policy "users_update_own" on public.users for update using (auth.uid() = id);

drop policy if exists "posts_select" on public.posts;
create policy "posts_select" on public.posts for select using (true);
drop policy if exists "posts_insert_own" on public.posts;
create policy "posts_insert_own" on public.posts for insert with check (auth.uid() = user_id);
drop policy if exists "posts_delete_own" on public.posts;
create policy "posts_delete_own" on public.posts for delete using (auth.uid() = user_id);

drop policy if exists "likes_select" on public.likes;
create policy "likes_select" on public.likes for select using (true);
drop policy if exists "likes_insert_own" on public.likes;
create policy "likes_insert_own" on public.likes for insert with check (auth.uid() = user_id);
drop policy if exists "likes_delete_own" on public.likes;
create policy "likes_delete_own" on public.likes for delete using (auth.uid() = user_id);

drop policy if exists "comments_select" on public.comments;
create policy "comments_select" on public.comments for select using (true);
drop policy if exists "comments_insert_own" on public.comments;
create policy "comments_insert_own" on public.comments for insert with check (auth.uid() = user_id);
drop policy if exists "comments_delete_own" on public.comments;
create policy "comments_delete_own" on public.comments for delete using (auth.uid() = user_id);

drop policy if exists "follows_select" on public.follows;
create policy "follows_select" on public.follows for select using (true);
drop policy if exists "follows_insert_own" on public.follows;
create policy "follows_insert_own" on public.follows for insert with check (auth.uid() = follower_id);
drop policy if exists "follows_delete_own" on public.follows;
create policy "follows_delete_own" on public.follows for delete using (auth.uid() = follower_id);

drop policy if exists "stories_select" on public.stories;
create policy "stories_select" on public.stories for select using (true);
drop policy if exists "stories_insert_own" on public.stories;
create policy "stories_insert_own" on public.stories for insert with check (auth.uid() = user_id);
drop policy if exists "stories_delete_own" on public.stories;
create policy "stories_delete_own" on public.stories for delete using (auth.uid() = user_id);

drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations for select using (true);
drop policy if exists "conversations_insert" on public.conversations;
create policy "conversations_insert" on public.conversations for insert with check (true);

drop policy if exists "messages_select" on public.messages;
create policy "messages_select" on public.messages for select using (true);
drop policy if exists "messages_insert" on public.messages;
create policy "messages_insert" on public.messages for insert with check (true);

drop policy if exists "notifications_select" on public.notifications;
create policy "notifications_select" on public.notifications for select using (auth.uid() = user_id);
drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own" on public.notifications for update using (auth.uid() = user_id);

drop policy if exists "admin_logs_select" on public.admin_logs;
create policy "admin_logs_select" on public.admin_logs for select using (true);

-- 13) مخازن الملفات (Storage)
insert into storage.buckets (id, name, public)
values ('media', 'media', true), ('avatars', 'avatars', true)
on conflict (id) do nothing;
