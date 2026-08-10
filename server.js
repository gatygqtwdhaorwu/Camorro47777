/* ============================================================
   كامورو — الخادم الكامل v2.1
   ============================================================
   حساب:    تسجيل / دخول / JWT / bcrypt / حظر المستخدمين
   محتوى:   منشورات، ريلز، ستوري، إعجابات، تعليقات
   اجتماعي: متابعة خاص/عام، طلبات متابعة، إشعارات
   رسائل:   محادثات مباشرة (نص + وسائط)
   إدارة:   لوحة تحكم أدمن كاملة + سجل إجراءات
   ============================================================ */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'camorro-dev-secret-change-me';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'camorro';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json({ limit: '5mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

/* ============================================================
   تهيئة قاعدة البيانات (تلقائية عند أول تشغيل)
   ============================================================ */
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(120),
      password TEXT NOT NULL,
      avatar_url TEXT,
      bio TEXT DEFAULT '',
      is_private BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_url TEXT,
      media_type VARCHAR(10) DEFAULT 'image',
      caption TEXT DEFAULT '',
      is_reel BOOLEAN NOT NULL DEFAULT false,
      hidden BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS follows (
      id SERIAL PRIMARY KEY,
      follower_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      following_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      accepted BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(follower_id, following_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS likes (
      id SERIAL PRIMARY KEY,
      post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(post_id, user_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INT REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(30) NOT NULL,
      read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_a INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT DEFAULT '',
      media_url TEXT,
      read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS stories (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_url TEXT NOT NULL,
      media_type VARCHAR(10) DEFAULT 'image',
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_logs (
      id SERIAL PRIMARY KEY,
      admin VARCHAR(50) NOT NULL,
      action VARCHAR(100) NOT NULL,
      target_type VARCHAR(20),
      target_id INT,
      details TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT`);
    await pool.query(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS read BOOLEAN NOT NULL DEFAULT false`);

    // الحساب التجريبي demo / 123456 (يُضاف مرة واحدة فقط)
    const demo = await pool.query(`SELECT id FROM users WHERE LOWER(username)='demo' LIMIT 1`);
    if (demo.rowCount === 0) {
      const hash = bcrypt.hashSync('123456', 10);
      await pool.query(
        `INSERT INTO users (username, email, password, bio) VALUES ('demo','demo@camorro.app',$1,'حساب تجريبي لكامورو 📸')`,
        [hash]);
      console.log('[DB] تم إنشاء الحساب التجريبي demo / 123456');
    }
    console.log('[DB] قاعدة البيانات جاهزة');
  } catch (e) {
    console.log('[DB] تحذير:', e.message);
  }
})();

/* ============================================================
   أدوات مساعدة
   ============================================================ */
function uploadBuffer(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ resource_type: 'auto' }, (err, res) => {
      if (err) return reject(new Error('فشل رفع الملف إلى السحابة'));
      resolve(res.secure_url);
    });
    stream.end(buffer);
  });
}

function sign(user) { return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '30d' }); }

/* ---------- مصادقة المستخدمين (تمنع المحظورين من الدخول) ---------- */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'غير مسجّل الدخول' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    pool.query('SELECT COALESCE(is_banned,false) AS b FROM users WHERE id=$1', [payload.id])
      .then(r => {
        if (r.rowCount === 0) return res.status(401).json({ error: 'الحساب غير موجود' });
        if (r.rows[0].b) return res.status(403).json({ error: 'تم حظر حسابك من قبل الإدارة' });
        req.user = payload;
        next();
      })
      .catch(() => res.status(500).json({ error: 'خطأ في الخادم' }));
  } catch (e) { res.status(401).json({ error: 'غير مسجّل الدخول' }); }
}

/* ---------- صلاحية الأدمن ---------- */
function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.role !== 'admin') return res.status(403).json({ error: 'غير مصرح' });
    req.admin = p;
    next();
  } catch (e) { res.status(401).json({ error: 'انتهت الجلسة، سجّل دخولك مجدداً' }); }
}

/* ---------- إنشاء إشعار ---------- */
async function notify(userId, actorId, type) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, actor_id, type) VALUES ($1,$2,$3)',
      [userId, actorId, type]);
  } catch (e) {}
}

/* ---------- حساب النظام الرسمي للمراسلة ---------- */
async function ensureAdminSystemUser() {
  let r = await pool.query(`SELECT id FROM users WHERE LOWER(username)='camorro_admin' LIMIT 1`);
  if (r.rowCount) return r.rows[0].id;
  const hash = bcrypt.hashSync('sys-' + Date.now() + '-' + Math.random().toString(36).slice(2), 10);
  r = await pool.query(
    `INSERT INTO users (username, password, bio) VALUES ('camorro_admin', $1, 'الحساب الرسمي لكامورو 📢') RETURNING id`,
    [hash]);
  return r.rows[0].id;
}

async function findOrCreateConv(uidA, uidB) {
  let r = await pool.query(
    `SELECT id FROM conversations WHERE (user_a=$1 AND user_b=$2) OR (user_a=$2 AND user_b=$1) LIMIT 1`,
    [uidA, uidB]);
  if (r.rowCount) return r.rows[0].id;
  r = await pool.query(`INSERT INTO conversations (user_a, user_b) VALUES ($1,$2) RETURNING id`, [uidA, uidB]);
  return r.rows[0].id;
}

/* ---------- تسجيل إجراءات الأدمن ---------- */
async function logAdmin(action, targetType, targetId, details) {
  try {
    await pool.query(
      'INSERT INTO admin_logs (admin, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)',
      [ADMIN_USERNAME, action, targetType || null, targetId || null, details || null]);
  } catch (e) {}
}

/* ============================================================
   الحسابات: تسجيل / دخول / بياناتي
   ============================================================ */
app.post('/api/register', async (req, res) => {
  try {
    const username = (req.body.username || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = (req.body.password || '');
    if (!username || !password) return res.status(400).json({ error: 'يرجى ملء جميع الحقول' });
    if (username.length < 3) return res.status(400).json({ error: 'اسم المستخدم قصير جداً (3 أحرف على الأقل)' });
    if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور قصيرة جداً (6 أحرف على الأقل)' });
    if (!/^[a-zA-Z0-9_.]+$/.test(username)) return res.status(400).json({ error: 'اسم المستخدم يحتوي أحرفاً غير مسموحة' });
    const ex = await pool.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (ex.rowCount) return res.status(409).json({ error: 'اسم المستخدم مستخدم بالفعل' });
    if (email) {
      const exe = await pool.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1)', [email]);
      if (exe.rowCount) return res.status(409).json({ error: 'البريد الإلكتروني مستخدم بالفعل' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const r = await pool.query(
      'INSERT INTO users (username, email, password) VALUES ($1,$2,$3) RETURNING id, username, avatar_url, bio, is_private',
      [username, email || null, hash]);
    const u = r.rows[0];
    res.json({ token: sign(u), user: u });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const identifier = (req.body.identifier || '').trim();
    const password = (req.body.password || '');
    if (!identifier || !password) return res.status(400).json({ error: 'يرجى ملء جميع الحقول' });
    const r = await pool.query(
      'SELECT * FROM users WHERE LOWER(username)=LOWER($1) OR LOWER(email)=LOWER($1) LIMIT 1',
      [identifier]);
    const u = r.rows[0];
    if (!u) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    if (u.is_banned) return res.status(403).json({
      error: u.ban_reason ? 'تم حظر حسابك: ' + u.ban_reason : 'تم حظر حسابك من قبل الإدارة'
    });
    if (!bcrypt.compareSync(password, u.password)) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    res.json({
      token: sign(u),
      user: { id: u.id, username: u.username, avatar_url: u.avatar_url || '', bio: u.bio || '', is_private: !!u.is_private }
    });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, username, email, avatar_url, bio, is_private, created_at FROM users WHERE id=$1',
      [req.user.id]);
    if (r.rowCount === 0) return res.status(401).json({ error: 'الحساب غير موجود' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   المنشورات والريلز
   ============================================================ */
app.post('/api/posts', auth, upload.single('media'), async (req, res) => {
  try {
    const caption = (req.body.caption || '').trim().slice(0, 2000);
    const isReel = req.body.is_reel === 'true' || req.body.is_reel === true;
    let media_url = null, media_type = 'text';
    if (req.file) {
      media_url = await uploadBuffer(req.file.buffer);
      media_type = (req.file.mimetype || '').startsWith('video') ? 'video' : 'image';
    }
    const r = await pool.query(
      'INSERT INTO posts (user_id, media_url, media_type, caption, is_reel) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, media_url, media_type, caption, isReel]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message || 'خطأ في الخادم' }); }
});

app.get('/api/feed', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*, u.username, u.avatar_url,
              (SELECT COUNT(*)::int FROM likes l WHERE l.post_id=p.id) AS likes_count,
              (SELECT COUNT(*)::int FROM comments c WHERE c.post_id=p.id) AS comments_count,
              EXISTS(SELECT 1 FROM likes l WHERE l.post_id=p.id AND l.user_id=$1) AS liked
       FROM posts p JOIN users u ON u.id=p.user_id
       WHERE (p.user_id=$1
          OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.following_id=p.user_id AND f.accepted=true))
         AND p.is_reel=false AND COALESCE(p.hidden,false)=false
       ORDER BY p.created_at DESC LIMIT 30`,
      [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/reels', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*, u.username, u.avatar_url,
              (SELECT COUNT(*)::int FROM likes l WHERE l.post_id=p.id) AS likes_count,
              (SELECT COUNT(*)::int FROM comments c WHERE c.post_id=p.id) AS comments_count,
              EXISTS(SELECT 1 FROM likes l WHERE l.post_id=p.id AND l.user_id=$1) AS liked
       FROM posts p JOIN users u ON u.id=p.user_id
       WHERE (p.user_id=$1
          OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.following_id=p.user_id AND f.accepted=true))
         AND p.is_reel=true AND COALESCE(p.hidden,false)=false
       ORDER BY p.created_at DESC LIMIT 30`,
      [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/posts/:id', auth, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    const r = await pool.query(
      `SELECT p.*, u.username, u.avatar_url,
              (SELECT COUNT(*)::int FROM likes l WHERE l.post_id=p.id) AS likes_count,
              (SELECT COUNT(*)::int FROM comments c WHERE c.post_id=p.id) AS comments_count,
              EXISTS(SELECT 1 FROM likes l WHERE l.post_id=p.id AND l.user_id=$1) AS liked
       FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$2`,
      [req.user.id, pid]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'المنشور غير موجود' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/posts/:id/like', auth, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    const ex = await pool.query('SELECT id FROM likes WHERE post_id=$1 AND user_id=$2', [pid, req.user.id]);
    if (ex.rowCount) {
      await pool.query('DELETE FROM likes WHERE post_id=$1 AND user_id=$2', [pid, req.user.id]);
      return res.json({ liked: false });
    }
    await pool.query('INSERT INTO likes (post_id, user_id) VALUES ($1,$2)', [pid, req.user.id]);
    const p = await pool.query('SELECT user_id FROM posts WHERE id=$1', [pid]);
    if (p.rowCount && p.rows[0].user_id !== req.user.id) await notify(p.rows[0].user_id, req.user.id, 'like');
    res.json({ liked: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/posts/:id/comments', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.*, u.username, u.avatar_url FROM comments c
       JOIN users u ON u.id=c.user_id WHERE c.post_id=$1 ORDER BY c.created_at ASC`,
      [Number(req.params.id)]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/posts/:id/comments', auth, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    const body = (req.body.body || '').trim().slice(0, 500);
    if (!body) return res.status(400).json({ error: 'التعليق فارغ' });
    const r = await pool.query(
      'INSERT INTO comments (post_id, user_id, body) VALUES ($1,$2,$3) RETURNING *',
      [pid, req.user.id, body]);
    const p = await pool.query('SELECT user_id FROM posts WHERE id=$1', [pid]);
    if (p.rowCount && p.rows[0].user_id !== req.user.id) await notify(p.rows[0].user_id, req.user.id, 'comment');
    const full = await pool.query(
      `SELECT c.*, u.username, u.avatar_url FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=$1`,
      [r.rows[0].id]);
    res.json(full.rows[0]);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.delete('/api/posts/:id', auth, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM posts WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.user.id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'المنشور غير موجود' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   القصص (ستوري) — تختفي بعد 24 ساعة
   ============================================================ */
app.post('/api/stories', auth, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'اختر صورة أو فيديو للقصة' });
    const media_url = await uploadBuffer(req.file.buffer);
    const media_type = (req.file.mimetype || '').startsWith('video') ? 'video' : 'image';
    const r = await pool.query(
      `INSERT INTO stories (user_id, media_url, media_type, expires_at)
       VALUES ($1,$2,$3, now() + interval '24 hours') RETURNING *`,
      [req.user.id, media_url, media_type]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message || 'خطأ في الخادم' }); }
});

app.get('/api/stories', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.*, u.username, u.avatar_url FROM stories s
       JOIN users u ON u.id=s.user_id
       WHERE s.expires_at > now()
         AND (s.user_id=$1
           OR EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.following_id=s.user_id AND f.accepted=true))
       ORDER BY s.created_at DESC LIMIT 100`,
      [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   الإشعارات
   ============================================================ */
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT n.*, u.username AS actor_username, u.avatar_url AS actor_avatar
       FROM notifications n LEFT JOIN users u ON u.id=n.actor_id
       WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT 50`,
      [req.user.id]);
    await pool.query('UPDATE notifications SET read=true WHERE user_id=$1', [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/notifications/unread', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND read=false', [req.user.id]);
    res.json({ count: r.rows[0].c });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   الرسائل المباشرة
   ============================================================ */
app.get('/api/conversations', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id,
              CASE WHEN c.user_a=$1 THEN c.user_b ELSE c.user_a END AS other_id,
              u.username AS other_name, u.avatar_url AS other_avatar,
              (SELECT m.body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
              (SELECT m.media_url FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_media,
              (SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
              (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id=c.id AND m.sender_id<>$1 AND m.read=false) AS unread
       FROM conversations c JOIN users u ON u.id = (CASE WHEN c.user_a=$1 THEN c.user_b ELSE c.user_a END)
       WHERE c.user_a=$1 OR c.user_b=$1
       ORDER BY last_at DESC NULLS LAST`,
      [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/conversations', auth, async (req, res) => {
  try {
    const otherId = Number(req.body.user_id);
    if (!otherId || otherId === req.user.id) return res.status(400).json({ error: 'مستخدم غير صالح' });
    const convId = await findOrCreateConv(req.user.id, otherId);
    res.json({ conversation_id: convId });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/conversations/:id/messages', auth, async (req, res) => {
  try {
    const convId = Number(req.params.id);
    const owns = await pool.query(
      'SELECT id FROM conversations WHERE id=$1 AND (user_a=$2 OR user_b=$2)', [convId, req.user.id]);
    if (owns.rowCount === 0) return res.status(403).json({ error: 'غير مصرح' });
    await pool.query(
      'UPDATE messages SET read=true WHERE conversation_id=$1 AND sender_id<>$2 AND read=false',
      [convId, req.user.id]);
    const r = await pool.query(
      'SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC', [convId]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/conversations/:id/messages', auth, async (req, res) => {
  try {
    const convId = Number(req.params.id);
    const body = (req.body.body || '').trim().slice(0, 2000);
    if (!body) return res.status(400).json({ error: 'الرسالة فارغة' });
    const owns = await pool.query(
      'SELECT id FROM conversations WHERE id=$1 AND (user_a=$2 OR user_b=$2)', [convId, req.user.id]);
    if (owns.rowCount === 0) return res.status(403).json({ error: 'غير مصرح' });
    const r = await pool.query(
      'INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3) RETURNING *',
      [convId, req.user.id, body]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/conversations/:id/messages/media', auth, upload.single('media'), async (req, res) => {
  try {
    const convId = Number(req.params.id);
    if (!req.file) return res.status(400).json({ error: 'اختر ملفاً' });
    const owns = await pool.query(
      'SELECT id FROM conversations WHERE id=$1 AND (user_a=$2 OR user_b=$2)', [convId, req.user.id]);
    if (owns.rowCount === 0) return res.status(403).json({ error: 'غير مصرح' });
    const media_url = await uploadBuffer(req.file.buffer);
    const r = await pool.query(
      'INSERT INTO messages (conversation_id, sender_id, media_url) VALUES ($1,$2,$3) RETURNING *',
      [convId, req.user.id, media_url]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message || 'خطأ في الخادم' }); }
});

app.get('/api/messages/unread-total', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM messages m
       JOIN conversations c ON c.id=m.conversation_id
       WHERE (c.user_a=$1 OR c.user_b=$1) AND m.sender_id<>$1 AND m.read=false`,
      [req.user.id]);
    res.json({ count: r.rows[0].c });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   البحث والملفات الشخصية والمتابعة
   ============================================================ */
app.get('/api/users/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);
    const r = await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.bio, u.is_private,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.following_id=u.id AND f.accepted=true) AS i_follow,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.following_id=u.id AND f.accepted=false) AS pending
       FROM users u
       WHERE LOWER(u.username) LIKE '%'||$2||'%' AND u.id<>$1 AND COALESCE(u.is_banned,false)=false
       ORDER BY u.username LIMIT 30`,
      [req.user.id, q]);
    res.json(r.rows.map(x => ({
      id: x.id, username: x.username, avatar_url: x.avatar_url || '',
      bio: x.bio || '', is_private: !!x.is_private,
      i_follow: !!x.i_follow, pending: !!x.pending
    })));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/users/:idOrName', auth, async (req, res) => {
  try {
    const v = req.params.idOrName;
    const r = await pool.query(
      'SELECT * FROM users WHERE id=$1 OR LOWER(username)=LOWER($2) LIMIT 1',
      [isNaN(v) ? 0 : Number(v), v]);
    const u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });

    const [pc, fc, fgc, myf] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS c FROM posts WHERE user_id=$1 AND is_reel=false', [u.id]),
      pool.query('SELECT COUNT(*)::int AS c FROM follows WHERE following_id=$1 AND accepted=true', [u.id]),
      pool.query('SELECT COUNT(*)::int AS c FROM follows WHERE follower_id=$1 AND accepted=true', [u.id]),
      pool.query('SELECT accepted FROM follows WHERE follower_id=$1 AND following_id=$2', [req.user.id, u.id])
    ]);
    const following = myf.rowCount > 0 && myf.rows[0].accepted;
    const pending = myf.rowCount > 0 && !myf.rows[0].accepted;
    const isMe = u.id === req.user.id;
    const canView = isMe || !u.is_private || following;

    let posts = [];
    if (canView) {
      const pr = await pool.query(
        'SELECT id, media_url, media_type, created_at FROM posts WHERE user_id=$1 AND is_reel=false AND COALESCE(hidden,false)=false ORDER BY created_at DESC LIMIT 30',
        [u.id]);
      posts = pr.rows;
    }
    res.json({
      id: u.id, username: u.username, avatar_url: u.avatar_url || '',
      bio: u.bio || '', is_private: !!u.is_private,
      post_count: pc.rows[0].c, followers_count: fc.rows[0].c, following_count: fgc.rows[0].c,
      following, pending, can_view: canView, posts
    });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/users/:idOrName/follow', auth, async (req, res) => {
  try {
    const v = req.params.idOrName;
    const r = await pool.query(
      'SELECT * FROM users WHERE id=$1 OR LOWER(username)=LOWER($2) LIMIT 1',
      [isNaN(v) ? 0 : Number(v), v]);
    const target = r.rows[0];
    if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'لا يمكنك متابعة نفسك' });

    const ex = await pool.query(
      'SELECT accepted FROM follows WHERE follower_id=$1 AND following_id=$2',
      [req.user.id, target.id]);

    if (ex.rowCount > 0) {
      await pool.query('DELETE FROM follows WHERE follower_id=$1 AND following_id=$2',
        [req.user.id, target.id]);
      return res.json({ following: false, pending: false });
    }

    if (target.is_private) {
      await pool.query(
        'INSERT INTO follows (follower_id, following_id, accepted) VALUES ($1,$2,false)',
        [req.user.id, target.id]);
      await notify(target.id, req.user.id, 'follow_request');
      return res.json({ following: false, pending: true });
    }

    await pool.query(
      'INSERT INTO follows (follower_id, following_id, accepted) VALUES ($1,$2,true)',
      [req.user.id, target.id]);
    await notify(target.id, req.user.id, 'follow');
    res.json({ following: true, pending: false });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/follow-requests', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.bio
       FROM follows f JOIN users u ON u.id=f.follower_id
       WHERE f.following_id=$1 AND f.accepted=false
       ORDER BY f.created_at DESC`, [req.user.id]);
    res.json(r.rows.map(x => ({
      id: x.id, username: x.username, avatar_url: x.avatar_url || '', bio: x.bio || ''
    })));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/follow-requests/:userId/accept', auth, async (req, res) => {
  try {
    const uid = Number(req.params.userId);
    await pool.query(
      'UPDATE follows SET accepted=true WHERE follower_id=$1 AND following_id=$2',
      [uid, req.user.id]);
    await notify(uid, req.user.id, 'follow_accept');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/follow-requests/:userId/reject', auth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM follows WHERE follower_id=$1 AND following_id=$2',
      [Number(req.params.userId), req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   لوحة تحكم الأدمن
   ============================================================ */

/* ---------- دخول الأدمن ---------- */
app.post('/api/admin/login', async (req, res) => {
  try {
    const u = (req.body.username || '').trim();
    const p = (req.body.password || '');
    if (u !== ADMIN_USERNAME || p !== ADMIN_PASSWORD)
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- الإحصائيات ---------- */
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const counts = {};
    const queries = [
      ['users',        'SELECT COUNT(*)::int AS c FROM users'],
      ['posts',        'SELECT COUNT(*)::int AS c FROM posts WHERE is_reel=false'],
      ['reels',        'SELECT COUNT(*)::int AS c FROM posts WHERE is_reel=true'],
      ['comments',     'SELECT COUNT(*)::int AS c FROM comments'],
      ['follows',      'SELECT COUNT(*)::int AS c FROM follows WHERE accepted=true'],
      ['conversations','SELECT COUNT(*)::int AS c FROM conversations'],
      ['messages',     'SELECT COUNT(*)::int AS c FROM messages'],
      ['stories',      'SELECT COUNT(*)::int AS c FROM stories']
    ];
    for (const [k, sql] of queries) {
      try { counts[k] = (await pool.query(sql)).rows[0].c; }
      catch (e) { counts[k] = 0; }
    }
    let recent = [];
    try {
      recent = (await pool.query(
        'SELECT id, username, avatar_url, created_at FROM users ORDER BY created_at DESC LIMIT 8')).rows;
    } catch (e) {}
    res.json({ counts, recent });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- قائمة المستخدمين + البحث ---------- */
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const pattern = '%' + q.toLowerCase() + '%';
    let rows;
    try {
      rows = (await pool.query(
        `SELECT id, username, avatar_url, bio, is_private, created_at,
                COALESCE(is_banned,false) AS is_banned, ban_reason
         FROM users WHERE LOWER(username) LIKE $1
         ORDER BY created_at DESC LIMIT $2`, [pattern, limit])).rows;
    } catch (e) {
      rows = (await pool.query(
        'SELECT id, username, avatar_url, bio, is_private, created_at FROM users ORDER BY created_at DESC LIMIT $1',
        [limit])).rows;
      rows.forEach(r => { r.is_banned = false; r.ban_reason = null; });
    }
    for (const u of rows) {
      try {
        const [pc, fc, fgc] = await Promise.all([
          pool.query('SELECT COUNT(*)::int AS c FROM posts WHERE user_id=$1', [u.id]),
          pool.query('SELECT COUNT(*)::int AS c FROM follows WHERE following_id=$1 AND accepted=true', [u.id]),
          pool.query('SELECT COUNT(*)::int AS c FROM follows WHERE follower_id=$1 AND accepted=true', [u.id])
        ]);
        u.post_count = pc.rows[0].c; u.followers_count = fc.rows[0].c; u.following_count = fgc.rows[0].c;
      } catch (e) { u.post_count = 0; u.followers_count = 0; u.following_count = 0; }
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- ملف مستخدم كامل ---------- */
app.get('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const uid = Number(req.params.id);
    const u = (await pool.query('SELECT * FROM users WHERE id=$1', [uid])).rows[0];
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });

    let pc = 0, fc = 0, fgc = 0;
    try {
      const [a, b, c] = await Promise.all([
        pool.query('SELECT COUNT(*)::int AS c FROM posts WHERE user_id=$1', [uid]),
        pool.query('SELECT COUNT(*)::int AS c FROM follows WHERE following_id=$1 AND accepted=true', [uid]),
        pool.query('SELECT COUNT(*)::int AS c FROM follows WHERE follower_id=$1 AND accepted=true', [uid])
      ]);
      pc = a.rows[0].c; fc = b.rows[0].c; fgc = c.rows[0].c;
    } catch (e) {}

    let posts = [];
    try {
      posts = (await pool.query(
        'SELECT * FROM posts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 12', [uid])).rows;
    } catch (e) {}

    let conversations = [];
    try {
      conversations = (await pool.query(
        `SELECT c.id,
                CASE WHEN c.user_a=$1 THEN c.user_b ELSE c.user_a END AS other_id,
                u.username AS other_username,
                (SELECT m.body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
                (SELECT m.media_url FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_media,
                (SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_at
         FROM conversations c
         JOIN users u ON u.id = CASE WHEN c.user_a=$1 THEN c.user_b ELSE c.user_a END
         WHERE c.user_a=$1 OR c.user_b=$1
         ORDER BY last_at DESC NULLS LAST`, [uid])).rows;
    } catch (e) {}

    res.json({
      id: u.id, username: u.username, email: u.email || '', avatar_url: u.avatar_url || '',
      bio: u.bio || '', is_private: !!u.is_private, is_banned: !!u.is_banned,
      ban_reason: u.ban_reason || '', created_at: u.created_at,
      post_count: pc, followers_count: fc, following_count: fgc,
      posts, conversations
    });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- حظر / فك حظر / خاص / عام ---------- */
app.patch('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const uid = Number(req.params.id);
    const body = req.body || {};
    if (typeof body.is_banned === 'boolean') {
      const r = await pool.query(
        'UPDATE users SET is_banned=$1, ban_reason=$2 WHERE id=$3',
        [body.is_banned, body.is_banned ? (body.ban_reason || 'تم الحظر بواسطة الإدارة') : null, uid]);
      if (r.rowCount === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
      await logAdmin(body.is_banned ? 'ban_user' : 'unban_user', 'user', uid,
        body.is_banned ? (body.ban_reason || '') : '');
      return res.json({ ok: true });
    }
    if (typeof body.is_private === 'boolean') {
      await pool.query('UPDATE users SET is_private=$1 WHERE id=$2', [body.is_private, uid]);
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'لا يوجد تحديث صالح' });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- حذف مستخدم نهائياً ---------- */
app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const uid = Number(req.params.id);
    await pool.query('DELETE FROM notifications WHERE user_id=$1 OR actor_id=$1', [uid]).catch(() => {});
    await pool.query('DELETE FROM comments WHERE user_id=$1', [uid]).catch(() => {});
    await pool.query('DELETE FROM likes WHERE user_id=$1', [uid]).catch(() => {});
    await pool.query('DELETE FROM posts WHERE user_id=$1', [uid]).catch(() => {});
    await pool.query('DELETE FROM follows WHERE follower_id=$1 OR following_id=$1', [uid]).catch(() => {});
    const convs = (await pool.query('SELECT id FROM conversations WHERE user_a=$1 OR user_b=$1', [uid])).rows;
    for (const c of convs) {
      await pool.query('DELETE FROM messages WHERE conversation_id=$1', [c.id]).catch(() => {});
    }
    await pool.query('DELETE FROM conversations WHERE user_a=$1 OR user_b=$1', [uid]).catch(() => {});
    const r = await pool.query('DELETE FROM users WHERE id=$1', [uid]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
    await logAdmin('delete_user', 'user', uid, 'تم حذف المستخدم نهائياً مع كل بياناته');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- تغيير كلمة مرور أي مستخدم ---------- */
app.post('/api/admin/users/:id/password', adminAuth, async (req, res) => {
  try {
    const uid = Number(req.params.id);
    const newPass = (req.body.password || '').trim();
    if (newPass.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    const hash = bcrypt.hashSync(newPass, 10);
    const r = await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hash, uid]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
    await logAdmin('reset_password', 'user', uid, 'تم تغيير كلمة مرور المستخدم #' + uid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- قائمة المنشورات + البحث ---------- */
app.get('/api/admin/posts', adminAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const type = req.query.type || 'all';
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    const params = [];
    let sql = `SELECT p.*, u.username FROM posts p JOIN users u ON u.id=p.user_id WHERE 1=1`;
    if (type === 'post') { params.push(false); sql += ` AND p.is_reel=$1`; }
    else if (type === 'reel') { params.push(true); sql += ` AND p.is_reel=$1`; }
    if (q) { params.push('%' + q + '%'); sql += ` AND LOWER(u.username) LIKE $${params.length}`; }
    params.push(limit);
    sql += ` ORDER BY p.created_at DESC LIMIT $${params.length}`;
    const rows = (await pool.query(sql, params)).rows;
    for (const p of rows) {
      try { p.likes_count = (await pool.query('SELECT COUNT(*)::int AS c FROM likes WHERE post_id=$1', [p.id])).rows[0].c; } catch (e) { p.likes_count = 0; }
      try { p.comments_count = (await pool.query('SELECT COUNT(*)::int AS c FROM comments WHERE post_id=$1', [p.id])).rows[0].c; } catch (e) { p.comments_count = 0; }
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- إخفاء / إظهار منشور ---------- */
app.patch('/api/admin/posts/:id', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE posts SET hidden=$1 WHERE id=$2',
      [!!(req.body && req.body.hidden), Number(req.params.id)]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'المنشور غير موجود' });
    await logAdmin(req.body && req.body.hidden ? 'hide_post' : 'show_post', 'post', Number(req.params.id), '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- حذف منشور ---------- */
app.delete('/api/admin/posts/:id', adminAuth, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    await pool.query('DELETE FROM likes WHERE post_id=$1', [pid]).catch(() => {});
    await pool.query('DELETE FROM comments WHERE post_id=$1', [pid]).catch(() => {});
    const r = await pool.query('DELETE FROM posts WHERE id=$1', [pid]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'المنشور غير موجود' });
    await logAdmin('delete_post', 'post', pid, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- فتح محادثة الأدمن مع مستخدم ---------- */
app.get('/api/admin/users/:id/chat', adminAuth, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const sysId = await ensureAdminSystemUser();
    const convId = await findOrCreateConv(sysId, targetId);
    const msgs = (await pool.query(
      `SELECT id, sender_id, body, media_url, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC`,
      [convId])).rows;
    res.json({
      conversation_id: convId,
      messages: msgs.map(m => ({
        id: m.id, body: m.body || '', media_url: m.media_url || '',
        is_mine: m.sender_id === sysId, created_at: m.created_at
      }))
    });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- إرسال رسالة من الأدمن لأي مستخدم ---------- */
app.post('/api/admin/message', adminAuth, async (req, res) => {
  try {
    const targetId = Number(req.body.user_id);
    const body = (req.body.body || '').trim();
    if (!targetId || !body) return res.status(400).json({ error: 'بيانات ناقصة' });
    const sysId = await ensureAdminSystemUser();
    if (targetId === sysId) return res.status(400).json({ error: 'لا يمكن مراسلة حساب النظام' });
    const convId = await findOrCreateConv(sysId, targetId);
    await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3)`,
      [convId, sysId, body]);
    await logAdmin('admin_message', 'user', targetId, body.slice(0, 60) + (body.length > 60 ? '...' : ''));
    res.json({ ok: true, conversation_id: convId });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- قراءة رسائل أي محادثة (للإشراف) ---------- */
app.get('/api/admin/conversations/:id/messages', adminAuth, async (req, res) => {
  try {
    const convId = Number(req.params.id);
    const msgs = (await pool.query(
      `SELECT m.id, m.sender_id, m.body, m.media_url, m.created_at, u.username AS sender_username
       FROM messages m JOIN users u ON u.id=m.sender_id
       WHERE m.conversation_id=$1 ORDER BY m.created_at ASC`, [convId])).rows;
    res.json({ messages: msgs.map(m => ({
      id: m.id, sender_username: m.sender_username, body: m.body || '',
      media_url: m.media_url || '', created_at: m.created_at
    })) });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- سجل الإجراءات ---------- */
app.get('/api/admin/logs', adminAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = (await pool.query(
      'SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT $1', [limit])).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   تشغيل الخادم
   ============================================================ */
app.listen(PORT, () => {
  console.log(`[Camorro] الخادم يعمل على المنفذ ${PORT}`);
});
