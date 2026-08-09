/* ============================================================
   كامورو — الخادم الكامل v2.0
   حسابات، منشورات (صور/فيديو)، ستوري 24 ساعة، إعجابات،
   تعليقات، متابعة خاص/عام مع طلبات، إشعارات، رسائل مباشرة، ريلز
   ============================================================ */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'camorro-dev-secret-change-me';

/* ---------- Cloudinary ---------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* ---------- قاعدة البيانات ---------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

/* ---------- إنشاء الجداول + الترقية التلقائية ---------- */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(30) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      bio TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      is_private BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_private BOOLEAN DEFAULT false;

    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      media_url TEXT DEFAULT '',
      media_type VARCHAR(10) DEFAULT 'image',
      is_reel BOOLEAN DEFAULT false,
      caption TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_reel BOOLEAN DEFAULT false;

    CREATE TABLE IF NOT EXISTS likes (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, post_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      following_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      accepted BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (follower_id, following_id)
    );
    ALTER TABLE follows ADD COLUMN IF NOT EXISTS accepted BOOLEAN DEFAULT true;

    CREATE TABLE IF NOT EXISTS stories (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      media_url TEXT NOT NULL,
      media_type VARCHAR(10) DEFAULT 'image',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(20) NOT NULL,
      post_id INTEGER,
      comment_id INTEGER,
      is_read BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user1_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      user2_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user1_id, user2_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      body TEXT DEFAULT '',
      media_url TEXT DEFAULT '',
      is_read BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await seedDemo();
  console.log('✅ قاعدة البيانات جاهزة (v2.0)');
}

/* ---------- بيانات تجريبية ---------- */
async function seedDemo() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c > 0) return;

  const hash = await bcrypt.hash('123456', 10);
  const mk = async (u, e, bio, img) => {
    const r = await pool.query(
      'INSERT INTO users (username, email, password_hash, bio, avatar_url) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [u, e, hash, bio, img]);
    return r.rows[0].id;
  };
  const d = await mk('demo', 'demo@camorro.app', 'حساب تجريبي لكامورو 👋', 'https://i.pravatar.cc/150?img=12');
  const s = await mk('sara', 'sara@camorro.app', 'مصوّرة طبيعية 📸', 'https://i.pravatar.cc/150?img=47');
  const o = await mk('omar', 'omar@camorro.app', 'مبرمج ويب 💻', 'https://i.pravatar.cc/150?img=59');

  await pool.query(
    'INSERT INTO follows (follower_id, following_id, accepted) VALUES ($1,$2,true), ($1,$3,true), ($2,$1,true), ($3,$1,true)',
    [d, s, o]);

  const posts = [
    [s, 'https://picsum.photos/seed/beach/600', 'image', false, 'غروب اليوم على الشاطئ 🌅'],
    [s, 'https://picsum.photos/seed/coffee/600', 'image', false, 'قهوة الصباح ☕️'],
    [o, 'https://picsum.photos/seed/code/600', 'image', false, 'جلسة برمجة طويلة 💻'],
    [d, 'https://picsum.photos/seed/mountain/600', 'image', false, 'أول منشور لي في كامورو ⛰️'],
  ];
  for (const [uid, url, type, reel, cap] of posts) {
    await pool.query(
      'INSERT INTO posts (user_id, media_url, media_type, is_reel, caption) VALUES ($1,$2,$3,$4,$5)',
      [uid, url, type, reel, cap]);
  }
  await pool.query('INSERT INTO likes (user_id, post_id) SELECT $1, id FROM posts WHERE user_id = $2', [d, s]);
  await pool.query('INSERT INTO likes (user_id, post_id) SELECT $1, id FROM posts WHERE user_id = $2', [o, s]);
  await pool.query(
    'INSERT INTO comments (user_id, post_id, body) SELECT $1, id, \'أول تعليق! 🎉\' FROM posts WHERE user_id = $2 LIMIT 1',
    [o, s]);
  await pool.query(
    'INSERT INTO stories (user_id, media_url, media_type) VALUES ($1,$2,$3)',
    [s, 'https://picsum.photos/seed/story1/600', 'image']);

  const conv = await pool.query(
    'INSERT INTO conversations (user1_id, user2_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id',
    [Math.min(d, s), Math.max(d, s)]);
  if (conv.rows.length) {
    await pool.query(
      'INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3)',
      [conv.rows[0].id, s, 'أهلاً بك في كامورو! 👋']);
  }
  console.log('🌱 بيانات تجريبية جاهزة — حساب: demo / 123456');
}

/* ---------- رفع الملفات ---------- */
fs.mkdirSync(path.join(__dirname, 'tmp'), { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'tmp'),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    },
  }),
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    cb(ok ? null : new Error('يسمح بالصور والفيديوهات فقط'), ok);
  },
});

async function uploadToCloudinary(filePath, folder) {
  try {
    const result = await cloudinary.uploader.upload(filePath, {
      folder: 'camorro/' + folder,
      resource_type: 'auto',
    });
    return {
      url: result.secure_url,
      type: result.resource_type === 'video' ? 'video' : 'image',
    };
  } finally {
    fs.unlink(filePath, () => {});
  }
}

/* ---------- المصادقة ---------- */
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'يرجى تسجيل الدخول أولاً' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول مجدداً' }); }
}
async function notify(userId, actorId, type, postId, commentId) {
  if (!userId || userId === actorId) return;
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id) VALUES ($1,$2,$3,$4,$5)',
      [userId, actorId, type, postId || null, commentId || null]);
  } catch (e) { /* تجاهل */ }
}

/* ---------- إعدادات عامة ---------- */
app.use(cors());
app.use(express.json());

/* ================= المصادقة ================= */
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'camorro-api', v: '2.0' }));

app.post('/api/register', async (req, res, next) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) return res.status(400).json({ error: 'يرجى ملء جميع الحقول' });
    const u = String(username).trim(), e = String(email).trim().toLowerCase();
    if (u.length < 3 || u.length > 30) return res.status(400).json({ error: 'اسم المستخدم بين 3 و 30 حرفاً' });
    if (!/^[a-zA-Z0-9_.]+$/.test(u)) return res.status(400).json({ error: 'اسم المستخدم: حروف وأرقام ونقطة وشرطة سفلية فقط' });
    if (!/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({ error: 'البريد الإلكتروني غير صالح' });
    if (String(password).length < 6) return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });
    const hash = await bcrypt.hash(String(password), 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3) RETURNING id, username, avatar_url, bio, is_private',
      [u, e, hash]);
    res.json({ token: signToken(rows[0]), user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'اسم المستخدم أو البريد مستخدم بالفعل' });
    next(err);
  }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const { identifier, password } = req.body || {};
    if (!identifier || !password) return res.status(400).json({ error: 'يرجى ملء جميع الحقول' });
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1) OR email = LOWER($1)',
      [String(identifier).trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(String(password), user.password_hash)))
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    res.json({
      token: signToken(user),
      user: { id: user.id, username: user.username, avatar_url: user.avatar_url, bio: user.bio, is_private: user.is_private },
    });
  } catch (err) { next(err); }
});

app.get('/api/me', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, avatar_url, bio, is_private, created_at FROM users WHERE id = $1',
      [req.user.id]);
    if (!rows.length) return res.status(401).json({ error: 'المستخدم غير موجود' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.patch('/api/me', auth, async (req, res, next) => {
  try {
    const bio = String(req.body.bio || '').trim().slice(0, 150);
    const is_private = req.body.is_private === undefined ? undefined : !!req.body.is_private;
    let q = 'UPDATE users SET bio = $1';
    const params = [bio];
    if (is_private !== undefined) { q += ', is_private = $2'; params.push(is_private); }
    q += ' WHERE id = $' + (params.length + 1) + ' RETURNING id, username, avatar_url, bio, is_private';
    params.push(req.user.id);
    const { rows } = await pool.query(q, params);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.post('/api/me/avatar', auth, upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'اختر صورة أولاً' });
    const media = await uploadToCloudinary(req.file.path, 'avatars');
    const { rows } = await pool.query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING id, username, avatar_url, bio, is_private',
      [media.url, req.user.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ================= البحث والمستخدمون ================= */
app.get('/api/search', auth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.bio, u.is_private,
        EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.following_id = u.id AND f.accepted = true) AS i_follow,
        EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.following_id = u.id AND f.accepted = false) AS pending
       FROM users u
       WHERE LOWER(u.username) LIKE LOWER($1) AND u.id <> $2
       ORDER BY u.username LIMIT 20`,
      ['%' + q + '%', req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

/* حالة العلاقة بيني وبين مستخدم */
async function relation(meId, userId) {
  const r = await pool.query(
    `SELECT accepted FROM follows WHERE follower_id = $1 AND following_id = $2`, [meId, userId]);
  if (r.rowCount) return { following: true, pending: !r.rows[0].accepted };
  return { following: false, pending: false };
}

app.get('/api/users/:username', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.bio, u.avatar_url, u.is_private, u.created_at,
        (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id)::int AS post_count,
        (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id AND f.accepted = true)::int AS followers_count,
        (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id AND f.accepted = true)::int AS following_count
       FROM users u WHERE LOWER(u.username) = LOWER($1)`,
      [req.params.username]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    const rel = await relation(req.user.id, user.id);
    const isSelf = user.id === req.user.id;
    const canView = isSelf || !user.is_private || (rel.following && !rel.pending);

    let posts = [];
    if (canView) {
      const pr = await pool.query(
        'SELECT id, media_url, media_type, caption, created_at FROM posts WHERE user_id = $1 AND is_reel = false ORDER BY created_at DESC LIMIT 30',
        [user.id]);
      posts = pr.rows;
    }
    res.json({ ...user, ...rel, is_self: isSelf, can_view: canView, posts });
  } catch (err) { next(err); }
});

/* متابعة / إلغاء / طلب */
app.post('/api/users/:id/follow', auth, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (targetId === req.user.id) return res.status(400).json({ error: 'لا يمكنك متابعة نفسك' });
    const t = await pool.query('SELECT id, is_private FROM users WHERE id = $1', [targetId]);
    if (!t.rowCount) return res.status(404).json({ error: 'المستخدم غير موجود' });

    const existing = await pool.query(
      'SELECT accepted FROM follows WHERE follower_id = $1 AND following_id = $2',
      [req.user.id, targetId]);

    if (existing.rowCount) {
      // إلغاء المتابعة
      await pool.query('DELETE FROM follows WHERE follower_id = $1 AND following_id = $2', [req.user.id, targetId]);
      return res.json({ following: false, pending: false });
    }

    const isPrivate = t.rows[0].is_private;
    const accepted = isPrivate ? false : true;
    await pool.query(
      'INSERT INTO follows (follower_id, following_id, accepted) VALUES ($1,$2,$3)',
      [req.user.id, targetId, accepted]);
    notify(targetId, req.user.id, isPrivate ? 'follow_request' : 'follow');
    res.json({ following: true, pending: !accepted });
  } catch (err) { next(err); }
});

/* طلبات المتابعة الواردة لي */
app.get('/api/follow-requests', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.bio, f.created_at
       FROM follows f JOIN users u ON u.id = f.follower_id
       WHERE f.following_id = $1 AND f.accepted = false
       ORDER BY f.created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

/* قبول طلب */
app.post('/api/follow-requests/:id/accept', auth, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      'UPDATE follows SET accepted = true WHERE follower_id = $1 AND following_id = $2 RETURNING id',
      [parseInt(req.params.id, 10), req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'الطلب غير موجود' });
    notify(req.user.id, parseInt(req.params.id, 10), 'follow');
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* رفض طلب */
app.post('/api/follow-requests/:id/reject', auth, async (req, res, next) => {
  try {
    await pool.query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2',
      [parseInt(req.params.id, 10), req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ================= المنشورات ================= */
app.post('/api/posts', auth, upload.single('media'), async (req, res, next) => {
  try {
    const caption = String(req.body.caption || '').trim().slice(0, 500);
    const is_reel = req.body.is_reel === 'true' || req.body.is_reel === true;
    let media_url = '', media_type = 'image';
    if (req.file) {
      const media = await uploadToCloudinary(req.file.path, is_reel ? 'reels' : 'posts');
      media_url = media.url; media_type = media.type;
    }
    if (!media_url && !caption) return res.status(400).json({ error: 'أضف صورة/فيديو أو نصاً على الأقل' });
    if (is_reel && media_type !== 'video') return res.status(400).json({ error: 'الريلز يجب أن يكون فيديو' });
    const { rows } = await pool.query(
      'INSERT INTO posts (user_id, media_url, media_type, is_reel, caption) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [req.user.id, media_url, media_type, is_reel, caption]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* التغذية: أنا + المتابَعون المقبولون فقط */
app.get('/api/feed', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.media_url, p.media_type, p.caption, p.created_at,
        u.id AS user_id, u.username, u.avatar_url,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id)::int AS like_count,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comment_count,
        EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked_by_me
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.is_reel = false AND (p.user_id = $1
          OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1 AND accepted = true))
       ORDER BY p.created_at DESC LIMIT 50`,
      [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

/* الريلز */
app.get('/api/reels', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.media_url, p.media_type, p.caption, p.created_at,
        u.id AS user_id, u.username, u.avatar_url,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id)::int AS like_count,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comment_count,
        EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked_by_me
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.is_reel = true AND p.media_type = 'video'
         AND (p.user_id = $1
            OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1 AND accepted = true))
       ORDER BY p.created_at DESC LIMIT 50`,
      [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

app.get('/api/posts/:id', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.media_url, p.media_type, p.caption, p.created_at,
        u.id AS user_id, u.username, u.avatar_url,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id)::int AS like_count,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comment_count,
        EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked_by_me
       FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = $2`,
      [req.user.id, parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: 'المنشور غير موجود' });
    const comments = await pool.query(
      `SELECT c.id, c.body, c.created_at, u.username, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = $1 ORDER BY c.created_at ASC`,
      [rows[0].id]);
    res.json({ ...rows[0], comments: comments.rows });
  } catch (err) { next(err); }
});

app.post('/api/posts/:id/like', auth, async (req, res, next) => {
  try {
    const postId = parseInt(req.params.id, 10);
    await pool.query('DELETE FROM likes WHERE user_id = $1 AND post_id = $2', [req.user.id, postId]);
    const inserted = await pool.query(
      'INSERT INTO likes (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id',
      [req.user.id, postId]);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM likes WHERE post_id = $1', [postId]);
    if (inserted.rowCount) {
      const owner = await pool.query('SELECT user_id FROM posts WHERE id = $1', [postId]);
      if (owner.rowCount) notify(owner.rows[0].user_id, req.user.id, 'like', postId);
    }
    res.json({ liked: inserted.rowCount > 0, like_count: rows[0].c });
  } catch (err) { next(err); }
});

app.get('/api/posts/:id/comments', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.body, c.created_at, u.username, u.avatar_url
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = $1 ORDER BY c.created_at ASC LIMIT 50`,
      [parseInt(req.params.id, 10)]);
    res.json(rows);
  } catch (err) { next(err); }
});

app.post('/api/posts/:id/comments', auth, async (req, res, next) => {
  try {
    const body = String(req.body.body || '').trim().slice(0, 300);
    if (!body) return res.status(400).json({ error: 'اكتب نص التعليق' });
    const postId = parseInt(req.params.id, 10);
    const post = await pool.query('SELECT user_id FROM posts WHERE id = $1', [postId]);
    if (!post.rowCount) return res.status(404).json({ error: 'المنشور غير موجود' });
    const { rows } = await pool.query(
      'INSERT INTO comments (user_id, post_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at, user_id',
      [req.user.id, postId, body]);
    notify(post.rows[0].user_id, req.user.id, 'comment', postId, rows[0].id);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.delete('/api/posts/:id', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING id',
      [parseInt(req.params.id, 10), req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'المنشور غير موجود أو غير مسموح' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ================= القصص (24 ساعة) ================= */
app.post('/api/stories', auth, upload.single('media'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'اختر صورة أو فيديو أولاً' });
    const media = await uploadToCloudinary(req.file.path, 'stories');
    const { rows } = await pool.query(
      'INSERT INTO stories (user_id, media_url, media_type) VALUES ($1,$2,$3) RETURNING *',
      [req.user.id, media.url, media.type]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.get('/api/stories', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (s.user_id) s.id, s.media_url, s.media_type, s.created_at,
         u.id AS user_id, u.username, u.avatar_url
       FROM stories s JOIN users u ON u.id = s.user_id
       WHERE s.created_at >= NOW() - INTERVAL '24 hours'
         AND (s.user_id = $1
              OR s.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1 AND accepted = true))
       ORDER BY s.user_id, s.created_at DESC`,
      [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

app.get('/api/users/:id/stories', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, media_url, media_type, created_at
       FROM stories
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at ASC`,
      [parseInt(req.params.id, 10)]);
    res.json(rows);
  } catch (err) { next(err); }
});

app.delete('/api/stories/:id', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM stories WHERE id = $1 AND user_id = $2 RETURNING id',
      [parseInt(req.params.id, 10), req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'القصة غير موجودة' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ================= الإشعارات ================= */
app.get('/api/notifications', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.id, n.type, n.is_read, n.created_at, n.post_id,
         u.id AS actor_id, u.username AS actor_name, u.avatar_url AS actor_avatar
       FROM notifications n JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC LIMIT 50`,
      [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

app.post('/api/notifications/read', auth, async (req, res, next) => {
  try {
    await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/api/notifications/unread', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS c FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.user.id]);
    res.json({ count: rows[0].c });
  } catch (err) { next(err); }
});

/* ================= الرسائل المباشرة ================= */
async function getOrCreateConversation(meId, otherId) {
  const a = Math.min(meId, otherId), b = Math.max(meId, otherId);
  await pool.query(
    'INSERT INTO conversations (user1_id, user2_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [a, b]);
  const { rows } = await pool.query(
    'SELECT id FROM conversations WHERE user1_id = $1 AND user2_id = $2', [a, b]);
  return rows[0].id;
}

/* قائمة المحادثات */
app.get('/api/conversations', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id,
         CASE WHEN c.user1_id = $1 THEN u2.id ELSE u1.id END AS other_id,
         CASE WHEN c.user1_id = $1 THEN u2.username ELSE u1.username END AS other_name,
         CASE WHEN c.user1_id = $1 THEN u2.avatar_url ELSE u1.avatar_url END AS other_avatar,
         (SELECT m.body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
         (SELECT m.media_url FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_media,
         (SELECT m.created_at FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_at,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> $1 AND m.is_read = false)::int AS unread
       FROM conversations c
       JOIN users u1 ON u1.id = c.user1_id
       JOIN users u2 ON u2.id = c.user2_id
       WHERE c.user1_id = $1 OR c.user2_id = $1
       ORDER BY last_at DESC NULLS LAST`,
      [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

/* بدء محادثة مع مستخدم */
app.post('/api/conversations', auth, async (req, res, next) => {
  try {
    const otherId = parseInt(req.body.user_id, 10);
    if (!otherId || otherId === req.user.id) return res.status(400).json({ error: 'مستخدم غير صالح' });
    const exists = await pool.query('SELECT id FROM users WHERE id = $1', [otherId]);
    if (!exists.rowCount) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const convId = await getOrCreateConversation(req.user.id, otherId);
    res.json({ conversation_id: convId });
  } catch (err) { next(err); }
});

/* رسائل محادثة */
app.get('/api/conversations/:id/messages', auth, async (req, res, next) => {
  try {
    const convId = parseInt(req.params.id, 10);
    const conv = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)',
      [convId, req.user.id]);
    if (!conv.rowCount) return res.status(404).json({ error: 'المحادثة غير موجودة' });
    await pool.query(
      'UPDATE messages SET is_read = true WHERE conversation_id = $1 AND sender_id <> $2',
      [convId, req.user.id]);
    const { rows } = await pool.query(
      `SELECT m.id, m.body, m.media_url, m.created_at, m.sender_id, u.username, u.avatar_url
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.conversation_id = $1 ORDER BY m.id ASC LIMIT 200`,
      [convId]);
    res.json(rows);
  } catch (err) { next(err); }
});

/* إرسال رسالة نصية */
app.post('/api/conversations/:id/messages', auth, async (req, res, next) => {
  try {
    const convId = parseInt(req.params.id, 10);
    const body = String(req.body.body || '').trim().slice(0, 1000);
    if (!body) return res.status(400).json({ error: 'اكتب الرسالة' });
    const conv = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)',
      [convId, req.user.id]);
    if (!conv.rowCount) return res.status(404).json({ error: 'المحادثة غير موجودة' });
    const { rows } = await pool.query(
      'INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at, sender_id',
      [convId, req.user.id, body]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* إرسال صورة/فيديو */
app.post('/api/conversations/:id/messages/media', auth, upload.single('media'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'اختر ملفاً أولاً' });
    const convId = parseInt(req.params.id, 10);
    const conv = await pool.query(
      'SELECT id FROM conversations WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)',
      [convId, req.user.id]);
    if (!conv.rowCount) return res.status(404).json({ error: 'المحادثة غير موجودة' });
    const media = await uploadToCloudinary(req.file.path, 'chat');
    const { rows } = await pool.query(
      'INSERT INTO messages (conversation_id, sender_id, body, media_url) VALUES ($1,$2,$3,$4) RETURNING id, created_at, sender_id',
      [convId, req.user.id, '🖼️ صورة', media.url]);
    res.json({ ...rows[0], media_url: media.url });
  } catch (err) { next(err); }
});

/* عدد الرسائل غير المقروءة */
app.get('/api/messages/unread-total', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE (c.user1_id = $1 OR c.user2_id = $1) AND m.sender_id <> $1 AND m.is_read = false`,
      [req.user.id]);
    res.json({ count: rows[0].c });
  } catch (err) { next(err); }
});

/* ================= أخطاء عامة ================= */
app.use('/api', (req, res) => res.status(404).json({ error: 'الرابط غير موجود' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (err.message === 'يسمح بالصور والفيديوهات فقط') return res.status(400).json({ error: err.message });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'حجم الملف أكبر من 60MB' });
  res.status(500).json({ error: 'خطأ في الخادم، حاول لاحقاً' });
});

/* ================= التشغيل ================= */
initDB()
  .then(() => app.listen(PORT, () => console.log('🚀 كامورو v2.0 يعمل على المنفذ ' + PORT)))
  .catch((err) => {
    console.error('❌ فشل الاتصال بقاعدة البيانات:', err.message);
    process.exit(1);
  });
