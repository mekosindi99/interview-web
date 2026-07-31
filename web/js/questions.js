// Seed question bank, derived from the interview training document
// (rules, salary table, company policy, delivery pricing, scripted replies).
// Text is kept mostly in Arabic (matching the source dialogues) with English
// translations. Kurdish (Badini) fields reuse the document's own wording
// where it exists; review/refine before using in a real exam.
//
// Image-based questions are intentionally NOT pre-seeded with answers here —
// nobody has verified the code/price shown in each photo against the admin's
// current price list, so the admin should add those manually from the
// "بنك الأسئلة" screen using the image library in assets/questions/ and type
// in the verified correct answer.

export const CATEGORIES = ["rules", "salary", "company", "delivery", "responses"];

export const seedQuestions = [
  // --- Rules / policy (بنود الشغل) ---
  {
    type: "truefalse",
    category: "rules",
    points: 1,
    text: {
      ar: "يجوز للموظف أن يستخدم أي اسم مستعار (غير المشتري) وينشره أثناء العمل.",
      en: "An employee may use and publish any nickname other than 'customer' while working.",
      ku: "چالاک دبیت کارمەند ناڤەکێ دی (نە مشتری) بکاربینیت و بلاڤ بکەت دناڤ کارێ دا.",
    },
    correctAnswer: false,
  },
  {
    type: "truefalse",
    category: "rules",
    points: 1,
    text: {
      ar: "يمكن ترك الموبايل بدون شحن أثناء الدوام إذا لم يوجد وقت للشحن.",
      en: "It's fine to leave the phone uncharged during a shift if there's no time to charge it.",
      ku: "ژ بو دهێت موبایل ب دویماهیک شحن نەکری بمینیت د کاتێ کارێ دا.",
    },
    correctAnswer: false,
  },
  {
    type: "mcq",
    category: "rules",
    points: 1,
    text: {
      ar: "أثناء الرد على الزبائن عبر السوشيال ميديا، ما هو الوقت المسموح للرد وللانشغال (استراحة)؟",
      en: "While replying to customers on social media, what is the allowed time for replying vs. a break?",
      ku: "دناڤ جابدانا مشتریان دا، چەند دەقە جابدان و چەند دەقە مژول بین ڕێگردایه؟",
    },
    options: [
      { ar: "5 دقائق جابدان و 10 دقائق مشغول", en: "5 min replying, 10 min busy", ku: "5 دەقا جابدان و 10 دەقا مژول" },
      { ar: "10 دقائق جابدان و 5 دقائق مشغول", en: "10 min replying, 5 min busy", ku: "10 دەقا جابدان و 5 دەقا مژول" },
      { ar: "15 دقيقة جابدان بدون استراحة", en: "15 min replying, no break", ku: "15 دەقا جابدان بێ ڕاوەستان" },
      { ar: "لا يوجد وقت محدد", en: "No fixed time", ku: "کاتەک دیارنەکری نینه" },
    ],
    correctIndex: 0,
  },
  {
    type: "mcq",
    category: "rules",
    points: 1,
    text: {
      ar: "إذا أراد الموظف ترك العمل، كم يجب أن يخبر الإدارة مسبقاً حتى يستلم راتب ذلك الشهر؟",
      en: "If an employee wants to quit, how much advance notice must they give management to still receive that month's salary?",
      ku: "ئەگەر کارمەند ب ڤیت کارێ خۆ بهێلیت، دڤێت چەند بەری ئیدارێ ئاگەهدار بکەت داکو مووچا وی مانگی وەربگریت؟",
    },
    options: [
      { ar: "بدون إشعار مسبق", en: "No notice needed", ku: "بێ ئاگەهداری" },
      { ar: "قبل شهر", en: "One month in advance", ku: "بەری مانگەکێ" },
      { ar: "قبل أسبوع", en: "One week in advance", ku: "بەری هەفتیەکێ" },
      { ar: "بعد ترك العمل مباشرة", en: "Right after quitting", ku: "دویماهیک هێلانا کارێ" },
    ],
    correctIndex: 1,
  },
  {
    type: "truefalse",
    category: "rules",
    points: 1,
    text: {
      ar: "يجوز للموظف إعطاء رقم موبايله الشخصي للزبون.",
      en: "An employee may give their personal phone number to a customer.",
      ku: "کارمەند دشێت ژمارا موبایلا خۆ یا کەسی بدەتە مشتری.",
    },
    correctAnswer: false,
  },
  {
    type: "truefalse",
    category: "rules",
    points: 1,
    text: {
      ar: "من واجب الموظف الالتزام بجدول أوقات الدوام (وقت الدخول والخروج) بدقة.",
      en: "The employee must strictly follow the shift schedule (clock-in and clock-out times).",
      ku: "ب ئەرکی کارمەندییه بگهورینا کاتێ خەتێ ب ورییی جهبکەت.",
    },
    correctAnswer: true,
  },

  // --- Salary table ---
  {
    type: "mcq",
    category: "salary",
    points: 1,
    text: {
      ar: "ماذا يحصل الموظف في فترة التدريب (أول أسبوع إلى أسبوعين)؟",
      en: "What does the employee receive during the training period (1–2 weeks)?",
      ku: "کارمەند دناڤ ماوێ ڕاهێنانێ دا (ئێک بۆ دوو هەفتا) چ وەردگریت؟",
    },
    options: [
      { ar: "لا يُحسب راتب خلال التدريب", en: "No salary during training", ku: "مووچە ناهێتە حساب کرن" },
      { ar: "نصف الراتب", en: "Half salary", ku: "نیڤێ مووچێ" },
      { ar: "الراتب الكامل من أول يوم", en: "Full salary from day one", ku: "مووچا تەکمیل ژ رۆژا ئێکێ" },
      { ar: "100 ألف دينار فقط", en: "Only 100K IQD", ku: "تنێ 100 هەزار دینار" },
    ],
    correctIndex: 0,
  },
  {
    type: "mcq",
    category: "salary",
    points: 1,
    text: {
      ar: "بعد إكمال أول شهر (1 month) في السلم الوظيفي، كم عدد ساعات الدوام؟",
      en: "After completing the first stage (1 month) of the pay scale, how many working hours?",
      ku: "دویماهیک تەواوکرنا قۆناغا ئێکێ (1 مانگ)، چەند سەعات کار؟",
    },
    options: [
      { ar: "3 ساعات", en: "3 hours", ku: "3 سەعات" },
      { ar: "4 ساعات", en: "4 hours", ku: "4 سەعات" },
      { ar: "5 ساعات", en: "5 hours", ku: "5 سەعات" },
      { ar: "6 ساعات", en: "6 hours", ku: "6 سەعات" },
    ],
    correctIndex: 0,
  },
  {
    type: "mcq",
    category: "salary",
    points: 1,
    text: {
      ar: "ما هو الراتب وعدد الساعات في المرحلة الأخيرة (Final) من سلم الرواتب؟",
      en: "What is the salary and hours at the Final stage of the pay scale?",
      ku: "دقۆناغا داهاتویی (Final) مووچە و سەعات چەندن؟",
    },
    options: [
      { ar: "250 ألف / 7 ساعات", en: "250K / 7 hours", ku: "250 هەزار / 7 سەعات" },
      { ar: "275 ألف / 8 ساعات", en: "275K / 8 hours", ku: "275 هەزار / 8 سەعات" },
      { ar: "300 ألف / 9 ساعات", en: "300K / 9 hours", ku: "300 هەزار / 9 سەعات" },
      { ar: "200 ألف / 6 ساعات", en: "200K / 6 hours", ku: "200 هەزار / 6 سەعات" },
    ],
    correctIndex: 2,
  },

  // --- Company policy ---
  {
    type: "truefalse",
    category: "company",
    points: 1,
    text: {
      ar: "الشركة تبيع الملابس بالجملة أيضاً وليس فقط بالمفرد.",
      en: "The company also sells wholesale, not only single pieces.",
      ku: "کۆمپانیا جلکان ب کۆمەلی ژی دفروشیت نە تنێ ب تاکی.",
    },
    correctAnswer: false,
  },
  {
    type: "truefalse",
    category: "company",
    points: 1,
    text: {
      ar: "يوجد لدى الشركة إمكانية التبديل (تغيير الموديل أو المقاس)، لكن لا يوجد استرجاع للفلوس.",
      en: "The company allows exchange (different model/size), but not a refund.",
      ku: "کۆمپانیا تبدیلێ دئینیت (گۆهرینا مۆدێل یان قیاس)، بەلێ ڤەگەڕاندنا فلوسان نینه.",
    },
    correctAnswer: true,
  },
  {
    type: "truefalse",
    category: "company",
    points: 1,
    text: {
      ar: "يوجد توصيل لخارج العراق.",
      en: "There is delivery outside of Iraq.",
      ku: "توصیل بۆ دەرڤەیێ عێراقێ هەیه.",
    },
    correctAnswer: false,
  },
  {
    type: "mcq",
    category: "company",
    points: 1,
    text: {
      ar: "طريقة الدفع المعتمدة لدى الشركة هي:",
      en: "The company's accepted payment method is:",
      ku: "شێوازێ دان و ستاندنا فلوسان یێ کۆمپانیێ:",
    },
    options: [
      { ar: "الدفع عند الاستلام (حجز وبريد)", en: "Cash on delivery (COD)", ku: "دان دگەل وەرگرتنێ (حجز و بەرید)" },
      { ar: "تحويل رصيد مسبق فقط", en: "Prepaid credit transfer only", ku: "تنێ گوهاستنا رصیدێ ب پێش" },
      { ar: "بطاقة ائتمانية فقط", en: "Credit card only", ku: "تنێ کارتا بانکی" },
      { ar: "أي طريقة يفضلها الزبون", en: "Whatever the customer prefers", ku: "هەر شێوازەکێ مشتری ب ڤیت" },
    ],
    correctIndex: 0,
  },

  // --- Delivery pricing ---
  {
    type: "mcq",
    category: "delivery",
    points: 1,
    text: {
      ar: "كم سعر التوصيل لبغداد وكم يوم يستغرق؟",
      en: "What is the delivery price and time to Baghdad?",
      ku: "بۆ بەغدا نرخێ توصیلێ و چەند رۆژان دگەهیتێ؟",
    },
    options: [
      { ar: "5 آلاف، 3-4 أيام", en: "5K, 3–4 days", ku: "5 هەزار، 3-4 ڕۆژان" },
      { ar: "7 آلاف، 2-3 أيام", en: "7K, 2–3 days", ku: "7 هەزار، 2-3 ڕۆژان" },
      { ar: "3 آلاف، يوم واحد", en: "3K, 1 day", ku: "3 هەزار، ڕۆژەک" },
      { ar: "لا يوجد توصيل لبغداد", en: "No delivery to Baghdad", ku: "توصیل بۆ بەغدا نینه" },
    ],
    correctIndex: 0,
  },
  {
    type: "mcq",
    category: "delivery",
    points: 1,
    text: {
      ar: "كم سعر التوصيل لباقي محافظات العراق (غير بغداد والإقليم)؟",
      en: "What is the delivery price to the other Iraqi governorates (outside Baghdad and the region)?",
      ku: "بۆ باقی پارێزگەهێن عێراقێ (نە بەغدا و نە هەرێم) نرخێ توصیلێ چەندە؟",
    },
    options: [
      { ar: "5 آلاف دينار", en: "5,000 IQD", ku: "5 هەزار دینار" },
      { ar: "7 آلاف دينار", en: "7,000 IQD", ku: "7 هەزار دینار" },
      { ar: "10 آلاف دينار", en: "10,000 IQD", ku: "10 هەزار دینار" },
      { ar: "مجاناً", en: "Free", ku: "بەلاش" },
    ],
    correctIndex: 1,
  },
  {
    type: "truefalse",
    category: "delivery",
    points: 1,
    text: {
      ar: "لا يوجد توصيل إلى منطقة شنكال.",
      en: "There is no delivery to Shingal (Sinjar).",
      ku: "توصیل بۆ شنگالێ نینه.",
    },
    correctAnswer: true,
  },
  {
    type: "mcq",
    category: "delivery",
    points: 1,
    text: {
      ar: "كم سعر التوصيل الداخلي لزاخو؟",
      en: "What is the delivery price inside Zakho?",
      ku: "نرخێ توصیلا زاخۆیا ناڤخۆیی چەندە؟",
    },
    options: [
      { ar: "5 آلاف دينار", en: "5,000 IQD", ku: "5 هەزار دینار" },
      { ar: "3 آلاف دينار", en: "3,000 IQD", ku: "3 هەزار دینار" },
      { ar: "7 آلاف دينار", en: "7,000 IQD", ku: "7 هەزار دینار" },
      { ar: "مجاناً", en: "Free", ku: "بەلاش" },
    ],
    correctIndex: 1,
  },

  // --- Scripted customer responses ---
  {
    type: "mcq",
    category: "responses",
    points: 1,
    text: {
      ar: "الزبون يقول: \"بيها مجال؟ / ممكن تخفيض؟\" ما هو الرد الصحيح؟",
      en: "The customer asks for a discount. What is the correct reply?",
      ku: "مشتری دبێژیت: تخفیض هەیه؟ بەرسڤا راست چیه؟",
    },
    options: [
      { ar: "الأسعار ثابتة عيني و احنا موظفين هنا", en: "Prices are fixed, dear — we're just employees here", ku: "بها جهگیرن و ئەم کارمەندین ل ڤێرێ" },
      { ar: "خليها أقل شوية بس متأكدة ما تخبري أحد", en: "I'll lower it a bit, just don't tell anyone", ku: "کێمتر دکەم بەس نەبێژە کەسی" },
      { ar: "لازم أسأل صاحب المحل", en: "I need to ask the shop owner", ku: "پێدڤیه پرسا خودانێ دکانێ بکەم" },
      { ar: "نعم فيه مجال دائماً", en: "Yes there's always room for discount", ku: "بەلێ هەردەم مەجال هەیه" },
    ],
    correctIndex: 0,
  },
  {
    type: "mcq",
    category: "responses",
    points: 1,
    text: {
      ar: "الزبونة تقول: \"بس أنا أخاف من القياس / قياس بنتي محير\". ما هو الرد الصحيح؟",
      en: "A customer says she's worried the size won't fit. What is the correct reply?",
      ku: "مشتری دبێژیت: ئەز ژ قیاسێ دترسم. بەرسڤا راست چیه؟",
    },
    options: [
      { ar: "القياسات هنا مظبوطة و احنا يومياً ندز لكل المحافظات و الزبائن راضيين ويستلمونها بشرط إعطاء العمر الصحيح", en: "Sizing here is accurate — we ship daily nationwide and customers are happy, as long as the correct age is given", ku: "قیاس ل ڤێرێ دروستن، ئەم رۆژانە بۆ هەمی پارێزگەها دنێرین و مشتری رازین" },
      { ar: "احتمال ما يجيك، جربي وشوفي", en: "It might not fit, just try and see", ku: "دبیت نەیێ، تاقی بکە" },
      { ar: "ما نضمن القياس أبداً", en: "We never guarantee the size", ku: "ئەم قیاسێ قەت ناپاریزین" },
      { ar: "اطلبي قياسين واحتفظي بواحد", en: "Order two sizes and keep one", ku: "دوو قیاسا داخازە بکە یا یەکێ بهێلە" },
    ],
    correctIndex: 0,
  },
  {
    type: "mcq",
    category: "responses",
    points: 1,
    text: {
      ar: "الزبون يسأل: \"أكو ترجيع لو لا؟\" (يقصد استرجاع الفلوس). ما هو الرد الصحيح حسب سياسة الشركة؟",
      en: "The customer asks if there's a refund. What is the correct reply per company policy?",
      ku: "مشتری دپرسیت: ترجیع هەیه؟ بەرسڤا راست ب گوهرێ رێکارێن کۆمپانیێ چیه؟",
    },
    options: [
      { ar: "اكو تبديل، واحنا واثقين من جودة ملابسنا وتقدرين تفحصين وتقيسين بيد المندوب، بس القياسات لازم تكون مضبوطة", en: "There's exchange, not refund — you can check with the delivery rep, but the size given must be accurate", ku: "تبدیل هەیه، بەس ڤەگەڕاندنا فلوسان نینه، دشێی دگەل نوینەری بپشکنی" },
      { ar: "أكيد، ترجيع فلوس كامل بدون شروط", en: "Sure, full refund no conditions", ku: "بەلێ، هەمی فلوس ڤەدگەڕینین" },
      { ar: "لا يوجد أي تبديل أو ترجيع إطلاقاً", en: "No exchange or refund at all", ku: "نە تبدیل و نە ترجیع هەیه" },
      { ar: "فقط خلال أسبوع من الشراء", en: "Only within a week of purchase", ku: "تنێ دناڤ هەفتیەکێ دا" },
    ],
    correctIndex: 0,
  },
  {
    type: "mcq",
    category: "responses",
    points: 1,
    text: {
      ar: "الزبون أرسل لينك (رابط) مشبوه وطلب فتحه. ماذا يجب أن يفعل الموظف؟",
      en: "A customer sends a suspicious link and asks the employee to open it. What should the employee do?",
      ku: "مشتری لینکەکێ گومانلێکری ڕادکێت. کارمەند دڤێت چ بکەت؟",
    },
    options: [
      { ar: "لا يفتح الرابط أبداً، ويطلب من الزبون سكرين شوت بدلاً منه", en: "Never open the link — ask the customer for a screenshot instead", ku: "لینکێ ناکەتەڤە، ژ مشتری سکرین شۆتەکێ دخوازیت" },
      { ar: "يفتحه فوراً لأن الزبون طلب ذلك", en: "Open it immediately since the customer asked", ku: "دەستبدەست ڤەیدکەت چونکی مشتری ڤیایه" },
      { ar: "يرسله لصفحة أخرى ليتأكد", en: "Forward it to another page to check", ku: "دنێریتە پەڕەیەکێ دی بۆ دڵنیابوونێ" },
      { ar: "يتجاهل الزبون فقط", en: "Just ignore the customer", ku: "تنێ چاڤگرتنا مشتری" },
    ],
    correctIndex: 0,
  },
  {
    type: "mcq",
    category: "responses",
    points: 1,
    text: {
      ar: "ما معنى علامة (نجمة / Follow Up) على المحادثة في برنامج Business Suite؟",
      en: "What does the star / Follow Up flag on a conversation mean in Business Suite?",
      ku: "واتا نیشانا ستێرک (Follow Up) دناڤ بەرنامجێ Business Suite دا چیه؟",
    },
    options: [
      { ar: "تأكيد أن الحجز الذي تم أخذه من الزبون قد سُجّل بشكل صحيح", en: "Confirms the booking taken from the customer was recorded correctly", ku: "دڵنیابوون ژ تۆمارکرنا حجزا مشتری" },
      { ar: "أن الرسالة غير مقروءة", en: "That the message is unread", ku: "پەیام نەخوینراییه" },
      { ar: "أن الحساب محظور", en: "That the account is blocked", ku: "هژمار بلۆکبویه" },
      { ar: "أن الزبون غاضب", en: "That the customer is angry", ku: "مشتری تووڕەیه" },
    ],
    correctIndex: 0,
  },
];
