// @ts-nocheck
/* ============================================================
   كامورو — API على Supabase Edge Functions
   يُنشر كدالة باسم "api" → يعمل على:
   https://jzvmvjgkbwziwbnrfgwn.supabase.co/functions/v1/api
   نفس مسارات server.js القديمة تماماً.
   ============================================================ */
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY") || "";
const ADMIN_KEY = Deno.env.get("ADMIN_KEY") || "change-this-admin-key-please";
const ADMIN_USERNAME = Deno.env.get("ADMIN_USERNAME") || "admin";
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") || "ChangeMe123!";

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

/* ---------- المصادقة ---------- */
async function getAuth(req) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return { user: data.user, token };
}

async function publicUser(id) {
  const { data } = await supabase
    .from("users")
    .select("id, username, email, bio, avatar_url, email_verified, is_private, is_admin, created_at")
    .eq("id", id).maybeSingle();
  return data || null;
}

async function notify(userId, actorId, type, postId = null) {
  if (!userId || userId === actorId) return;
  await supabase.from("notifications").insert({ user_id: userId, actor_id: actorId, type, post_id: postId });
}

async function uploadFile(bucket, file) {
  if (!file) return null;
  if (file.size > 15 * 1024 * 1024) throw new Error("حجم الملف يتجاوز 15MB");
  const t = (file.type || "").toLowerCase();
  if (!t.startsWith("image/") && !t.startsWith("video/")) throw new Error("نوع الملف غير مسموح");
  const ext = (file.name || "file").split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, await file.arrayBuffer(), { contentType: file.type, upsert: false });
  if (error) throw new Error("فشل رفع الملف: " + error.message);
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
}

async function logAdmin(adminName, action, targetType, targetId, details = "") {
  await supabase.from("admin_logs").insert({
    admin_name: adminName, action, target_type: targetType,
    target_id: String(targetId), details,
  });
}

/* ---------- توكن الأدمن (JWT عبر Web Crypto) ---------- */
const enc = new TextEncoder();
async function hmacKey() {
  return crypto.subtle.importKey("raw", enc.encode(ADMIN_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function b64url(s) { return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
async function signAdmin(user) {
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(JSON.stringify({
    sub: user, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 12 * 3600,
  }));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(String.fromCharCode(...new Uint8Array(sig)))}`;
}
// ... (ما سبق: الاستيرادات، CORS، json، getAuth، publicUser، notify، uploadFile، logAdmin، hmacKey، b64url، signAdmin)

async function verifyAdmin(req) {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [hb, pb, sb] = parts;
  const bin = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(), enc.encode(`${hb}.${pb}`), bin(sb));
  if (!valid) return null;
  const payload = JSON.parse(new TextDecoder().decode(bin(pb)));
  if (payload.exp < Date.now() / 1000) return null;
  return payload; // { sub, iat, exp }
}

/* ---------- دوال مساعدة ---------- */
const ok = (d) => json(d, 200);
const err = (msg, status = 400) => json({ error: msg }, status);
async function userByUsernameOrEmail(idf) {
  const { data } = await supabase
    .from("users").select("*")
    .or(`username.eq.${idf},email.eq.${idf}`)
    .maybeSingle();
  return data;
}
function fileFromForm(form, keys) {
  for (const k of keys) { const f = form.get(k); if (f) return f; }
  return null;
}

/* ============================================================
   المسارات — نفس مسارات server.js القديمة بالضبط
   ============================================================ */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const url = new URL(req.url);
  let p = url.pathname
    .replace(/^\/functions\/v1\/api/, "")
    .replace(/^\/api/, "")
    .replace(/\/+$/, "") || "/";
  const seg = p.split("/").filter(Boolean);
  const m = req.method;

  try {
    /* ===== الصحة ===== */
    if (p === "/" || p === "/health") {
      return ok({ ok: true, service: "Camorro API on Supabase", time: new Date().toISOString() });
    }

    /* ===== تسجيل الدخول ===== */
    if (p === "/login" && m === "POST") {
      const { identifier, password } = await req.json();
      const u = await userByUsernameOrEmail(String(identifier || "").trim());
      if (!u) return err("اسم المستخدم أو كلمة المرور غير صحيحة", 401);
      const { data, error } = await supabase.auth.signInWithPassword({ email: u.email, password: String(password) });
      if (error) return err("اسم المستخدم أو كلمة المرور غير صحيحة", 401);
      if (!u.email_verified) {
        await supabase.auth.signInWithOtp({ email: u.email, options: { shouldCreateUser: false } });
        return ok({ needs_verification: true, email: u.email });
      }
      return ok({ token: data.session.access_token, user: await publicUser(data.user.id) });
    }

    /* ===== إنشاء حساب ===== */
    if (p === "/register" && m === "POST") {
      const { username, email, password } = await req.json();
      if (!username || !email || !password) return err("يرجى ملء جميع الحقول");
      const taken = await userByUsernameOrEmail(String(username).trim());
      if (taken) return err("اسم المستخدم مستخدم بالفعل");
      const { data, error } = await supabase.auth.signUp({
        email: String(email).trim().toLowerCase(),
        password: String(password),
        options: { data: { username: String(username).trim() } },
      });
      if (error) return err(error.message);
      await supabase.from("users").upsert({
        id: data.user.id, username: String(username).trim(), email: data.user.email,
        email_verified: false,
      }, { onConflict: "id" });
      await supabase.auth.signInWithOtp({ email: data.user.email, options: { shouldCreateUser: false } });
      return ok({ needs_verification: true, email: data.user.email });
    }

    /* ===== OTP ===== */
    if (p === "/otp/send" && m === "POST") {
      const { email } = await req.json();
      const { error } = await supabase.auth.signInWithOtp({ email: String(email).toLowerCase(), options: { shouldCreateUser: false } });
      if (error) return err(error.message);
      return ok({ sent: true });
    }
    if (p === "/otp/verify" && m === "POST") {
      const { email, code } = await req.json();
      const { data, error } = await supabase.auth.verifyOtp({ email: String(email).toLowerCase(), token: String(code), type: "email" });
      if (error || !data.session) return err("الرمز غير صحيح أو منتهي", 401);
      await supabase.from("users").update({ email_verified: true }).eq("id", data.user.id);
      return ok({ token: data.session.access_token });
    }

    /* ===== المستخدم الحالي ===== */
    if (p === "/me") {
      const a = await getAuth(req);
      if (!a) return err("غير مصرح", 401);
      return ok(await publicUser(a.user.id));
    }

    /* ===== تحديث الملف الشخصي ===== */
    if (p === "/users/me" && m === "PATCH") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const ct = (req.headers.get("content-type") || "");
      let bio, avatar_url;
      if (ct.includes("multipart/form-data")) {
        const form = await req.formData();
        bio = String(form.get("bio") || "").trim();
        const f = fileFromForm(form, ["avatar", "file", "media"]);
        if (f) avatar_url = await uploadFile("avatars", f);
      } else {
        const b = await req.json();
        bio = b.bio; avatar_url = b.avatar_url;
      }
      const upd = {};
      if (bio !== undefined) upd.bio = String(bio).slice(0, 150);
      if (avatar_url) upd.avatar_url = avatar_url;
      if (!Object.keys(upd).length) return err("لا توجد بيانات");
      await supabase.from("users").update(upd).eq("id", a.user.id);
      return ok(await publicUser(a.user.id));
    }

    /* ===== الملف الشخصي لعموم المستخدمين ===== */
    if (seg[0] === "users" && seg[1] && m === "GET" && !seg[2]) {
      const a = await getAuth(req);
      const target = await publicUser(seg[1]); if (!target) return err("المستخدم غير موجود", 404);
      const posts = (await supabase.from("posts").select("*, comments(count), likes(count)")
        .eq("user_id", seg[1]).order("created_at", { ascending: false }).limit(30)).data || [];
      const follows = (await supabase.from("follows").select("follower_id, following_id")
        .or(`follower_id.eq.${seg[1]},following_id.eq.${seg[1]}`)).data || [];
      const followers = follows.filter((x) => x.following_id === seg[1]).length;
      const following = follows.filter((x) => x.follower_id === seg[1]).length;
      const rel = a ? (await supabase.from("follows").select("status")
        .eq("follower_id", a.user.id).eq("following_id", seg[1]).maybeSingle()).data : null;
      return ok({ user: target, posts, stats: { posts: posts.length, followers, following }, relationship: rel?.status || null });
    }

    /* ===== متابعة / إلغاء ===== */
    if (seg[0] === "users" && seg[1] && p.endsWith("/follow") && m === "POST") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const { action } = await req.json();
      if (action === "follow") {
        await supabase.from("follows").upsert({ follower_id: a.user.id, following_id: seg[1], status: "accepted" },
          { onConflict: "follower_id,following_id" });
        await notify(seg[1], a.user.id, "follow");
      } else {
        await supabase.from("follows").delete().eq("follower_id", a.user.id).eq("following_id", seg[1]);
      }
      return ok({ ok: true });
    }

    /* ===== البحث ===== */
    if (p === "/search" && m === "GET") {
      const q = url.searchParams.get("q") || "";
      const { data } = await supabase.from("users")
        .select("id, username, avatar_url, bio")
        .or(`username.ilike.%${q}%,bio.ilike.%${q}%`).limit(20);
      return ok(data || []);
    }

    /* ===== المنشورات (الخيط الرئيسي) ===== */
    if (p === "/feed" && m === "GET") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const fs = (await supabase.from("follows").select("following_id").eq("follower_id", a.user.id)).data || [];
      const ids = [a.user.id, ...fs.map((f) => f.following_id)];
      const { data: posts } = await supabase.from("posts")
        .select("*, users(username, avatar_url), comments(count), likes(count)")
        .in("user_id", ids).order("created_at", { ascending: false }).limit(30);
      const liked = (await supabase.from("likes").select("post_id").eq("user_id", a.user.id)).data || [];
      const likedSet = new Set(liked.map((l) => l.post_id));
      return ok((posts || []).map((x) => ({ ...x, liked: likedSet.has(x.id), comments_count: x.comments?.[0]?.count || 0, likes_count: x.likes?.[0]?.count || 0 })));
    }

    if (p === "/posts" && m === "POST") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const form = await req.formData();
      const f = fileFromForm(form, ["media", "file", "image", "video"]);
      if (!f) return err("أرفق صورة أو فيديو");
      const media_url = await uploadFile("media", f);
      const caption = String(form.get("caption") || "").trim();
      const { data, error } = await supabase.from("posts")
        .insert({ user_id: a.user.id, media_url, media_type: (f.type || "").startsWith("video/") ? "video" : "image", caption })
        .select("*, users(username, avatar_url)").single();
      if (error) return err(error.message);
      return ok(data);
    }
    if (seg[0] === "posts" && seg[1] && m === "DELETE") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      await supabase.from("posts").delete().eq("id", seg[1]).eq("user_id", a.user.id);
      return ok({ ok: true });
    }

    /* ===== الإعجابات ===== */
    if (p === "/likes" && m === "POST") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const { post_id } = await req.json();
      await supabase.from("likes").upsert({ post_id, user_id: a.user.id }, { onConflict: "post_id,user_id" });
      const post = (await supabase.from("posts").select("user_id").eq("id", post_id).maybeSingle()).data;
      await notify(post?.user_id, a.user.id, "like", post_id);
      return ok({ liked: true });
    }
    if (p === "/likes" && m === "DELETE") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const post_id = url.searchParams.get("post_id");
      await supabase.from("likes").delete().eq("post_id", post_id).eq("user_id", a.user.id);
      return ok({ liked: false });
    }

    /* ===== التعليقات ===== */
    if (p === "/comments" && m === "POST") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const { post_id, body } = await req.json();
      if (!body?.trim()) return err("اكتب التعليق");
      const { data, error } = await supabase.from("comments")
        .insert({ post_id, user_id: a.user.id, body: String(body).trim() })
        .select("*, users(username, avatar_url)").single();
      if (error) return err(error.message);
      const post = (await supabase.from("posts").select("user_id").eq("id", post_id).maybeSingle()).data;
      await notify(post?.user_id, a.user.id, "comment", post_id);
      return ok(data);
    }
    if (seg[0] === "comments" && seg[1] && m === "DELETE") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      await supabase.from("comments").delete().eq("id", seg[1]).eq("user_id", a.user.id);
      return ok({ ok: true });
    }

    /* ===== القصص ===== */
    if (p === "/stories" && m === "GET") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const fs = (await supabase.from("follows").select("following_id").eq("follower_id", a.user.id)).data || [];
      const ids = [a.user.id, ...fs.map((f) => f.following_id)];
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data } = await supabase.from("stories")
        .select("*, users(username, avatar_url)").in("user_id", ids).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(50);
      return ok(data || []);
    }
    if (p === "/stories" && m === "POST") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const form = await req.formData();
      const f = fileFromForm(form, ["media", "file", "image", "video"]);
      if (!f) return err("أرفق صورة أو فيديو");
      const media_url = await uploadFile("media", f);
      const { data, error } = await supabase.from("stories")
        .insert({ user_id: a.user.id, media_url, media_type: (f.type || "").startsWith("video/") ? "video" : "image" })
        .select().single();
      if (error) return err(error.message);
      return ok(data);
    }

    /* ===== الإشعارات ===== */
    if (p === "/notifications" && m === "GET") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const { data } = await supabase.from("notifications")
        .select("*, users(username, avatar_url)").eq("user_id", a.user.id)
        .order("created_at", { ascending: false }).limit(50);
      return ok(data || []);
    }
    if (p === "/notifications/read" && m === "POST") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      await supabase.from("notifications").update({ read: true }).eq("user_id", a.user.id).eq("read", false);
      return ok({ ok: true });
    }
    if (p === "/notifications/unread" && m === "GET") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const { count } = await supabase.from("notifications").select("*", { count: "exact", head: true })
        .eq("user_id", a.user.id).eq("read", false);
      return ok({ count: count || 0 });
    }

    /* ===== المحادثات ===== */
    async function convKey(x, y) { return [x, y].sort().join("__"); }
    if (p === "/conversations" && m === "GET") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const { data: convs } = await supabase.from("conversations").select("*")
        .or(`user_a.eq.${a.user.id},user_b.eq.${a.user.id}`).order("created_at", { ascending: false }).limit(50);
      const out = [];
      for (const c of (convs || [])) {
        const otherId = c.user_a === a.user.id ? c.user_b : c.user_a;
        const other = await publicUser(otherId);
        const last = (await supabase.from("messages").select("*").eq("conversation_id", c.id).order("created_at", { ascending: false }).limit(1).maybeSingle()).data;
        const unread = (await supabase.from("messages").select("*", { count: "exact", head: true })
          .eq("conversation_id", c.id).eq("sender_id", otherId).eq("read", false)).count || 0;
        out.push({ id: c.id, other_id: otherId, other_name: other?.username || "مستخدم", other_avatar: other?.avatar_url || "", last_body: last?.body || "", last_media: last?.media_url || "", last_at: last?.created_at || null, unread });
      }
      return ok(out);
    }
    if (p === "/conversations" && m === "POST") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const { user_id } = await req.json();
      if (user_id === a.user.id) return err("لا يمكن مراسلة نفسك");
      const key = await convKey(a.user.id, user_id);
      let conv = (await supabase.from("conversations").select("*").eq("user_a", key.split("__")[0]).eq("user_b", key.split("__")[1]).maybeSingle()).data;
      if (!conv) {
        const { data, error } = await supabase.from("conversations").insert({ user_a: key.split("__")[0], user_b: key.split("__")[1] }).select().single();
        if (error) return err(error.message);
        conv = data;
      }
      return ok({ conversation_id: conv.id });
    }
    if (seg[0] === "conversations" && seg[1] && m === "GET" && seg[2] === "messages") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const { data } = await supabase.from("messages").select("*").eq("conversation_id", seg[1]).order("created_at", { ascending: true });
      await supabase.from("messages").update({ read: true }).eq("conversation_id", seg[1]).eq("sender_id", a.user.id).eq("read", false);
      return ok(data || []);
    }
    if (seg[0] === "conversations" && seg[1] && m === "POST" && seg[2] === "messages") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const { body } = await req.json();
      if (!body?.trim()) return err("اكتب الرسالة");
      const { data, error } = await supabase.from("messages").insert({ conversation_id: seg[1], sender_id: a.user.id, body: String(body).trim() }).select().single();
      if (error) return err(error.message);
      return ok(data);
    }
    if (seg[0] === "conversations" && seg[1] && m === "POST" && seg[2] === "messages" && seg[3] === "media") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const form = await req.formData();
      const f = fileFromForm(form, ["media", "file", "image", "video"]);
      if (!f) return err("أرفق ملف");
      const media_url = await uploadFile("media", f);
      const { data, error } = await supabase.from("messages").insert({ conversation_id: seg[1], sender_id: a.user.id, media_url }).select().single();
      if (error) return err(error.message);
      return ok(data);
    }
    if (p === "/messages/unread-total" && m === "GET") {
      const a = await getAuth(req); if (!a) return err("غير مصرح", 401);
      const convs = (await supabase.from("conversations").select("id").or(`user_a.eq.${a.user.id},user_b.eq.${a.user.id}`)).data || [];
      let count = 0;
      for (const c of convs) {
        const { count: n } = await supabase.from("messages").select("*", { count: "exact", head: true })
          .eq("conversation_id", c.id).neq("sender_id", a.user.id).eq("read", false);
        count += n || 0;
      }
      return ok({ count });
    }

    /* ============================================================
       لوحة الإدارة (admin.html) — توكن مخصص HS256 + صلاحيات env
       ============================================================ */
    if (p === "/admin/login" && m === "POST") {
      const { username, password } = await req.json();
      if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) return err("بيانات غير صحيحة", 401);
      return ok({ token: await signAdmin(username) });
    }
    if (p === "/admin/stats" && m === "GET") {
      const a = await verifyAdmin(req); if (!a) return err("غير مصرح", 401);
      const users = (await supabase.from("users").select("id", { count: "exact", head: true })).count || 0;
      const posts = (await supabase.from("posts").select("id", { count: "exact", head: true })).count || 0;
      const stories = (await supabase.from("stories").select("id", { count: "exact", head: true })).count || 0;
      return ok({ users, posts, stories });
    }
    if (p === "/admin/users" && m === "GET") {
      const a = await verifyAdmin(req); if (!a) return err("غير مصرح", 401);
      const { data } = await supabase.from("users").select("*").order("created_at", { ascending: false }).limit(200);
      return ok(data || []);
    }
    if (p === "/admin/posts" && m === "GET") {
      const a = await verifyAdmin(req); if (!a) return err("غير مصرح", 401);
      const { data } = await supabase.from("posts").select("*, users(username)").order("created_at", { ascending: false }).limit(300);
      return ok(data || []);
    }
    if (seg[0] === "admin" && seg[1] === "posts" && seg[2] && m === "DELETE") {
      const a = await verifyAdmin(req); if (!a) return err("غير مصرح", 401);
      await supabase.from("posts").delete().eq("id", seg[2]);
      await logAdmin(a.sub, "delete_post", "post", seg[2]);
      return ok({ ok: true });
    }
    if (p === "/admin/comments" && m === "GET") {
      const a = await verifyAdmin(req); if (!a) return err("غير مصرح", 401);
      const { data } = await supabase.from("comments").select("*, users(username)").order("created_at", { ascending: false }).limit(300);
      return ok(data || []);
    }
    if (seg[0] === "admin" && seg[1] === "comments" && seg[2] && m === "DELETE") {
      const a = await verifyAdmin(req); if (!a) return err("غير مصرح", 401);
      await supabase.from("comments").delete().eq("id", seg[2]);
      await logAdmin(a.sub, "delete_comment", "comment", seg[2]);
      return ok({ ok: true });
    }
    if (p === "/admin/stories" && m === "GET") {
      const a = await verifyAdmin(req); if (!a) return err("غير مصرح", 401);
      const { data } = await supabase.from("stories").select("*, users(username)").order("created_at", { ascending: false }).limit(200);
      return ok(data || []);
    }
    if (seg[0] === "admin" && seg[1] === "stories" && seg[2] && m === "DELETE") {
      const a = await verifyAdmin(req); if (!a) return err("غير مصرح", 401);
      await supabase.from("stories").delete().eq("id", seg[2]);
      await logAdmin(a.sub, "delete_story", "story", seg[2]);
      return ok({ ok: true });
    }
    if (p === "/admin/logs" && m === "GET") {
      const a = await verifyAdmin(req); if (!a) return err("غير مصرح", 401);
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      const { data } = await supabase.from("admin_logs").select("*").order("created_at", { ascending: false }).limit(limit);
      return ok(data || []);
    }
    if (seg[0] === "admin" && seg[1] === "users" && seg[2] && seg[3] === "chat" && m === "GET") {
      const a = await verifyAdmin(req); if (!a) return err("غير مصرح", 401);
      const sysId = "00000000-0000-0000-0000-000000000000";
      const key = await convKey(sysId, seg[2]);
      let conv = (await supabase.from("conversations").select("*").eq("user_a", key.split("__")[0]).eq("user_b", key.split("__")[1]).maybeSingle()).data;
      if (!conv) {
        const { data } = await supabase.from("conversations").insert({ user_a: key.split("__")[0], user_b: key.split("__")[1] }).select().single();
        conv = data;
      }
      const { data: msgs } = await supabase.from("messages").select("*").eq("conversation_id", conv.id).order("created_at", { ascending: true });
      return ok({ conversation_id: conv.id, messages: (msgs || []).map((x) => ({ ...x, is_mine: x.sender_id === sysId })) });
    }
    if (p === "/admin/message" && m === "POST") {
      const a = await verifyAdmin(req); if (!a) return err("غير مصرح", 401);
      const { user_id, body } = await req.json();
      if (!user_id || !body?.trim()) return err("بيانات ناقصة");
      const sysId = "00000000-0000-0000-0000-000000000000";
      const key = await convKey(sysId, user_id);
      let conv = (await supabase.from("conversations").select("*").eq("user_a", key.split("__")[0]).eq("user_b", key.split("__")[1]).maybeSingle()).data;
      if (!conv) {
        const { data } = await supabase.from("conversations").insert({ user_a: key.split("__")[0], user_b: key.split("__")[1] }).select().single();
        conv = data;
      }
      await supabase.from("messages").insert({ conversation_id: conv.id, sender_id: sysId, body: String(body) });
      await logAdmin(a.sub, "admin_message", "user", user_id, String(body).slice(0, 60));
      return ok({ ok: true, conversation_id: conv.id });
    }
    if (seg[0] === "admin" && seg[1] === "conversations" && seg[2] && seg[3] === "messages" && m === "GET") {
      const a = await verifyAdmin(req); if (!a) return err("غير مصرح", 401);
      const { data } = await supabase.from("messages").select("*").eq("conversation_id", seg[2]).order("created_at", { ascending: true });
      return ok({ messages: data || [] });
    }

    return err("المسار غير موجود", 404);
  } catch (e) {
    console.error(e);
    return json({ error: e.message || "خطأ في الخادم" }, 500);
  }
});
