# interview-admin-server

سيرفر صغير مهمته الوحيدة: حذف حساب دخول (Firebase Auth) نهائياً — شي
المتصفح ما يقدر يسويه بنفسه. الموقع الرئيسي (`web/`) يشتغل بشكل كامل بدونه
(زر "حذف" العادي = إخفاء آمن قابل للاسترجاع). هذا السيرفر يضيف بس زر إضافي
"حذف نهائي" لما يكون فعّال.

## 1) توليد مفتاح الخدمة (Service Account)

1. Firebase Console → ⚙️ Project Settings → **Service Accounts**
2. اضغط **Generate new private key** → ينزّل ملف JSON
3. **لا** ترفعه لـ GitHub أبداً ولا ترسله بالمحادثة — راح نحطه بـ Render كـ
   متغيّر بيئة سري بالخطوة الجاية.

## 2) النشر على Render

1. Render Dashboard → **New** → **Blueprint** → اختر ريبو `interview-web`
   (نفس الريبو، Render يقرأ `server/render.yaml` تلقائياً)
2. اسم الخدمة: `interview-admin-server`
3. لما يوصلك طلب قيمة **FIREBASE_SERVICE_ACCOUNT_JSON** — افتح ملف الـJSON
   يلي نزّلته بالخطوة السابقة، انسخ **محتواه كامل** (سطر واحد أو أكثر، مو
   مهم) والصقه كقيمة.
4. اضغط **Deploy**. بعد ما يخلص، انسخ رابط الخدمة (شكله تقريباً
   `https://interview-admin-server.onrender.com`)

## 3) ربط الموقع بالسيرفر

خبرني رابط الخدمة وأنا أحطه بـ [web/js/firebase-config.js](../web/js/firebase-config.js)
(`ADMIN_SERVER_URL`) وأنشره.

## 4) منع نوم السيرفر (خطة Render المجانية تنيمه بعد 15 دقيقة خمول)

1. GitHub → ريبو `interview-web` → **Settings** → **Secrets and variables**
   → **Actions** → **New repository secret**
2. الاسم: `RENDER_HEALTH_URL`، القيمة: رابط السيرفر (نفس رابط الخطوة 2،
   بدون `/` بالآخر)
3. خلص — فيه GitHub Action (`.github/workflows/keepalive.yml`) يبينغ
   السيرفر كل 5 دقايق تلقائياً ومجاناً.
