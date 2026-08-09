/* ============================================================
   كامورو — الخادم الكامل v2.0 (الجزء الأول)
   حسابات، منشورات، ريلز، ستوري، إعجابات، تعليقات، متابعة خاص/عام،
   طلبات متابعة، إشعارات، رسائل مباشرة
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

/* ---------- أدوات مساعدة ---------- */
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

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'غير مسجّل الدخول' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch (e) { return res.status(401).json({ error: 'انتهت الجلسة، سجّل الدخول مجدداً' }); }
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, email: u.email,
    bio: u.bio || '', avatar_url: u.avatar_url || '',
    is_private: !!u.is_private, created_at: u.created_at
  };
}

async function notify(userId, actorId, type, postId = null) {
  if (userId === actorId) return;
  await pool.query(
    'INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES ($1,$2,$3,$4)',
    [userId, actorId, type, postId]);
}

async function getUserById(id) {
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [id]);
  return r.rows[0] || null;
}

async function postShape(p, meId) {
  const [lk, cm] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM likes WHERE post_id=$1', [p.id]),
    pool.query('SELECT COUNT(*)::int AS c FROM comments WHERE post_id=$1', [p.id])
  ]);
  const liked = await pool.query('SELECT 1 FROM likes WHERE post_id=$1 AND user_id=$2', [p.id, meId]);
  return {
    id: p.id, user_id: p.user_id, username: p.username, avatar_url: p.avatar_url,
    media_url: p.media_url, media_type: p.media_type, is_reel: !!p.is_reel,
    caption: p.caption || '', created_at: p.created_at,
    like_count: lk.rows[0].c, comment_count: cm.rows[0].c,
    liked_by_me: !!liked.rowCount, is_mine: p.user_id === meId
  };
}

/* ---------- إنشاء الجداول + بيانات تجريبية ---------- */
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

async function seedDemo() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c > 0) return; // لا تكرر البيانات إذا كانت موجودة
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
    'INSERT INTO follows (follower_id, following_id, accepted) VALUES ($1,$2,true),($1,$3,true),($2,$1,true),($3,$1,true)',
    [d, s, o]);

  const posts = [
    [s, 'https://picsum.photos/seed/beach/600', 'image', false, 'غروب اليوم على الشاطئ 🌅'],
    [s, 'https://picsum.photos/seed/coffee/600', 'image', false, 'قهوة الصباح ☕️'],
    [o, 'https://picsum.photos/seed/code/600', 'image', false, 'جلسة برمجة طويلة 💻'],
    [d, 'https://picsum.photos/seed/mountain/600', 'image', false, 'أول منشور لي في كامورو ⛰️']
  ];
  for (const [uid, url, type, reel, cap] of posts)
    await pool.query(
      'INSERT INTO posts (user_id, media_url, media_type, is_reel, caption) VALUES ($1,$2,$3,$4,$5)',
      [uid, url, type, reel, cap]);

  await pool.query('INSERT INTO likes (user_id, post_id) SELECT $1, id FROM posts WHERE user_id=$2', [d, s]);
  await pool.query('INSERT INTO likes (user_id, post_id) SELECT $1, id FROM posts WHERE user_id=$2', [o, s]);
  await pool.query(
    'INSERT INTO comments (user_id, post_id, body) SELECT $1, id, \'أول تعليق! 🎉\' FROM posts WHERE user_id=$2 LIMIT 1',
    [o, s]);
  await pool.query(
    'INSERT INTO stories (user_id, media_url, media_type) VALUES ($1,$2,$3)',
    [s, 'https://picsum.photos/seed/story1/600', 'image']);

  const conv = await pool.query(
    'INSERT INTO conversations (user1_id, user2_id) VALUES ($1,$2) RETURNING id', [d, s]);
  await pool.query(
    'INSERT INTO messages (conversation_id, sender_id, body) VALUES ($1,$2,$3)',
    [conv.rows[0].id, s, 'أهلاً بك في كامورو! 👋']);

  await notify(d, s, 'follow');        // سارة بدأت متابعتك
  await notify(s, d, 'like', 1);       // ديمو أعجب بمنشور سارة
  await notify(s, o, 'comment', 1);    // عمر علّق على منشور سارة
}

/* ---------- المصادقة ---------- */
app.get('/', (req, res) => res.json({ status: 'ok', app: 'كامورو API', version: '2.0' }));

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    const un = (username || '').trim().toLowerCase();
    const em = (email || '').trim().toLowerCase();
    if (!un || !em || !password) return res.status(400).json({ error: 'أكمل جميع الحقول' });
    if (!/^[a-z0-9_]{3,30}$/.test(un))
      return res.status(400).json({ error: 'اسم المستخدم: حروف/أرقام/شرطة سفلية فقط (3-30)' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em))
      return res.status(400).json({ error: 'البريد الإلكتروني غير صالح' });
    if (password.length < 6) return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1,$2,$3) RETURNING *',
      [un, em, hash]);
    const user = r.rows[0];
    res.json({ token: sign(user), user: publicUser(user) });
  } catch (e) {
    if (e.code === '23505')
      return res.status(400).json({ error: 'اسم المستخدم أو البريد مستخدم مسبقاً' });
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username_or_email, password } = req.body || {};
    const q = (username_or_email || '').trim().toLowerCase();
    if (!q || !password) return res.status(400).json({ error: 'أدخل الاسم وكلمة المرور' });
    const r = await pool.query('SELECT * FROM users WHERE LOWER(username)=$1 OR LOWER(email)=$1', [q]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
    res.json({ token: sign(user), user: publicUser(user) });
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- المستخدم الحالي ---------- */
app.get('/api/me', auth, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json(publicUser(user));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.patch('/api/me', auth, async (req, res) => {
  try {
    const { bio, is_private } = req.body || {};
    const r = await pool.query(
      'UPDATE users SET bio=$1, is_private=$2 WHERE id=$3 RETURNING *',
      [typeof bio === 'string' ? bio.slice(0, 150) : '', !!is_private, req.user.id]);
    res.json(publicUser(r.rows[0]));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

app.post('/api/me/avatar', auth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'اختر صورة أولاً' });
    const url = await uploadBuffer(req.file.buffer);
    const r = await pool.query(
      'UPDATE users SET avatar_url=$1 WHERE id=$2 RETURNING *', [url, req.user.id]);
    res.json(publicUser(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message || 'خطأ في الرفع' }); }
});

/* ---------- البحث ---------- */
app.get('/api/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.json([]);
    const r = await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.bio, u.is_private,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.following_id=u.id AND f.accepted=true) AS i_follow,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.following_id=u.id AND f.accepted=false) AS pending
       FROM users u
       WHERE LOWER(u.username) LIKE '%'||$2||'%' AND u.id<>$1
       ORDER BY u.username LIMIT 30`,
      [req.user.id, q]);
    res.json(r.rows.map(x => ({
      id: x.id, username: x.username, avatar_url: x.avatar_url || '',
      bio: x.bio || '', is_private: !!x.is_private,
      i_follow: !!x.i_follow, pending: !!x.pending
    })));
  } catch (e) { res.status(500).json({ error: 'خطأ في الخادم' }); }
});

/* ---------- الملف الشخصي ---------- */
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
        'SELECT id, media_url, media_type, created_at FROM posts WHERE user_id=$1 AND is_reel=false ORDER BY created_at DESC LIMIT 30',
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

/* ---------- متابعة / إلغاء متابعة / طلب متابعة ---------- */
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

    if (ex.rowCount > 0) { // يوجد متابعة أو طلب معلّق → إلغاء
      await pool.query('DELETE FROM follows WHERE follower_id=$1 AND following_id=$2',
        [req.user.id, target.id]);
      return res.json({ following: false, pending: false });
    }

    if (target.is_private) { // حساب خاص → طلب متابعة
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

/* ---------- طلبات المتابعة (لحسابي الخاص) ---------- */
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
