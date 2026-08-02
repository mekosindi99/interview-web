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

## 5) رفع الملفات عبر Google Drive (تسجيلات المحادثة، صوت الاستماع، ملف التدريب)

المشروع على خطة Firebase المجانية (Spark) اللي ما تدعم Storage، فرفع الملفات
يمر عبر هذا السيرفر إلى Google Drive بدل Firebase Storage. يحتاج إعداد
لمرة وحدة:

1. **فعّل Google Drive API**: [Google Cloud Console](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   → اختر نفس مشروع Firebase تبعك (`interview-3f9f3`) → **Enable**.
2. **أنشئ مجلد بـ Google Drive تبعك** (مثلاً "Interview Uploads")، وشاركه
   (Share) مع بريد حساب الخدمة — تلقاه بملف `FIREBASE_SERVICE_ACCOUNT_JSON`
   نفسه، الحقل `"client_email"` (شكله تقريباً
   `firebase-adminsdk-xxxxx@interview-3f9f3.iam.gserviceaccount.com`) —
   وأعطه صلاحية **Editor** (محرر).
3. **انسخ معرّف المجلد (Folder ID)** من رابط المجلد بالمتصفح (الجزء الأخير
   من الرابط بعد `folders/`).
4. أضفه بـ Render كمتغيّر بيئة: **Environment** → **Add Environment Variable**
   → الاسم `DRIVE_FOLDER_ID`، القيمة معرّف المجلد.
5. **Manual Deploy** حتى ينزّل السيرفر الاعتماديات الجديدة (`googleapis`,
   `multer`) ويشتغل.

⚠️ ملاحظة أمان: الملفات المرفوعة (تسجيلات صوت المرشحين، صوت الاستماع، ملف
PDF) تصير "أي شخص عنده الرابط يقدر يوصلها" — Google Drive ما يدعم تقييد
الوصول حسب المستخدم بدون تسجيل دخول Google منفصل لكل مرشح. هذا تنازل مقبول
لتفادي ربط بطاقة بنكية بـ Firebase Blaze؛ لو الأمان أهم أعد النظر لاحقاً
بتفعيل Blaze والرجوع لـ Firebase Storage.
