# Tutor Companion

Tutor Companion is an AI-assisted teaching and academic management app for
tutors, lecturers and schools. It runs inside this DeepTutor deployment at
**`https://tutor-companion.<account>.workers.dev/companion`** (Cloudflare address; the Render address also works where it is not blocked) and installs as an app
on Windows, Android and any modern browser.

## Using it

1. Open `/companion` and sign in with your DeepTutor account.
2. **Install it** (optional but recommended):
   - **Windows** — download `Tutor-Companion-Setup-<version>.exe` from the
     [Releases page](https://github.com/DeeJayKyle/DeepTutor/releases) and run
     it (or, in Edge/Chrome, click *Install Tutor Companion* in the address bar).
   - **Android** — in Chrome tap ⋮ › *Install app* / *Add to Home screen*.
   - **Web** — just use the page; bookmark it.
3. After the first visit the app opens and works **without internet**.

Typical flow: *Classes* → create “Diploma in Pharmacy — Year One” → add the
course unit “Pharmacology I” with objectives and topics → *Digital Library* →
upload the textbook, curriculum and references and link them to the unit →
*AI Teaching Assistant* → choose lecture notes / slides / exam / quiz /
assignment → review and edit the draft → *Mark as reviewed* → export to Word,
PDF or PowerPoint. Register students in *Students & Marks*, create assessments
with maximum scores and weights, record marks, export the marksheet to Excel
and open *Reports & Analytics*.

## What is implemented

| Area | Status |
| --- | --- |
| Dashboard (counts, upcoming assessments, recent resources/notes, recent performance, storage, connection, backup status, quick actions) | Done |
| Classes — create/edit/delete, levels, descriptions, **20-class limit** enforced with a clear message | Done |
| Course units — code, title, description, hours, objectives, topics/subtopics, curriculum, outline; linked to a class | Done |
| Digital library — PDF, Word, PowerPoint, Excel, text, images (≤ 40 MB each); metadata (author, year, edition, subject, publisher, topic, tags, notes, link); search and filters; offline copies on the device; text extraction for AI use | Done |
| AI Teaching Assistant — lecture notes, topic summaries, slide decks, examinations, quizzes, assignments/coursework with rubrics, case studies, marking guides, AI revision of a draft | Done |
| Source grounding — uploaded sources are sent first and cited as `[Source: S#]`; AI-only explanations are marked; a provenance meter shows how much is source-backed; no invented references | Done |
| Tutor review — every AI output starts as a draft; *Mark as reviewed* requires explicit confirmation; editing after review returns it to draft; draft exports carry a DRAFT footer | Done |
| Export — DOCX, PPTX, PDF (documents), XLSX (marksheets), CSV (class lists), Markdown; generated in the browser, works offline; uses a *Save as* dialog where the browser supports it, otherwise the Downloads folder; success is only reported after the file is written | Done |
| Interactive quiz mode (multiple-choice with answer check from the marking guide) | Done |
| Students — register, edit, move class, delete, CSV import (duplicate registration numbers rejected), CSV export | Done |
| Marks — coursework, assignment, quiz, practical, midterm, final, other; max score and weight per assessment; validation (no negatives, no values above the maximum, numbers only); absent/exempt; lock marks against accidental edits | Done |
| Grading — configurable bands, pass mark, missing-mark policy and rounding; weighted finals, grades, class averages, median, spread, pass rate, ranking with ties, trends; formulas shown on screen and in exports | Done |
| Analytics — students performing well / needing support, weak topics, gaps between assessments, improving/declining students, incomplete records; Word/PDF report | Done |
| Research — articles from OpenAlex and arXiv (real metadata, DOI links), openly licensed images from Wikimedia Commons (licence + author shown), YouTube search (with `YOUTUBE_API_KEY`), saving items to classes/units/topics/lecture notes with notes | Done |
| Offline — the app shell, export libraries and all records are stored on the device; a service worker serves the app offline and when the server is asleep or the session has expired | Done |
| Accounts & separate workspaces — each signed-in account gets its own local database; nothing is uploaded unless the tutor chooses to | Done |
| Cloud backup — tutor selects which data to include; SHA-256 integrity checks on upload and restore; 20 versions kept; stored in the tutor's own server workspace | Done |
| Restore & sync — restore to any device; every record is compared and **conflicts are shown for review** (keep mine / use backup / keep both); manual *Synchronise* merges the latest cloud copy and uploads the result; offline backup files | Done |
| Sharing — export a class as a share package (students and files only if ticked) and import it into another tutor's workspace with the same conflict review | Done |
| Activity log of sensitive actions (marks changes, deletions, exports, backups, restores) | Done |
| OCR — PDFs are read on the device with pdf.js; scanned pages (up to 150 per document) and photographed pages are read with Tesseract OCR, offline | Done |
| DeepTutor AI — DeepTutor's tutor chat (web/paper/reasoning tools), Deep Solve, Deep Research and question generator, grounded in DeepTutor knowledge bases built from a unit's library; answers saved as materials | Done |
| School workspaces — schools, admins and tutors, shared classes, per-class roles (lead / teacher / assistant / viewer) enforced on the server, offline copies with sync and conflict review, institution report, activity log | Done |
| Android app — signed APK (Capacitor) that opens the hosted app, works offline, saves exports to Documents and shares them | Done |
| Windows app — signed NSIS installer (Electron) | Done |

## Architecture

```
Browser / installed app (web/public/companion — no build step)
  ├─ IndexedDB  tutor-companion--<account>   classes, units, resources, files,
  │                                         materials, students, assessments,
  │                                         marks, research, settings, audit
  ├─ Service worker (sw.js)                 offline app shell + export libs
  └─ Exporters (docx, pptxgenjs, exceljs, jspdf — vendored)
            │  same-origin, session cookie
            ▼
DeepTutor backend  /api/companion/*  (deeptutor/api/routers/companion.py)
  ├─ POST /generate   server-side LLM (OpenAI or Gemini; keys never leave the server)
  ├─ POST /extract    text from PDF / DOCX / PPTX / XLSX / TXT
  ├─ POST /research   OpenAlex, arXiv, Wikimedia Commons, YouTube Data API
  ├─ /backups         per-account versioned backups (data/…/companion/backups)
  ├─ /deeptutor/*     runs DeepTutor capabilities, streams events (NDJSON)
  └─ /schools/*       school workspaces (SQLite in data/system/companion)
```

Mobile networks reach the server through a Cloudflare Worker
(`deploy/cloudflare/worker.js`) that passes requests to Render unchanged.

**Permissions.** Every `/api/companion` call requires a valid DeepTutor login
and runs inside that account's own workspace, so one tutor can never list or
read another tutor's backups. Restricted *learning* (student) accounts are
denied the companion API by DeepTutor's learning-surface policy. Local data is
separated per account on shared devices. School administrators manage tutor
accounts in DeepTutor's admin area; they do not get access to tutors' private
workspaces. Collaboration happens by explicit share packages.

**Data model (IndexedDB, keyPath `id`, all records carry `createdAt`,
`updatedAt`, `rev`).** `classes` {name, level, year, description} ·
`units` {classId, code, title, hours, description, objectives[], topics[{title,
subtopics[]}], curriculum, outline} · `resources` {title, docType, author,
year, edition, subject, publisher, topic, tags[], notes, url, classId, unitId,
fileId, fileName, size, offline, text} · `files` {blob} · `materials` {kind,
title, classId, unitId, content (Markdown), status draft|reviewed, aiGenerated,
sources[], reviewedBy, reviewedAt} · `students` {classId, regNo, firstName,
lastName, email, phone} · `assessments` {classId, unitId, title, category,
maxScore, weight, date, topics[], locked} · `marks` {id = assessmentId|studentId,
score|null, absent, exempt} · `research` {kind, title, url, source, licence,
classId, unitId, topic, materialId, notes} · `settings` · `audit`. Schema
changes are applied by ordered migrations in `js/db.js`.

## Tests

| Suite | Command (from `web/`) | Covers |
| --- | --- | --- |
| Router tests | `python -m pytest tests/api/test_companion_router.py` (repo root) | prompt building, AI-unavailable handling, generation, extraction (incl. corrupted/unsupported files), backup round trip and integrity, path-safety, research parsers |
| Logic tests | `node --test companion-tests/logic.test.mjs` | grading against hand-calculated results, validation, ranking, trends, Markdown, slides, quiz parsing, source selection, restore conflict planning, CSV |
| End-to-end | `npx playwright test -c companion-tests/playwright.config.mjs` | full tutor workflow in Chromium (desktop + Android phone size): classes, units, library upload, AI drafts, review, DOCX/PDF/PPTX/XLSX exports opened and checked, marks validation, reports, cloud backup, conflict review, restore after erasing, offline reload, 20-class limit |

All run automatically on GitHub (`.github/workflows/companion.yml`). The
end-to-end tests use a stand-in AI model so they are deterministic and free.

## Known limitations

- **AI, DeepTutor and research need internet.** Offline you can view, edit,
  export, OCR and record marks, but not generate.
- **Signing.** Without a purchased certificate (`WINDOWS_CERT_PFX_BASE64`) the
  Windows installer is self-signed, so Windows shows *Unknown publisher*.
  Without `ANDROID_KEYSTORE_*` secrets each APK build uses a temporary key, so
  installing a later version may require uninstalling first (back up first).
- **Shared classes** carry library catalogue entries and extracted text, not
  the files themselves. Sync is manual by design.
- **OCR** is English-only and capped at 150 scanned pages per document.
- **YouTube search** needs a `YOUTUBE_API_KEY`; videos are saved as links.
- Browser storage can be cleared by the user or the browser under pressure;
  keep regular backups.

## Recommended next steps

1. Per-unit grading scheme overrides; more OCR languages.
2. Play Store / Microsoft Store listings (need developer accounts).

## Releases

Run **Actions → Release Tutor Companion → Run workflow** with a version. It
checks the live site, builds the Windows installer, zips the web app and
publishes a GitHub release `companion-v<version>` using
`.github/release-notes/companion-<version>.md`.
