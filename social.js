/* ============================================================
   ROXX / ストーリー・フォロー・通報

   * 権限判定はサーバーのRLSに任せる。ここでの絞り込みは表示の都合であって
     防壁ではない。フォロー外のストーリーは、そもそも返ってこない。
   * ストーリー画像は非公開バケットに置き、閲覧は署名付きURLで行う。
     URLを知られても、フォロワーでなければ発行自体ができない。
   * 通報とブロックは App Store ガイドライン1.2 の要件。後付けにしない。
   ============================================================ */

const elx = id => document.getElementById(id);
const STORY_BUCKET = "stories";

let FOLLOWING = [];   // 自分がフォローしている相手のプロフィール
let FEED = [];        // 表示中のストーリー

/* ---------- 画面 ---------- */
function openSocial() {
  if (!sb || !ME || !MY_PROFILE) { alert("先にアカウントを作成してください"); return }
  show("s-social");
  refreshSocial();
  if (typeof track === "function") track("social_open");
}
function closeSocial() { show(R ? "s-res" : "s-intro") }

async function refreshSocial() {
  await loadFollowing();
  await loadFeed();
  paintFollowing();
  paintFeed();
}

/* ---------- フォロー ---------- */
async function loadFollowing() {
  const { data } = await sb.from("follows").select("followee_id").eq("follower_id", ME.id);
  const ids = (data || []).map(r => r.followee_id);
  if (!ids.length) { FOLLOWING = []; return }
  const { data: profs } = await sb.from("profiles").select("id,handle,display_name,sex").in("id", ids);
  FOLLOWING = profs || [];
}

async function searchUser() {
  const q = (elx("soFind").value || "").trim().toLowerCase().replace(/^@/, "");
  const out = elx("soFindOut");
  if (!/^[a-z0-9_]{3,20}$/.test(q)) { out.innerHTML = `<p class="authmsg err">ユーザーIDを入力してください（半角英数字3〜20文字）</p>`; return }
  out.innerHTML = `<p class="authmsg">探しています…</p>`;

  const { data } = await sb.from("profiles").select("id,handle,display_name").eq("handle", q).maybeSingle();
  if (!data) { out.innerHTML = `<p class="authmsg">@${escHtml(q)} は見つかりませんでした</p>`; return }
  if (data.id === ME.id) { out.innerHTML = `<p class="authmsg">それはあなた自身です</p>`; return }

  const already = FOLLOWING.some(f => f.id === data.id);
  out.innerHTML = `
    <div class="sorow">
      <div><b>${escHtml(data.display_name)}</b><span>@${escHtml(data.handle)}</span></div>
      ${already
        ? `<span class="sotag">フォロー中</span>`
        : `<button class="sobtn" onclick="follow('${data.id}')">フォローする</button>`}
    </div>`;
}

async function follow(id) {
  const { error } = await sb.from("follows").insert({ follower_id: ME.id, followee_id: id });
  if (error) { alert("フォローできませんでした：" + error.message); return }
  if (typeof track === "function") track("follow");
  elx("soFindOut").innerHTML = "";
  elx("soFind").value = "";
  await refreshSocial();
}

async function unfollow(id) {
  if (!confirm("フォローを外しますか。相手のストーリーは見えなくなります。")) return;
  await sb.from("follows").delete().eq("follower_id", ME.id).eq("followee_id", id);
  await refreshSocial();
}

function paintFollowing() {
  const box = elx("soList");
  if (!FOLLOWING.length) {
    box.innerHTML = `<p class="authmsg">まだ誰もフォローしていません。ユーザーIDで探して追加すると、相手のストーリーが見られます。</p>`;
    return;
  }
  box.innerHTML = FOLLOWING.map(f => `
    <div class="sorow">
      <div><b>${escHtml(f.display_name)}</b><span>@${escHtml(f.handle)}</span></div>
      <div class="soacts">
        <button class="sobtn" onclick="pairWith('${f.id}')">ペアで計算</button>
        <button class="solink" onclick="unfollow('${f.id}')">解除</button>
        <button class="solink" onclick="openReport('user','${f.id}','${escAttr(f.display_name)}')">通報</button>
        <button class="solink" onclick="blockUser('${f.id}')">ブロック</button>
      </div>
    </div>`).join("");
}

/* ---------- ペア生成（サーバー版） ---------- */
async function pairWith(userId) {
  if (!R) { alert("先にあなたの診断を終えてください"); return }
  const { data: pub } = await sb.from("athlete_public").select("*").eq("user_id", userId).maybeSingle();
  if (!pub) { alert("相手がまだ診断を終えていません"); return }
  const prof = FOLLOWING.find(f => f.id === userId);

  PARTNER = {
    sex: prof && prof.sex ? prof.sex : (A ? A.sex : "m"),
    lap: pub.lap_sec,
    S: pub.stations,
    need: pub.need_weeks,
    name: prof ? prof.display_name : "相手"
  };
  Store.set("partner", PARTNER);
  if (typeof track === "function") track("pair_from_follow");
  closeSocial();
  renderDoubles();
  const t = elx("rPair"); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- ストーリー ---------- */
async function postStory() {
  if (!R) { alert("先に診断を終えてください"); return }
  const btn = elx("soPost"); if (btn) { btn.disabled = true; btn.textContent = "投稿しています…" }
  try {
    const canvas = await buildShareCard(null);
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    const id = crypto.randomUUID();
    const path = `${ME.id}/${id}.png`;

    const { error: upErr } = await sb.storage.from(STORY_BUCKET)
      .upload(path, blob, { contentType: "image/png", upsert: false });
    if (upErr) throw upErr;

    const { error: insErr } = await sb.from("stories").insert({
      id, author_id: ME.id, image_path: path, kind: "result",
      caption: `予測 ${hms(R.total)} ／ 必要 ${R.need}週`
    });
    if (insErr) throw insErr;

    if (typeof track === "function") track("story_post");
    await loadFeed(); paintFeed();
    alert("投稿しました。24時間でフォロワーの画面から自動的に消えます。");
  } catch (e) {
    alert("投稿できませんでした：" + (e.message || e));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "いまの結果を投稿する" }
  }
}

async function loadFeed() {
  // 期限内・フォロー中・ブロック外の絞り込みはRLS側で行われる
  const { data } = await sb.from("stories")
    .select("id,author_id,image_path,caption,created_at,expires_at")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(30);
  FEED = data || [];

  const ids = [...new Set(FEED.map(s => s.author_id))];
  const names = {};
  if (ids.length) {
    const { data: profs } = await sb.from("profiles").select("id,handle,display_name").in("id", ids);
    (profs || []).forEach(p => { names[p.id] = p });
  }
  for (const s of FEED) {
    s.author = names[s.author_id] || { display_name: "利用者", handle: "" };
    if (s.image_path) {
      const { data: signed } = await sb.storage.from(STORY_BUCKET).createSignedUrl(s.image_path, 3600);
      s.url = signed ? signed.signedUrl : null;
    }
  }
}

function paintFeed() {
  const box = elx("soFeed");
  if (!FEED.length) {
    box.innerHTML = `<p class="authmsg">まだストーリーがありません。あなたが投稿すると、フォロワーの画面に24時間だけ表示されます。</p>`;
    return;
  }
  box.innerHTML = `<div class="storyrow">` + FEED.map((s, i) => `
    <button class="storycell" onclick="openStory(${i})">
      ${s.url ? `<img src="${s.url}" alt="">` : `<div class="storyna"></div>`}
      <span>${escHtml(s.author.display_name)}${s.author_id === ME.id ? "（自分）" : ""}</span>
    </button>`).join("") + `</div>`;
}

function openStory(i) {
  const s = FEED[i]; if (!s) return;
  const mine = s.author_id === ME.id;
  const v = elx("storyView");
  v.innerHTML = `
    <div class="storyhd">
      <div><b>${escHtml(s.author.display_name)}</b><span>${leftTime(s.expires_at)}</span></div>
      <button onclick="closeStory()">閉じる</button>
    </div>
    ${s.url ? `<img class="storybig" src="${s.url}" alt="">` : ""}
    <p class="storycap">${escHtml(s.caption || "")}</p>
    <div class="storyacts">
      ${mine
        ? `<button class="solink" onclick="deleteStory('${s.id}','${s.image_path}')">この投稿を削除</button>`
        : `<button class="solink" onclick="openReport('story','${s.id}','この投稿')">通報</button>
           <button class="solink" onclick="blockUser('${s.author_id}')">この人をブロック</button>`}
    </div>`;
  v.classList.add("on");
  if (s.author_id !== ME.id) sb.from("story_views").upsert({ story_id: s.id, viewer_id: ME.id });
}
function closeStory() { elx("storyView").classList.remove("on") }

function leftTime(exp) {
  const m = Math.max(0, Math.round((Date.parse(exp) - Date.now()) / 60000));
  return m >= 60 ? `あと${Math.floor(m / 60)}時間` : `あと${m}分`;
}

async function deleteStory(id, path) {
  if (!confirm("この投稿を削除しますか。")) return;
  await sb.from("stories").delete().eq("id", id);
  if (path) await sb.storage.from(STORY_BUCKET).remove([path]);
  closeStory();
  await loadFeed(); paintFeed();
}

/* ---------- 通報・ブロック ---------- */
function openReport(type, id, label) {
  const v = elx("storyView");
  v.innerHTML = `
    <div class="storyhd"><div><b>通報する</b><span>${escHtml(label)}</span></div>
      <button onclick="closeStory()">閉じる</button></div>
    <p class="authlead">内容を確認し、必要に応じて削除やアカウントの停止を行います。通報したことは相手に通知されません。</p>
    <select class="authinput" id="rpReason">
      <option value="harassment">嫌がらせ・迷惑行為</option>
      <option value="sexual">性的な内容</option>
      <option value="spam">スパム・宣伝</option>
      <option value="impersonation">なりすまし</option>
      <option value="other">その他</option>
    </select>
    <textarea class="authinput" id="rpNote" rows="3" maxlength="500" placeholder="補足があれば（任意）"></textarea>
    <button class="btn" onclick="sendReport('${type}','${id}')">通報する</button>
    <p class="authmsg" id="rpMsg"></p>`;
  v.classList.add("on");
}

async function sendReport(type, id) {
  const reason = elx("rpReason").value;
  const note = (elx("rpNote").value || "").trim();
  const { error } = await sb.from("reports").insert({
    reporter_id: ME.id, target_type: type, target_id: id, reason, note: note || null
  });
  const msg = elx("rpMsg");
  if (error) { msg.textContent = "送信できませんでした：" + error.message; msg.className = "authmsg err"; return }
  if (typeof track === "function") track("report", { type });
  msg.textContent = "通報を受け付けました。確認のうえ対応します。";
  msg.className = "authmsg";
}

async function blockUser(id) {
  if (!confirm("この人をブロックしますか。お互いの投稿とプロフィールが見えなくなり、メッセージも届かなくなります。")) return;
  await sb.from("blocks").insert({ blocker_id: ME.id, blocked_id: id });
  await sb.from("follows").delete().eq("follower_id", ME.id).eq("followee_id", id);
  if (typeof track === "function") track("block");
  closeStory();
  await refreshSocial();
  alert("ブロックしました。");
}

/* ---------- 共通 ---------- */
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escAttr(s) { return escHtml(s).replace(/'/g, "&#39;") }
