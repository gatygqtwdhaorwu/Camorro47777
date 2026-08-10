/* ============================================================
   كامورو — الخادم الكامل v3.0 (معدّل)
   ============================================================
   حساب:    تسجيل / دخول / JWT / bcrypt
   محتوى:   منشورات، ريلز، ستوري، إعجابات، تعليقات
   اجتماعي: متابعة خاص/عام، طلبات متابعة، إشعارات
   رسائل:   محادثات مباشرة (نص + وسائط)
   إدارة:   لوحة تحكم أدمن (عدة حسابات نصية) + سجل إجراءات
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

/* ============================================================
   حسابات الأدمن — أضف أو عدّل أو احذف الأسطر كما تريد
   (كلمات سر نصية واضحة بدون تشفير، ويمكن إضافة أي عدد)
   ============================================================ */
const ADMINS = [
  { username: process.env.ADMIN_USERNAME || 'camorro',   password: process.env.ADMIN_PASSWORD || 'admin123' },
  { username: 'moderator', password: 'mod@2026' }
];
const ADMIN_SECRET = (process.env.ADMIN_SECRET || JWT_SECRET) + ':admin';
const ADMIN_TTL = 60 * 60; // مدة جلسة الأدمن: ساعة واحدة

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
      caption TEXT DEFAULT '',
      media_url TEXT,
      media_type VARCHAR(10) DEFAULT 'image',
      is_reel BOOLEAN NOT NULL DEFAULT false,
      hidden BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS likes (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(user_id, post_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      post_id INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS follows (
      id SERIAL PRIMARY KEY,
      follower_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(10) NOT NULL DEFAULT 'accepted',
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(follower_id, followee_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS follow_requests (
      id SERIAL PRIMARY KEY,
      follower_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(follower_id, followee_id)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS stories (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_url TEXT,
      media_type VARCHAR(10) DEFAULT 'image',
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_a INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(user_a, user_b)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT DEFAULT '',
      media_url TEXT,
      media_type VARCHAR(10) DEFAULT 'image',
      read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(30) NOT NULL,
      post_id INT,
      body TEXT DEFAULT '',
      read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS admin_logs (
      id SERIAL PRIMARY KEY,
      action VARCHAR(50) NOT NULL,
      target_type VARCHAR(30) DEFAULT '',
      target_id INT DEFAULT 0,
      detail TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    )`);

    // حساب تجريبي إذا كانت القاعدة فارغة
    const cnt = (await pool.query('SELECT COUNT(*)::int AS c FROM users')).rows[0].c;
    if (cnt === 0) {
      const hash = await bcrypt.hash('123456', 10);
      await pool.query('INSERT INTO users (username, email, password) VALUES ($1,$2,$3)',
        ['demo', 'demo@camorro.app', hash]);
      console.log('[Camorro] تم إنشاء الحساب التجريبي demo / 123456');
    }
    console.log('[Camorro] قاعدة البيانات جاهزة');
  } catch (e) {
    console.error('[Camorro] فشل تهيئة قاعدة البيانات:', e.message);
  }
})();

/* ============================================================
   دوال مساعدة
   ============================================================ */
function uploadToCloudinary(buffer, folder, resourceType) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: folder || 'camorro', resource_type: resourceType || 'auto' },
      (err, result) => { if (err) reject(err); else resolve(result); }
    );
    stream.end(buffer);
  });
}

function mediaTypeOf(mime) {
  return (mime || '').startsWith('video/') ? 'video' : 'image';
}

function userPublic(u) {
  return {
    id: u.id, username: u.username, email: u.email || '',
    avatar_url: u.avatar_url || '', bio: u.bio || '',
    is_private: u.is_private, created_at: u.created_at
  };
}

async function logAdmin(action, targetType, targetId, detail) {
  try {
    await pool.query(
      'INSERT INTO admin_logs (action, target_type, target_id, detail) VALUES ($1,$2,$3,$4)',
      [action, targetType || '', targetId || 0, detail || '']);
  } catch (e) { /* تجاهل أخطاء السجل */ }
}

async function notify(userId, actorId, type, postId, body) {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, actor_id, type, post_id, body) VALUES ($1,$2,$3,$4,$5)',
      [userId, actorId, type, postId || null, body || '']);
  } catch (e) { /* تجاهل */ }
}

async function ensureAdminSystemUser() {
  const sys = (await pool.query('SELECT id FROM users WHERE username=$1', ['__camorro_system__'])).rows[0];
  if (sys) return sys.id;
  const hash = await bcrypt.hash(Math.random().toString(36).slice(2), 10);
  const r = await pool.query(
    'INSERT INTO users (username, password, bio, is_private) VALUES ($1,$2,$3,true) ON CONFLICT (username) DO NOTHING RETURNING id',
    ['__camorro_system__', hash, 'حساب نظام كامورو']);
  if (r.rowCount === 0) {
    return (await pool.query('SELECT id FROM users WHERE username=$1', ['__camorro_system__'])).rows[0].id;
  }
  return r.rows[0].id;
}

async function findOrCreateConv(a, b) {
  const x = Math.min(a, b), y = Math.max(a, b);
  await pool.query(
    'INSERT INTO conversations (user_a, user_b) VALUES ($1,$2) ON CONFLICT (user_a, user_b) DO NOTHING',
    [x, y]).catch(() => {});
  const r = await pool.query('SELECT id FROM conversations WHERE user_a=$1 AND user_b=$2', [x, y]);
  return r.rows[0].id;
}

/* ============================================================
   مصادقة المستخدمين (JWT)
   ============================================================ */
function authUser(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (!p || !p.sub) throw new Error('bad');
    req.userId = p.sub;
    next();
  } catch (e) {
    res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول مجدداً' });
  }
}

/* ============================================================
   حساب المستخدمين
   ============================================================ */
app.post('/api/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim();
    const password = String(req.body.password || '');
    if (!/^[a-zA-Z0-9_.]{3,30}$/.test(username))
      return res.status(400).json({ error: 'اسم المستخدم 3-30 حرفاً (حروف، أرقام، _ أو .)' });
    if (password.length < 6)
      return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });
    const exists = (await pool.query('SELECT 1 FROM users WHERE username=$1 OR email=$2', [username, email])).rowCount > 0;
    if (exists) return res.status(400).json({ error: 'اسم المستخدم أو البريد مستخدم من قبل' });
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query('INSERT INTO users (username, email, password) VALUES ($1,$2,$3) RETURNING *', [username, email, hash]);
    const user = r.rows[0];
    const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: userPublic(user) });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const identifier = String(req.body.identifier || '').trim();
    const password = String(req.body.password || '');
    const r = await pool.query('SELECT * FROM users WHERE username=$1 OR email=$1', [identifier]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: userPublic(user) });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/me', authUser, async (req, res) => {
  try {
    const u = (await pool.query('SELECT * FROM users WHERE id=$1', [req.userId])).rows[0];
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const posts_count = (await pool.query('SELECT COUNT(*)::int AS c FROM posts WHERE user_id=$1', [u.id])).rows[0].c;
    const followers_count = (await pool.query('SELECT COUNT(*)::int AS c FROM follows WHERE followee_id=$1 AND status=$2', [u.id, 'accepted'])).rows[0].c;
    const following_count = (await pool.query('SELECT COUNT(*)::int AS c FROM follows WHERE follower_id=$1 AND status=$2', [u.id, 'accepted'])).rows[0].c;
    res.json(Object.assign(userPublic(u), { posts_count, followers_count, following_count }));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.patch('/api/me', authUser, async (req, res) => {
  try {
    const bio = String(req.body.bio !== undefined ? req.body.bio : '').slice(0, 150);
    const avatar_url = String(req.body.avatar_url || '').slice(0, 500);
    const is_private = req.body.is_private === undefined ? undefined : !!req.body.is_private;
    let sql = 'UPDATE users SET bio=$1', params = [bio];
    if (avatar_url) { params.push(avatar_url); sql += ', avatar_url=$' + params.length; }
    if (is_private !== undefined) { params.push(is_private); sql += ', is_private=$' + params.length; }
    params.push(req.userId);
    sql += ' WHERE id=$' + params.length;
    await pool.query(sql, params);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/me/avatar', authUser, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });
    const result = await uploadToCloudinary(req.file.buffer, 'camorro/avatars', 'auto');
    await pool.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [result.secure_url, req.userId]);
    res.json({ avatar_url: result.secure_url });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   المستخدمون: بحث / ملف / متابعة
   ============================================================ */
app.get('/api/users', authUser, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);
    const rows = (await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.bio, u.is_private, u.created_at,
              (SELECT COUNT(*)::int FROM follows f WHERE f.followee_id=u.id AND f.status='accepted') AS followers_count
         FROM users u
        WHERE (LOWER(u.username) LIKE $1 OR LOWER(COALESCE(u.email,'')) LIKE $1)
          AND u.username <> '__camorro_system__'
        ORDER BY u.username LIMIT 50`, ['%' + q + '%'])).rows;
    const out = [];
    for (const u of rows) {
      const is_following = (await pool.query('SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2', [req.userId, u.id])).rowCount > 0;
      const is_requested = (await pool.query('SELECT 1 FROM follow_requests WHERE follower_id=$1 AND followee_id=$2', [req.userId, u.id])).rowCount > 0;
      out.push({
        id: u.id, username: u.username, avatar_url: u.avatar_url || '',
        bio: u.bio || '', is_private: u.is_private, created_at: u.created_at,
        followers_count: u.followers_count, is_following, is_requested
      });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/users/:username', authUser, async (req, res) => {
  try {
    const u = (await pool.query('SELECT * FROM users WHERE username=$1', [req.params.username])).rows[0];
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const posts_count = (await pool.query('SELECT COUNT(*)::int AS c FROM posts WHERE user_id=$1', [u.id])).rows[0].c;
    const followers_count = (await pool.query('SELECT COUNT(*)::int AS c FROM follows WHERE followee_id=$1 AND status=$2', [u.id, 'accepted'])).rows[0].c;
    const following_count = (await pool.query('SELECT COUNT(*)::int AS c FROM follows WHERE follower_id=$1 AND status=$2', [u.id, 'accepted'])).rows[0].c;
    const is_following = (await pool.query('SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2', [req.userId, u.id])).rowCount > 0;
    const is_requested = (await pool.query('SELECT 1 FROM follow_requests WHERE follower_id=$1 AND followee_id=$2', [req.userId, u.id])).rowCount > 0;
    res.json({
      user: Object.assign(userPublic(u), { posts_count, followers_count, following_count }),
      is_following, is_requested
    });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/users/:id/follow', authUser, async (req, res) => {
  try {
    const me = req.userId, target = Number(req.params.id);
    if (me === target) return res.status(400).json({ error: 'لا يمكنك متابعة نفسك' });
    const u = (await pool.query('SELECT id, is_private FROM users WHERE id=$1', [target])).rows[0];
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (u.is_private) {
      await pool.query('INSERT INTO follow_requests (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [me, target]);
      await notify(target, me, 'follow_request', null, '');
    } else {
      await pool.query(
        'INSERT INTO follows (follower_id, followee_id, status) VALUES ($1,$2,$3) ON CONFLICT (follower_id, followee_id) DO UPDATE SET status=$3',
        [me, target, 'accepted']);
      await notify(target, me, 'follow', null, '');
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.delete('/api/users/:id/follow', authUser, async (req, res) => {
  try {
    const me = req.userId, target = Number(req.params.id);
    await pool.query('DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2', [me, target]);
    await pool.query('DELETE FROM follow_requests WHERE follower_id=$1 AND followee_id=$2', [me, target]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/users/:id/followers', authUser, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.bio, u.is_private
         FROM follows f JOIN users u ON u.id = f.follower_id
        WHERE f.followee_id=$1 AND f.status='accepted' ORDER BY f.created_at DESC LIMIT 200`,
      [Number(req.params.id)])).rows;
    res.json(rows.map(u => ({ id: u.id, username: u.username, avatar_url: u.avatar_url || '', bio: u.bio || '', is_private: u.is_private })));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/users/:id/following', authUser, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.bio, u.is_private
         FROM follows f JOIN users u ON u.id = f.followee_id
        WHERE f.follower_id=$1 AND f.status='accepted' ORDER BY f.created_at DESC LIMIT 200`,
      [Number(req.params.id)])).rows;
    res.json(rows.map(u => ({ id: u.id, username: u.username, avatar_url: u.avatar_url || '', bio: u.bio || '', is_private: u.is_private })));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   المنشورات: إنشاء / حذف / إعجاب / تعليق / التغذية
   ============================================================ */
async function buildPost(p, meId) {
  const likes_count = (await pool.query('SELECT COUNT(*)::int AS c FROM likes WHERE post_id=$1', [p.id])).rows[0].c;
  const comments_count = (await pool.query('SELECT COUNT(*)::int AS c FROM comments WHERE post_id=$1', [p.id])).rows[0].c;
  const liked = (await pool.query('SELECT 1 FROM likes WHERE post_id=$1 AND user_id=$2', [p.id, meId])).rowCount > 0;
  return {
    id: p.id, user_id: p.user_id, username: p.username, avatar_url: p.avatar_url || '',
    caption: p.caption || '', media_url: p.media_url || '', media_type: p.media_type || 'image',
    is_reel: p.is_reel, hidden: p.hidden, created_at: p.created_at,
    likes_count, comments_count, liked_by_me: liked
  };
}

app.get('/api/feed', authUser, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const rows = (await pool.query(
      `SELECT p.id, p.user_id, p.caption, p.media_url, p.media_type, p.is_reel, p.hidden, p.created_at,
              u.username, u.avatar_url
         FROM posts p JOIN users u ON u.id = p.user_id
        WHERE p.hidden = false
          AND (p.user_id = $1 OR p.user_id IN (
                SELECT followee_id FROM follows WHERE follower_id = $1 AND status = 'accepted'))
        ORDER BY p.created_at DESC LIMIT $2`, [req.userId, limit])).rows;
    const out = [];
    for (const p of rows) out.push(await buildPost(p, req.userId));
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/posts', authUser, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const rows = (await pool.query(
      `SELECT p.id, p.user_id, p.caption, p.media_url, p.media_type, p.is_reel, p.hidden, p.created_at,
              u.username, u.avatar_url
         FROM posts p JOIN users u ON u.id = p.user_id
        WHERE p.hidden = false
        ORDER BY p.created_at DESC LIMIT $1`, [limit])).rows;
    const out = [];
    for (const p of rows) out.push(await buildPost(p, req.userId));
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/posts', authUser, upload.single('media'), async (req, res) => {
  try {
    const caption = String(req.body.caption || '').slice(0, 1000);
    const is_reel = req.body.is_reel === 'true' || req.body.is_reel === '1' || req.body.is_reel === true;
    let media_url = '', media_type = 'image';
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer, 'camorro/posts', 'auto');
      media_url = result.secure_url;
      media_type = mediaTypeOf(req.file.mimetype);
    }
    const r = await pool.query(
      'INSERT INTO posts (user_id, caption, media_url, media_type, is_reel) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.userId, caption, media_url, media_type, is_reel]);
    const p = r.rows[0];
    p.username = (await pool.query('SELECT username, avatar_url FROM users WHERE id=$1', [p.user_id])).rows[0].username;
    res.json(await buildPost(p, req.userId));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.delete('/api/posts/:id', authUser, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    const r = await pool.query('DELETE FROM posts WHERE id=$1 AND user_id=$2', [pid, req.userId]);
    if (r.rowCount === 0) return res.status(403).json({ error: 'لا يمكنك حذف هذا المنشور' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/posts/:id/like', authUser, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    const p = (await pool.query('SELECT user_id FROM posts WHERE id=$1', [pid])).rows[0];
    if (!p) return res.status(404).json({ error: 'المنشور غير موجود' });
    await pool.query('INSERT INTO likes (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.userId, pid]);
    if (p.user_id !== req.userId) await notify(p.user_id, req.userId, 'like', pid, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.delete('/api/posts/:id/like', authUser, async (req, res) => {
  try {
    await pool.query('DELETE FROM likes WHERE post_id=$1 AND user_id=$2', [Number(req.params.id), req.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/posts/:id/comments', authUser, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT c.id, c.post_id, c.body, c.created_at, u.id AS user_id, u.username, u.avatar_url
         FROM comments c JOIN users u ON u.id = c.user_id
        WHERE c.post_id=$1 ORDER BY c.created_at ASC`, [Number(req.params.id)])).rows;
    res.json(rows.map(c => ({
      id: c.id, post_id: c.post_id, user_id: c.user_id, username: c.username,
      avatar_url: c.avatar_url || '', body: c.body, created_at: c.created_at
    })));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/posts/:id/comments', authUser, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    const body = String(req.body.body || '').trim();
    if (!body) return res.status(400).json({ error: 'اكتب التعليق أولاً' });
    const p = (await pool.query('SELECT user_id FROM posts WHERE id=$1', [pid])).rows[0];
    if (!p) return res.status(404).json({ error: 'المنشور غير موجود' });
    const r = await pool.query(
      'INSERT INTO comments (post_id, user_id, body) VALUES ($1,$2,$3) RETURNING *', [pid, req.userId, body]);
    if (p.user_id !== req.userId) await notify(p.user_id, req.userId, 'comment', pid, body.slice(0, 80));
    res.json({ id: r.rows[0].id, post_id: pid, user_id: req.userId, body, created_at: r.rows[0].created_at });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.delete('/api/comments/:id', authUser, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM comments WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.userId]);
    if (r.rowCount === 0) return res.status(403).json({ error: 'لا يمكنك حذف هذا التعليق' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   القصص (ستوري)
   ============================================================ */
app.get('/api/stories', authUser, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT s.id, s.user_id, s.media_url, s.media_type, s.created_at,
              u.username, u.avatar_url
         FROM stories s JOIN users u ON u.id = s.user_id
        WHERE s.created_at > now() - interval '24 hours'
          AND (s.user_id = $1 OR s.user_id IN (
                SELECT followee_id FROM follows WHERE follower_id = $1 AND status = 'accepted'))
        ORDER BY s.created_at DESC`, [req.userId])).rows;
    res.json(rows.map(s => ({
      id: s.id, user_id: s.user_id, username: s.username, avatar_url: s.avatar_url || '',
      media_url: s.media_url, media_type: s.media_type || 'image', created_at: s.created_at
    })));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/stories', authUser, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });
    const result = await uploadToCloudinary(req.file.buffer, 'camorro/stories', 'auto');
    const r = await pool.query(
      'INSERT INTO stories (user_id, media_url, media_type) VALUES ($1,$2,$3) RETURNING *',
      [req.userId, result.secure_url, mediaTypeOf(req.file.mimetype)]);
    res.json({ id: r.rows[0].id, user_id: req.userId, media_url: result.secure_url, created_at: r.rows[0].created_at });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.delete('/api/stories/:id', authUser, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM stories WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.userId]);
    if (r.rowCount === 0) return res.status(403).json({ error: 'لا يمكنك حذف هذه القصة' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/stories/:userId', authUser, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT id, media_url, media_type, created_at FROM stories
        WHERE user_id=$1 AND created_at > now() - interval '24 hours'
        ORDER BY created_at DESC`, [Number(req.params.userId)])).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   الإشعارات
   ============================================================ */
app.get('/api/notifications', authUser, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT n.id, n.type, n.post_id, n.body, n.read, n.created_at,
              u.username AS actor_username, u.avatar_url AS actor_avatar
         FROM notifications n JOIN users u ON u.id = n.actor_id
        WHERE n.user_id=$1 ORDER BY n.created_at DESC LIMIT 50`, [req.userId])).rows;
    res.json(rows.map(n => ({
      id: n.id, type: n.type, post_id: n.post_id, body: n.body || '',
      read: n.read, created_at: n.created_at,
      actor_username: n.actor_username, actor_avatar: n.actor_avatar || ''
    })));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/notifications/unread', authUser, async (req, res) => {
  try {
    const c = (await pool.query('SELECT COUNT(*)::int AS c FROM notifications WHERE user_id=$1 AND read=false', [req.userId])).rows[0].c;
    res.json({ count: c });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/notifications/read', authUser, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read=true WHERE user_id=$1', [req.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   الرسائل والمحادثات
   ============================================================ */
app.get('/api/conversations', authUser, async (req, res) => {
  try {
    const me = req.userId;
    const rows = (await pool.query(
      `SELECT c.id,
              CASE WHEN c.user_a=$1 THEN c.user_b ELSE c.user_a END AS other_id,
              u.username AS other_name, u.avatar_url AS other_avatar,
              (SELECT m.body FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
              (SELECT (m.media_url IS NOT NULL) FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_media,
              (SELECT m.created_at FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
              (SELECT COUNT(*)::int FROM messages m WHERE m.conversation_id=c.id AND m.sender_id<>$1 AND m.read=false) AS unread
         FROM conversations c JOIN users u ON u.id = CASE WHEN c.user_a=$1 THEN c.user_b ELSE c.user_a END
        WHERE c.user_a=$1 OR c.user_b=$1
        ORDER BY last_at DESC NULLS LAST`, [me])).rows;
    res.json(rows.map(c => ({
      id: c.id, other_id: c.other_id, other_name: c.other_name, other_avatar: c.other_avatar || '',
      last_body: c.last_body || '', last_media: !!c.last_media, last_at: c.last_at, unread: c.unread || 0
    })));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/conversations', authUser, async (req, res) => {
  try {
    const target = Number(req.body.user_id);
    if (!target || target === req.userId) return res.status(400).json({ error: 'بيانات ناقصة' });
    const convId = await findOrCreateConv(req.userId, target);
    res.json({ conversation_id: convId });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/conversations/:id/messages', authUser, async (req, res) => {
  try {
    const convId = Number(req.params.id);
    const conv = (await pool.query('SELECT id FROM conversations WHERE id=$1 AND (user_a=$2 OR user_b=$2)', [convId, req.userId])).rows[0];
    if (!conv) return res.status(403).json({ error: 'غير مصرح' });
    await pool.query('UPDATE messages SET read=true WHERE conversation_id=$1 AND sender_id<>$2', [convId, req.userId]);
    const rows = (await pool.query(
      'SELECT id, sender_id, body, media_url, media_type, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC',
      [convId])).rows;
    res.json(rows.map(m => ({
      id: m.id, sender_id: m.sender_id, body: m.body || '',
      media_url: m.media_url || '', media_type: m.media_type || 'image', created_at: m.created_at
    })));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/conversations/:id/messages', authUser, async (req, res) => {
  try {
    const convId = Number(req.params.id);
    const body = String(req.body.body || '').trim();
    const conv = (await pool.query('SELECT id FROM conversations WHERE id=$1 AND (user_a=$2 OR user_b=$2)', [convId, req.userId])).rows[0];
    if (!conv) return res.status(403).json({ error: 'غير مصرح' });
    if (!body) return res.status(400).json({ error: 'اكتب الرسالة أولاً' });
    await pool.query('INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3)', [convId, req.userId, body]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/conversations/:id/messages/media', authUser, upload.single('media'), async (req, res) => {
  try {
    const convId = Number(req.params.id);
    const conv = (await pool.query('SELECT id FROM conversations WHERE id=$1 AND (user_a=$2 OR user_b=$2)', [convId, req.userId])).rows[0];
    if (!conv) return res.status(403).json({ error: 'غير مصرح' });
    if (!req.file) return res.status(400).json({ error: 'لا يوجد ملف' });
    const result = await uploadToCloudinary(req.file.buffer, 'camorro/messages', 'auto');
    await pool.query(
      'INSERT INTO messages (conversation_id, sender_id, media_url, media_type) VALUES ($1,$2,$3,$4)',
      [convId, req.userId, result.secure_url, mediaTypeOf(req.file.mimetype)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/messages/unread-total', authUser, async (req, res) => {
  try {
    const c = (await pool.query(
      `SELECT COUNT(*)::int AS c FROM conversations c
        WHERE (c.user_a=$1 OR c.user_b=$1) AND EXISTS (
          SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.sender_id<>$1 AND m.read=false)`,
      [req.userId])).rows[0].c;
    res.json({ count: c });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   لوحة تحكم الأدمن — عدة حسابات نصية
   ============================================================ */
app.post('/api/admin/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const admin = ADMINS.find(a => a.username === username && a.password === password);
    if (!admin) {
      await logAdmin('failed_login', 'admin', 0, username.slice(0, 50));
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    const token = jwt.sign(
      { role: 'admin', username: admin.username, exp: Math.floor(Date.now() / 1000) + ADMIN_TTL },
      ADMIN_SECRET
    );
    await logAdmin('admin_login', 'admin', 0, admin.username);
    res.json({ ok: true, token, username: admin.username, expires_in: ADMIN_TTL });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token']
             || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const payload = jwt.verify(token, ADMIN_SECRET);
    if (!payload || payload.role !== 'admin') throw new Error('bad token');
    req.admin = payload;
    next();
  } catch (e) {
    res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول مجدداً' });
  }
}

app.post('/api/admin/logout', adminAuth, async (req, res) => {
  try {
    await logAdmin('admin_logout', 'admin', 0, req.admin.username);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [u, p, r, s, c, f, m, cv] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS c FROM users'),
      pool.query('SELECT COUNT(*)::int AS c FROM posts'),
      pool.query("SELECT COUNT(*)::int AS c FROM posts WHERE is_reel=true"),
      pool.query('SELECT COUNT(*)::int AS c FROM stories'),
      pool.query('SELECT COUNT(*)::int AS c FROM comments'),
      pool.query("SELECT COUNT(*)::int AS c FROM follows WHERE status='accepted'"),
      pool.query('SELECT COUNT(*)::int AS c FROM messages'),
      pool.query('SELECT COUNT(*)::int AS c FROM conversations')
    ]);
    res.json({
      users: u.rows[0].c, posts: p.rows[0].c, reels: r.rows[0].c,
      stories: s.rows[0].c, comments: c.rows[0].c, follows: f.rows[0].c,
      messages: m.rows[0].c, conversations: cv.rows[0].c
    });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    let sql = `SELECT u.id, u.username, u.email, u.avatar_url, u.bio, u.is_private, u.created_at,
                      (SELECT COUNT(*)::int FROM posts p WHERE p.user_id=u.id) AS post_count,
                      (SELECT COUNT(*)::int FROM follows f WHERE f.followee_id=u.id AND f.status='accepted') AS followers
                 FROM users u WHERE u.username <> '__camorro_system__'`;
    const params = [];
    if (q) { params.push('%' + q + '%'); sql += ' AND (LOWER(u.username) LIKE $1 OR LOWER(COALESCE(u.email,\'\')) LIKE $1)'; }
    sql += ' ORDER BY u.created_at DESC LIMIT 200';
    res.json((await pool.query(sql, params)).rows.map(u => ({
      id: u.id, username: u.username, email: u.email || '', avatar_url: u.avatar_url || '',
      bio: u.bio || '', is_private: u.is_private, created_at: u.created_at,
      post_count: u.post_count, followers: u.followers
    })));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.patch('/api/admin/users/:id/private', adminAuth, async (req, res) => {
  try {
    const uid = Number(req.params.id);
    const val = !!(req.body && req.body.is_private);
    const r = await pool.query('UPDATE users SET is_private=$1 WHERE id=$2', [val, uid]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
    await logAdmin(val ? 'make_private' : 'make_public', 'user', uid, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/admin/users/:id/reset-password', adminAuth, async (req, res) => {
  try {
    const uid = Number(req.params.id);
    const np = String((req.body && req.body.new_password) || '').trim();
    if (np.length < 6) return res.status(400).json({ error: 'كلمة المرور الجديدة 6 أحرف على الأقل' });
    const hash = await bcrypt.hash(np, 10);
    const r = await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hash, uid]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
    await logAdmin('reset_password', 'user', uid, 'تم تغيير كلمة مرور المستخدم #' + uid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const uid = Number(req.params.id);
    const u = (await pool.query('SELECT username FROM users WHERE id=$1', [uid])).rows[0];
    if (!u) return res.status(404).json({ error: 'المستخدم غير موجود' });
    await pool.query('DELETE FROM users WHERE id=$1', [uid]);
    await logAdmin('delete_user', 'user', uid, u.username);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/admin/posts', adminAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    const type = req.query.type || 'all';
    const limit = Math.min(Number(req.query.limit) || 60, 200);
    const params = [];
    let sql = `SELECT p.*, u.username FROM posts p JOIN users u ON u.id=p.user_id WHERE 1=1`;
    if (type === 'post') { params.push(false); sql += ' AND p.is_reel=$1'; }
    else if (type === 'reel') { params.push(true); sql += ' AND p.is_reel=$1'; }
    if (q) { params.push('%' + q + '%'); sql += ' AND LOWER(u.username) LIKE $' + params.length; }
    params.push(limit);
    sql += ' ORDER BY p.created_at DESC LIMIT $' + params.length;
    const rows = (await pool.query(sql, params)).rows;
    const out = [];
    for (const p of rows) {
      const likes_count = (await pool.query('SELECT COUNT(*)::int AS c FROM likes WHERE post_id=$1', [p.id])).rows[0].c;
      const comments_count = (await pool.query('SELECT COUNT(*)::int AS c FROM comments WHERE post_id=$1', [p.id])).rows[0].c;
      out.push({
        id: p.id, user_id: p.user_id, username: p.username, caption: p.caption || '',
        media_url: p.media_url || '', media_type: p.media_type || 'image',
        is_reel: p.is_reel, hidden: p.hidden, created_at: p.created_at,
        likes_count, comments_count
      });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.patch('/api/admin/posts/:id', adminAuth, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    const hidden = !!(req.body && req.body.hidden);
    const r = await pool.query('UPDATE posts SET hidden=$1 WHERE id=$2', [hidden, pid]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'المنشور غير موجود' });
    await logAdmin(hidden ? 'hide_post' : 'show_post', 'post', pid, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.delete('/api/admin/posts/:id', adminAuth, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    await pool.query('DELETE FROM posts WHERE id=$1', [pid]);
    await logAdmin('delete_post', 'post', pid, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/admin/comments', adminAuth, async (req, res) => {
  try {
    const rows = (await pool.query(
      'SELECT c.id, c.post_id, c.body, c.created_at, u.username FROM comments c JOIN users u ON u.id=c.user_id ORDER BY c.created_at DESC LIMIT 300')).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.delete('/api/admin/comments/:id', adminAuth, async (req, res) => {
  try {
    const cid = Number(req.params.id);
    await pool.query('DELETE FROM comments WHERE id=$1', [cid]);
    await logAdmin('delete_comment', 'comment', cid, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/admin/stories', adminAuth, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT s.id, s.user_id, s.media_url, s.media_type, s.created_at, u.username,
              (s.created_at < now() - interval '24 hours') AS expired
         FROM stories s JOIN users u ON u.id=s.user_id
        ORDER BY s.created_at DESC LIMIT 200`)).rows;
    res.json(rows.map(s => ({
      id: s.id, user_id: s.user_id, username: s.username, media_url: s.media_url || '',
      media_type: s.media_type || 'image', created_at: s.created_at, expired: s.expired
    })));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.delete('/api/admin/stories/:id', adminAuth, async (req, res) => {
  try {
    const sid = Number(req.params.id);
    await pool.query('DELETE FROM stories WHERE id=$1', [sid]);
    await logAdmin('delete_story', 'story', sid, '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.get('/api/admin/users/:id/chat', adminAuth, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const sysId = await ensureAdminSystemUser();
    const convId = await findOrCreateConv(sysId, targetId);
    const msgs = (await pool.query(
      'SELECT id, sender_id, body, media_url, created_at FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC',
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

app.post('/api/admin/message', adminAuth, async (req, res) => {
  try {
    const targetId = Number(req.body.user_id);
    const body = String(req.body.body || '').trim();
    if (!targetId || !body) return res.status(400).json({ error: 'بيانات ناقصة' });
    const sysId = await ensureAdminSystemUser();
    if (targetId === sysId) return res.status(400).json({ error: 'لا يمكن مراسلة حساب النظام' });
    const convId = await findOrCreateConv(sysId, targetId);
    await pool.query('INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3)', [convId, sysId, body]);
    await logAdmin('admin_message', 'user', targetId, body.slice(0, 60) + (body.length > 60 ? '...' : ''));
    res.json({ ok: true, conversation_id: convId });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

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

app.get('/api/admin/logs', adminAuth, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json((await pool.query('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT $1', [limit])).rows);
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ============================================================
   تشغيل الخادم
   ============================================================ */
app.listen(PORT, () => {
  console.log('[Camorro] الخادم يعمل على المنفذ ' + PORT);
});
