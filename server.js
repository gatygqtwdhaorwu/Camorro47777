/* ============================================================
   كامورو — الخادم الكامل v4.0 (نسخة مؤمّنة)
   ------------------------------------------------------------
   الإصلاحات الأمنية المطبقة:
   1) JWT_SECRET إجباري (بدون قيمة افتراضية) — يوقف التشغيل إن غاب
   2) حسابات الأدمن من متغيرات البيئة فقط (لا كلمات سر في الكود)
   3) Rate limiting على الدخول/التسجيل/OTP/الأدمن
   4) CORS محصور على نطاق الواجهة فقط
   5) ترويسات أمنية عبر helmet
   6) رفع الملفات: فحص نوع الملف + حد 15MB + ملف واحد فقط
   7) جميع استعلامات SQL parameterized (بلا SQL Injection)
   8) أكواد OTP مخزنة كـ hash + صلاحية 10 دقائق + محاولات محدودة
   9) لا توجد أي أسرار في الكود إطلاقاً
   ============================================================ */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

/* ============================================================
   1) المفتاح السري — إجباري (بدون fallback ضعيف)
   ============================================================ */
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] عيّن JWT_SECRET في متغيرات البيئة (32 حرفاً على الأقل)');
  process.exit(1);
}

/* ============================================================
   2) حسابات الأدمن — من البيئة فقط، بدون كلمات سر في الكود
   ============================================================ */
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_USERNAME || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  console.error('[FATAL] عيّن ADMIN_USERNAME و ADMIN_PASSWORD (8 أحرف على الأقل)');
  process.exit(1);
}
const ADMINS = [{ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }];
const ADMIN_SECRET = (process.env.ADMIN_SECRET || JWT_SECRET) + ':admin';
const ADMIN_TTL = 60 * 60; // جلسة الأدمن: ساعة واحدة

/* ============================================================
   3) Cloudinary
   ============================================================ */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/* ============================================================
   4) قاعدة البيانات — إجبارية
   ============================================================ */
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[FATAL] DATABASE_URL غير مضبوط في متغيرات البيئة');
  process.exit(1);
}
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

/* ============================================================
   5) وسيطات عامة
   ============================================================ */
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: '2mb' }));

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://gatygqtwdhaorwu.github.io';
app.use(cors({ origin: ALLOWED_ORIGIN }));

/* ============================================================
   6) Rate limiting
   ============================================================ */
const apiLimiter    = rateLimit({ windowMs: 60 * 1000,        limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
const loginLimiter  = rateLimit({ windowMs: 15 * 60 * 1000,   limit: 5,   standardHeaders: 'draft-7', legacyHeaders: false });
const regLimiter    = rateLimit({ windowMs: 60 * 60 * 1000,   limit: 10,  standardHeaders: 'draft-7', legacyHeaders: false });
const otpLimiter    = rateLimit({ windowMs: 15 * 60 * 1000,   limit: 5,   standardHeaders: 'draft-7', legacyHeaders: false });
const adminLimiter  = rateLimit({ windowMs: 15 * 60 * 1000,   limit: 10,  standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api/', apiLimiter);

/* ============================================================
   7) رفع الملفات — فحص النوع + حد 15MB + ملف واحد
   ============================================================ */
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) return cb(new Error('نوع الملف غير مسموح'));
    cb(null, true);
  }
});

/* ============================================================
   8) أدوات مساعدة
   ============================================================ */
function signToken(u) {
  return jwt.sign({ uid: u.id, username: u.username }, JWT_SECRET, { expiresIn: '7d' });
}
function signAdminToken(username) {
  return jwt.sign({ username, role: 'admin' }, ADMIN_SECRET, { expiresIn: ADMIN_TTL });
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ---------- مصادقة المستخدمين ---------- */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const p = jwt.verify(token, JWT_SECRET);
    req.userId = p.uid;
    req.username = p.username;
    next();
  } catch (e) { res.status(401).json({ error: 'جلسة غير صالحة' }); }
}

/* ---------- مصادقة الأدمن ---------- */
function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const p = jwt.verify(token, ADMIN_SECRET);
    if (p.role !== 'admin') throw new Error('x');
    req.adminName = p.username;
    next();
  } catch (e) { res.status(401).json({ error: 'جلسة أدمن غير صالحة' }); }
}

/* ---------- رفع إلى Cloudinary ---------- */
function uploadToCloudinary(buffer, mime) {
  return new Promise((resolve, reject) => {
    const resourceType = mime.startsWith('video/') ? 'video' : 'image';
    const stream = cloudinary.uploader.upload_stream(
      { folder: 'camorro', resource_type: resourceType },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

/* ---------- إشعارات ---------- */
async function notify(userId, actorId, type, postId) {
  if (!userId || userId === actorId) return;
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES ($1,$2,$3,$4)',
      [userId, actorId, type, postId || null]
    );
  } catch (e) {}
}

/* ---------- سجل الأدمن ---------- */
async function logAdmin(adminName, action, targetType, targetId, details) {
  try {
    await pool.query(
      'INSERT INTO admin_logs (admin_username, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)',
      [adminName, action, targetType, targetId || null, details || '']
    );
  } catch (e) {}
}

/* ---------- إرسال رمز OTP (Resend اختياري + سجل للاختبار) ---------- */
async function sendOtpEmail(email, code) {
  const key = process.env.RESEND_API_KEY;
  if (key) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'Camorro <onboarding@resend.dev>',
          to: email,
          subject: 'رمز التحقق من بريدك — كامورو',
          html: '<div dir="rtl" style="font-family:sans-serif;padding:20px"><h2>مرحباً 👋</h2><p>رمز التحقق الخاص بك هو:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#b78103">' + code + '</p><p>الرمز صالح لمدة 10 دقائق.</p></div>'
        })
      });
    } catch (e) { console.error('[OTP-EMAIL]', e.message); }
  }
  console.log('[OTP] ' + email + ' → ' + code);
}

async function generateOtp(email) {
  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = await bcrypt.hash(code, 10);
  await pool.query(
    "INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ($1,$2, now() + interval '10 minutes')",
    [email, codeHash]
  );
  await sendOtpEmail(email, code);
}

/* ============================================================
   9) إنشاء الجداول تلقائياً (آمن — لا يؤثر على البيانات الموجودة)
   ============================================================ */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      avatar_url TEXT,
      bio TEXT,
      is_private BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_url TEXT,
      media_type TEXT DEFAULT 'image',
      caption TEXT,
      is_reel BOOLEAN NOT NULL DEFAULT FALSE,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS comments (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS likes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, post_id)
    );
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'accepted',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (follower_id, followee_id)
    );
    CREATE TABLE IF NOT EXISTS stories (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_url TEXT NOT NULL,
      media_type TEXT DEFAULT 'image',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS story_views (
      story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (story_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user1_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user2_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user1_id, user2_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT,
      media_url TEXT,
      read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS admin_logs (
      id SERIAL PRIMARY KEY,
      admin_username TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id INTEGER,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
    CREATE INDEX IF NOT EXISTS idx_posts_reel ON posts(is_reel);
    CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
    CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);
    CREATE INDEX IF NOT EXISTS idx_stories_user ON stories(user_id);
    CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email);
  `);
  console.log('[Camorro] تم التأكد من جداول قاعدة البيانات');
}

/* ============================================================
   10) الحسابات — تسجيل / دخول / OTP
   ============================================================ */
app.post('/api/register', regLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!/^[a-zA-Z0-9_.]{3,30}$/.test(username)) {
      return res.status(400).json({ error: 'اسم المستخدم: 3-30 حرفاً (حروف، أرقام، _ أو . فقط)' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'بريد إلكتروني غير صالح' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'كلمة المرور 6 أحرف على الأقل' });
    }

    const dup = await pool.query('SELECT id FROM users WHERE username=$1 OR email=$2', [username, email]);
    if (dup.rowCount > 0) return res.status(409).json({ error: 'اسم المستخدم أو البريد مستخدم مسبقاً' });

    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users (username, email, password_hash, email_verified) VALUES ($1,$2,$3,FALSE) RETURNING id, username',
      [username, email, hash]
    );
    const user = r.rows[0];
    await generateOtp(email);
    res.status(201).json({ needs_verification: true, email, user_id: user.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const identifier = String(req.body.identifier || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!identifier || !password) return res.status(400).json({ error: 'يرجى ملء جميع الحقول' });

    const r = await pool.query('SELECT * FROM users WHERE lower(username)=$1 OR lower(email)=$1', [identifier]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });

    if (!user.email_verified) {
      await generateOtp(user.email);
      return res.json({ needs_verification: true, email: user.email });
    }
    res.json({ token: signToken(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/otp/send', otpLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const u = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (u.rowCount === 0) return res.status(404).json({ error: 'البريد غير مسجل' });
    await generateOtp(email);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/otp/verify', otpLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();

    const u = await pool.query('SELECT id, username, password_hash FROM users WHERE email=$1', [email]);
    if (u.rowCount === 0) return res.status(404).json({ error: 'البريد غير مسجل' });
    const user = u.rows[0];

    const otps = await pool.query(
      'SELECT * FROM otp_codes WHERE email=$1 AND used=FALSE AND expires_at > now() ORDER BY id DESC LIMIT 1',
      [email]
    );
    const rec = otps.rows[0];
    if (!rec) return res.status(400).json({ error: 'لا يوجد رمز صالح. اطلب رمزاً جديداً' });
    if (rec.attempts >= 5) return res.status(429).json({ error: 'محاولات كثيرة. اطلب رمزاً جديداً' });

    const ok = await bcrypt.compare(code, rec.code_hash);
    if (!ok) {
      await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id=$1', [rec.id]);
      return res.status(400).json({ error: 'الرمز غير صحيح' });
    }

    await pool.query('UPDATE otp_codes SET used=TRUE WHERE id=$1', [rec.id]);
    await pool.query('UPDATE users SET email_verified=TRUE WHERE id=$1', [user.id]);
    res.json({ token: signToken(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ============================================================
   11) الملف الشخصي
   ============================================================ */
app.get('/api/me', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, username, email, email_verified, avatar_url, bio, is_private, created_at FROM users WHERE id=$1',
      [req.userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const u = r.rows[0];
    res.json({
      id: u.id, username: u.username, email: u.email, email_verified: u.email_verified,
      avatar_url: u.avatar_url || '', bio: u.bio || '',
      is_private: u.is_private, private: u.is_private, created_at: u.created_at
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.patch('/api/me', auth, async (req, res) => {
  try {
    const bio = String(req.body.bio || '').trim().slice(0, 150);
    await pool.query('UPDATE users SET bio=$1 WHERE id=$2', [bio, req.userId]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/me/avatar', auth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'أرفق صورة' });
    const url = await uploadToCloudinary(req.file.buffer, req.file.mimetype);
    await pool.query('UPDATE users SET avatar_url=$1 WHERE id=$2', [url, req.userId]);
    res.json({ avatar_url: url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ============================================================
   12) المنشورات والريلز
   ============================================================ */
const POST_SELECT = `
  SELECT p.id, p.user_id, p.media_url, p.media_type, p.caption, p.is_reel, p.created_at,
         u.username, u.avatar_url,
         (SELECT COUNT(*)::int FROM likes l WHERE l.post_id = p.id) AS likes_count,
         (SELECT COUNT(*)::int FROM comments c WHERE c.post_id = p.id) AS comments_count,
         EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked_by_me
    FROM posts p JOIN users u ON u.id = p.user_id
`;

function fmtPost(p) {
  return {
    id: p.id, user_id: p.user_id, username: p.username,
    avatar_url: p.avatar_url || '', media_url: p.media_url || '',
    media_type: p.media_type || 'image', caption: p.caption || '',
    is_reel: p.is_reel, likes_count: p.likes_count, comments_count: p.comments_count,
    liked_by_me: !!p.liked_by_me, created_at: p.created_at
  };
}

app.get('/api/feed', auth, async (req, res) => {
  try {
    const rows = (await pool.query(
      POST_SELECT + ` WHERE p.hidden=FALSE AND (p.user_id=$1 OR p.user_id IN
        (SELECT followee_id FROM follows WHERE follower_id=$1 AND status='accepted'))
        ORDER BY p.created_at DESC LIMIT 50`,
      [req.userId]
    )).rows;
    res.json(rows.map(fmtPost));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.get('/api/reels', auth, async (req, res) => {
  try {
    const rows = (await pool.query(
      POST_SELECT + ' WHERE p.is_reel=TRUE AND p.hidden=FALSE ORDER BY p.created_at DESC LIMIT 50',
      [req.userId]
    )).rows;
    res.json(rows.map(fmtPost));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.get('/api/users/:username/posts', auth, async (req, res) => {
  try {
    const username = String(req.params.username).trim();
    const u = await pool.query('SELECT id, is_private FROM users WHERE username=$1', [username]);
    if (u.rowCount === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const target = u.rows[0];

    if (target.is_private && target.id !== req.userId) {
      const f = await pool.query(
        "SELECT 1 FROM follows WHERE follower_id=$1 AND followee_id=$2 AND status='accepted'",
        [req.userId, target.id]
      );
      if (f.rowCount === 0) return res.status(403).json({ error: 'الحساب خاص' });
    }

    const rows = (await pool.query(
      POST_SELECT + ' WHERE p.user_id=$2 AND p.hidden=FALSE ORDER BY p.created_at DESC LIMIT 50',
      [req.userId, target.id]
    )).rows;
    res.json(rows.map(fmtPost));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/posts', auth, upload.single('media'), async (req, res) => {
  try {
    const caption = String(req.body.caption || '').trim().slice(0, 2200);
    const isReel = req.body.is_reel === 'true' || req.body.is_reel === true;
    let mediaUrl = null, mediaType = null;

    if (req.file) {
      mediaUrl = await uploadToCloudinary(req.file.buffer, req.file.mimetype);
      mediaType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    }
    if (!mediaUrl && !caption) return res.status(400).json({ error: 'أضف صورة أو نصاً' });

    const r = await pool.query(
      'INSERT INTO posts (user_id, media_url, media_type, caption, is_reel) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [req.userId, mediaUrl, mediaType, caption, isReel]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.delete('/api/posts/:id', auth, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM posts WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.userId]);
    if (r.rowCount === 0) return res.status(403).json({ error: 'لا يمكنك حذف هذا المنشور' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/posts/:id/like', auth, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    const p = await pool.query('SELECT id, user_id FROM posts WHERE id=$1 AND hidden=FALSE', [pid]);
    if (p.rowCount === 0) return res.status(404).json({ error: 'المنشور غير موجود' });

    const existing = await pool.query('SELECT 1 FROM likes WHERE user_id=$1 AND post_id=$2', [req.userId, pid]);
    if (existing.rowCount > 0) {
      await pool.query('DELETE FROM likes WHERE user_id=$1 AND post_id=$2', [req.userId, pid]);
      return res.json({ liked: false });
    }
    await pool.query('INSERT INTO likes (user_id, post_id) VALUES ($1,$2)', [req.userId, pid]);
    await notify(p.rows[0].user_id, req.userId, 'like', pid);
    res.json({ liked: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ============================================================
   13) التعليقات
   ============================================================ */
app.post('/api/posts/:id/comments', auth, async (req, res) => {
  try {
    const pid = Number(req.params.id);
    const body = String(req.body.body || '').trim().slice(0, 1000);
    if (!body) return res.status(400).json({ error: 'اكتب تعليقاً' });

    const p = await pool.query('SELECT id, user_id FROM posts WHERE id=$1 AND hidden=FALSE', [pid]);
    if (p.rowCount === 0) return res.status(404).json({ error: 'المنشور غير موجود' });

    const r = await pool.query(
      'INSERT INTO comments (post_id, user_id, body) VALUES ($1,$2,$3) RETURNING id',
      [pid, req.userId, body]
    );
    await notify(p.rows[0].user_id, req.userId, 'comment', pid);
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.get('/api/posts/:id/comments', auth, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT c.id, c.body, c.created_at, u.id AS user_id, u.username, u.avatar_url
         FROM comments c JOIN users u ON u.id=c.user_id
        WHERE c.post_id=$1 ORDER BY c.id ASC`,
      [Number(req.params.id)]
    )).rows;
    res.json(rows.map(c => ({
      id: c.id, body: c.body, created_at: c.created_at,
      user_id: c.user_id, username: c.username, avatar_url: c.avatar_url || ''
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.delete('/api/comments/:id', auth, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM comments WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.userId]);
    if (r.rowCount === 0) return res.status(403).json({ error: 'لا يمكنك حذف هذا التعليق' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ============================================================
   14) القصص (ستوري)
   ============================================================ */
app.get('/api/stories', auth, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT s.id, s.user_id, s.media_url, s.media_type, s.created_at, u.username, u.avatar_url,
              EXISTS (SELECT 1 FROM story_views v WHERE v.story_id=s.id AND v.user_id=$1) AS viewed
         FROM stories s JOIN users u ON u.id=s.user_id
        WHERE s.created_at > now() - interval '24 hours'
          AND (s.user_id=$1 OR s.user_id IN
            (SELECT followee_id FROM follows WHERE follower_id=$1 AND status='accepted'))
        ORDER BY s.created_at DESC LIMIT 100`,
      [req.userId]
    )).rows;
    res.json(rows.map(s => ({
      id: s.id, user_id: s.user_id, username: s.username, avatar_url: s.avatar_url || '',
      media_url: s.media_url, media_type: s.media_type || 'image',
      created_at: s.created_at, viewed: !!s.viewed
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/stories', auth, upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'أرفق صورة أو فيديو' });
    const url = await uploadToCloudinary(req.file.buffer, req.file.mimetype);
    const type = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    const r = await pool.query(
      'INSERT INTO stories (user_id, media_url, media_type) VALUES ($1,$2,$3) RETURNING id',
      [req.userId, url, type]
    );
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.delete('/api/stories/:id', auth, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM stories WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.userId]);
    if (r.rowCount === 0) return res.status(403).json({ error: 'لا يمكنك حذف هذه القصة' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/stories/:id/view', auth, async (req, res) => {
  try {
    const sid = Number(req.params.id);
    await pool.query(
      'INSERT INTO story_views (story_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [sid, req.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ============================================================
   15) المتابعة — بحث، متابعة، إلغاء، طلبات
   ============================================================ */
app.get('/api/search', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    const rows = (await pool.query(
      `SELECT id, username, avatar_url, bio, is_private,
              EXISTS (SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.followee_id=u.id AND f.status='accepted') AS is_following,
              EXISTS (SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.followee_id=u.id AND f.status='pending') AS has_pending
         FROM users u
        WHERE username ILIKE '%'||$2||'%' LIMIT 30`,
      [req.userId, q]
    )).rows;
    res.json(rows.map(u => ({
      id: u.id, username: u.username, avatar_url: u.avatar_url || '',
      bio: u.bio || '', is_private: u.is_private, is_following: !!u.is_following,
      has_pending: !!u.has_pending
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.get('/api/users/:username', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.username, u.avatar_url, u.bio, u.is_private, u.created_at,
              (SELECT COUNT(*)::int FROM posts p WHERE p.user_id=u.id AND p.hidden=FALSE) AS posts_count,
              (SELECT COUNT(*)::int FROM follows f WHERE f.followee_id=u.id AND f.status='accepted') AS followers_count,
              (SELECT COUNT(*)::int FROM follows f WHERE f.follower_id=u.id AND f.status='accepted') AS following_count,
              EXISTS (SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.followee_id=u.id AND f.status='accepted') AS is_following,
              EXISTS (SELECT 1 FROM follows f WHERE f.follower_id=$1 AND f.followee_id=u.id AND f.status='pending') AS request_pending,
              EXISTS (SELECT 1 FROM follows f WHERE f.followee_id=$1 AND f.follower_id=u.id AND f.status='pending') AS has_incoming_request
         FROM users u WHERE u.username=$2`,
      [req.userId, String(req.params.username)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const u = r.rows[0];
    res.json({
      id: u.id, username: u.username, avatar_url: u.avatar_url || '', bio: u.bio || '',
      is_private: u.is_private, created_at: u.created_at,
      posts_count: u.posts_count, followers_count: u.followers_count, following_count: u.following_count,
      is_following: !!u.is_following, request_pending: !!u.request_pending,
      has_incoming_request: !!u.has_incoming_request
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/users/:id/follow', auth, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (targetId === req.userId) return res.status(400).json({ error: 'لا يمكنك متابعة نفسك' });

    const t = await pool.query('SELECT id, is_private FROM users WHERE id=$1', [targetId]);
    if (t.rowCount === 0) return res.status(404).json({ error: 'المستخدم غير موجود' });

    const existing = await pool.query(
      'SELECT status FROM follows WHERE follower_id=$1 AND followee_id=$2',
      [req.userId, targetId]
    );
    if (existing.rowCount > 0) {
      await pool.query('DELETE FROM follows WHERE follower_id=$1 AND followee_id=$2', [req.userId, targetId]);
      return res.json({ following: false });
    }

    const status = t.rows[0].is_private ? 'pending' : 'accepted';
    await pool.query(
      'INSERT INTO follows (follower_id, followee_id, status) VALUES ($1,$2,$3)',
      [req.userId, targetId, status]
    );
    if (status === 'accepted') await notify(targetId, req.userId, 'follow');
    else await notify(targetId, req.userId, 'follow_request');
    res.json({ following: true, pending: status === 'pending' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/follow-requests/:id/accept', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE follows SET status=$1 WHERE followee_id=$2 AND follower_id=$3 AND status=$4 RETURNING id',
      ['accepted', req.userId, Number(req.params.id), 'pending']
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'لا يوجد طلب' });
    await notify(Number(req.params.id), req.userId, 'follow');
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/follow-requests/:id/reject', auth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM follows WHERE followee_id=$1 AND follower_id=$2 AND status=$3',
      [req.userId, Number(req.params.id), 'pending']
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

/* ============================================================
   16) الإشعارات
   ============================================================ */
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const rows = (await pool.query(
      `SELECT n.id, n.type, n.post_id, n.read, n.created_at,
              u.id AS actor_id, u.username AS actor_username, u.avatar_url AS actor_avatar
         FROM notifications n JOIN users u ON u.id=n.actor_id
        WHERE n.user_id=$1 ORDER BY n.id DESC LIMIT 50`,
      [req.userId]
    )).rows;
    res.json(rows.map(n => ({
      id: n.id, type: n.type, post_id: n.post_id, read: n.read, created_at: n.created_at,
      actor_id: n.actor_id, actor_username: n.actor_username, actor_avatar: n.actor_avatar || ''
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.get('/api/notifications/unread', auth, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT COUNT(*)::int AS count FROM notifications WHERE user_id=$1 AND read=FALSE',
      [req.userId]
    );
    res.json({ count: r.rows[0].count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});

app.post('/api/notifications/read', auth, async (req, res) => {
  try {
    await pool.query('UPDATE notifications SET read=TRUE WHERE user_id=$1 AND read=FALSE', [req.userId]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'خطأ في الخادم' });
  }
});
