-- ============================================================
-- ROXX / ①投稿の公開範囲 ②アバター ③通知
-- ============================================================

-- ---------- ① フィード投稿の公開範囲 ----------
alter table public.posts
  add column if not exists visibility text not null default 'public'
  check (visibility in ('public','followers'));
alter table public.posts
  add column if not exists race text;

create index if not exists idx_posts_public_recent
  on public.posts (created_at desc) where visibility = 'public';
create index if not exists idx_posts_race
  on public.posts (race, created_at desc) where visibility = 'public';

drop policy if exists posts_read on public.posts;
create policy posts_read on public.posts for select to authenticated
  using (
    auth.uid() = author_id
    or (
      not public.is_blocked(auth.uid(), author_id)
      and (visibility = 'public' or public.is_following(auth.uid(), author_id))
    )
  );

-- ---------- ② アバター（公開バケット） ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 4194304, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

drop policy if exists avatar_insert on storage.objects;
create policy avatar_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists avatar_update on storage.objects;
create policy avatar_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists avatar_delete on storage.objects;
create policy avatar_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- ③ 通知 ----------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  actor_id   uuid references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('like','follow','dm')),
  target_id  uuid,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_notif_user on public.notifications (user_id, created_at desc);
create index if not exists idx_notif_unread on public.notifications (user_id) where read_at is null;

alter table public.notifications enable row level security;
drop policy if exists notif_read on public.notifications;
create policy notif_read on public.notifications for select to authenticated
  using (auth.uid() = user_id);
drop policy if exists notif_update on public.notifications;
create policy notif_update on public.notifications for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists notif_delete on public.notifications;
create policy notif_delete on public.notifications for delete to authenticated
  using (auth.uid() = user_id);

create or replace function public.notify_like() returns trigger
language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  select author_id into owner from public.posts where id = NEW.post_id;
  if owner is null or owner = NEW.user_id then return NEW; end if;
  if public.is_blocked(owner, NEW.user_id) then return NEW; end if;
  insert into public.notifications(user_id, actor_id, kind, target_id)
    values (owner, NEW.user_id, 'like', NEW.post_id);
  return NEW;
end $$;
drop trigger if exists trg_notify_like on public.post_likes;
create trigger trg_notify_like after insert on public.post_likes
  for each row execute function public.notify_like();

create or replace function public.notify_follow() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_blocked(NEW.followee_id, NEW.follower_id) then return NEW; end if;
  insert into public.notifications(user_id, actor_id, kind, target_id)
    values (NEW.followee_id, NEW.follower_id, 'follow', NEW.follower_id);
  return NEW;
end $$;
drop trigger if exists trg_notify_follow on public.follows;
create trigger trg_notify_follow after insert on public.follows
  for each row execute function public.notify_follow();

create or replace function public.notify_dm() returns trigger
language plpgsql security definer set search_path = public as $$
declare rec record;
begin
  for rec in
    select user_id, accepted from public.dm_participants
    where thread_id = NEW.thread_id and user_id <> NEW.sender_id
  loop
    if rec.accepted and not public.is_blocked(rec.user_id, NEW.sender_id) then
      insert into public.notifications(user_id, actor_id, kind, target_id)
        values (rec.user_id, NEW.sender_id, 'dm', NEW.thread_id);
    end if;
  end loop;
  return NEW;
end $$;
drop trigger if exists trg_notify_dm on public.messages;
create trigger trg_notify_dm after insert on public.messages
  for each row execute function public.notify_dm();

select
  (select count(*) from information_schema.columns
    where table_name='posts' and column_name in ('visibility','race')) as "posts列",
  (select count(*) from storage.buckets where id='avatars')            as "アバター保存領域",
  (select count(*) from information_schema.tables
    where table_name='notifications')                                  as "通知テーブル",
  (select count(*) from information_schema.triggers
    where trigger_name like 'trg_notify%')                             as "通知トリガー";
