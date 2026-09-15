-- ============================================================
-- ROXX / 通知が作られたら send-push を呼ぶ
--
-- 呼び出しに秘密は載せない。send-push は受け取った本文を信用せず、
-- 通知IDでDBから読み直して「実在し・5分以内で・未送信」のものだけを
-- 1回送る。第三者が同じURLを叩いても、送られるのは本来届くはずの
-- 通知が少し早まるだけで、偽の通知は作れない。
-- そのため send-push は JWT 検証をオフにしてデプロイする。
-- ============================================================
create extension if not exists pg_net;

create or replace function public.push_on_notification() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url     := 'https://yywygivoktufvgcyswji.supabase.co/functions/v1/send-push',
    body    := jsonb_build_object('record', jsonb_build_object('id', NEW.id)),
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
  return NEW;
end $$;

drop trigger if exists trg_push_on_notification on public.notifications;
create trigger trg_push_on_notification after insert on public.notifications
  for each row execute function public.push_on_notification();

select
  (select count(*) from pg_extension where extname = 'pg_net')                              as "pg_net",
  (select count(*) from information_schema.triggers where trigger_name = 'trg_push_on_notification') as "送信トリガー";
