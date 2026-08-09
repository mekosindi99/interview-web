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
يمر عبر هذا السيرفر إلى Google Drive بدل Firebase Storage.

⚠️ **حساب الخدمة (Service Account) لا يصلح لهذا** — جوجل ما يعطيه أي مساحة
تخزين خاصة به على حساب Gmail شخصي (Shared Drives تحتاج Google Workspace
مدفوع). الحل: رفع الملفات "باسم" حساب Google الشخصي تبعك عبر OAuth، مرة
وحدة تفوّض فيها السيرفر، وبعدها يشتغل تلقائياً بدون تدخل.

### أ) أنشئ OAuth Client ID

1. [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
   → تأكد نفس مشروع Firebase (`interview-3f9f3`) مختار بالأعلى.
2. **Create Credentials** → **OAuth client ID**.
3. لو أول مرة، راح يطلب تعبّي **OAuth consent screen** أول: User Type
   **External**، عبّي اسم التطبيق وإيميلك، وبخطوة الـ Scopes ما تحتاج تضيف
   شي يدوياً (السيرفر يطلب `drive.file` مباشرة). احفظ واستمر لين ينخلص،
   وبالنهاية اضغط **Publish App** (نشر) حتى ما يصير التفويض مؤقت (7 أيام).
4. رجّع لصفحة Create Credentials: **Application type** = **Web application**،
   اسمه أي شي.
5. تحت **Authorized redirect URIs** أضف بالضبط:
   `https://interview-admin-server.onrender.com/oauth/callback`
6. **Create** — راح يطلعلك **Client ID** و **Client secret**، خلّيهم قريبين
   للخطوة الجاية.

### ب) أضف المتغيّرات بـ Render وانشر

بـ Render Dashboard → خدمة `interview-admin-server` → **Environment**، أضف:

| الاسم | القيمة |
|---|---|
| `DRIVE_FOLDER_ID` | معرّف مجلد Drive (من رابط المجلد بعد `folders/`) |
| `GOOGLE_OAUTH_CLIENT_ID` | من الخطوة أ.6 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | من الخطوة أ.6 |
| `OAUTH_SETUP_SECRET` | أي كلمة سر تختارها انت (تستخدم مرة وحدة بالخطوة الجاية) |

(`GOOGLE_OAUTH_REDIRECT_URI` موجود جاهز بـ `render.yaml`.)

اضغط **Save, rebuild, and deploy** وانتظر يصير **Live**.

### ج) فوّض السيرفر (مرة وحدة)

1. افتح بالمتصفح (وانت داخل بحساب Google تبعك):
   `https://interview-admin-server.onrender.com/oauth/start?key=<OAUTH_SETUP_SECRET>`
   (بدّل `<OAUTH_SETUP_SECRET>` بنفس القيمة اللي حطيتها فوق)
2. وافق على الصلاحية المطلوبة (ممكن يطلع تحذير "تطبيق غير موثّق" — هذا طبيعي
   لتطبيق شخصي، اضغط **Advanced** → **Go to (app name)**).
3. راح ينرجّعك لصفحة فيها **refresh token** طويل — انسخه كامل.
4. رجّع لـ Render → Environment → أضف `GOOGLE_OAUTH_REFRESH_TOKEN` بهذي
   القيمة → **Save, rebuild, and deploy**.

خلص — الرفع يشتغل تلقائياً بعد هذا بدون أي تدخل إضافي.

⚠️ ملاحظة أمان: الملفات المرفوعة (تسجيلات صوت المرشحين، صوت الاستماع، ملف
PDF) تصير "أي شخص عنده الرابط يقدر يوصلها" — Google Drive ما يدعم تقييد
الوصول حسب المستخدم بدون تسجيل دخول Google منفصل لكل مرشح. هذا تنازل مقبول
لتفادي ربط بطاقة بنكية بـ Firebase Blaze؛ لو الأمان أهم أعد النظر لاحقاً
بتفعيل Blaze والرجوع لـ Firebase Storage.

## 6) بعد تحديث تصحيح الاختبار (answer-key split) — خطوات نشر لازمة

هذا التحديث نقل تصحيح الاختبار (وسر الإجابات الصحيحة) من المتصفح إلى هذا
السيرفر، حتى ما يقدر مرشّح يشوف الإجابات الصحيحة أو يزوّر علامته من الكونسول.
عشان يشتغل لازم:

1. **انشر قواعد Firestore الجديدة** — الصق محتوى
   [`web/firestore.rules`](../web/firestore.rules) بالكامل بـ Firebase
   Console → Firestore Database → Rules → Publish. **قبل** هذه الخطوة
   ما راح يشتغل تصحيح الاختبار أو حماية `questionAnswers`.
2. **ثبّت التبعية الجديدة وانشر السيرفر من جديد** — `npm install` هون
   (أو خلي Render يسويها تلقائياً بأول Deploy بعد الـ push، لأنها مضافة
   بـ `package.json`).
3. **رحّل أسئلة بنك الأسئلة الموجودة حالياً** (تشغيل مرة وحدة فقط، أي وقت
   قبل أو بعد نشر القواعد — لا يأثر على أسئلة جديدة تُنشأ من الواجهة، فقط
   الموجودة من قبل):
   ```
   FIREBASE_SERVICE_ACCOUNT_JSON='<نفس JSON تبع service account>' node migrate-question-answers.js
   ```
   هذا يفصل `correctAnswer`/`correctIndex` من كل سؤال موجود إلى مجموعة
   `questionAnswers` الجديدة (يلي ما يقدر يقراها إلا الأدمن/الكو-أدمن).
   آمن يتعاد تشغيله أكثر من مرة.
