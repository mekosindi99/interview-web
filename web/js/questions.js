// Seed question bank, derived from the interview training document
// (rules, salary table, company policy, delivery pricing, scripted replies).
// Text is kept mostly in Arabic (matching the source dialogues) with English
// translations. Kurdish was removed site-wide.
//
// Image-based questions are intentionally NOT pre-seeded with answers here —
// nobody has verified the code/price shown in each photo against the admin's
// current price list, so the admin should add those manually from the
// "بنك الأسئلة" screen using the image library in assets/questions/ and type
// in the verified correct answer.

export const CATEGORIES = ["rules", "salary", "company", "delivery", "responses", "tools"];

export const seedQuestions = [
  // --- Rules / policy (بنود الشغل) ---
  {
    type: "truefalse",
    category: "rules",
    points: 1,
    text: {
      ar: "يجوز للموظف أن يستخدم أي اسم مستعار (غير المشتري) وينشره أثناء العمل.",
      en: "An employee may use and publish any nickname other than 'customer' while working.",
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
    },
    options: [
      { ar: "5 دقائق جابدان و 10 دقائق مشغول", en: "5 min replying, 10 min busy" },
      { ar: "10 دقائق جابدان و 5 دقائق مشغول", en: "10 min replying, 5 min busy" },
      { ar: "15 دقيقة جابدان بدون استراحة", en: "15 min replying, no break" },
      { ar: "لا يوجد وقت محدد", en: "No fixed time" },
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
    },
    options: [
      { ar: "بدون إشعار مسبق", en: "No notice needed" },
      { ar: "قبل شهر", en: "One month in advance" },
      { ar: "قبل أسبوع", en: "One week in advance" },
      { ar: "بعد ترك العمل مباشرة", en: "Right after quitting" },
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
    },
    options: [
      { ar: "لا يُحسب راتب خلال التدريب", en: "No salary during training" },
      { ar: "نصف الراتب", en: "Half salary" },
      { ar: "الراتب الكامل من أول يوم", en: "Full salary from day one" },
      { ar: "100 ألف دينار فقط", en: "Only 100K IQD" },
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
    },
    options: [
      { ar: "3 ساعات", en: "3 hours" },
      { ar: "4 ساعات", en: "4 hours" },
      { ar: "5 ساعات", en: "5 hours" },
      { ar: "6 ساعات", en: "6 hours" },
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
    },
    options: [
      { ar: "250 ألف / 7 ساعات", en: "250K / 7 hours" },
      { ar: "275 ألف / 8 ساعات", en: "275K / 8 hours" },
      { ar: "300 ألف / 9 ساعات", en: "300K / 9 hours" },
      { ar: "200 ألف / 6 ساعات", en: "200K / 6 hours" },
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
    },
    options: [
      { ar: "الدفع عند الاستلام (حجز وبريد)", en: "Cash on delivery (COD)" },
      { ar: "تحويل رصيد مسبق فقط", en: "Prepaid credit transfer only" },
      { ar: "بطاقة ائتمانية فقط", en: "Credit card only" },
      { ar: "أي طريقة يفضلها الزبون", en: "Whatever the customer prefers" },
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
    },
    options: [
      { ar: "5 آلاف، 3-4 أيام", en: "5K, 3–4 days" },
      { ar: "7 آلاف، 2-3 أيام", en: "7K, 2–3 days" },
      { ar: "3 آلاف، يوم واحد", en: "3K, 1 day" },
      { ar: "لا يوجد توصيل لبغداد", en: "No delivery to Baghdad" },
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
    },
    options: [
      { ar: "5 آلاف دينار", en: "5,000 IQD" },
      { ar: "7 آلاف دينار", en: "7,000 IQD" },
      { ar: "10 آلاف دينار", en: "10,000 IQD" },
      { ar: "مجاناً", en: "Free" },
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
    },
    options: [
      { ar: "5 آلاف دينار", en: "5,000 IQD" },
      { ar: "3 آلاف دينار", en: "3,000 IQD" },
      { ar: "7 آلاف دينار", en: "7,000 IQD" },
      { ar: "مجاناً", en: "Free" },
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
    },
    options: [
      { ar: "الأسعار ثابتة عيني و احنا موظفين هنا", en: "Prices are fixed, dear — we're just employees here" },
      { ar: "خليها أقل شوية بس متأكدة ما تخبري أحد", en: "I'll lower it a bit, just don't tell anyone" },
      { ar: "لازم أسأل صاحب المحل", en: "I need to ask the shop owner" },
      { ar: "نعم فيه مجال دائماً", en: "Yes there's always room for discount" },
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
    },
    options: [
      { ar: "القياسات هنا مظبوطة و احنا يومياً ندز لكل المحافظات و الزبائن راضيين ويستلمونها بشرط إعطاء العمر الصحيح", en: "Sizing here is accurate — we ship daily nationwide and customers are happy, as long as the correct age is given" },
      { ar: "احتمال ما يجيك، جربي وشوفي", en: "It might not fit, just try and see" },
      { ar: "ما نضمن القياس أبداً", en: "We never guarantee the size" },
      { ar: "اطلبي قياسين واحتفظي بواحد", en: "Order two sizes and keep one" },
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
    },
    options: [
      { ar: "اكو تبديل، واحنا واثقين من جودة ملابسنا وتقدرين تفحصين وتقيسين بيد المندوب، بس القياسات لازم تكون مضبوطة", en: "There's exchange, not refund — you can check with the delivery rep, but the size given must be accurate" },
      { ar: "أكيد، ترجيع فلوس كامل بدون شروط", en: "Sure, full refund no conditions" },
      { ar: "لا يوجد أي تبديل أو ترجيع إطلاقاً", en: "No exchange or refund at all" },
      { ar: "فقط خلال أسبوع من الشراء", en: "Only within a week of purchase" },
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
    },
    options: [
      { ar: "لا يفتح الرابط أبداً، ويطلب من الزبون سكرين شوت بدلاً منه", en: "Never open the link — ask the customer for a screenshot instead" },
      { ar: "يفتحه فوراً لأن الزبون طلب ذلك", en: "Open it immediately since the customer asked" },
      { ar: "يرسله لصفحة أخرى ليتأكد", en: "Forward it to another page to check" },
      { ar: "يتجاهل الزبون فقط", en: "Just ignore the customer" },
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
    },
    options: [
      { ar: "تأكيد أن الحجز الذي تم أخذه من الزبون قد سُجّل بشكل صحيح", en: "Confirms the booking taken from the customer was recorded correctly" },
      { ar: "أن الرسالة غير مقروءة", en: "That the message is unread" },
      { ar: "أن الحساب محظور", en: "That the account is blocked" },
      { ar: "أن الزبون غاضب", en: "That the customer is angry" },
    ],
    correctIndex: 0,
  },
];
