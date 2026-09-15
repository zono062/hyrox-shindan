-- ============================================================
-- ROXX / プッシュ通知の購読
-- ============================================================
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists idx_push_user on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists push_read on public.push_subscriptions;
create policy push_read on public.push_subscriptions for select to authenticated
  using (auth.uid() = user_id);
drop policy if exists push_delete on public.push_subscriptions;
create policy push_delete on public.push_subscriptions for delete to authenticated
  using (auth.uid() = user_id);

-- 登録は関数経由のみ。同じ端末で別アカウントにログインし直した場合に
-- 端末の購読を新しいアカウントへ付け替えられるようにする。
-- 送信先は既知のプッシュ配信サービスに限定し、任意のURLへ送らせない。
create or replace function public.save_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if length(p_endpoint) > 1000 or p_endpoint !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/' then
    raise exception 'invalid endpoint';
  end if;
  if length(p_p256dh) not between 40 and 200 or length(p_auth) not between 10 and 100 then
    raise exception 'invalid keys';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 200));
end $$;
revoke all on function public.save_push_subscription(text, text, text, text) from public;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;

-- 二重送信を防ぐ印
alter table public.notifications add column if not exists pushed_at timestamptz;

select
  (select count(*) from information_schema.tables where table_name = 'push_subscriptions') as "購読テーブル",
  (select count(*) from pg_proc where proname = 'save_push_subscription')                as "登録関数",
  (select count(*) from information_schema.columns
     where table_name = 'notifications' and column_name = 'pushed_at')                    as "送信済み列";
