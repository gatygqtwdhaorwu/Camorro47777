# كامورو 📸 — شبكة اجتماعية مثل إنستقرام

## البنية
| الجزء | التقنية | المكان |
|-------|---------|--------|
| الواجهة | HTML + CSS + JS | GitHub Pages |
| الخادم | Node.js + Express | Render |
| قاعدة البيانات | PostgreSQL | Neon |
| الصور والفيديوهات | Cloudinary | Cloudinary |

## الميزات
- تسجيل دخول وإنشاء حساب (JWT + bcrypt)
- منشورات صور وفيديوهات مع تعليقات وإعجابات
- متابعة / إلغاء متابعة + بحث عن المستخدمين
- ملفات شخصية (صورة، نبذة، إحصائيات)
- قصص (ستوري) تختفي بعد 24 ساعة
- بيانات تجريبية: حساب `demo` / كلمة المرور `123456`

## النشر خطوة بخطوة
1. أنشئ حساب Cloudinary → Dashboard → انسخ Cloud Name و API Key و API Secret
2. أنشئ حساب Neon → Project جديد → انسخ رابط الاتصال (يبدأ بـ postgres://)
3. ارفع هذا المجلد على GitHub (اسم المستودع مثلاً camorro-backend)
4. في Render: New → Web Service → اختر المستودع
   - Build Command: npm install
   - Start Command: npm start
   - Instance Type: Free
   - Environment Variables:
     - DATABASE_URL = رابط Neon
     - JWT_SECRET = أي نص طويل عشوائي
     - CLOUDINARY_CLOUD_NAME
     - CLOUDINARY_API_KEY
     - CLOUDINARY_API_SECRET
5. بعد النشر انسخ الرابط (مثل https://camorro-api.onrender.com)
6. افتح ملف الواجهة config.js وعدّل API_URL إلى الرابط
7. ارفع مجلد الواجهة على GitHub (camorro-frontend)
8. في إعدادات المستودع: Pages → Deploy from branch → main → /root → Save
9. افتح موقعك ✅
