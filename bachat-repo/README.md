# समूह बचत एप (Samuha Bachat — Cloudflare Edition)

यो परियोजना **Firebase र OneSignal बिना** पूर्ण रूपमा **Cloudflare (Pages + D1 + R2 + Cron Worker)** मा चल्ने गरी तयार गरिएको हो।
पुरानो `accounting.js` को हिसाब–किताब सूत्र १००% जस्ताको तस्तै सुरक्षित राखिएको छ।

## मुख्य विशेषताहरू
- **Cloudflare D1 Database (`group_state`, `month_snapshots`, `auth_credentials`, `chat_messages`, `push_subscriptions`)**:
  - एकल स्रोत (Single Source of Truth) + Version Check (`txnId` idempotent outbox) — अफलाइनमा राखेको हिसाब नेट आउनासाथ दोहोरो entry नगरी सिंक हुन्छ।
  - बन्द भएका महिनाहरू Server मै Immutable Snapshot र R2 Archive मा सुरक्षित रहन्छन्।
- **Cloudflare R2 (`MEDIA`)**:
  - ऋण लिँदाको सहि (Signature), सदस्यको फोटो, परिचय पत्र, लोगो र स्वागत भिडियो स्वतः R2 मा सेभ हुन्छन् (Database कहिल्यै भारी हुँदैन)।
- **सुरक्षित दोहोरो लगइन (Admin A, Admin B, Member)**:
  - एउटै लगइन स्क्रिनबाट PBKDF2 + JWT प्रमाणीकरण। Password र PIN plaintext मा कहिल्यै सेभ हुँदैनन्।
- **Standard Web Push (VAPID + RFC 8291)**:
  - ब्राउजर / PWA मा सिधै पुश नोटिफिकेसन (Firebase/OneSignal को आवश्यकता नपर्ने)।
- **स्वचालित स्वास्थ्य जाँच र भेला रिमाइन्डर (`cron-worker`)**:
  - बिहान ६:०० बजे (NPT) प्रणाली स्वास्थ्य जाँच — त्रुटि देखिएमा Admin ले नहेरेसम्म हरेक घण्टा Admin लाई मात्र Background Push।
  - हरेक नेपाली महिनाको दोस्रो शुक्रबार साँझ ६:००–८:०० बजे (NPT) समूह च्याट र Web Push बाट बैठक रिमाइन्डर।

---

## GitHub बाट Cloudflare Pages मा Deploy गर्ने तरिका

### १. यो फोल्डर GitHub मा राख्नुहोस्
`bachat` नामको नयाँ GitHub repository बनाएर `bachat-repo/` भित्रका सबै फाइलहरू push गर्नुहोस्।

### २. Cloudflare मा D1 र R2 बनाउनुहोस्
1. Cloudflare Dashboard → **Workers & Pages → D1 SQL Database → Create**: नाम `bachat-db`।
2. `bachat-db` को **Console** मा गएर `schema.sql` को पूरै SQL चलाउनुहोस् (वा CLI बाट `npm run db:init:remote`)।
3. **R2 Object Storage → Create bucket**: नाम `bachat-media`।
4. `wrangler.toml` र `cron-worker/wrangler.toml` मा `database_id` राख्नुहोस्।

### ३. Cloudflare Pages Connect गर्नुहोस्
1. **Workers & Pages → Create → Pages → Connect to Git** → `bachat` repo छान्नुहोस्।
2. Build settings:
   - **Framework preset**: None
   - **Build command**: *(खाली छोड्नुहोस्)*
   - **Build output directory**: `public`
3. Deploy भएपछि **Settings → Functions → Bindings** मा थप्नुहोस्:
   - **D1 database**: Variable name `DB` → `bachat-db`
   - **R2 bucket**: Variable name `MEDIA` → `bachat-media`
4. **Retry deployment** गर्नुहोस्।

### ४. पुरानो JSON ब्याकअप Import गर्नुहोस्
- पहिलो पटक साइट खोल्दा लगइन स्क्रिनमै **"📥 पुरानो JSON ब्याकअप Import"** देखिन्छ।
- पुरानो एपबाट डाउनलोड गरेको `.json` फाइल छान्नुहोस् — पुराना महिना, सदस्य, कित्ता, ऋण, पासवर्ड, PIN, च्याट र सहि फोटोहरू सबै स्वतः Cloudflare D1/R2 मा आउँछन्।
- त्यसपछि पहिलेकै Admin username/password वा सदस्य mobile/PIN ले लगइन गर्नुहोस्!

### ५. (वैकल्पिक) दोस्रो शुक्रबार रिमाइन्डर Cron Worker
```bash
cd cron-worker
npx wrangler deploy
```
