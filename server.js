/* ============================================================
   كامورو — الخادم الرئيسي
   Node.js + Express + PostgreSQL (Neon) + Cloudinary
   الميزات: حسابات، منشورات صور/فيديو، إعجابات، تعليقات،
            متابعة، بحث، ستوري (24 ساعة)، ملفات شخصية
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

/* ---------- إعداد Cloudinary ---------- */
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

/* ---------- إنشاء الجداول تلقائياً + بيانات تجريبية ---------- */
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(30) UNIQUE NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      bio TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      media_url TEXT DEFAULT '',
      media_type VARCHAR(10) DEFAULT 'image',
      caption TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (follower_id, following_id)
    );

    CREATE TABLE IF NOT EXISTS stories (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      media_url TEXT NOT NULL,
      media_type VARCHAR(10) DEFAULT 'image',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await seedDemo();
  console.log('✅ قاعدة البيانات جاهزة');
}

/* ---------- بيانات تجريبية (مرة واحدة فقط) ---------- */
async function seedDemo() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c > 0) return;

  const hash = await bcrypt.hash('123456', 10);

  const demo = await pool.query(
    `INSERT INTO users (username, email, password_hash, bio, avatar_url)
     VALUES ('demo', 'demo@camorro.app', $1, 'حساب تجريبي لكامورو 👋', 'https://i.pravatar.cc/150?img=12')
     RETURNING id`, [hash]);
  const sara = await pool.query(
    `INSERT INTO users (username, email, password_hash, bio, avatar_url)
     VALUES ('sara', 'sara@camorro.app', $1, 'مصوّرة طبيعية 📸', 'https://i.pravatar.cc/150?img=47')
     RETURNING id`, [hash]);
  const omar = await pool.query(
    `INSERT INTO users (username, email, password_hash, bio, avatar_url)
     VALUES ('omar', 'omar@camorro.app', $1, 'مبرمج ويب 💻', 'https://i.pravatar.cc/150?img=59')
     RETURNING id`, [hash]);

  const d = demo.rows[0].id, s = sara.rows[0].id, o = omar.rows[0].id;

  // متابعات
  await pool.query(
    'INSERT INTO follows (follower_id, following_id) VALUES ($1,$2), ($1,$3), ($2,$1), ($3,$1)',
    [d, s, o]);

  // منشورات
  const posts = [
    [s, 'https://picsum.photos/seed/beach/600', 'image', 'غروب اليوم على الشاطئ 🌅'],
    [s, 'https://picsum.photos/seed/coffee/600', 'image', 'قهوة الصباح ☕️'],
    [o, 'https://picsum.photos/seed/code/600', 'image', 'جلسة برمجة طويلة 💻'],
    [d, 'https://picsum.photos/seed/mountain/600', 'image', 'أول منشور لي في كامورو ⛰️'],
  ];
  for (const [uid, url, type, cap] of posts) {
    await pool.query(
      'INSERT INTO posts (user_id, media_url, media_type, caption) VALUES ($1,$2,$3,$4)',
      [uid, url, type, cap]);
  }

  // إعجابات
  await pool.query(
    'INSERT INTO likes (user_id, post_id) SELECT $1, id FROM posts WHERE user_id = $2', [d, s]);
  await pool.query(
    'INSERT INTO likes (user_id, post_id) SELECT $1, id FROM posts WHERE user_id = $2', [o, s]);

  // تعليقات
  await pool.query(
    `INSERT INTO comments (user_id, post_id, body)
     SELECT $1, id, 'أول تعليق! 🎉' FROM posts WHERE user_id = $2 LIMIT 1`, [o, s]);

  // قصة
  await pool.query(
    'INSERT INTO stories (user_id, media_url, media_type) VALUES ($1, $2, $3)',
    [s, 'https://picsum.photos/seed/story1/600', 'image']);

  console.log('🌱 بيانات تجريبية جاهزة — حساب: demo / 123456');
}

/* ---------- رفع الملفات (مؤقت ثم Cloudinary) ---------- */
fs.mkdirSync(path.join(__dirname, 'tmp'), { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, 'tmp'),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    },
  }),
  limits: { fileSize: 60 * 1024 * 1024 }, // حد أقصى 60MB
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    cb(ok ? null : new Error('يسمح بالصور والفيديوهات فقط'), ok);
  },
});

/* رفع ملف إلى Cloudinary وحذف النسخة المؤقتة */
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
    fs.unlink(filePath, () => {}); // حذف الملف المؤقت من الخادم
  }
}

/* ---------- أدوات المصادقة ---------- */
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'يرجى تسجيل الدخول أولاً' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول مجدداً' });
  }
}

/* ---------- إعدادات عامة ---------- */
app.use(cors()); // مفتوح للمظاهرة — لتقييده لاحقاً: cors({ origin: ['https://user.github.io'] })
app.use(express.json());

/* ================= المصادقة ================= */
app.get('/api/health', (req, res) => res.json({ ok: true, name: 'camorro-api' }));

app.post('/api/register', async (req, res, next) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password)
      return res.status(400).json({ error: 'يرجى ملء جميع الحقول' });

    const u = String(username).trim();
    const e = String(email).trim().toLowerCase();
    if (u.length < 3 || u.length > 30)
      return res.status(400).json({ error: 'اسم المستخدم بين 3 و 30 حرفاً' });
    if (!/^[a-zA-Z0-9_.]+$/.test(u))
      return res.status(400).json({ error: 'اسم المستخدم: حروف وأرقام ونقطة وشرطة سفلية فقط' });
    if (!/^\S+@\S+\.\S+$/.test(e))
      return res.status(400).json({ error: 'البريد الإلكتروني غير صالح' });
    if (String(password).length < 6)
      return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });

    const hash = await bcrypt.hash(String(password), 10);
    const { rows } = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3) RETURNING id, username, avatar_url, bio',
      [u, e, hash]);
    res.json({ token: signToken(rows[0]), user: rows[0] });
  } catch (err) {
    if (err.code === '23505')
      return res.status(400).json({ error: 'اسم المستخدم أو البريد مستخدم بالفعل' });
    next(err);
  }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const { identifier, password } = req.body || {};
    if (!identifier || !password)
      return res.status(400).json({ error: 'يرجى ملء جميع الحقول' });

    const { rows } = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1) OR email = LOWER($1)',
      [String(identifier).trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(String(password), user.password_hash)))
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });

    res.json({
      token: signToken(user),
      user: { id: user.id, username: user.username, avatar_url: user.avatar_url, bio: user.bio },
    });
  } catch (err) { next(err); }
});

app.get('/api/me', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, avatar_url, bio, created_at FROM users WHERE id = $1',
      [req.user.id]);
    if (!rows.length) return res.status(401).json({ error: 'المستخدم غير موجود' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.patch('/api/me', auth, async (req, res, next) => {
  try {
    const bio = String(req.body.bio || '').trim().slice(0, 150);
    const { rows } = await pool.query(
      'UPDATE users SET bio = $1 WHERE id = $2 RETURNING id, username, avatar_url, bio',
      [bio, req.user.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.post('/api/me/avatar', auth, upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'اختر صورة أولاً' });
    const media = await uploadToCloudinary(req.file.path, 'avatars');
    const { rows } = await pool.query(
      'UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING id, username, avatar_url, bio',
      [media.url, req.user.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ================= المستخدمون والبحث ================= */
app.get('/api/search', auth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.bio,
        EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $2 AND f.following_id = u.id) AS i_follow
       FROM users u
       WHERE LOWER(u.username) LIKE LOWER($1) AND u.id <> $2
       ORDER BY u.username LIMIT 20`,
      ['%' + q + '%', req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

app.get('/api/users/:username', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.bio, u.avatar_url, u.created_at,
        (SELECT COUNT(*) FROM posts p WHERE p.user_id = u.id)::int AS post_count,
        (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id)::int AS followers_count,
        (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id)::int AS following_count,
        EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.following_id = u.id) AS i_follow
       FROM users u WHERE LOWER(u.username) = LOWER($2)`,
      [req.user.id, req.params.username]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });

    const posts = await pool.query(
      'SELECT id, media_url, media_type, caption, created_at FROM posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
      [user.id]);
    res.json({ ...user, posts: posts.rows });
  } catch (err) { next(err); }
});

app.post('/api/users/:id/follow', auth, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (targetId === req.user.id)
      return res.status(400).json({ error: 'لا يمكنك متابعة نفسك' });

    await pool.query(
      'DELETE FROM follows WHERE follower_id = $1 AND following_id = $2',
      [req.user.id, targetId]);
    const inserted = await pool.query(
      'INSERT INTO follows (follower_id, following_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id',
      [req.user.id, targetId]);
    res.json({ following: inserted.rowCount > 0 });
  } catch (err) { next(err); }
});

/* ================= المنشورات ================= */
app.post('/api/posts', auth, upload.single('media'), async (req, res, next) => {
  try {
    const caption = String(req.body.caption || '').trim().slice(0, 500);
    let media_url = '', media_type = 'image';

    if (req.file) {
      const media = await uploadToCloudinary(req.file.path, 'posts');
      media_url = media.url;
      media_type = media.type;
    }
    if (!media_url && !caption)
      return res.status(400).json({ error: 'أضف صورة/فيديو أو نصاً على الأقل' });

    const { rows } = await pool.query(
      'INSERT INTO posts (user_id, media_url, media_type, caption) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, media_url, media_type, caption]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

app.get('/api/feed', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.media_url, p.media_type, p.caption, p.created_at,
        u.id AS user_id, u.username, u.avatar_url,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id)::int AS like_count,
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id)::int AS comment_count,
        EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked_by_me
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE p.user_id = $1
          OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1)
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
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS c FROM likes WHERE post_id = $1', [postId]);
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

    const post = await pool.query('SELECT id FROM posts WHERE id = $1', [postId]);
    if (!post.rows.length) return res.status(404).json({ error: 'المنشور غير موجود' });

    const { rows } = await pool.query(
      'INSERT INTO comments (user_id, post_id, body) VALUES ($1,$2,$3) RETURNING id, body, created_at, user_id',
      [req.user.id, postId, body]);
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

/* ================= القصص (ستوري - 24 ساعة) ================= */
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

/* قصص المتصفح: أحدث قصة لكل مستخدم (نفسه + من يتابعهم) خلال 24 ساعة */
app.get('/api/stories', auth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (s.user_id) s.id, s.media_url, s.media_type, s.created_at,
         u.id AS user_id, u.username, u.avatar_url
       FROM stories s JOIN users u ON u.id = s.user_id
       WHERE s.created_at >= NOW() - INTERVAL '24 hours'
         AND (s.user_id = $1
              OR s.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1))
       ORDER BY s.user_id, s.created_at DESC`,
      [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

/* كل قصص مستخدم معين (لمشاهدتها كاملة) */
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

/* ================= أخطاء عامة ================= */
app.use('/api', (req, res) => res.status(404).json({ error: 'الرابط غير موجود' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (err.message === 'يسمح بالصور والفيديوهات فقط')
    return res.status(400).json({ error: err.message });
  if (err.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ error: 'حجم الملف أكبر من 60MB' });
  res.status(500).json({ error: 'خطأ في الخادم، حاول لاحقاً' });
});

/* ================= التشغيل ================= */
initDB()
  .then(() => app.listen(PORT, () => console.log('🚀 كامورو يعمل على المنفذ ' + PORT)))
  .catch((err) => {
    console.error('❌ فشل الاتصال بقاعدة البيانات:', err.message);
    process.exit(1);
  });
