// ROXX / send-push
// notifications への INSERT をDatabase Webhookが通知してくる。
// 受け取った内容は信用しない。通知IDだけを取り出し、DBから読み直して
// 「5分以内に作られ、まだ送っていない」通知だけを1回送る。
// anon key は公開されているため、第三者が偽の本文で呼んでも送信は起きない。
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const VAPID_PUBLIC_KEY = "BKNZJIkWnmRfF2tVzNbYZX59lpv1RnuiM--M5WLqtR2kuIOt9ofh9dzr8wCWv1RL3116mPZ8kBfmrExfIHZLFAM";
const VAPID_SUBJECT = "mailto:mizuyuu0602@gmail.com";
const FRESH_MS = 5 * 60 * 1000;
const PUSH_TTL_SEC = 3600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TEXT: Record<string, string> = {
  like: "があなたの投稿にいいねしました",
  follow: "があなたをフォローしました",
  dm: "からメッセージが届きました",
};

// Secretsに貼る際に末尾の改行が混ざりやすいので取り除く。
// 鍵が不正でも起動時に落とさず、理由を返せるようにする（落ちると原因がログにしか残らない）。
const privateKey = (Deno.env.get("VAPID_PRIVATE_KEY") ?? "").trim();
let vapidError: string | null = null;
if (!privateKey) {
  vapidError = "VAPID_PRIVATE_KEY is not set";
} else {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, privateKey);
  } catch (e) {
    vapidError = `invalid VAPID key: ${(e as Error).message}`;
  }
}
if (vapidError) console.error(vapidError);

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  if (vapidError) return json({ ok: false, error: "push is not configured", reason: vapidError }, 503);

  let body: { record?: { id?: unknown } };
  try { body = await req.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }
  const id = body?.record?.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) return json({ ok: false, error: "invalid id" }, 400);

  // 送信済みの印を先に付ける。同じ通知が二重に届かない
  const { data: n, error } = await sb.from("notifications")
    .update({ pushed_at: new Date().toISOString() })
    .eq("id", id)
    .is("pushed_at", null)
    .gte("created_at", new Date(Date.now() - FRESH_MS).toISOString())
    .select("id,user_id,actor_id,kind,target_id")
    .maybeSingle();
  if (error) {
    console.error("notification lookup failed", { id, error });
    return json({ ok: false, error: "lookup failed" }, 500);
  }
  if (!n) return json({ ok: true, skipped: true });

  const [{ data: actor }, { data: subs, error: subErr }] = await Promise.all([
    sb.from("profiles").select("display_name").eq("id", n.actor_id).maybeSingle(),
    sb.from("push_subscriptions").select("id,endpoint,p256dh,auth").eq("user_id", n.user_id),
  ]);
  if (subErr) {
    console.error("subscription lookup failed", { user: n.user_id, subErr });
    return json({ ok: false, error: "subscription lookup failed" }, 500);
  }

  const payload = JSON.stringify({
    title: "ROXX",
    body: `${actor?.display_name ?? "だれか"}${TEXT[n.kind] ?? ""}`,
    tag: `${n.kind}-${n.target_id ?? ""}`,
    url: n.kind === "dm" ? `./#dm=${n.target_id}` : "./",
  });

  const results = await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: PUSH_TTL_SEC },
      );
      return "sent";
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 端末側で購読が切れている。以後送らないよう消す
      if (code === 404 || code === 410) {
        await sb.from("push_subscriptions").delete().eq("id", s.id);
        return "expired";
      }
      console.error("push send failed", { sub: s.id, code });
      return "failed";
    }
  }));

  return json({ ok: true, results });
});
