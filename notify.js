/* ============================================================
   ROXX / 通知とアバター

   * 通知の行はサーバー側のトリガーが作る。クライアントからは作れない。
     DMは「承認済みのスレッドだけ」通知する判定もトリガー内にある。
   * アバターは公開バケット。見られる前提の画像なので署名を挟まない。
   ============================================================ */

const AVATAR_BUCKET = "avatars";
const NOTIF_LIMIT = 40;

let NOTIFS = [];
let UNREAD = 0;

/* ---------- 取得 ---------- */
async function loadNotifs() {
  if (!sb || !ME) return;
  const { data, error } = await sb.from("notifications")
    .select("id,actor_id,kind,target_id,read_at,created_at")
    .order("created_at", { ascending: false })
    .limit(NOTIF_LIMIT);
  if (error) { NOTIFS = []; UNREAD = 0; return }

  NOTIFS = data || [];
  UNREAD = NOTIFS.filter(n => !n.read_at).length;

  const who = await profilesByIds([...new Set(NOTIFS.map(n => n.actor_id).filter(Boolean))]);
  NOTIFS.forEach(n => { n.actor = who[n.actor_id] || { display_name: "利用者", handle: "" } });
  paintBell();
}

function paintBell() {
  const b = elx("bellCount");
  if (!b) return;
  b.textContent = UNREAD > 99 ? "99+" : String(UNREAD);
  b.hidden = UNREAD === 0;
}

/* ---------- 表示 ---------- */
const NOTIF_TEXT = {
  like:   "があなたの投稿にいいねしました",
  follow: "があなたをフォローしました",
  dm:     "からメッセージが届きました"
};

function renderNotifs() {
  const rows = NOTIFS.length ? NOTIFS.map(n => `
    <button class="nfrow ${n.read_at ? "" : "new"}" onclick="openNotif('${n.kind}','${n.target_id}','${n.actor_id}')">
      <span class="nfav">${avatarImg(n.actor, 34)}</span>
      <span class="nftx"><b>${escHtml(n.actor.display_name)}</b>${NOTIF_TEXT[n.kind] || ""}</span>
      <em>${ago(n.created_at)}</em>
    </button>`).join("")
    : `<p class="somsg">通知はまだありません。</p>`;

  elx("soView").innerHTML = `
    <div class="sopad">
      <div class="dmhd">
        <button class="solink" onclick="goTab('home')">← 戻る</button>
        <b>お知らせ</b>
        ${UNREAD ? `<button class="solink" onclick="markAllRead()">すべて既読</button>` : `<span></span>`}
      </div>
      ${rows}
    </div>`;
}

async function openNotifTab() {
  show("s-social");
  document.querySelectorAll(".tabbtn").forEach(b => b.classList.remove("on"));
  elx("soView").innerHTML = `<p class="somsg">読み込んでいます…</p>`;
  await loadNotifs();
  renderNotifs();
  markAllRead(true);
}

function openNotif(kind, targetId, actorId) {
  if (kind === "dm") { goTab("dm"); setTimeout(() => openThread(targetId), 250); return }
  goTab("home");
}

async function markAllRead(silent) {
  if (!sb || !ME || !UNREAD) return;
  const now = new Date().toISOString();
  await sb.from("notifications").update({ read_at: now })
    .eq("user_id", ME.id).is("read_at", null);
  NOTIFS.forEach(n => { if (!n.read_at) n.read_at = now });
  UNREAD = 0;
  paintBell();
  if (!silent) renderNotifs();
}

/* ---------- アバター ---------- */
function avatarUrl(profile) {
  if (!profile || !profile.avatar_path || !sb) return null;
  const { data } = sb.storage.from(AVATAR_BUCKET).getPublicUrl(profile.avatar_path);
  return data ? data.publicUrl : null;
}

/* 画像が無ければ頭文字の丸を出す。輪が全部同じ黒だと人格が出ないため */
function avatarImg(profile, size) {
  const url = avatarUrl(profile);
  const name = (profile && profile.display_name) ? profile.display_name : "?";
  if (url) return `<img class="av" style="width:${size}px;height:${size}px" src="${url}" alt="">`;
  return `<span class="av ini" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${escHtml(name.slice(0, 1))}</span>`;
}

async function pickAvatar() {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*";
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    if (!/^image\//.test(f.type)) { alert("画像ファイルを選んでください"); return }
    if (f.size > 4 * 1024 * 1024) { alert("画像が大きすぎます（4MBまで）"); return }
    try {
      const blob = await squareCrop(f, 512);
      const path = `${ME.id}/avatar.png`;
      const { error: upErr } = await sb.storage.from(AVATAR_BUCKET)
        .upload(path, blob, { contentType: "image/png", upsert: true });
      if (upErr) throw upErr;
      // 同じパスに上書きするため、キャッシュ避けに更新時刻を付ける
      const { error } = await sb.from("profiles")
        .update({ avatar_path: path + "?v=" + Date.now() }).eq("id", ME.id);
      if (error) throw error;
      await loadProfile();
      renderMe();
    } catch (e) {
      alert("画像を保存できませんでした：" + (e.message || e));
    }
  };
  inp.click();
}

/* 中央を正方形に切り出して縮小する。元画像をそのまま上げない */
function squareCrop(file, size) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = size; c.height = size;
      const x = c.getContext("2d");
      const s = Math.min(img.width, img.height);
      x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      c.toBlob(b => b ? resolve(b) : reject(new Error("変換に失敗しました")), "image/png");
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("この画像は読み込めませんでした")) };
    img.src = url;
  });
}
