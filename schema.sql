-- ============================================================
-- كامورو — مخطط قاعدة البيانات لإضافة التحقق بالبريد الإلكتروني
-- نفّذه في Neon → SQL Editor
-- ============================================================

-- 1) عمود تفعيل البريد في جدول المستخدمين
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN;

-- المستخدمون الموجودون حالياً يبقون مفعلين (لا يُطلب منهم تحقق)
UPDATE users SET email_verified = TRUE WHERE email_verified IS NULL;

-- المستخدمون الجدد يبدأون بحالة "غير مفعل"
ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT FALSE;

-- 2) جدول أكواد التحقق (OTP)
CREATE TABLE IF NOT EXISTS otp_codes (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- فهرس للبحث السريع بالبريد
CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes (email);
