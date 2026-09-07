/* ============================================================
   ROXX / コミュニティ（Instagram型の構成）

   下部タブ：ホーム / さがす / プログラム / DM / 自分
   ログイン済みならタブがアプリの外枠になり、診断は「プログラム」タブの中身になる。

   * 権限判定はサーバーのRLSに任せる。ここでの絞り込みは表示の都合であって
     防壁ではない。フォロー外の投稿はそもそも返ってこない。
   * ストーリーとフィード画像は非公開バケットに置き、署名付きURLで読む。
   * 通報・ブロックは App Store ガイドライン1.2 の要件。全画面から到達できる。
   ============================================================ */

const elx = id => document.getElementById(id);
const STORY_BUCKET = "stories";

let TAB = "home";
let FOLLOWING = [];
let STORIES = [];
let POSTS = [];
let THREADS = [];
let OPEN_THREAD = null;
let STORY_IX = 0;
let STORY_TIMER = null;

/* ---------- シェル ----------
   ログイン済みならアプリの外枠はタブになる。診断は「プログラム」タブの中身。
   診断がまだの人はフィードが空なので、プログラムから開く。 */
function enterShell() {
  if (!sb || !ME || !MY_PROFILE) return;
  document.body.classList.add("hastab");
  goTab(R ? "home" : "program");
}
function leaveShell() {
  document.body.classList.remove("hastab");
  stopStory();
  show("s-intro");
}
/* 旧導線からの呼び出しを受ける */
function openSocial() {
  if (!sb || !ME || !MY_PROFILE) { alert("先にアカウントを作成してください"); return }
  enterShell();
  if (typeof track === "function") track("social_open");
}
function closeSocial() { goTab("program") }

function goTab(t) {
  TAB = t;
  document.querySelectorAll(".tabbtn").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  stopStory();
  window.scrollTo(0, 0);

  if (t === "program") {          // 診断とトレーニング
    show(R ? "s-res" : "s-intro");
    if (typeof track === "function") track("tab_program");
    return;
  }
  show("s-social");
  const v = elx("soView");
  v.scrollTop = 0;
  const sub = elx("soTopSub");
  if (sub) sub.textContent = { home: "", find: "さがす", dm: "メッセージ", me: MY_PROFILE ? "@" + MY_PROFILE.handle : "" }[t] || "";
  if (t === "home") { v.innerHTML = skeleton("読み込んでいます…"); loadHome() }
  if (t === "find") renderFind();
  if (t === "post") renderCompose();
  if (t === "dm")   { v.innerHTML = skeleton("読み込んでいます…"); loadThreads() }
  if (t === "me")   renderMe();
}
const skeleton = t => `<p class="somsg">${t}</p>`;

/* ---------- ホーム ---------- */
async function loadHome() {
  await loadFollowing();
  const now = new Date().toISOString();

  const [{ data: st }, { data: ps }] = await Promise.all([
    sb.from("stories").select("id,author_id,image_path,caption,created_at,expires_at")
      .gt("expires_at", now).order("created_at", { ascending: false }).limit(50),
    sb.from("posts").select("id,author_id,image_path,caption,created_at")
      .order("created_at", { ascending: false }).limit(30)
  ]);
  STORIES = st || []; POSTS = ps || [];

  const ids = [...new Set([...STORIES, ...POSTS].map(x => x.author_id))];
  const who = await profilesByIds(ids);
  STORIES.forEach(s => s.author = who[s.author_id] || { display_name: "利用者" });
  POSTS.forEach(p => p.author = who[p.author_id] || { display_name: "利用者" });

  await Promise.all([...STORIES, ...POSTS].map(async x => {
    if (x.image_path) x.url = await signed(x.image_path);
  }));

  // いいね
  if (POSTS.length) {
    const { data: likes } = await sb.from("post_likes").select("post_id,user_id")
      .in("post_id", POSTS.map(p => p.id));
    POSTS.forEach(p => {
      const mine = (likes || []).filter(l => l.post_id === p.id);
      p.likes = mine.length;
      p.liked = mine.some(l => l.user_id === ME.id);
    });
  }
  renderHome();
}

function renderHome() {
  // ストーリーは作者ごとにまとめる（インスタと同じく1人1つの輪）
  const byAuthor = [];
  STORIES.forEach(s => {
    let g = byAuthor.find(g => g.id === s.author_id);
    if (!g) { g = { id: s.author_id, author: s.author, items: [] }; byAuthor.push(g) }
    g.items.push(s);
  });
  const mineFirst = byAuthor.sort((a, b) => (a.id === ME.id ? -1 : b.id === ME.id ? 1 : 0));

  const ring = mineFirst.map((g, i) => `
    <button class="ring" onclick="openStoryGroup(${i})">
      <span class="ringimg">${g.items[0].url ? `<img src="${g.items[0].url}" alt="">` : ""}</span>
      <span class="ringname">${g.id === ME.id ? "自分" : escHtml(g.author.display_name)}</span>
    </button>`).join("");

  const feed = POSTS.length ? POSTS.map(p => `
    <article class="post">
      <header class="posthd">
        <div><b>${escHtml(p.author.display_name)}</b><span>${ago(p.created_at)}</span></div>
        <button class="solink" onclick="postMenu('${p.id}','${p.author_id}')">…</button>
      </header>
      ${p.url ? `<img class="postimg" src="${p.url}" alt="">` : ""}
      <div class="postact">
        <button class="likebtn ${p.liked ? "on" : ""}" onclick="toggleLike('${p.id}')">
          ${p.liked ? "♥" : "♡"} <span>${p.likes || 0}</span>
        </button>
      </div>
      ${p.caption ? `<p class="postcap"><b>${escHtml(p.author.display_name)}</b> ${escHtml(p.caption)}</p>` : ""}
    </article>`).join("")
    : `<p class="somsg">まだ投稿がありません。「さがす」で仲間を追加するか、＋から自分のトレーニングを投稿してください。</p>`;

  elx("soView").innerHTML = `
    <div class="storystrip">
      <button class="ring add" onclick="openCompose()">
        <span class="ringimg plus">＋</span><span class="ringname">投稿</span>
      </button>
      ${ring}
    </div>
    <div class="feed">${feed}</div>`;
}

/* ---------- ストーリー閲覧（全画面・自動送り） ---------- */
let STORY_GROUP = [];
function openStoryGroup(gi) {
  const byAuthor = [];
  STORIES.forEach(s => {
    let g = byAuthor.find(g => g.id === s.author_id);
    if (!g) { g = { id: s.author_id, author: s.author, items: [] }; byAuthor.push(g) }
    g.items.push(s);
  });
  const g = byAuthor.sort((a, b) => (a.id === ME.id ? -1 : b.id === ME.id ? 1 : 0))[gi];
  if (!g) return;
  STORY_GROUP = g.items; STORY_IX = 0;
  elx("storyView").classList.add("on");
  paintStory();
}

function paintStory() {
  const s = STORY_GROUP[STORY_IX];
  if (!s) { stopStory(); return }
  const mine = s.author_id === ME.id;
  elx("storyView").innerHTML = `
    <div class="stbars">${STORY_GROUP.map((_, i) =>
      `<i class="${i < STORY_IX ? "done" : i === STORY_IX ? "cur" : ""}"></i>`).join("")}</div>
    <div class="sthd">
      <div><b>${escHtml(s.author.display_name)}</b><span>${leftTime(s.expires_at)}</span></div>
      <button onclick="stopStory()">✕</button>
    </div>
    <div class="stbody">
      <button class="stnav prev" onclick="stepStory(-1)" aria-label="前へ"></button>
      <button class="stnav next" onclick="stepStory(1)" aria-label="次へ"></button>
      ${s.url ? `<img src="${s.url}" alt="">` : `<div class="stna"></div>`}
    </div>
    <p class="stcap">${escHtml(s.caption || "")}</p>
    <div class="stacts">
      ${mine
        ? `<button class="solink" onclick="deleteStory('${s.id}','${s.image_path}')">削除する</button>`
        : `<button class="solink" onclick="openReport('story','${s.id}','この投稿')">通報</button>
           <button class="solink" onclick="blockUser('${s.author_id}')">この人をブロック</button>
           <button class="solink" onclick="dmTo('${s.author_id}')">メッセージを送る</button>`}
    </div>`;
  if (!mine) sb.from("story_views").upsert({ story_id: s.id, viewer_id: ME.id });
  clearTimeout(STORY_TIMER);
  STORY_TIMER = setTimeout(() => stepStory(1), 6000);
}
function stepStory(d) {
  STORY_IX += d;
  if (STORY_IX < 0) { STORY_IX = 0; return }
  if (STORY_IX >= STORY_GROUP.length) { stopStory(); return }
  paintStory();
}
function stopStory() {
  clearTimeout(STORY_TIMER);
  const v = elx("storyView"); if (v) { v.classList.remove("on"); v.innerHTML = "" }
}

/* ---------- さがす ---------- */
function renderFind() {
  elx("soView").innerHTML = `
    <div class="sopad">
      <h3 class="soh">仲間を探す</h3>
      <input class="authinput" id="soFind" type="text" placeholder="ユーザーID（例：mizuyuu0602）">
      <button class="btn" onclick="searchUser()">探す</button>
      <div id="soFindOut"></div>
      <h3 class="soh" style="margin-top:32px">フォロー中</h3>
      <div id="soList"></div>
    </div>`;
  loadFollowing().then(paintFollowing);
}

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
  if (!/^[a-z0-9_]{3,20}$/.test(q)) { out.innerHTML = `<p class="somsg err">ユーザーIDを入力してください</p>`; return }
  out.innerHTML = skeleton("探しています…");
  const { data } = await sb.from("profiles").select("id,handle,display_name").eq("handle", q).maybeSingle();
  if (!data) { out.innerHTML = `<p class="somsg">@${escHtml(q)} は見つかりませんでした</p>`; return }
  if (data.id === ME.id) { out.innerHTML = `<p class="somsg">それはあなた自身です</p>`; return }
  const already = FOLLOWING.some(f => f.id === data.id);
  out.innerHTML = `
    <div class="sorow">
      <div><b>${escHtml(data.display_name)}</b><span>@${escHtml(data.handle)}</span></div>
      ${already ? `<span class="sotag">フォロー中</span>`
                : `<button class="sobtn" onclick="follow('${data.id}')">フォローする</button>`}
    </div>`;
}

async function follow(id) {
  const { error } = await sb.from("follows").insert({ follower_id: ME.id, followee_id: id });
  if (error) { alert("フォローできませんでした：" + error.message); return }
  if (typeof track === "function") track("follow");
  renderFind();
}
async function unfollow(id) {
  if (!confirm("フォローを外しますか。相手の投稿は見えなくなります。")) return;
  await sb.from("follows").delete().eq("follower_id", ME.id).eq("followee_id", id);
  renderFind();
}

function paintFollowing() {
  const box = elx("soList"); if (!box) return;
  if (!FOLLOWING.length) { box.innerHTML = `<p class="somsg">まだ誰もフォローしていません。</p>`; return }
  box.innerHTML = FOLLOWING.map(f => `
    <div class="sorow">
      <div><b>${escHtml(f.display_name)}</b><span>@${escHtml(f.handle)}</span></div>
      <div class="soacts">
        <button class="sobtn" onclick="pairWith('${f.id}')">ペアで計算</button>
        <button class="solink" onclick="dmTo('${f.id}')">メッセージ</button>
        <button class="solink" onclick="unfollow('${f.id}')">解除</button>
        <button class="solink" onclick="openReport('user','${f.id}','${escAttr(f.display_name)}')">通報</button>
        <button class="solink" onclick="blockUser('${f.id}')">ブロック</button>
      </div>
    </div>`).join("");
}

async function pairWith(userId) {
  if (!R) { alert("先にあなたの診断を終えてください"); return }
  const { data: pub } = await sb.from("athlete_public").select("*").eq("user_id", userId).maybeSingle();
  if (!pub) { alert("相手がまだ診断を終えていません"); return }
  const prof = FOLLOWING.find(f => f.id === userId);
  PARTNER = {
    sex: prof && prof.sex ? prof.sex : (A ? A.sex : "m"),
    lap: pub.lap_sec, S: pub.stations, need: pub.need_weeks,
    name: prof ? prof.display_name : "相手"
  };
  Store.set("partner", PARTNER);
  if (typeof track === "function") track("pair_from_follow");
  closeSocial(); renderDoubles();
  const t = elx("rPair"); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------- 投稿 ---------- */
function openCompose() {
  show("s-social");
  document.querySelectorAll(".tabbtn").forEach(b => b.classList.remove("on"));
  renderCompose();
}
function renderCompose() {
  elx("soView").innerHTML = `
    <div class="sopad">
      <h3 class="soh">投稿する</h3>
      ${R ? `<p class="somsg">いまの結果カードがそのまま画像になります。写真を選ぶと背景に使えます。</p>
      <textarea class="authinput" id="cpCap" rows="3" maxlength="300" placeholder="ひとこと（任意）"></textarea>
      <button class="btn" id="cpStory" onclick="publish('story')">ストーリーに出す（24時間で消える）</button>
      <button class="ghost" style="margin-top:9px" id="cpPost" onclick="publish('post')">フィードに投稿する（残る）</button>
      <p class="authnote">どちらも<b>フォロワーだけ</b>が見られます。画像に身長・体重・年齢は含まれません。</p>`
      : `<p class="somsg">先に診断を終えてください。結果が投稿の中身になります。</p>`}
    </div>`;
}

async function publish(kind) {
  const cap = (elx("cpCap") ? elx("cpCap").value : "").trim();
  const btn = elx(kind === "story" ? "cpStory" : "cpPost");
  if (btn) { btn.disabled = true; btn.textContent = "投稿しています…" }
  try {
    const canvas = await buildShareCard(null);
    const blob = await new Promise(r => canvas.toBlob(r, "image/png"));
    const id = crypto.randomUUID();
    const path = `${ME.id}/${id}.png`;
    const { error: upErr } = await sb.storage.from(STORY_BUCKET)
      .upload(path, blob, { contentType: "image/png", upsert: false });
    if (upErr) throw upErr;

    const caption = cap || `予測 ${hms(R.total)} ／ 必要 ${R.need}週`;
    const table = kind === "story" ? "stories" : "posts";
    const row = kind === "story"
      ? { id, author_id: ME.id, image_path: path, kind: "result", caption }
      : { id, author_id: ME.id, image_path: path, kind: "training", caption };
    const { error } = await sb.from(table).insert(row);
    if (error) throw error;

    if (typeof track === "function") track(kind === "story" ? "story_post" : "feed_post");
    goTab("home");
  } catch (e) {
    alert("投稿できませんでした：" + (e.message || e));
    if (btn) { btn.disabled = false; btn.textContent = kind === "story" ? "ストーリーに出す（24時間で消える）" : "フィードに投稿する（残る）" }
  }
}

async function toggleLike(postId) {
  const p = POSTS.find(x => x.id === postId); if (!p) return;
  if (p.liked) { await sb.from("post_likes").delete().eq("post_id", postId).eq("user_id", ME.id); p.likes--; p.liked = false }
  else { await sb.from("post_likes").insert({ post_id: postId, user_id: ME.id }); p.likes++; p.liked = true }
  renderHome();
}

function postMenu(postId, authorId) {
  if (authorId === ME.id) {
    if (confirm("この投稿を削除しますか。")) deletePost(postId);
    return;
  }
  openReport("story", postId, "この投稿");
}
async function deletePost(id) {
  await sb.from("posts").delete().eq("id", id);
  loadHome();
}
async function deleteStory(id, path) {
  if (!confirm("この投稿を削除しますか。")) return;
  await sb.from("stories").delete().eq("id", id);
  if (path) await sb.storage.from(STORY_BUCKET).remove([path]);
  stopStory(); loadHome();
}

/* ---------- DM ---------- */
async function loadThreads() {
  const { data: parts } = await sb.from("dm_participants").select("thread_id,accepted,last_read_at").eq("user_id", ME.id);
  const ids = (parts || []).map(p => p.thread_id);
  if (!ids.length) { THREADS = []; renderThreads(); return }

  const { data: others } = await sb.from("dm_participants").select("thread_id,user_id").in("thread_id", ids);
  const { data: msgs } = await sb.from("messages").select("thread_id,body,created_at,sender_id")
    .in("thread_id", ids).order("created_at", { ascending: false });

  const who = await profilesByIds([...new Set((others || []).map(o => o.user_id).filter(u => u !== ME.id))]);
  THREADS = (parts || []).map(p => {
    const other = (others || []).find(o => o.thread_id === p.thread_id && o.user_id !== ME.id);
    const last = (msgs || []).find(m => m.thread_id === p.thread_id);
    return {
      id: p.thread_id, accepted: p.accepted,
      other: other ? (who[other.user_id] || { display_name: "利用者" }) : { display_name: "利用者" },
      otherId: other ? other.user_id : null,
      last: last ? last.body : "", at: last ? last.created_at : null
    };
  }).sort((a, b) => (Date.parse(b.at || 0) - Date.parse(a.at || 0)));
  renderThreads();
}

function renderThreads() {
  const open = THREADS.filter(t => t.accepted);
  const req = THREADS.filter(t => !t.accepted);
  const row = t => `
    <button class="dmrow" onclick="openThread('${t.id}')">
      <div><b>${escHtml(t.other.display_name)}</b><span>${escHtml((t.last || "").slice(0, 40)) || "（メッセージなし）"}</span></div>
      <em>${t.at ? ago(t.at) : ""}</em>
    </button>`;
  elx("soView").innerHTML = `
    <div class="sopad">
      <h3 class="soh">メッセージ</h3>
      ${open.length ? open.map(row).join("") : `<p class="somsg">やり取りはまだありません。</p>`}
      ${req.length ? `<h3 class="soh" style="margin-top:28px">リクエスト <span class="reqn">${req.length}</span></h3>
        <p class="somsg">承認するまで相手に既読は伝わりません。</p>${req.map(row).join("")}` : ""}
    </div>`;
}

async function dmTo(userId) {
  const { data, error } = await sb.rpc("start_dm", { target_user: userId });
  if (error) { alert("メッセージを開始できませんでした：" + error.message); return }
  stopStory(); goTab("dm");
  setTimeout(() => openThread(data), 300);
}

async function openThread(id) {
  OPEN_THREAD = THREADS.find(t => t.id === id) || { id, other: { display_name: "" }, accepted: true };
  const { data: msgs } = await sb.from("messages").select("*").eq("thread_id", id).order("created_at");
  const mine = THREADS.find(t => t.id === id);
  elx("soView").innerHTML = `
    <div class="dmhd">
      <button class="solink" onclick="goTab('dm')">← 戻る</button>
      <b>${escHtml(OPEN_THREAD.other.display_name)}</b>
      <button class="solink" onclick="openReport('user','${OPEN_THREAD.otherId}','${escAttr(OPEN_THREAD.other.display_name)}')">通報</button>
    </div>
    ${mine && !mine.accepted ? `<div class="dmreq">
        <p>この人からのメッセージリクエストです。</p>
        <button class="sobtn" onclick="acceptThread('${id}')">承認する</button>
        <button class="solink" onclick="blockUser('${OPEN_THREAD.otherId}')">ブロック</button>
      </div>` : ""}
    <div class="dmbody" id="dmBody">
      ${(msgs || []).map(m => `<div class="bub ${m.sender_id === ME.id ? "me" : ""}">${escHtml(m.body)}</div>`).join("")
        || `<p class="somsg">まだメッセージがありません。</p>`}
    </div>
    <div class="dmform">
      <input class="authinput" id="dmText" maxlength="2000" placeholder="メッセージ">
      <button class="sobtn" onclick="sendMsg('${id}')">送信</button>
    </div>`;
  const b = elx("dmBody"); if (b) b.scrollTop = b.scrollHeight;
  await sb.from("dm_participants").update({ last_read_at: new Date().toISOString() })
    .eq("thread_id", id).eq("user_id", ME.id);
}

async function acceptThread(id) {
  await sb.from("dm_participants").update({ accepted: true }).eq("thread_id", id).eq("user_id", ME.id);
  await loadThreads(); openThread(id);
}

async function sendMsg(id) {
  const box = elx("dmText"); const body = (box.value || "").trim();
  if (!body) return;
  box.value = "";
  const { error } = await sb.from("messages").insert({ thread_id: id, sender_id: ME.id, body });
  if (error) { alert("送信できませんでした：" + error.message); return }
  if (typeof track === "function") track("dm_send");
  openThread(id);
}

/* ---------- 自分 ---------- */
function renderMe() {
  elx("soView").innerHTML = `
    <div class="sopad">
      <div class="mehd">
        <b>${escHtml(MY_PROFILE.display_name)}</b>
        <span>@${escHtml(MY_PROFILE.handle)}</span>
      </div>
      <h3 class="soh" style="margin-top:28px">設定</h3>
      <button class="ghost" onclick="goTab('program')">診断とトレーニングを見る</button>
      <button class="ghost" style="margin-top:9px" onclick="openBlocked()">ブロックした人</button>
      <button class="ghost" style="margin-top:9px" onclick="signOut();leaveShell()">ログアウト</button>
      <h3 class="soh" style="margin-top:28px">安全のために</h3>
      <p class="somsg">不快な投稿やメッセージは通報してください。内容を確認し、削除やアカウント停止を行います。緊急のご連絡は mizuyuu0602@gmail.com へ。</p>
      <p class="somsg"><a href="./legal/privacy.html">プライバシーポリシー</a>　<a href="./legal/terms.html">利用規約</a></p>
    </div>`;
}

async function openBlocked() {
  const { data } = await sb.from("blocks").select("blocked_id").eq("blocker_id", ME.id);
  const ids = (data || []).map(b => b.blocked_id);
  const who = await profilesByIds(ids);
  elx("soView").innerHTML = `
    <div class="sopad">
      <div class="dmhd"><button class="solink" onclick="goTab('me')">← 戻る</button><b>ブロックした人</b><span></span></div>
      ${ids.length ? ids.map(id => `
        <div class="sorow">
          <div><b>${escHtml((who[id] || {}).display_name || "利用者")}</b></div>
          <div class="soacts"><button class="sobtn" onclick="unblock('${id}')">解除する</button></div>
        </div>`).join("") : `<p class="somsg">ブロックしている人はいません。</p>`}
    </div>`;
}
async function unblock(id) {
  await sb.from("blocks").delete().eq("blocker_id", ME.id).eq("blocked_id", id);
  openBlocked();
}

/* ---------- 通報・ブロック ---------- */
function openReport(type, id, label) {
  const v = elx("storyView");
  v.innerHTML = `
    <div class="sthd"><div><b>通報する</b><span>${escHtml(label)}</span></div>
      <button onclick="stopStory()">✕</button></div>
    <div class="sopad">
      <p class="somsg">内容を確認し、必要に応じて削除やアカウントの停止を行います。通報したことは相手に通知されません。</p>
      <select class="authinput" id="rpReason">
        <option value="harassment">嫌がらせ・迷惑行為</option>
        <option value="sexual">性的な内容</option>
        <option value="spam">スパム・宣伝</option>
        <option value="impersonation">なりすまし</option>
        <option value="other">その他</option>
      </select>
      <textarea class="authinput" id="rpNote" rows="3" maxlength="500" placeholder="補足があれば（任意）"></textarea>
      <button class="btn" onclick="sendReport('${type}','${id}')">通報する</button>
      <p class="somsg" id="rpMsg"></p>
    </div>`;
  v.classList.add("on");
}

async function sendReport(type, id) {
  const { error } = await sb.from("reports").insert({
    reporter_id: ME.id, target_type: type, target_id: id,
    reason: elx("rpReason").value, note: (elx("rpNote").value || "").trim() || null
  });
  const msg = elx("rpMsg");
  msg.textContent = error ? "送信できませんでした：" + error.message : "通報を受け付けました。確認のうえ対応します。";
  msg.className = "somsg" + (error ? " err" : "");
  if (!error && typeof track === "function") track("report", { type });
}

async function blockUser(id) {
  if (!confirm("この人をブロックしますか。お互いの投稿とプロフィールが見えなくなり、メッセージも届かなくなります。")) return;
  await sb.from("blocks").insert({ blocker_id: ME.id, blocked_id: id });
  await sb.from("follows").delete().eq("follower_id", ME.id).eq("followee_id", id);
  if (typeof track === "function") track("block");
  stopStory(); goTab("home");
}

/* ---------- 共通 ---------- */
async function profilesByIds(ids) {
  const map = {};
  if (!ids || !ids.length) return map;
  const { data } = await sb.from("profiles").select("id,handle,display_name").in("id", ids);
  (data || []).forEach(p => { map[p.id] = p });
  return map;
}
async function signed(path) {
  const { data } = await sb.storage.from(STORY_BUCKET).createSignedUrl(path, 3600);
  return data ? data.signedUrl : null;
}
function leftTime(exp) {
  const m = Math.max(0, Math.round((Date.parse(exp) - Date.now()) / 60000));
  return m >= 60 ? `あと${Math.floor(m / 60)}時間` : `あと${m}分`;
}
function ago(at) {
  const m = Math.round((Date.now() - Date.parse(at)) / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  if (m < 1440) return `${Math.floor(m / 60)}時間前`;
  return `${Math.floor(m / 1440)}日前`;
}
function escHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escAttr(s) { return escHtml(s).replace(/'/g, "&#39;") }
