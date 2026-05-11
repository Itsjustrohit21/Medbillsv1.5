# CGHS Medical Bill Automation — POC

End-to-end automation for processing CGHS medical reimbursement claims at the **Department of Expenditure, Ministry of Finance**. Built as a 4-page web application with OCR-driven data extraction and 8 automated compliance checks against current CGHS rules.

## What it does

1. **Page 1 — Sign in.** Dealing Hand / Section Officer / Under Secretary log in with hardcoded demo credentials.
2. **Page 2 — Upload documents.** Five upload tiles (e-Claim, CGHS Referral, Hospital Bills, CGHS Card, Payment Proof). The system validates each uploaded file is the right document type for its tile. None of the slots is mandatory.
3. **Page 3 — Review & 8 Checks.** OCR (Claude Vision API) extracts every field from every uploaded document. Dealing Hand can edit any field. Then 8 compliance checks run with PASS / FAIL / CONDITIONAL / PENDING results, OM excerpts, and override-with-justification options.
4. **Page 4 — Generated Noting.** Produces the noting in the exact style of the sample notings supplied (Department of Expenditure, Admn. I), with the itemised table, sanction order, amount-in-words, and downloadable PDF / copy-to-clipboard.

## The 8 checks

| # | Check | Rule reference |
|---|---|---|
| 1 | Type of claim (IPD/OPD/Emergency, IFD delegation) | MoHFW OM dated 16-02-2026 |
| 2 | Bill amount reconciliation (e-Claim ↔ uploaded bills) | Internal reconciliation |
| 3 | CGHS rate card compliance (line-by-line restriction) | MoHFW OM dated 03-10-2025 |
| 4 | Ward entitlement (pay-level → ward) | MoHFW OM dated 07-11-2022 |
| 5 | Hospital empanelment (Delhi/HQ list of 774 hospitals) | CGHS empanelment list |
| 6 | Listed procedure check (against 1,996 CGHS codes) | MoHFW rate list |
| 7 | Ex-post-facto approval (triggered by CHK-5 / CHK-6) | OM dated 30-12-2015 |
| 8 | Referral procedure match (referred ↔ claimed) | CGHS referral system |

## Tech stack

- **Node.js 18+** with **Express** for the server
- **Vanilla HTML / CSS / JS** for the frontend (no React build step)
- **Anthropic Claude Sonnet 4.5** for vision-based OCR & document classification
- **PDFKit** for itemised table PDF generation
- **In-memory** session and file storage (POC — no database)

## Local development

```bash
git clone <your-repo>
cd cghs-app
npm install
ANTHROPIC_API_KEY=sk-ant-... node server.js
```
Open http://localhost:3000 — sign in with `admin` / `admin`.

## Deployment on Render

1. Push this repo to GitHub.
2. On Render → **New → Web Service** → connect your repo.
3. Render auto-detects `render.yaml`. The build command is `npm install`, start command is `node server.js`.
4. Under **Environment Variables**, set:
   - `ANTHROPIC_API_KEY` = your Anthropic API key (starts with `sk-ant-`)
   - `SESSION_SECRET` = Render auto-generates this if you keep `generateValue: true`
5. Click **Deploy**. App goes live at `https://<your-name>.onrender.com` in 2–3 minutes.

The free Render tier sleeps after 15 minutes of inactivity — first request after sleep takes ~30 seconds to cold-start. For a stable demo, upgrade to the Starter plan ($7/mo) or use Render's keep-alive cron.

## Demo credentials

| Username | Password | Role |
|---|---|---|
| `admin` | `admin` | PD Dealing Hand |
| `so` | `so123` | Section Officer |
| `us` | `us123` | Under Secretary (Admn.) |

## Reference data shipped with the app

- **`data/cghs_rates.json`** — 1,996 procedure codes × 3 city tiers × 3 accreditations (Non-NABH / NABH / Super-Specialty), built from the CGHS rate list dated 03-10-2025.
- **`data/empanelled_hospitals.json`** — 774 Delhi/HQ/Directorate/Ministry empanelled hospitals with name, accreditation, tier, address. (POC scope is Delhi/Chandigarh only — outside this region the hospital empanelment check returns PENDING with manual override.)

## Project structure

```
cghs-app/
├── server.js              # Express server, all API routes, the 8 checks, noting generator
├── package.json
├── render.yaml            # Render deployment config
├── data/
│   ├── cghs_rates.json
│   └── empanelled_hospitals.json
└── public/
    ├── styles.css         # All styles (government navy + saffron)
    ├── login.html         # Page 1
    ├── upload.html        # Page 2
    ├── checks.html        # Page 3
    └── noting.html        # Page 4
```

## Limitations & next steps for production

- **In-memory storage** — file uploads live in process memory; on Render the free tier loses everything on restart. For production: PostgreSQL + S3-compatible object storage.
- **Hospital empanelment** is Delhi/HQ only. Loading state-wise lists is a data exercise; the lookup function already supports it.
- **Pay-level → ward mapping** uses the standard 1–5 / 6–11 / 12+ rule from the OM dated 07-11-2022. Adjust `entitledWardFromPayLevel()` in server.js if your office uses different bands.
- **Authentication** is hardcoded; production would integrate with the e-Office SSO.
- **OCR accuracy** depends on document scan quality. Every extracted field is editable — Dealing Hand always has the final word.
