const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Reference data ----------
const RATES = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cghs_rates.json'), 'utf8'));
const RATES_OLD = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cghs_rates_old_2024.json'), 'utf8'));
const HOSPITALS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'empanelled_hospitals.json'), 'utf8'));

// Build a normalized-description → old-rate index for fuzzy matching
function normDesc(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
const OLD_RATES_BY_DESC = {};   // exact normalized description → entry
const OLD_RATES_BY_TOKENS = []; // [{tokens:Set, entry}] for fuzzy match
for (const k in RATES_OLD) {
  const e = RATES_OLD[k];
  const nd = normDesc(e.description);
  OLD_RATES_BY_DESC[nd] = e;
  const tokens = new Set(nd.split(' ').filter(t => t.length > 3));
  if (tokens.size > 0) OLD_RATES_BY_TOKENS.push({ tokens, entry: e, nd });
}

function lookupOldRateByDescription(desc) {
  if (!desc) return null;
  const nd = normDesc(desc);
  if (!nd) return null;
  if (OLD_RATES_BY_DESC[nd]) return { entry: OLD_RATES_BY_DESC[nd], score: 100, match_type: 'exact' };

  // Stemming-lite: drop trailing 's' for plurals
  const stem = s => s.replace(/s\b/g, '');
  const ndStem = stem(nd);
  const queryTokens = new Set(ndStem.split(' ').filter(t => t.length > 2));
  if (queryTokens.size === 0) return null;

  let best = null, bestScore = 0;
  for (const cand of OLD_RATES_BY_TOKENS) {
    const candStem = stem(cand.nd);
    const candTokens = new Set(candStem.split(' ').filter(t => t.length > 2));
    if (candTokens.size === 0) continue;
    const intersect = [...queryTokens].filter(t => candTokens.has(t)).length;
    if (intersect === 0) continue;
    const union = queryTokens.size + candTokens.size - intersect;
    let score = (intersect / union) * 100;
    // Strong bonus for substring containment (handles "Joints Aspiration" → "Joints Aspiration")
    if (candStem === ndStem) score = 100;
    else if (candStem.includes(ndStem) || ndStem.includes(candStem)) score = Math.max(score, 90);
    // Penalty when very few tokens match
    if (intersect < 2 && queryTokens.size > 2) score *= 0.5;
    if (score > bestScore) { bestScore = score; best = cand.entry; }
  }
  // Stricter threshold for fuzzy — require 70% to avoid spurious matches
  return bestScore >= 70 ? { entry: best, score: Math.round(bestScore), match_type: bestScore === 100 ? 'exact_stem' : 'fuzzy' } : null;
}

function lookupOldRateBySrNo(srNo) {
  if (!srNo) return null;
  const k = String(srNo).trim();
  return RATES_OLD[k] || null;
}

function getOldApplicableRate(oldEntry, accreditation) {
  if (!oldEntry) return null;
  const a = String(accreditation || '').toUpperCase();
  // Old list has only Non-NABH and NABH columns
  if (a.includes('NABH') || a.includes('SUPER')) return oldEntry.nabh || oldEntry.non_nabh;
  return oldEntry.non_nabh || oldEntry.nabh;
}

// Hospital lookup helpers
function normalizeHospName(s) {
  return String(s || '').toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(HOSPITAL|HOSPITALS|CLINIC|CENTRE|CENTER|MULTI|SPECIALITY|SPECIALTY|PVT|PRIVATE|LIMITED|LTD|AND|THE)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lookupHospital(name, city) {
  if (!name) return null;
  const normName = normalizeHospName(name);
  const tokens = normName.split(' ').filter(t => t.length > 2);
  let best = null;
  let bestScore = 0;
  for (const h of HOSPITALS) {
    const hn = normalizeHospName(h.name);
    let score = 0;
    if (hn === normName) score = 100;
    else if (hn.includes(normName) || normName.includes(hn)) score = 80;
    else {
      const hnTokens = new Set(hn.split(' '));
      const matched = tokens.filter(t => hnTokens.has(t)).length;
      if (tokens.length > 0) score = (matched / tokens.length) * 70;
    }
    if (city) {
      const hCity = String(h.address || '').toUpperCase();
      if (hCity.includes(String(city).toUpperCase())) score += 10;
    }
    if (score > bestScore) {
      bestScore = score;
      best = h;
    }
  }
  return bestScore >= 50 ? { hospital: best, score: Math.round(bestScore) } : null;
}

function lookupCghsCode(code) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  return RATES[c] || null;
}

function getApplicableRate(rateEntry, tier, accreditation) {
  if (!rateEntry || !rateEntry.rates) return null;
  const tierKey = (tier === 'Tier 2' || tier === 'Tier_II') ? 'Tier_II'
                : (tier === 'Tier 3' || tier === 'Tier_III') ? 'Tier_III'
                : 'Tier_I';
  const r = rateEntry.rates[tierKey];
  if (!r) return null;
  const a = String(accreditation || '').toUpperCase();
  if (a.includes('SUPER')) return r.super_specialty || r.nabh || r.non_nabh;
  if (a.includes('NABH')) return r.nabh || r.non_nabh;
  return r.non_nabh || r.nabh;
}

// ---------- Pay-level → ward entitlement (OM GA_07-11-2022_53) ----------
// Pay level <= 5: General Ward
// Pay level 6-11: Semi-Private Ward
// Pay level >= 12: Private Ward
function entitledWardFromPayLevel(level) {
  const n = parseInt(level, 10);
  if (isNaN(n)) return null;
  if (n <= 5) return 'General';
  if (n <= 11) return 'Semi-Private';
  return 'Private';
}

function wardRank(w) {
  const s = String(w || '').toUpperCase();
  if (s.includes('PRIVATE') && !s.includes('SEMI')) return 3;
  if (s.includes('SEMI')) return 2;
  if (s.includes('GENERAL')) return 1;
  return 0;
}

// ---------- Express setup ----------
app.set('trust proxy', 1);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
const isProd = process.env.NODE_ENV === 'production';
app.use(session({
  secret: process.env.SESSION_SECRET || 'cghs-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,
    secure: isProd,
    httpOnly: true,
    sameSite: isProd ? 'none' : 'lax'
  }
}));

// Static
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for uploaded file blobs (POC)
const fileStore = new Map();
const claimStore = new Map();

// Multer for uploads (memory storage, then we save buffers)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB per file
});

// Anthropic client
let anthropic = null;
function getAnthropic() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

// ---------- Auth ----------
const VALID_USERS = {
  'admin': { password: 'admin', name: 'Dealing Hand', role: 'PD Dealing Hand' },
  'so': { password: 'so123', name: 'Section Officer', role: 'Section Officer' },
  'us': { password: 'us123', name: 'Under Secretary', role: 'Under Secretary (Admn.)' }
};

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = VALID_USERS[String(username || '').toLowerCase().trim()];
  if (!u || u.password !== password) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.user = { username: String(username).toLowerCase().trim(), name: u.name, role: u.role };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.session.user });
});

// ---------- File upload ----------
const SLOTS = ['eclaim', 'referral', 'hospital_bill', 'cghs_card', 'payment_proof'];
const SLOT_LABELS = {
  eclaim: 'e-Claim Form',
  referral: 'CGHS Referral',
  hospital_bill: 'Hospital Bills',
  cghs_card: 'CGHS Card',
  payment_proof: 'Payment Proof'
};

app.post('/api/upload/:slot', requireAuth, upload.array('files', 10), async (req, res) => {
  const { slot } = req.params;
  if (!SLOTS.includes(slot)) return res.status(400).json({ error: 'Invalid slot' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });
  const out = [];
  for (const f of req.files) {
    const id = crypto.randomBytes(8).toString('hex');
    fileStore.set(id, {
      id,
      slot,
      filename: f.originalname,
      mime: f.mimetype,
      size: f.size,
      buffer: f.buffer,
      uploaded_at: new Date().toISOString()
    });
    out.push({ id, slot, filename: f.originalname, mime: f.mimetype, size: f.size });
  }
  if (!req.session.uploaded_files) req.session.uploaded_files = {};
  if (!req.session.uploaded_files[slot]) req.session.uploaded_files[slot] = [];
  req.session.uploaded_files[slot].push(...out);
  res.json({ ok: true, files: out });
});

// View a file (returns the raw bytes)
app.get('/api/file/:id', requireAuth, (req, res) => {
  const f = fileStore.get(req.params.id);
  if (!f) return res.status(404).send('Not found');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', `inline; filename="${f.filename.replace(/"/g, '')}"`);
  res.send(f.buffer);
});

app.delete('/api/file/:id', requireAuth, (req, res) => {
  const f = fileStore.get(req.params.id);
  if (!f) return res.status(404).json({ error: 'Not found' });
  fileStore.delete(req.params.id);
  if (req.session.uploaded_files && req.session.uploaded_files[f.slot]) {
    req.session.uploaded_files[f.slot] = req.session.uploaded_files[f.slot].filter(x => x.id !== req.params.id);
  }
  res.json({ ok: true });
});

// ---------- Document type classification (validates the right doc was uploaded into the right slot) ----------
async function classifyDocument(buffer, mime, expectedSlot) {
  const client = getAnthropic();
  if (!client) return { matches: true, confidence: 'low', detected_type: 'unknown', reason: 'OCR disabled (no API key)' };

  const isPdf = mime.includes('pdf');
  const isImage = mime.includes('image');
  if (!isPdf && !isImage) return { matches: true, confidence: 'low', detected_type: 'unknown', reason: 'Unsupported MIME' };

  const docDescriptions = {
    eclaim: 'GIFMIS / PFMS RPR-23 e-Claim form (Medical Charges Reimbursement) — has Claim Reference No., CGHS Beneficiary IDs, claimant bank details, and a "Details of total amount Claimed" table.',
    referral: 'CGHS Referral Slip / Referral Form — issued by a CGHS Wellness Centre (e.g., CGHS Delhi Cantt, President Estate). Lists procedures/investigations the beneficiary is referred to undergo at an empanelled hospital.',
    hospital_bill: 'Hospital bill / cash memo / invoice / discharge summary issued by a hospital — has bill number, dates, itemised charges, hospital letterhead.',
    cghs_card: 'CGHS Beneficiary Card — has BEN ID, photo, name, DOB/gender, category (Serving/Pensioner), relation, ward entitlement, validity, QR code.',
    payment_proof: 'Payment proof — receipt, bank statement, UPI transaction, payment confirmation showing money transferred to the hospital.'
  };

  const prompt = `You are validating that the right document was uploaded into the right slot of a CGHS medical reimbursement system.

Expected document type for this slot: **${SLOT_LABELS[expectedSlot]}**
Description: ${docDescriptions[expectedSlot]}

Look at the document and respond ONLY with this JSON (no other text, no markdown fences):
{
  "detected_type": "eclaim" | "referral" | "hospital_bill" | "cghs_card" | "payment_proof" | "unknown",
  "matches": true | false,
  "confidence": "high" | "medium" | "low",
  "reason": "one short sentence explaining what you see"
}`;

  try {
    const content = isPdf
      ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }, { type: 'text', text: prompt }]
      : [{ type: 'image', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } }, { type: 'text', text: prompt }];

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 300,
      messages: [{ role: 'user', content }]
    });
    const text = (resp.content[0] && resp.content[0].text || '').replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (e) {
    console.error('Classify error:', e.message);
    return { matches: true, confidence: 'low', detected_type: 'unknown', reason: 'Validation skipped: ' + e.message };
  }
}

app.post('/api/validate-slot/:slot/:fileId', requireAuth, async (req, res) => {
  const f = fileStore.get(req.params.fileId);
  if (!f) return res.status(404).json({ error: 'File not found' });
  const result = await classifyDocument(f.buffer, f.mime, req.params.slot);
  res.json(result);
});

// ---------- OCR field extraction ----------
const EXTRACTION_PROMPTS = {
  eclaim: `Extract from this CGHS e-Claim (RPR-23) form. Return ONLY this JSON (no prose, no fences):
{
  "claim_reference_no": "...",
  "claim_date": "DD-MM-YYYY",
  "employee_name": "...",
  "designation": "...",
  "office": "...",
  "mobile": "...",
  "email": "...",
  "bank_account_no": "...",
  "bank_name": "...",
  "bank_ifsc": "...",
  "principal_cghs_id": "...",
  "principal_pay": "...",
  "principal_pay_level": "...",
  "principal_ward_entitlement": "Semi-Private | Private | General",
  "patient_name": "...",
  "patient_cghs_id": "...",
  "patient_relation": "Self | Spouse | Father | Mother | Son | Daughter | Other",
  "patient_ward_entitlement": "Semi-Private | Private | General",
  "hospital_name": "...",
  "hospital_address": "...",
  "is_empaneled_per_eclaim": "Yes | No",
  "treatment_type": "Indoor | OPD | Investigations | Mixed",
  "is_emergency": "Yes | No",
  "prior_permission_taken": "Yes | No",
  "total_amount_claimed": <number>,
  "bill_lines": [
    { "treatment_type": "...", "from_date": "DD-MM-YYYY", "to_date": "DD-MM-YYYY", "amount": <number>, "cghs_sr_no": "...", "cash_memo_no": "...", "issuing_authority": "..." }
  ],
  "supporting_documents": ["..."]
}
Use null for missing values, not "N/A".`,

  referral: `Extract from this CGHS Referral Slip. Return ONLY this JSON:
{
  "referral_date": "DD-MM-YYYY",
  "referring_centre": "name of CGHS Wellness Centre or CMO",
  "beneficiary_name": "...",
  "beneficiary_cghs_id": "...",
  "diagnosis": "...",
  "referred_to": "name of hospital/centre referred to, if specified",
  "procedures_referred": [
    { "name": "procedure or investigation name", "cghs_code": "code if visible, else null" }
  ],
  "validity_period": "if specified",
  "remarks": "..."
}`,

  hospital_bill: `Extract from this hospital bill / cash memo / invoice. Return ONLY this JSON:
{
  "hospital_name": "...",
  "hospital_address": "...",
  "city": "...",
  "patient_name": "...",
  "bill_no": "...",
  "bill_date": "DD-MM-YYYY",
  "admission_date": "DD-MM-YYYY or null if not IPD",
  "discharge_date": "DD-MM-YYYY or null",
  "is_ipd": true | false,
  "ward_category": "General | Semi-Private | Private | ICU | NICU | null",
  "line_items": [
    { "description": "...", "cghs_code": "if mentioned", "qty": <number>, "rate": <number>, "amount": <number> }
  ],
  "total_amount": <number>
}`,

  cghs_card: `Extract from this CGHS Beneficiary Card. Return ONLY this JSON:
{
  "ben_id": "...",
  "name": "...",
  "dob": "DD-MMM-YYYY",
  "gender": "M | F",
  "category": "Serving | Pensioner",
  "relation": "Self | Spouse | Father | Mother | Son | Daughter",
  "ward_entitlement": "General | Semi-Private | Private",
  "valid_upto": "MMM-YYYY or DD-MMM-YYYY"
}`,

  payment_proof: `Extract from this payment proof (receipt / bank statement / UPI screenshot). Return ONLY this JSON:
{
  "amount": <number>,
  "date": "DD-MM-YYYY",
  "paid_to": "...",
  "mode": "Cash | UPI | Card | NEFT | Cheque | Other",
  "reference_no": "..."
}`
};

async function extractFields(buffer, mime, slot) {
  const client = getAnthropic();
  if (!client) return { _error: 'OCR disabled (no API key)', _confidence: 'low' };

  const isPdf = mime.includes('pdf');
  const isImage = mime.includes('image');
  if (!isPdf && !isImage) return { _error: 'Unsupported file type', _confidence: 'low' };

  const prompt = EXTRACTION_PROMPTS[slot];
  if (!prompt) return { _error: 'No extractor for slot', _confidence: 'low' };

  try {
    const content = isPdf
      ? [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }, { type: 'text', text: prompt }]
      : [{ type: 'image', source: { type: 'base64', media_type: mime, data: buffer.toString('base64') } }, { type: 'text', text: prompt }];

    const resp = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      messages: [{ role: 'user', content }]
    });
    let text = (resp.content[0] && resp.content[0].text || '').replace(/```json|```/g, '').trim();
    // Try to fix truncated JSON
    if (!text.endsWith('}') && !text.endsWith(']')) {
      const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
      if (lastBrace > 0) text = text.slice(0, lastBrace + 1);
    }
    const parsed = JSON.parse(text);
    parsed._confidence = 'high';
    return parsed;
  } catch (e) {
    console.error('Extract error for', slot, ':', e.message);
    return { _error: e.message, _confidence: 'low' };
  }
}

app.post('/api/extract', requireAuth, async (req, res) => {
  const claimId = crypto.randomBytes(6).toString('hex');
  const uploaded = req.session.uploaded_files || {};
  const extracted = {};

  for (const slot of SLOTS) {
    const files = uploaded[slot] || [];
    extracted[slot] = [];
    for (const meta of files) {
      const f = fileStore.get(meta.id);
      if (!f) continue;
      const fields = await extractFields(f.buffer, f.mime, slot);
      extracted[slot].push({ file_id: f.id, filename: f.filename, fields });
    }
  }

  claimStore.set(claimId, {
    id: claimId,
    user: req.session.user,
    extracted,
    created_at: new Date().toISOString()
  });
  req.session.current_claim_id = claimId;
  res.json({ claim_id: claimId, extracted });
});

// ---------- The 8 Checks ----------
function consolidateExtraction(extracted) {
  const out = {
    eclaim: extracted.eclaim?.[0]?.fields || null,
    referral: extracted.referral?.[0]?.fields || null,
    cghs_card: extracted.cghs_card?.[0]?.fields || null,
    bills: (extracted.hospital_bill || []).map(b => b.fields).filter(Boolean),
    payment: extracted.payment_proof?.[0]?.fields || null
  };
  return out;
}

function check1_TypeOfClaim(c) {
  const e = c.eclaim || {};
  const bills = c.bills || [];

  // Structural classification — based on what the bills actually show
  // IPD if any bill has admission/discharge dates, ward category, or is marked is_ipd
  const ipdSignals = [];
  for (const b of bills) {
    if (!b) continue;
    if (b.is_ipd === true) ipdSignals.push('hospital marked is_ipd=true');
    if (b.admission_date) ipdSignals.push(`admission date present (${b.admission_date})`);
    if (b.discharge_date) ipdSignals.push(`discharge date present (${b.discharge_date})`);
    if (b.ward_category && !/^null|^none/i.test(b.ward_category)) ipdSignals.push(`ward category: ${b.ward_category}`);
  }
  // Emergency declared on e-claim
  const is_emergency = String(e.is_emergency || '').toLowerCase().startsWith('y');
  const prior_permission = String(e.prior_permission_taken || '').toLowerCase().startsWith('y');

  let claim_type;
  let basis;
  if (ipdSignals.length > 0) {
    claim_type = is_emergency ? 'Emergency-IPD' : 'IPD';
    basis = `IPD indicators found in hospital bills: ${ipdSignals.slice(0,3).join('; ')}.`;
  } else if (is_emergency) {
    claim_type = 'Emergency-OPD';
    basis = 'No admission/discharge details found; e-Claim flags emergency.';
  } else {
    claim_type = 'OPD';
    basis = 'No admission/discharge details, ward category, or emergency declaration found — classified as OPD claim.';
  }
  if (is_emergency) claim_type += prior_permission ? ' (with prior permission)' : ' (without prior permission)';

  const total = Number(e.total_amount_claimed || 0)
              || bills.reduce((s, b) => s + Number(b?.total_amount || 0), 0);

  return {
    id: 'CHK-1',
    name: 'Type of Claim',
    result: 'PASS',
    finding: `Claim classified as **${claim_type}**. ${basis} Total claimed: ₹${total.toLocaleString('en-IN')}.`,
    om_ref: 'Structural classification (not OM-based)',
    om_page: null,
    om_pdf: null,
    om_excerpt: 'Classification of a medical reimbursement claim as IPD or OPD is determined by the nature of the bills uploaded: presence of a discharge summary, admission/discharge dates, or ward category on any hospital bill indicates IPD (hospitalisation). Absence of these indicates OPD (out-patient department). Emergency status is taken from the e-Claim form declaration.',
    source_refs: [
      { slot: 'hospital_bill', label: 'Admission/discharge dates, ward category' },
      { slot: 'eclaim', label: 'Emergency declaration' }
    ],
    data: { claim_type, is_emergency, prior_permission, total, ipd_signals: ipdSignals }
  };
}

function check2_BillReconciliation(c) {
  const eclaim_total = Number(c.eclaim?.total_amount_claimed || 0);
  const bills_sum = c.bills.reduce((s, b) => s + Number(b?.total_amount || 0), 0);
  const diff = Math.round((eclaim_total - bills_sum) * 100) / 100;
  const passed = Math.abs(diff) === 0 || (eclaim_total === 0 && bills_sum === 0);
  const bothZero = eclaim_total === 0 && bills_sum === 0;
  return {
    id: 'CHK-2',
    name: 'Bill Amount Reconciliation',
    result: bothZero ? 'PENDING' : passed ? 'PASS' : 'CONDITIONAL',
    finding: bothZero
      ? 'No amounts extracted. Upload the e-Claim and hospital bills to enable reconciliation.'
      : passed
        ? `e-Claim total (₹${eclaim_total.toLocaleString('en-IN')}) exactly matches sum of uploaded bill amounts (₹${bills_sum.toLocaleString('en-IN')}).`
        : `Discrepancy of ₹${Math.abs(diff).toLocaleString('en-IN')} between e-Claim total (₹${eclaim_total.toLocaleString('en-IN')}) and sum of uploaded bills (₹${bills_sum.toLocaleString('en-IN')}). ${diff > 0 ? 'Bills under-reported — verify missing bills.' : 'Bills over-reported — verify if duplicate bills uploaded.'}`,
    om_ref: 'Structural — Internal Claim Reconciliation',
    om_excerpt: 'The total amount claimed in the GIFMIS/PFMS e-Claim form must exactly match the aggregate of individual cash memos and bills attached. Any variance must be explained with a noting.',
    om_page: null,
    om_pdf: null,
    source_refs: [{ slot: 'eclaim', label: 'Total claimed field' }, { slot: 'hospital_bill', label: 'Individual bill totals' }],
    data: { eclaim_total, bills_sum, difference: diff }
  };
}

function check3_RateCompliance(c) {
  // Determine hospital tier & accreditation from matched hospital
  const hospName = c.eclaim?.hospital_name || c.bills.find(b => b?.hospital_name)?.hospital_name;
  const hospCity = c.bills.find(b => b?.city)?.city || '';
  const hospMatch = lookupHospital(hospName, hospCity);
  const tier = hospMatch?.hospital?.tier?.includes('2') ? 'Tier_II'
             : hospMatch?.hospital?.tier?.includes('3') ? 'Tier_III' : 'Tier_I';
  const accreditation = hospMatch?.hospital?.accreditation || 'NABH';

  // Gather line items
  const sources = [];
  for (const b of c.bills) {
    if (b && Array.isArray(b.line_items)) {
      for (const li of b.line_items) {
        sources.push({ description: li.description, cghs_code: li.cghs_code, amount: Number(li.amount || 0) });
      }
    }
  }
  if (sources.length === 0 && c.eclaim?.bill_lines) {
    for (const li of c.eclaim.bill_lines) {
      sources.push({ description: li.treatment_type || 'Item', cghs_code: li.cghs_sr_no, amount: Number(li.amount || 0) });
    }
  }

  const lines = [];
  let total_claimed = 0, total_admissible_new = 0, total_admissible_old = 0;
  let any_overshoot_new = false, any_overshoot_old = false, unlisted_count = 0;

  // Treatment date determines which OM is applicable
  // OM dated 03-10-2025 — applies on/after 03-Oct-2025
  // Old rates 2024 — applied before 03-Oct-2025
  function parseDateDDMMYYYY(s) {
    if (!s) return null;
    const m = String(s).match(/(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
    if (!m) return null;
    return new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
  }
  const treatmentDateStr = c.bills.find(b => b?.bill_date || b?.admission_date)?.bill_date
                        || c.bills.find(b => b?.admission_date)?.admission_date
                        || c.eclaim?.bill_lines?.[0]?.from_date;
  const treatmentDate = parseDateDDMMYYYY(treatmentDateStr);
  const cutoff = new Date(2025, 9, 3); // 03-Oct-2025
  let applicable_list, applicable_label;
  if (!treatmentDate) {
    applicable_list = 'unknown';
    applicable_label = 'Treatment date not extracted — defaulting to 2025 list. Verify manually.';
  } else if (treatmentDate >= cutoff) {
    applicable_list = '2025';
    applicable_label = `Treatment date ${treatmentDate.toLocaleDateString('en-IN')} is on/after 03-Oct-2025 — CGHS Rates 2025 (OM dated 03-10-2025) apply.`;
  } else {
    applicable_list = '2024';
    applicable_label = `Treatment date ${treatmentDate.toLocaleDateString('en-IN')} is before 03-Oct-2025 — CGHS Rates 2024 (pre-revision) apply.`;
  }

  for (const li of sources) {
    const claimed = li.amount;
    total_claimed += claimed;

    // === Lookup in NEW (2025) rate list — by CGHS code ===
    // === Lookup in NEW (2025) rate list — by CGHS code ===
    let newEntry = lookupCghsCode(li.cghs_code);
    let newRate = newEntry ? getApplicableRate(newEntry, tier, accreditation) : null;
    let newDesc = newEntry?.description || null;
    let new_match_via = newEntry ? 'code' : null;

    // === Lookup in OLD (2024) rate list — Sr No (if numeric) OR by description ===
    let oldMatch = null;
    if (li.cghs_code && /^\d+$/.test(String(li.cghs_code).trim())) {
      const direct = lookupOldRateBySrNo(li.cghs_code);
      if (direct) oldMatch = { entry: direct, score: 100, match_type: 'sr_no' };
    }
    if (!oldMatch) {
      // Try by description — use line description first, then new list's description if available
      oldMatch = lookupOldRateByDescription(li.description)
              || (newDesc ? lookupOldRateByDescription(newDesc) : null);
    }
    const oldRate = oldMatch ? getOldApplicableRate(oldMatch.entry, accreditation) : null;
    const oldDesc = oldMatch?.entry?.description || null;

    // === Cross-lookup: if we got 2024 match but no 2025 match, try description-based 2025 lookup ===
    if (!newEntry && oldDesc) {
      // Search 2025 rate list by description match (same fuzzy logic)
      const lcDesc = normDesc(oldDesc);
      for (const k in RATES) {
        if (normDesc(RATES[k].description) === lcDesc) {
          newEntry = RATES[k];
          newRate = getApplicableRate(newEntry, tier, accreditation);
          newDesc = newEntry.description;
          new_match_via = 'description';
          break;
        }
      }
    }
    if (!newEntry && li.description) {
      // Last attempt: fuzzy match line description against 2025 list descriptions
      const lcDesc = normDesc(li.description);
      for (const k in RATES) {
        if (normDesc(RATES[k].description) === lcDesc) {
          newEntry = RATES[k];
          newRate = getApplicableRate(newEntry, tier, accreditation);
          newDesc = newEntry.description;
          new_match_via = 'description';
          break;
        }
      }
    }

    // === Determine admissible by both lists ===
    let admissible_new, admissible_old;
    let status_new, status_old;

    if (newRate == null) {
      admissible_new = claimed;
      status_new = newEntry ? 'no_rate_for_tier' : (li.cghs_code ? 'unlisted' : 'no_code');
      if (!newEntry && li.cghs_code) unlisted_count++;
    } else if (claimed > newRate) {
      admissible_new = newRate;
      status_new = 'restricted';
      any_overshoot_new = true;
    } else {
      admissible_new = claimed;
      status_new = 'within_rate';
    }

    if (oldRate == null) {
      admissible_old = claimed;
      status_old = 'unlisted';
    } else if (claimed > oldRate) {
      admissible_old = oldRate;
      status_old = 'restricted';
      any_overshoot_old = true;
    } else {
      admissible_old = claimed;
      status_old = 'within_rate';
    }

    total_admissible_new += admissible_new;
    total_admissible_old += admissible_old;

    // Which list is actually applicable for this claim?
    const final_admissible = applicable_list === '2024' ? admissible_old : admissible_new;
    const final_status = applicable_list === '2024' ? status_old : status_new;
    const final_source = applicable_list === '2024'
      ? (oldMatch ? `OM 2024 (Sr.No. ${oldMatch.entry.sr_no}, Page ${oldMatch.entry.page || '—'})` : 'OM 2024 — not found')
      : (newEntry ? `OM 03-10-2025 (Code ${Object.keys(RATES).find(k=>RATES[k]===newEntry) || li.cghs_code}, via ${new_match_via})` : 'OM 03-10-2025 — not in list');

    lines.push({
      description: li.description,
      cghs_code: li.cghs_code,
      matched_new_desc: newDesc,
      matched_old_desc: oldMatch?.entry?.description || null,
      matched_old_sr: oldMatch?.entry?.sr_no || null,
      matched_old_page: oldMatch?.entry?.page || null,
      old_match_score: oldMatch?.score || 0,
      old_match_type: oldMatch?.match_type || null,
      claimed,
      // 2025 rates
      rate_2025: newRate,
      admissible_2025: admissible_new,
      status_2025: status_new,
      // 2024 rates
      rate_2024: oldRate,
      admissible_2024: admissible_old,
      status_2024: status_old,
      // Final per applicable date
      admissible_final: final_admissible,
      status_final: final_status,
      rate_source_cited: final_source,
      tier,
      accreditation
    });
  }

  // Final totals based on applicable list
  const total_admissible = applicable_list === '2024' ? total_admissible_old : total_admissible_new;
  const any_overshoot = applicable_list === '2024' ? any_overshoot_old : any_overshoot_new;

  const result = lines.length === 0 ? 'PENDING'
               : (any_overshoot || unlisted_count > 0) ? 'CONDITIONAL'
               : 'PASS';

  return {
    id: 'CHK-3',
    name: 'CGHS Rate Card Compliance',
    result,
    finding: lines.length === 0
      ? 'No itemised bill data extracted. Upload hospital bills with line items to enable rate-card check.'
      : `${applicable_label} ${any_overshoot ? `${lines.filter(l => l.status_final === 'restricted').length} line(s) exceed applicable rate — admissible restricted.` : 'All lines within applicable rates.'} Claimed: ₹${total_claimed.toLocaleString('en-IN')}, Admissible (per applicable list): ₹${total_admissible.toLocaleString('en-IN')}.`,
    om_ref: applicable_list === '2024'
      ? 'CGHS Rate Card 2024 (pre-revision rate list) — applicable for treatment before 03-10-2025'
      : 'MoHFW OM No. 5-16/CGHS(HQ)/HEC/2024(Part I) dated 03-10-2025',
    om_page: applicable_list === '2024'
      ? 'Page reference per line item (see Source column in table)'
      : 'Annexure-I (Rate List) — applicable tier and accreditation column',
    om_excerpt: applicable_list === '2024'
      ? 'For treatments rendered before 03-10-2025, the pre-revision CGHS rate list (with Sr. No. and page-wise codification) applies. Each line item is matched against the Sr.No. and procedure name in the 2024 rate card.'
      : 'The revised CGHS rates are applicable with effect from the date of issue of this OM (03-10-2025) for treatment at empanelled Health Care Organisations. Reimbursement is restricted to the CGHS package rates as per tier of city and accreditation status of the HCO.',
    om_pdf: applicable_list === '2024' ? null : '/om/cghs-rates-2025.pdf',
    source_refs: [{ slot: 'hospital_bill', label: 'Itemised bill with treatment date' }, { slot: 'eclaim', label: 'Bill lines' }],
    data: {
      lines,
      total_claimed,
      total_admissible_new,
      total_admissible_old,
      total_admissible,
      tier,
      accreditation,
      applicable_list,
      applicable_label,
      treatment_date: treatmentDateStr,
      hospital_match_score: hospMatch?.score || 0
    }
  };
}

function check4_WardEntitlement(c) {
  // Only meaningful for IPD/Emergency hospitalisation
  const claim1 = check1_TypeOfClaim(c);
  const isHosp = claim1.data.claim_type.includes('IPD') || claim1.data.claim_type.includes('Emergency-IPD');
  if (!isHosp) {
    return {
      id: 'CHK-4',
      name: 'Ward Entitlement',
      result: 'PASS',
      finding: 'Not applicable — this is not an IPD / hospitalisation claim. Ward entitlement check skipped.',
      om_ref: 'MoHFW OM dated 07-11-2022 (Ward entitlement based on Pay Level)',
    om_page: 'Para 3 — Table of ward entitlement by Pay Level',
    om_pdf: null,
      om_excerpt: 'Ward entitlement under CGHS is determined by the basic pay drawn by the principal CGHS card holder: Pay Level 1–5 — General Ward; Pay Level 6–11 — Semi-Private Ward; Pay Level 12 and above — Private Ward.',
      source_refs: [],
      data: { applicable: false }
    };
  }

  const card = c.cghs_card;
  const eclaim = c.eclaim;
  const cardWard = card?.ward_entitlement || eclaim?.principal_ward_entitlement || eclaim?.patient_ward_entitlement;
  const payLevel = eclaim?.principal_pay_level;
  const derivedWard = entitledWardFromPayLevel(payLevel);
  const entitledWard = derivedWard || cardWard || 'Semi-Private';

  const wardClaimed = c.bills.find(b => b?.ward_category)?.ward_category;
  let result, finding;
  if (!wardClaimed) {
    result = 'PENDING';
    finding = `Could not extract ward category from any uploaded bill. Entitled ward: **${entitledWard}** (per pay level ${payLevel || 'n/a'}; per CGHS card: ${cardWard || 'n/a'}). Dealing Hand to verify manually.`;
  } else if (wardRank(wardClaimed) <= wardRank(entitledWard)) {
    result = 'PASS';
    finding = `Ward claimed (${wardClaimed}) is within entitlement (${entitledWard}, derived from Pay Level ${payLevel || 'n/a'}).`;
  } else {
    result = 'FAIL';
    finding = `Ward claimed (${wardClaimed}) **exceeds** entitled ward (${entitledWard}). Reimbursement to be restricted to ${entitledWard} ward rates per CGHS rules.`;
  }
  return {
    id: 'CHK-4',
    name: 'Ward Entitlement',
    result,
    finding,
    om_ref: 'MoHFW OM dated 07-11-2022 (Pay-Level-based ward entitlement)',
    om_page: 'Para 2 — Ward entitlement table by Pay Level',
    om_pdf: null,
    om_excerpt: 'Ward entitlement under CGHS: Pay Level 1–5 → General Ward; Pay Level 6–11 → Semi-Private Ward; Pay Level 12 & above → Private Ward. Where higher ward is availed, reimbursement is restricted to the entitled ward rate.',
    source_refs: [{ slot: 'cghs_card', label: 'Ward entitlement on CGHS card' }, { slot: 'eclaim', label: 'Pay level' }, { slot: 'hospital_bill', label: 'Ward actually occupied' }],
    data: { ward_claimed: wardClaimed, entitled_ward: entitledWard, pay_level: payLevel }
  };
}

function check5_HospitalEmpanelment(c) {
  const eclaim = c.eclaim;
  const hospName = eclaim?.hospital_name || c.bills.find(b => b?.hospital_name)?.hospital_name;
  const hospCity = c.bills.find(b => b?.city)?.city || '';

  if (!hospName) {
    return {
      id: 'CHK-5',
      name: 'Hospital Empanelment',
      result: 'PENDING',
      finding: 'Hospital name not extracted from any document. Dealing Hand to verify empanelment manually.',
      om_ref: 'CGHS empanelled HCO list (Delhi/HQ/Directorate/Ministry — current)',
      om_excerpt: 'Reimbursement is permissible only at CGHS empanelled hospitals/diagnostic centres unless treated under emergency or with valid ex-post-facto approval.',
      source_refs: [],
      data: {}
    };
  }

  // POC scope: Delhi/Chandigarh list only
  const inScope = !hospCity || /delhi|gurugram|gurgaon|noida|faridabad|ghaziabad|chandigarh|delhi cantt/i.test(hospCity);

  const match = lookupHospital(hospName, hospCity);
  if (match) {
    return {
      id: 'CHK-5',
      name: 'Hospital Empanelment',
      result: 'PASS',
      finding: `Hospital **${hospName}** matched against CGHS empanelment list (${match.score}% match → "${match.hospital.name}", ${match.hospital.accreditation || 'no accreditation listed'}, ${match.hospital.tier}, ${match.hospital.address}).`,
      om_ref: 'CGHS Empanelled Hospitals — Delhi/HQ/Directorate/Ministry list',
      om_page: 'Empanelment list (current) — verified against database',
      om_pdf: null,
      om_excerpt: 'The hospital is found on the CGHS empanelled list applicable to Delhi/HQ/Directorate/Ministry beneficiaries.',
      source_refs: [{ slot: 'eclaim', label: 'Hospital name in e-Claim' }, { slot: 'hospital_bill', label: 'Hospital letterhead' }],
      data: { hospital_name: hospName, matched: match.hospital, match_score: match.score }
    };
  }

  if (!inScope) {
    return {
      id: 'CHK-5',
      name: 'Hospital Empanelment',
      result: 'PENDING',
      finding: `Hospital **${hospName}** is in **${hospCity}** which is outside the POC scope (Delhi/Chandigarh only). Dealing Hand to verify empanelment manually using the state-specific CGHS list.`,
      om_ref: 'CGHS Empanelled Hospitals (state-wise lists)',
      om_excerpt: 'Empanelment lists for cities outside Delhi/Chandigarh are maintained by respective CGHS regional offices. POC has only Delhi/HQ list loaded.',
      source_refs: [{ slot: 'eclaim', label: 'Hospital location' }],
      data: { hospital_name: hospName, city: hospCity, out_of_scope: true }
    };
  }

  return {
    id: 'CHK-5',
    name: 'Hospital Empanelment',
    result: 'FAIL',
    finding: `Hospital **${hospName}** could **not** be matched against the CGHS empanelled list. Reimbursement at non-empanelled hospitals requires (a) emergency justification, or (b) ex-post-facto approval of the competent authority.`,
    om_ref: 'OM No. 1967/2013/DEL/CGHS/SZ/D52/CGHS(P) dated 30-12-2015',
    om_excerpt: 'In case of serving beneficiaries, prior permission must be obtained for elective treatment/investigations taken at non-empanelled hospitals/diagnostic centres. Ex-post-facto approval from the Competent Authority is required where prior permission could not be obtained due to genuine emergency.',
    source_refs: [{ slot: 'eclaim', label: 'Hospital name & address' }],
    data: { hospital_name: hospName, city: hospCity, matched: false }
  };
}

function check6_ListedProcedure(c) {
  // Cross-check each procedure against BOTH the 2024 and 2025 rate lists
  const lines = [];
  let unlistedCount = 0;
  for (const b of c.bills) {
    if (b && Array.isArray(b.line_items)) {
      for (const li of b.line_items) {
        // Try 2025 list by code
        let in2025 = !!lookupCghsCode(li.cghs_code);
        // Try 2024 list by Sr No (numeric code)
        let in2024 = false;
        let oldSr = null;
        if (li.cghs_code && /^\d+$/.test(String(li.cghs_code).trim())) {
          const direct = lookupOldRateBySrNo(li.cghs_code);
          if (direct) { in2024 = true; oldSr = direct.sr_no; }
        }
        // Try by description in old list
        if (!in2024 && li.description) {
          const m = lookupOldRateByDescription(li.description);
          if (m) { in2024 = true; oldSr = m.entry.sr_no; }
        }
        // Try by description in new list
        if (!in2025 && li.description) {
          const lcDesc = normDesc(li.description);
          for (const k in RATES) {
            if (normDesc(RATES[k].description) === lcDesc) { in2025 = true; break; }
          }
        }
        const listed = in2024 || in2025;
        if (!listed && li.cghs_code) unlistedCount++;
        if (!listed && !li.cghs_code) {
          // No code AND not in either list — still flag
          unlistedCount++;
        }
        lines.push({
          description: li.description,
          cghs_code: li.cghs_code,
          listed,
          in_2024: in2024,
          in_2025: in2025,
          matched_sr_no: oldSr
        });
      }
    }
  }
  if (lines.length === 0) {
    return {
      id: 'CHK-6',
      name: 'Listed Procedure Check',
      result: 'PENDING',
      finding: 'No itemised line data extracted from bills. Manual review required to confirm all procedures are on the CGHS approved list.',
      om_ref: 'MoHFW OM dated 03-10-2025 (CGHS Rate List)',
      om_page: 'Annexure-I (Rate List)',
      om_pdf: '/om/cghs-rates-2025.pdf',
      om_excerpt: 'Procedures not listed in the CGHS approved rate card require either (a) restriction to the nearest analogous procedure, or (b) ex-post-facto approval of the competent authority.',
      source_refs: [{ slot: 'hospital_bill' }],
      data: { lines }
    };
  }

  const allListed = lines.every(l => l.listed);
  const result = allListed ? 'PASS' : 'CONDITIONAL';
  const findingMsg = allListed
    ? `All ${lines.length} procedure(s) found in CGHS approved list (matched against ${lines.filter(l=>l.in_2024).length} in 2024 list, ${lines.filter(l=>l.in_2025).length} in 2025 list).`
    : `${unlistedCount} of ${lines.length} procedure(s) not found in either the 2024 or 2025 CGHS rate list. Triggers CHK-7 ex-post-facto check.`;

  return {
    id: 'CHK-6',
    name: 'Listed Procedure Check',
    result,
    finding: findingMsg,
    om_ref: 'CGHS Approved Procedure List — 2024 (pre-revision) & 2025 (OM 03-10-2025)',
    om_page: 'Cross-referenced against both rate lists',
    om_pdf: '/om/cghs-rates-2025.pdf',
    om_excerpt: 'A procedure is considered "listed" if it appears in either the 2024 pre-revision CGHS rate list (by Sr.No. or procedure name) or the 2025 revised rate list (by CGHS code or procedure name). Procedures not found in either list require ex-post-facto approval of the competent authority.',
    source_refs: [{ slot: 'hospital_bill', label: 'Itemised line items' }],
    data: { lines, unlisted_count: unlistedCount }
  };
}

function check7_ExPostFacto(c) {
  const c6 = check6_ListedProcedure(c);
  const c5 = check5_HospitalEmpanelment(c);
  const needsApproval = c6.result === 'CONDITIONAL' || c5.result === 'FAIL';

  if (!needsApproval) {
    return {
      id: 'CHK-7',
      name: 'Ex-Post-Facto Approval',
      result: 'PASS',
      finding: 'Not required — all procedures are listed and the hospital is empanelled (or treated as emergency).',
      om_ref: 'OM No. 1967/2013/DEL/CGHS/SZ/D52/CGHS(P) dated 30-12-2015',
      om_excerpt: 'Ex-post-facto approval is required only where (a) the hospital is non-empanelled, or (b) procedures undertaken are outside the CGHS approved list.',
      source_refs: [],
      data: { required: false }
    };
  }

  return {
    id: 'CHK-7',
    name: 'Ex-Post-Facto Approval',
    result: 'CONDITIONAL',
    finding: `Ex-post-facto approval **required** because: ${c5.result === 'FAIL' ? 'hospital is not empanelled; ' : ''}${c6.result === 'CONDITIONAL' ? 'unlisted procedure(s) found.' : ''} The dealing hand must verify that the approval order from the competent authority is on file before generating the noting.`,
    om_ref: 'OM No. 1967/2013/DEL/CGHS/SZ/D52/CGHS(P) dated 30-12-2015',
    om_excerpt: 'Where prior permission could not be obtained for treatment at a non-empanelled hospital or for unlisted procedures due to genuine emergency or exigency, the beneficiary may seek ex-post-facto approval of the competent authority. The reimbursement is admissible only after such approval is granted.',
    source_refs: [{ slot: 'eclaim', label: 'Emergency declaration' }],
    data: { required: true, hospital_non_empanelled: c5.result === 'FAIL', unlisted_procedures: c6.result === 'CONDITIONAL' }
  };
}

function check8_ReferralProcedureCount(c) {
  const ref = c.referral;
  if (!ref) {
    return {
      id: 'CHK-8',
      name: 'Referral Procedure Match',
      result: 'PENDING',
      finding: 'No referral document uploaded — cannot cross-check claimed procedures against authorisation. (Self-referral / OPD-without-referral cases may be valid; verify per case.)',
      om_ref: 'CGHS Referral System guidelines',
      om_excerpt: 'Treatment at empanelled hospitals (other than emergency) requires a valid referral from the CGHS Wellness Centre / authorised CMO listing the procedures or investigations to be undertaken.',
      source_refs: [],
      data: {}
    };
  }
  const referredNames = (ref.procedures_referred || []).map(p => String(p.name || '').toLowerCase());
  const claimedNames = [];
  for (const b of c.bills) {
    if (b && Array.isArray(b.line_items)) {
      for (const li of b.line_items) claimedNames.push(String(li.description || '').toLowerCase());
    }
  }
  if (c.eclaim?.bill_lines) {
    for (const li of c.eclaim.bill_lines) claimedNames.push(String(li.treatment_type || '').toLowerCase());
  }

  // Common lab tests / investigations that are implicitly authorized when investigations are referred
  // These do not need to be individually listed in the referral
  const COMMON_LAB_INVESTIGATIONS = [
    /\b(cbc|cbp|complete\s*(blood\s*count|haemogram|hemogram))\b/i,
    /\b(esr|erythrocyte)\b/i,
    /\b(blood\s*group|rh\s*type|cross\s*match)\b/i,
    /\b(hb|hemoglobin|haemoglobin)\b/i,
    /\b(rbs|fbs|fasting\s*blood\s*sugar|random\s*blood\s*sugar)\b/i,
    /\b(urea|creatinine|electrolytes|kft|lft|rft)\b/i,
    /\b(urine\s*(routine|examination|r\/?e|culture))\b/i,
    /\b(sgot|sgpt|alt|ast|bilirubin|alkaline\s*phosphatase)\b/i,
    /\b(lipid\s*profile|cholesterol|triglycerides|hdl|ldl)\b/i,
    /\b(thyroid|tsh|t3|t4)\b/i,
    /\b(hba1c|glycated\s*hemoglobin)\b/i,
    /\b(ecg|electrocardiogram)\b/i,
    /\b(x[-\s]?ray|chest\s*pa|xray)\b/i,
    /\b(usg|ultrasound|sonography)\b/i,
    /\b(culture|sensitivity|c\s*&\s*s)\b/i,
    /\b(coagulation|pt|aptt|inr|bleeding\s*time|clotting\s*time)\b/i,
    /\b(consultation|opd\s*visit|follow\s*up)\b/i,
  ];

  function isCommonInvestigation(s) {
    return COMMON_LAB_INVESTIGATIONS.some(re => re.test(s));
  }

  // Check if referral itself authorizes "tests and investigations" broadly
  const referralHasBroadAuth = referredNames.some(rn =>
    /investigation|test|workup|labs?|laborator|diagnostic|profile/i.test(rn)
  );

  // Find claimed items not in referral (token overlap)
  function overlap(a, b) {
    const ta = a.split(/\W+/).filter(w => w.length > 3);
    const tb = b.split(/\W+/).filter(w => w.length > 3);
    if (ta.length === 0 || tb.length === 0) return 0;
    const set = new Set(ta);
    return tb.filter(w => set.has(w)).length / Math.max(tb.length, 1);
  }

  const extras = [];
  const impliedAuthorized = [];
  for (const cn of claimedNames) {
    if (!cn.trim()) continue;
    // Direct match in referral
    const matched = referredNames.some(rn => overlap(cn, rn) >= 0.4 || cn.includes(rn) || rn.includes(cn));
    if (matched) continue;
    // Common lab/investigation — implicitly authorized
    if (isCommonInvestigation(cn)) {
      impliedAuthorized.push(cn);
      continue;
    }
    // Referral has broad "investigations" authorization
    if (referralHasBroadAuth && /\b(test|investigation|profile|panel|assay|examination)\b/i.test(cn)) {
      impliedAuthorized.push(cn);
      continue;
    }
    extras.push(cn);
  }

  if (extras.length === 0) {
    let findingText = `All ${claimedNames.length} claimed procedure(s) accounted for: ${claimedNames.length - impliedAuthorized.length} matched directly against the referral`;
    if (impliedAuthorized.length > 0) {
      findingText += `, and ${impliedAuthorized.length} routine investigation(s) treated as implicitly authorized (e.g., ${impliedAuthorized.slice(0, 3).join(', ')}).`;
    } else {
      findingText += '.';
    }
    return {
      id: 'CHK-8',
      name: 'Referral Procedure Match',
      result: 'PASS',
      finding: findingText,
      om_ref: 'CGHS Referral System Guidelines',
      om_page: 'Standard referral practice',
      om_pdf: null,
      om_excerpt: 'Procedures undertaken at an empanelled hospital should match those authorised in the CGHS referral. Routine laboratory investigations (CBC, ESR, urine R/E, blood group, etc.), basic radiology (X-ray, ECG, USG) and standard pre-procedure work-up are treated as implicitly authorised when investigations or a procedure requiring such workup is referred. Substantive procedures beyond the referral require separate authorisation or justification.',
      source_refs: [{ slot: 'referral', label: 'Procedures authorised' }, { slot: 'hospital_bill', label: 'Procedures actually billed' }],
      data: { referred: referredNames, matched_directly: claimedNames.length - impliedAuthorized.length, implied_authorized: impliedAuthorized, extras: [] }
    };
  }
  return {
    id: 'CHK-8',
    name: 'Referral Procedure Match',
    result: 'CONDITIONAL',
    finding: `${extras.length} claimed procedure(s) not matched in referral and not recognised as routine investigations. Items: ${extras.slice(0, 5).join('; ')}${extras.length > 5 ? '…' : ''}. ${impliedAuthorized.length} item(s) treated as routine and implicitly authorized. Dealing Hand to confirm flagged items are (a) included implicitly, (b) separately authorised, or (c) to be excluded.`,
    om_ref: 'CGHS Referral System Guidelines',
    om_page: 'Standard referral practice',
    om_pdf: null,
    om_excerpt: 'Procedures undertaken beyond the scope of the issued referral require either separate authorisation from the CGHS Wellness Centre or justified inclusion by the dealing hand with documented reasons. Routine laboratory/radiology investigations are treated as implicitly authorised; substantive procedures (surgical, interventional, specialised imaging) are not.',
    source_refs: [{ slot: 'referral', label: 'Procedures authorised' }, { slot: 'hospital_bill', label: 'Procedures actually billed' }],
    data: { referred: referredNames, extras, implied_authorized: impliedAuthorized }
  };
}

app.post('/api/checks', requireAuth, (req, res) => {
  const claimId = req.session.current_claim_id;
  const claim = claimStore.get(claimId);
  if (!claim) return res.status(404).json({ error: 'No active claim. Re-run extraction.' });

  // Allow client to send corrected fields
  if (req.body && req.body.extracted) {
    claim.extracted = req.body.extracted;
  }

  const c = consolidateExtraction(claim.extracted);
  const checks = [
    check1_TypeOfClaim(c),
    check2_BillReconciliation(c),
    check3_RateCompliance(c),
    check4_WardEntitlement(c),
    check5_HospitalEmpanelment(c),
    check6_ListedProcedure(c),
    check7_ExPostFacto(c),
    check8_ReferralProcedureCount(c)
  ];
  claim.checks = checks;
  claim.consolidated = c;
  claimStore.set(claimId, claim);
  res.json({ checks, consolidated: c });
});

// ---------- Noting generation ----------
function num2words(num) {
  // Simple Indian numbering for the noting
  const a = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const b = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function inWords(n) {
    if (n < 20) return a[n];
    if (n < 100) return b[Math.floor(n/10)] + (n%10 ? ' ' + a[n%10] : '');
    if (n < 1000) return a[Math.floor(n/100)] + ' Hundred' + (n%100 ? ' and ' + inWords(n%100) : '');
    if (n < 100000) return inWords(Math.floor(n/1000)) + ' Thousand' + (n%1000 ? ' ' + inWords(n%1000) : '');
    if (n < 10000000) return inWords(Math.floor(n/100000)) + ' Lakh' + (n%100000 ? ' ' + inWords(n%100000) : '');
    return inWords(Math.floor(n/10000000)) + ' Crore' + (n%10000000 ? ' ' + inWords(n%10000000) : '');
  }
  const intPart = Math.floor(num);
  const dec = Math.round((num - intPart) * 100);
  let out = inWords(intPart) || 'Zero';
  if (dec > 0) out += ' and ' + inWords(dec) + ' Paise';
  return out + ' only';
}

app.post('/api/noting', requireAuth, (req, res) => {
  const claimId = req.session.current_claim_id;
  const claim = claimStore.get(claimId);
  if (!claim || !claim.checks) return res.status(404).json({ error: 'Run checks first.' });
  const overrides = req.body?.overrides || {};

  const c = claim.consolidated;
  const e = c.eclaim || {};
  const checks = claim.checks;
  const c1 = checks[0].data;
  const c3 = checks[2].data;
  const c5 = checks[4];
  const c7 = checks[6];

  // Aggregate amounts — use the list applicable to the treatment date
  const claimedTotal = c3.total_claimed || Number(e.total_amount_claimed || 0);
  const admissibleTotal = c3.total_admissible || claimedTotal;
  const applicableList = c3.applicable_list || '2025';

  const isEmergency = c1.is_emergency;
  const isHospital = c1.claim_type.includes('IPD');
  const needsExPostFacto = c7.result === 'CONDITIONAL';

  const today = new Date();
  const todayStr = today.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // Build itemised table — use admissible_final (which respects applicable_list)
  const tableRows = [];
  let sno = 1;
  for (const li of c3.lines || []) {
    tableRows.push({
      sno: sno++,
      description: li.description || '—',
      claimed: li.claimed || 0,
      admissible: li.admissible_final != null ? li.admissible_final : (li.admissible || 0),
      cghs_code: li.cghs_code || '—',
      rate_source: li.rate_source_cited || ''
    });
  }

  // Subject line
  const subject = `Medical Reimbursement claim in respect of ${e.employee_name || 'Shri/Smt _______'}, ${e.designation || '________'}.`;

  // Build noting paragraphs
  const para1 = `${e.employee_name || '______'}, ${e.designation || '______'}, a CGHS beneficiary of this Department, has submitted a medical reimbursement claim of **₹${claimedTotal.toLocaleString('en-IN')}/-** for treatment of ${c.cghs_card?.relation === 'Self' ? 'self' : (c.cghs_card?.relation || c.eclaim?.patient_relation || 'dependent') + ' (' + (e.patient_name || c.cghs_card?.name || '___') + ')'} at **${e.hospital_name || '______'}**, which is ${c5.data?.matched ? 'a CGHS empanelled hospital' : 'a non-empanelled hospital'}.`;

  const para2 = isEmergency
    ? `2. The treatment was undertaken in **emergency** ${c1.prior_permission ? 'with prior permission' : 'without prior permission'}. ${needsExPostFacto ? 'Ex-post-facto approval of the competent authority is being sought herewith.' : ''}`
    : `2. CMO/CGHS has referred the beneficiary for the said treatment/investigations at the empanelled hospital.`;

  const para3 = `3. The details of the claim are as under:`;

  const para4 = applicableList === '2024'
    ? `4. The treatment dates indicate the claim relates to a period **prior to 03-10-2025**. Accordingly, the **pre-revision CGHS rate list (2024)** has been applied for determining the admissible amount, with each line item matched against the Sr. No. and procedure name in the 2024 rate card. ${c3.total_claimed > admissibleTotal ? 'Where claimed amounts exceeded the prescribed rates, admissible amounts have been restricted to CGHS rates accordingly.' : 'All claimed amounts are within the prescribed CGHS rates of the applicable list.'}`
    : `4. The treatment dates fall **on or after 03-10-2025**. Accordingly, the revised CGHS rates notified vide **MoHFW OM No. 5-16/CGHS(HQ)/HEC/2024(Part I) dated 03-10-2025** have been applied (${c3.accreditation || 'NABH'}, ${(c3.tier || 'Tier_I').replace('_', ' ')}) for determining the admissible amount. ${c3.total_claimed > admissibleTotal ? 'Where claimed amounts exceeded the prescribed package rates, admissible amounts have been restricted to CGHS rates accordingly.' : 'All claimed amounts are within the prescribed CGHS rates.'}`;

  const para5_ifd = c1.total > 1000000
    ? `5. The claim amount exceeds ₹10.00 lakh. As per **MoHFW OM No. S.11030/4/2026-EHS dated 16-02-2026**, IFD concurrence is required and is being obtained.`
    : c1.total > 500000
      ? `5. The claim amount is ₹${c1.total.toLocaleString('en-IN')}/-, which is within the enhanced delegation of **₹10.00 lakh** to the Head of Department vide **MoHFW OM No. S.11030/4/2026-EHS dated 16-02-2026**, without consultation of IFD.`
      : `5. The claim amount of ₹${c1.total.toLocaleString('en-IN')}/- is within the normal delegation of HoD; no IFD consultation is required.`;

  const para6 = needsExPostFacto
    ? `6. In view of the above, **ex-post-facto approval** of the competent authority is solicited for the medical claim, and **US (Admn.)** may kindly accord financial sanction of **₹${admissibleTotal.toLocaleString('en-IN')}/- (Rupees ${num2words(admissibleTotal)})** to ${e.employee_name || '______'}, ${e.designation || '______'}, towards reimbursement of medical expenses.`
    : `6. In view of the above, **US (Admn.)** may kindly accord financial sanction of **₹${admissibleTotal.toLocaleString('en-IN')}/- (Rupees ${num2words(admissibleTotal)})** to ${e.employee_name || '______'}, ${e.designation || '______'}, towards reimbursement of medical expenses.`;

  const para7 = `7. A draft sanction order is accordingly placed below for signature of US (Admn.), please.`;

  // Sanction order
  const sanctionOrder = `No. _______________
Government of India
Ministry of Finance
Department of Expenditure
*****
                                                                Kartavya Bhavan 1, New Delhi
                                                                Dated: ${todayStr}

To,
The Pay & Accounts Officer,
Department of Expenditure,
Kartavya Bhavan 1, New Delhi-110001.

Subject: ${subject}

Sir,

       I am directed to convey the ${needsExPostFacto ? 'ex-post-facto approval' : 'sanction'} of the President to the payment of **₹${admissibleTotal.toLocaleString('en-IN')}/- (Rupees ${num2words(admissibleTotal)})** to be made to ${e.employee_name || '______'}, ${e.designation || '______'}, in Department of Expenditure, Ministry of Finance, towards reimbursement of expenses incurred in respect of ${c.cghs_card?.relation || e.patient_relation || 'self/dependent'} ${e.patient_name ? '(' + e.patient_name + ')' : ''} at ${e.hospital_name || '______'} which is ${c5.data?.matched ? 'a CGHS empanelled hospital' : 'a non-empanelled hospital'}.

2.    The above-mentioned amount of medical reimbursement claim is in accordance with the M/o Health & Family Welfare's O.M. No. Z15025/19/2024/DIR/CGHS/EHS dated 28-06-2024 and 05-08-2024, and the prescribed rates vide their O.M. No. 5-16/CGHS(HQ)/HEC/2024(Part I) dated 03-10-2025 / CS (MA) Rules, 1944, as amended from time to time.

3.    The DDO, Department of Expenditure, is authorized to draw the amount and disburse the same through e-transfer/cheque in favour of ${e.employee_name || '______'} (as per the bank details indicated in the medical claim) of this department.

4.    The expenditure is debitable under Major Head 2052 — A. Sectt. General Services, A-10.01.06 — Medical Treatment in Demand No. 31, D/o Expenditure, M/o Finance for the year ${today.getFullYear()}-${(today.getFullYear()+1).toString().slice(2)}.

                                                                Yours faithfully,


                                                                ( ___________ )
                                                                Under Secretary to the Government of India

Copy to:
1. A & B Branch (Along with original claim papers)
2. ${e.employee_name || '______'}, ${e.designation || '______'}
3. Guard file-${today.getFullYear()}.`;

  const noting = {
    file_no: '_______________',
    department: 'Department of Expenditure',
    section: 'Admn. I',
    subject,
    paragraphs: [para1, para2, para3, para4, para5_ifd, para6, para7],
    table: tableRows,
    grand_total_claimed: claimedTotal,
    grand_total_admissible: admissibleTotal,
    grand_total_admissible_in_words: num2words(admissibleTotal),
    sanction_order: sanctionOrder,
    overrides_applied: Object.keys(overrides).length,
    generated_at: new Date().toISOString(),
    generated_by: req.session.user
  };

  claim.noting = noting;
  claimStore.set(claimId, claim);
  res.json({ noting });
});

// ---------- PDF download for the table ----------
app.post('/api/noting/pdf-table', requireAuth, (req, res) => {
  const PDFDocument = require('pdfkit');
  const claimId = req.session.current_claim_id;
  const claim = claimStore.get(claimId);
  if (!claim || !claim.noting) return res.status(404).send('No noting');
  const n = claim.noting;
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="cghs_claim_table.pdf"');
  doc.pipe(res);

  doc.fontSize(14).font('Helvetica-Bold').text('CGHS Medical Reimbursement — Itemised Claim', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica').text(`Subject: ${n.subject}`, { align: 'left' });
  doc.text(`Generated: ${new Date(n.generated_at).toLocaleString('en-IN')}`, { align: 'left' });
  doc.moveDown(0.5);

  // Table
  const startX = 40;
  let y = doc.y + 5;
  const colW = [35, 250, 110, 110];
  const head = ['S.No.', 'Description', 'Amount Claimed (₹)', 'Amount Admissible (₹)'];
  doc.font('Helvetica-Bold').fontSize(9);
  let x = startX;
  for (let i = 0; i < head.length; i++) {
    doc.rect(x, y, colW[i], 22).fillAndStroke('#003366', '#003366');
    doc.fillColor('white').text(head[i], x + 4, y + 6, { width: colW[i] - 8 });
    x += colW[i];
  }
  y += 22;
  doc.font('Helvetica').fontSize(9);
  for (const r of n.table) {
    x = startX;
    const cells = [String(r.sno), r.description, String(r.claimed.toLocaleString('en-IN')), String(r.admissible.toLocaleString('en-IN'))];
    const heights = cells.map((t, i) => doc.heightOfString(t, { width: colW[i] - 8 }));
    const rowH = Math.max(...heights) + 8;
    if (y + rowH > 800) { doc.addPage(); y = 40; }
    for (let i = 0; i < cells.length; i++) {
      doc.rect(x, y, colW[i], rowH).fillAndStroke('white', '#999');
      doc.fillColor('black').text(cells[i], x + 4, y + 4, { width: colW[i] - 8 });
      x += colW[i];
    }
    y += rowH;
  }
  // Totals
  x = startX;
  doc.font('Helvetica-Bold');
  const totalCells = ['', 'Grand Total', String(n.grand_total_claimed.toLocaleString('en-IN')), String(n.grand_total_admissible.toLocaleString('en-IN'))];
  for (let i = 0; i < totalCells.length; i++) {
    doc.rect(x, y, colW[i], 22).fillAndStroke('#e6f0ff', '#003366');
    doc.fillColor('black').text(totalCells[i], x + 4, y + 6, { width: colW[i] - 8 });
    x += colW[i];
  }
  y += 28;
  doc.font('Helvetica').fontSize(9).text(`In words: Rupees ${n.grand_total_admissible_in_words}`, startX, y);
  doc.end();
});

// Get current claim (extracted + checks + noting if present)
app.get('/api/claim', requireAuth, (req, res) => {
  const claimId = req.session.current_claim_id;
  const claim = claimStore.get(claimId);
  if (!claim) return res.status(404).json({ error: 'No active claim' });
  res.json({
    id: claim.id,
    extracted: claim.extracted,
    checks: claim.checks || null,
    consolidated: claim.consolidated || null,
    noting: claim.noting || null
  });
});

// ---------- Page routes ----------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/upload', (req, res) => res.sendFile(path.join(__dirname, 'public', 'upload.html')));
app.get('/checks', (req, res) => res.sendFile(path.join(__dirname, 'public', 'checks.html')));
app.get('/noting', (req, res) => res.sendFile(path.join(__dirname, 'public', 'noting.html')));

// Health
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  ocr_enabled: !!process.env.ANTHROPIC_API_KEY,
  rates_loaded: Object.keys(RATES).length,
  hospitals_loaded: HOSPITALS.length
}));

app.listen(PORT, () => {
  console.log(`CGHS Medical Bill Automation running on http://localhost:${PORT}`);
  console.log(`OCR (Claude Vision): ${process.env.ANTHROPIC_API_KEY ? 'ENABLED' : 'DISABLED — set ANTHROPIC_API_KEY'}`);
  console.log(`Rates loaded: ${Object.keys(RATES).length}, Hospitals loaded: ${HOSPITALS.length}`);
});
