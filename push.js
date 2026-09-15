/* ============================================================
   ROXX / プッシュ通知の購読（端末側）

   * 公開鍵はブラウザに渡す前提の値。秘密鍵はEdge FunctionのSecretsにだけ置く。
   * iPhoneは「ホーム画面に追加」したアプリからでないと通知を許可できない。
     Safariのタブのままでは購読APIそのものが存在しないため、その旨を案内する。
   ============================================================ */

const VAPID_PUBLIC_KEY = "BKNZJIkWnmRfF2tVzNbYZX59lpv1RnuiM--M5WLqtR2kuIOt9ofh9dzr8wCWv1RL3116mPZ8kBfmrExfIHZLFAM";

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent) }
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}

function b64uToBytes(s) {
  const pad = "=".repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function enablePush() {
  if (!sb || !ME) { alert("先にログインしてください"); return }
  if (!pushSupported()) {
    alert(isIOS() && !isStandalone()
      ? "iPhoneでは、Safariの共有ボタンから「ホーム画面に追加」したアプリを開くと通知を有効にできます。"
      : "このブラウザは通知に対応していません。");
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    alert("通知が許可されませんでした。端末の設定からこのアプリの通知を許可すると有効にできます。");
    paintPushState();
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    const { error } = await sb.rpc("save_push_subscription", {
      p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
      p_user_agent: navigator.userAgent.slice(0, 200)
    });
    if (error) throw error;
    if (typeof track === "function") track("push_enabled");
  } catch (e) {
    alert("通知を有効にできませんでした：" + (e.message || e));
  }
  paintPushState();
}

async function disablePush() {
  try {
    const sub = await currentSubscription();
    if (sub) {
      await sb.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      await sub.unsubscribe();
    }
  } catch (e) {
    alert("通知を止められませんでした：" + (e.message || e));
  }
  paintPushState();
}

async function paintPushState() {
  const box = document.getElementById("pushState");
  if (!box) return;
  if (!pushSupported()) {
    box.innerHTML = `<p class="somsg">${isIOS() && !isStandalone()
      ? "iPhoneでは「ホーム画面に追加」したアプリから通知を有効にできます。"
      : "このブラウザは通知に対応していません。"}</p>`;
    return;
  }
  const sub = await currentSubscription();
  const on = !!sub && Notification.permission === "granted";
  box.innerHTML = on
    ? `<div class="sorow"><div><b>通知はオンです</b><span>いいね・フォロー・メッセージを知らせます</span></div>
         <div class="soacts"><button class="solink" onclick="disablePush()">オフにする</button></div></div>`
    : `<button class="btn" onclick="enablePush()">通知をオンにする</button>
       <p class="authnote">いいね・フォロー・承認済みのメッセージが届いたときに知らせます。メッセージリクエストの段階では通知しません。</p>`;
}

/* 通知から開かれた場合の遷移（例：#dm=スレッドID） */
function routeFromHash() {
  const m = location.hash.match(/^#dm=([0-9a-f-]{36})$/i);
  if (!m) return false;
  history.replaceState({}, "", location.pathname);
  goTab("dm");
  setTimeout(() => openThread(m[1]), 300);
  return true;
}
