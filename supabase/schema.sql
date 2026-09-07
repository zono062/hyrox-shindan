-- ============================================================
-- ROXX / スキーマとRLS
--
-- 方針
--  * 権限は全てRLSで宣言する。アプリ側の条件分岐に依存しない。
--    クライアントは anon key しか持たないため、ここが唯一の防壁になる。
--  * ブロックは相互に効く。ブロックした側・された側のどちらからも
--    相手のコンテンツが見えなくなる。
--  * ストーリーは24時間・フォロワー限定。期限判定もRLSに入れる。
--  * DMは誰にでも送れるが、受信側が承認するまで「リクエスト」扱い。
--    App Store ガイドライン1.2（UGC）対応として通報とブロックを最初から持つ。
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- プロフィール ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  handle       text unique not null check (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 30),
  bio          text check (char_length(bio) <= 160),
  avatar_path  text,
  sex          text check (sex in ('m','f')),
  created_at   timestamptz not null default now()
);

-- ---------- 診断の状態（localStorage からの移行先） ----------
-- 身長・体重・年齢を含むため、本人以外は絶対に読めない
create table if not exists public.athlete_state (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  answers    jsonb not null,
  result     jsonb not null,
  week       int  not null default 1 check (week >= 1),
  paid       boolean not null default false,
  updated_at timestamptz not null default now()
);

-- 他人に見せてよい範囲だけを切り出したもの（ペア生成・プロフィール表示用）
-- ステーション秒数とラップのみ。体格情報は入れない
create table if not exists public.athlete_public (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  lap_sec     int not null check (lap_sec > 0),
  stations    jsonb not null,
  need_weeks  int,
  total_sec   int,
  race        text,
  updated_at  timestamptz not null default now()
);

-- ---------- 実施ログ ----------
create table if not exists public.training_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  week       int  not null check (week >= 1),
  day_index  int  not null check (day_index >= 0),
  state      text not null check (state in ('open','done','skip')),
  level      int  check (level between 1 and 3),
  updated_at timestamptz not null default now(),
  unique (user_id, week, day_index)
);

-- ---------- フォロー / ブロック / 通報 ----------
create table if not exists public.follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);

create table if not exists public.blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table if not exists public.reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid not null references auth.users(id) on delete cascade,
  target_type  text not null check (target_type in ('user','story','message')),
  target_id    uuid not null,
  reason       text not null check (reason in ('harassment','sexual','spam','impersonation','other')),
  note         text check (char_length(note) <= 500),
  status       text not null default 'open' check (status in ('open','actioned','dismissed')),
  created_at   timestamptz not null default now()
);

-- ---------- ストーリー（24時間・フォロワー限定） ----------
create table if not exists public.stories (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid not null references auth.users(id) on delete cascade,
  image_path text,
  caption    text check (char_length(caption) <= 200),
  kind       text not null default 'week' check (kind in ('week','result','pair','free')),
  payload    jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

create table if not exists public.story_views (
  story_id  uuid not null references public.stories(id) on delete cascade,
  viewer_id uuid not null references auth.users(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer_id)
);

-- ---------- DM ----------
create table if not exists public.dm_threads (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

-- accepted=false の間は「リクエスト」。通知は出さない
create table if not exists public.dm_participants (
  thread_id    uuid not null references public.dm_threads(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  accepted     boolean not null default false,
  last_read_at timestamptz,
  primary key (thread_id, user_id)
);

create table if not exists public.messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.dm_threads(id) on delete cascade,
  sender_id  uuid not null references auth.users(id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

-- ---------- 索引 ----------
create index if not exists idx_follows_followee on public.follows(followee_id);
create index if not exists idx_stories_author_exp on public.stories(author_id, expires_at desc);
create index if not exists idx_messages_thread on public.messages(thread_id, created_at desc);
create index if not exists idx_logs_user_week on public.training_logs(user_id, week);
create index if not exists idx_reports_status on public.reports(status, created_at desc);

-- ============================================================
-- 補助関数
-- security definer にしないと、ポリシー内から blocks / follows を
-- 参照した時点で再びRLSに引っかかり、常に false になる
-- ============================================================
create or replace function public.is_blocked(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = a and blocked_id = b)
       or (blocker_id = b and blocked_id = a)
  );
$$;

create or replace function public.is_following(follower uuid, followee uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.follows
    where follower_id = follower and followee_id = followee
  );
$$;

create or replace function public.in_thread(t uuid, u uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.dm_participants where thread_id = t and user_id = u
  );
$$;

-- ============================================================
-- RLS
-- ============================================================
alter table public.profiles        enable row level security;
alter table public.athlete_state   enable row level security;
alter table public.athlete_public  enable row level security;
alter table public.training_logs   enable row level security;
alter table public.follows         enable row level security;
alter table public.blocks          enable row level security;
alter table public.reports         enable row level security;
alter table public.stories         enable row level security;
alter table public.story_views     enable row level security;
alter table public.dm_threads      enable row level security;
alter table public.dm_participants enable row level security;
alter table public.messages        enable row level security;

-- プロフィール：ブロック関係にない限り誰でも閲覧できる。更新は本人のみ
create policy profiles_read on public.profiles for select to authenticated
  using (not public.is_blocked(auth.uid(), id));
create policy profiles_insert on public.profiles for insert to authenticated
  with check (auth.uid() = id);
create policy profiles_update on public.profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- 診断の状態：本人以外は一切読めない（体格情報を含むため）
create policy state_own on public.athlete_state for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 公開用の数値：ブロック関係になければ閲覧可。書き込みは本人のみ
create policy pub_read on public.athlete_public for select to authenticated
  using (not public.is_blocked(auth.uid(), user_id));
create policy pub_write on public.athlete_public for insert to authenticated
  with check (auth.uid() = user_id);
create policy pub_update on public.athlete_public for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 実施ログ：本人のみ
create policy logs_own on public.training_logs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- フォロー：自分の関係だけ作成・削除できる。ブロック中は作れない
create policy follows_read on public.follows for select to authenticated
  using (auth.uid() = follower_id or auth.uid() = followee_id);
create policy follows_insert on public.follows for insert to authenticated
  with check (auth.uid() = follower_id and not public.is_blocked(follower_id, followee_id));
create policy follows_delete on public.follows for delete to authenticated
  using (auth.uid() = follower_id);

-- ブロック：本人のみ
create policy blocks_own on public.blocks for all to authenticated
  using (auth.uid() = blocker_id) with check (auth.uid() = blocker_id);

-- 通報：投稿できるが読み返せない（対応状況は運営のみ）
create policy reports_insert on public.reports for insert to authenticated
  with check (auth.uid() = reporter_id);

-- ストーリー：自分のもの、または「フォローしていて・期限内で・ブロック関係にない」もの
create policy stories_read on public.stories for select to authenticated
  using (
    auth.uid() = author_id
    or (
      expires_at > now()
      and public.is_following(auth.uid(), author_id)
      and not public.is_blocked(auth.uid(), author_id)
    )
  );
create policy stories_insert on public.stories for insert to authenticated
  with check (auth.uid() = author_id);
create policy stories_delete on public.stories for delete to authenticated
  using (auth.uid() = author_id);

-- 閲覧記録：自分が見たことだけ書ける。読めるのは投稿者と本人
create policy views_insert on public.story_views for insert to authenticated
  with check (auth.uid() = viewer_id);
create policy views_read on public.story_views for select to authenticated
  using (
    auth.uid() = viewer_id
    or exists (select 1 from public.stories s where s.id = story_id and s.author_id = auth.uid())
  );

-- DM：参加者のみ
create policy threads_read on public.dm_threads for select to authenticated
  using (public.in_thread(id, auth.uid()));
create policy threads_insert on public.dm_threads for insert to authenticated
  with check (true);

create policy parts_read on public.dm_participants for select to authenticated
  using (public.in_thread(thread_id, auth.uid()));
create policy parts_insert on public.dm_participants for insert to authenticated
  with check (not public.is_blocked(auth.uid(), user_id));
create policy parts_update on public.dm_participants for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- メッセージ：スレッド参加者のみ。ブロック中は送れない
create policy messages_read on public.messages for select to authenticated
  using (public.in_thread(thread_id, auth.uid()));
create policy messages_insert on public.messages for insert to authenticated
  with check (
    auth.uid() = sender_id
    and public.in_thread(thread_id, auth.uid())
    and not exists (
      select 1 from public.dm_participants p
      where p.thread_id = thread_id
        and p.user_id <> auth.uid()
        and public.is_blocked(auth.uid(), p.user_id)
    )
  );

-- ============================================================
-- 期限切れストーリーの掃除（pg_cron が有効なら1時間ごと）
-- ============================================================
create or replace function public.purge_expired_stories()
returns void language sql security definer set search_path = public as $$
  delete from public.stories where expires_at < now() - interval '1 hour';
$$;
