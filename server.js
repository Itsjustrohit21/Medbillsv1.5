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
const HOSPITALS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'empanelled_hospitals.json'), 'utf8'));

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
app.use(session({
  secret: process.env.SESSION_SECRET || 'cghs-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, secure: false, httpOnly: true, sameSite: 'lax' }
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
  const e = c.eclaim;
  let claim_type = 'OPD';
  let is_emergency = false;
  let prior_permission = false;
  let total = 0;
  if (e) {
    is_emergency = String(e.is_emergency || '').toLowerCase().startsWith('y');
    prior_permission = String(e.prior_permission_taken || '').toLowerCase().startsWith('y');
    total = Number(e.total_amount_claimed || 0);
    const tt = String(e.treatment_type || '').toLowerCase();
    if (tt.includes('indoor')) claim_type = 'IPD';
    else if (tt.includes('mixed')) claim_type = 'Mixed';
    else if (tt.includes('investig')) claim_type = 'Investigations';
    else claim_type = 'OPD';
  }
  // Check bills for IPD signals if e-claim is silent
  const ipdSignals = c.bills.some(b => b && (b.is_ipd === true || b.admission_date || b.ward_category));
  if (ipdSignals && claim_type === 'OPD') claim_type = 'IPD';
  if (is_emergency) claim_type = (claim_type === 'IPD' ? 'Emergency-IPD' : 'Emergency-OPD');
  if (is_emergency && !prior_permission) claim_type += ' (without prior permission)';
  else if (is_emergency && prior_permission) claim_type += ' (with prior permission)';

  // Delegation: amount > 5L (older limit) but the OM dated 16-02-2026 raises to 10L.
  // We flag whether IFD consultation is required.
  const requiresIFD = total > 1000000;
  const note = total > 500000
    ? (requiresIFD ? `Amount > ₹10L — IFD concurrence required.` : `Amount > ₹5L but ≤ ₹10L — covered under enhanced delegation per OM dated 16-02-2026; HoD may settle without IFD.`)
    : `Amount within normal HoD delegation.`;

  return {
    id: 'CHK-1',
    name: 'Type of Claim',
    result: 'PASS',
    finding: `Claim classified as **${claim_type}**. Total claimed: ₹${total.toLocaleString('en-IN')}. ${note}`,
    om_ref: 'MoHFW OM No. S.11030/4/2026-EHS dated 16-02-2026 (Delegation enhancement to ₹10 lakh)',
    om_excerpt: '"It has been decided to enhance the present ceiling limit from ₹5.00 lakh to ₹10.00 lakh for settling medical reimbursement cases by the Heads of Departments of Ministries/Departments without consultation of IFD, provided that: (i) No relaxation of CGHS/CS(MA) Rules is involved, and (ii) The entitlement is worked out strictly with reference to the prescribed CGHS/CS(MA) rate lists."',
    source_refs: [{ slot: 'eclaim', label: 'Treatment type, emergency flag, total amount' }],
    data: { claim_type, is_emergency, prior_permission, total, requires_IFD: requiresIFD }
  };
}

function check2_BillReconciliation(c) {
  const eclaim_total = Number(c.eclaim?.total_amount_claimed || 0);
  const bills_sum = c.bills.reduce((s, b) => s + Number(b?.total_amount || 0), 0);
  const diff = Math.round((eclaim_total - bills_sum) * 100) / 100;
  const tolerance = 10;
  const passed = Math.abs(diff) <= tolerance;
  return {
    id: 'CHK-2',
    name: 'Bill Amount Reconciliation',
    result: passed ? 'PASS' : 'FAIL',
    finding: passed
      ? `e-Claim total (₹${eclaim_total.toLocaleString('en-IN')}) matches sum of uploaded bill amounts (₹${bills_sum.toLocaleString('en-IN')}) within ±₹${tolerance} tolerance.`
      : `Discrepancy of ₹${Math.abs(diff).toLocaleString('en-IN')} between e-Claim total (₹${eclaim_total.toLocaleString('en-IN')}) and bills sum (₹${bills_sum.toLocaleString('en-IN')}). ${diff > 0 ? 'Bills under-reported.' : 'Bills over-reported.'}`,
    om_ref: 'CGHS internal reconciliation; not derived from a specific OM.',
    om_excerpt: 'Total claimed in the e-Claim form must be supported by individual cash memos / bill amounts within reasonable rounding tolerance.',
    source_refs: [{ slot: 'eclaim', label: 'Total claimed' }, { slot: 'hospital_bill', label: 'Individual bill amounts' }],
    data: { eclaim_total, bills_sum, difference: diff }
  };
}

function check3_RateCompliance(c) {
  // For each bill line, look up CGHS rate; flag overshoot
  const tier = 'Tier_I'; // default; in production we'd derive from hospital city
  const lines = [];
  let total_claimed = 0;
  let total_admissible = 0;
  let any_overshoot = false;

  // Use bill line items if present, else fall back to e-claim bill_lines
  const sources = [];
  for (const b of c.bills) {
    if (b && Array.isArray(b.line_items)) {
      for (const li of b.line_items) {
        sources.push({
          description: li.description,
          cghs_code: li.cghs_code,
          amount: Number(li.amount || 0),
          source: 'bill'
        });
      }
    }
  }
  if (sources.length === 0 && c.eclaim?.bill_lines) {
    for (const li of c.eclaim.bill_lines) {
      sources.push({
        description: li.treatment_type || 'Item',
        cghs_code: li.cghs_sr_no,
        amount: Number(li.amount || 0),
        source: 'eclaim'
      });
    }
  }

  for (const li of sources) {
    const rateEntry = lookupCghsCode(li.cghs_code);
    const cghsRate = rateEntry ? getApplicableRate(rateEntry, tier, 'NABH') : null;
    const claimed = li.amount;
    let admissible, status;
    if (cghsRate == null) {
      admissible = claimed; // unknown — pass through, flagged in CHK-6/7
      status = 'unknown_code';
    } else if (claimed > cghsRate) {
      admissible = cghsRate;
      status = 'restricted';
      any_overshoot = true;
    } else {
      admissible = claimed;
      status = 'within_rate';
    }
    total_claimed += claimed;
    total_admissible += admissible;
    lines.push({
      description: li.description,
      cghs_code: li.cghs_code,
      cghs_rate: cghsRate,
      claimed,
      admissible,
      status
    });
  }

  return {
    id: 'CHK-3',
    name: 'CGHS Rate Card Compliance',
    result: any_overshoot ? 'CONDITIONAL' : 'PASS',
    finding: any_overshoot
      ? `${lines.filter(l => l.status === 'restricted').length} line(s) exceed the applicable CGHS package rate. Admissible amount restricted accordingly. Total claimed: ₹${total_claimed.toLocaleString('en-IN')}, Total admissible: ₹${total_admissible.toLocaleString('en-IN')}.`
      : `All ${lines.length} claimed line items are within applicable CGHS package rates. Admissible: ₹${total_admissible.toLocaleString('en-IN')}.`,
    om_ref: 'MoHFW OM No. 5-16/CGHS(HQ)/HEC/2024(Part I) dated 03-10-2025',
    om_excerpt: 'CGHS rates revised vide OM dated 3rd October 2025 are applicable for treatment at empanelled HCOs. Reimbursement to beneficiaries shall be restricted to the prescribed CGHS package rates as per tier (I/II/III) and accreditation status (NABH / Non-NABH / Super-Specialty).',
    source_refs: [{ slot: 'hospital_bill', label: 'Itemised bill' }, { slot: 'eclaim', label: 'Bill lines' }],
    data: { lines, total_claimed, total_admissible }
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
  // Cross-check each procedure against the rate card
  const tier = 'Tier_I';
  const lines = [];
  let unlistedCount = 0;
  for (const b of c.bills) {
    if (b && Array.isArray(b.line_items)) {
      for (const li of b.line_items) {
        const rate = lookupCghsCode(li.cghs_code);
        if (!rate && li.cghs_code) {
          lines.push({ description: li.description, cghs_code: li.cghs_code, listed: false });
          unlistedCount++;
        } else if (rate) {
          lines.push({ description: li.description, cghs_code: li.cghs_code, listed: true });
        }
      }
    }
  }
  if (lines.length === 0) {
    return {
      id: 'CHK-6',
      name: 'Listed Procedure Check',
      result: 'PENDING',
      finding: 'No itemised line data extracted from bills with CGHS codes. Manual review required to confirm all procedures are on the CGHS approved list.',
      om_ref: 'MoHFW OM dated 03-10-2025 (CGHS Rate List)',
      om_excerpt: 'Procedures not listed in the CGHS approved rate card require either (a) restriction to the nearest analogous procedure, or (b) ex-post-facto approval of the competent authority.',
      source_refs: [{ slot: 'hospital_bill' }],
      data: { lines }
    };
  }
  return {
    id: 'CHK-6',
    name: 'Listed Procedure Check',
    result: unlistedCount > 0 ? 'CONDITIONAL' : 'PASS',
    finding: unlistedCount === 0
      ? `All ${lines.length} procedures with CGHS codes are present in the approved list.`
      : `${unlistedCount} procedure(s) have CGHS codes not found in the master list. Triggers CHK-7 ex-post-facto check.`,
    om_ref: 'MoHFW OM dated 03-10-2025 (CGHS Rate List)',
    om_excerpt: 'Procedures not listed in the CGHS approved rate card require either restriction to the nearest analogous procedure or ex-post-facto approval of the competent authority.',
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

  // Find claimed items not in referral (rough token overlap)
  function overlap(a, b) {
    const ta = a.split(/\W+/).filter(w => w.length > 3);
    const tb = b.split(/\W+/).filter(w => w.length > 3);
    if (ta.length === 0 || tb.length === 0) return 0;
    const set = new Set(ta);
    return tb.filter(w => set.has(w)).length / Math.max(tb.length, 1);
  }

  const extras = [];
  for (const cn of claimedNames) {
    const matched = referredNames.some(rn => overlap(cn, rn) >= 0.4 || cn.includes(rn) || rn.includes(cn));
    if (!matched && cn.trim()) extras.push(cn);
  }

  if (extras.length === 0) {
    return {
      id: 'CHK-8',
      name: 'Referral Procedure Match',
      result: 'PASS',
      finding: `All ${claimedNames.length} claimed procedure(s) match against the ${referredNames.length} procedure(s) authorised in the referral.`,
      om_ref: 'CGHS Referral System guidelines',
      om_excerpt: 'Procedures undertaken at the empanelled hospital should match those authorised in the CGHS referral. Additional procedures require separate authorisation or justification.',
      source_refs: [{ slot: 'referral' }, { slot: 'hospital_bill' }],
      data: { referred: referredNames, extras: [] }
    };
  }
  return {
    id: 'CHK-8',
    name: 'Referral Procedure Match',
    result: 'CONDITIONAL',
    finding: `${extras.length} claimed procedure(s) not found in the referral list. Items: ${extras.slice(0, 5).join('; ')}${extras.length > 5 ? '…' : ''}. Dealing Hand to confirm whether these are (a) included implicitly, (b) separately authorised, or (c) to be excluded from reimbursement.`,
    om_ref: 'CGHS Referral System guidelines',
    om_excerpt: 'Procedures undertaken beyond the scope of the issued referral require either separate authorisation from the CGHS Wellness Centre or justified inclusion by the dealing hand with documented reasons.',
    source_refs: [{ slot: 'referral', label: 'Procedures authorised' }, { slot: 'hospital_bill', label: 'Procedures actually billed' }],
    data: { referred: referredNames, extras }
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

  // Aggregate amounts
  const claimedTotal = c3.total_claimed || Number(e.total_amount_claimed || 0);
  const admissibleTotal = c3.total_admissible || claimedTotal;

  const isEmergency = c1.is_emergency;
  const isHospital = c1.claim_type.includes('IPD');
  const needsExPostFacto = c7.result === 'CONDITIONAL';

  const today = new Date();
  const todayStr = today.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });

  // Build itemised table
  const tableRows = [];
  let sno = 1;
  for (const li of c3.lines || []) {
    tableRows.push({
      sno: sno++,
      description: li.description || '—',
      claimed: li.claimed || 0,
      admissible: li.admissible || 0,
      cghs_code: li.cghs_code || '—'
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

  const para4 = `4. As per **MoHFW OM No. 5-16/CGHS(HQ)/HEC/2024(Part I) dated 03-10-2025**, the prescribed CGHS rates have been applied for determining the admissible amount. ${c3.total_claimed > c3.total_admissible ? `Where claimed amounts exceeded the prescribed package rates, admissible amounts have been restricted to CGHS rates accordingly.` : 'All claimed amounts are within the prescribed CGHS rates.'}`;

  const para5_ifd = c1.total > 1000000
    ? `5. The claim amount exceeds ₹10.00 lakh. As per **MoHFW OM No. S.11030/4/2026-EHS dated 16-02-2026**, IFD concurrence is required and is being obtained.`
    : c1.total > 500000
      ? `5. The claim amount is ₹${c1.total.toLocaleString('en-IN')}/-, which is within the enhanced delegation of **₹10.00 lakh** to the Head of Department vide **MoHFW OM No. S.11030/4/2026-EHS dated 16-02-2026**, without consultation of IFD.`
      : `5. The claim amount of ₹${c1.total.toLocaleString('en-IN')}/- is within the normal delegation of HoD; no IFD consultation is required.`;

  const para6 = needsExPostFacto
    ? `6. In view of the above, **ex-post-facto approval** of the competent authority is solicited for the medical claim, and ${needsExPostFacto ? '**US (Admn.)** may kindly accord financial sanction of ' : '**US (Admn.)** may kindly accord financial sanction of '}**₹${admissibleTotal.toLocaleString('en-IN')}/- (Rupees ${num2words(admissibleTotal)})** to ${e.employee_name || '______'}, ${e.designation || '______'}, towards reimbursement of medical expenses.`
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
