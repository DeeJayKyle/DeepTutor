**Tutor Companion 1.0.0** — the first release of the AI-assisted teaching and academic management app for tutors, lecturers and schools.

## Get it

| Platform | How |
| --- | --- |
| **Windows** | Download **`Tutor-Companion-Setup-1.0.0.exe`** below and run it. It adds Start-menu and desktop shortcuts. The installer is not code-signed yet, so Windows SmartScreen may warn: choose *More info → Run anyway*. |
| **Android** | Open **https://deeptutor-ia8s.onrender.com/companion** in Chrome → ⋮ → *Install app*. It installs like a normal app and works offline. |
| **Web** | Open **https://deeptutor-ia8s.onrender.com/companion** in any modern browser. |

Sign in with your DeepTutor account the first time (online). After that the app opens and works without internet. Your classes, students, marks and files are stored on your own device.

## Features

- **Dashboard**: classes, units, library, materials and students at a glance; upcoming assessments; recent performance; storage, connection and backup status; quick actions.
- **Classes and course units**: up to 20 classes per workspace. Units hold their code, hours, learning outcomes, topics and subtopics, curriculum and course outline.
- **Digital library**:
  - Upload PDF, Word, PowerPoint, Excel, text and image files (up to 40 MB each).
  - Add full metadata, then search and filter.
  - Keep files on the device for offline use.
  - Text is extracted so the AI can use the files as sources.
- **AI Teaching Assistant**: lecture notes, topic summaries, PowerPoint decks, examinations, quizzes, assignments and coursework with rubrics, case studies, marking guides, and AI revision of any draft.
  - Your uploaded materials are used first and cited as `[Source: S#]`.
  - AI-only explanations are marked as such, and the AI is told never to invent references.
  - Every output stays a draft until you mark it as reviewed.
- **Exports**: Word, PowerPoint, Excel and PDF, generated on your device (also offline). Drafts are labelled DRAFT in the footer.
- **Interactive quiz mode** for multiple-choice questions.
- **Students and marks**:
  - Register students or import them from CSV; duplicate registration numbers are rejected.
  - Record marks for coursework, assignments, quizzes, practicals, midterms and finals. Scores are validated, students can be marked absent or exempt, and marks can be locked.
- **Grading and reports**:
  - Grade bands, pass mark and the handling of missing marks are all configurable.
  - Reports cover weighted final marks, grades, averages, pass rates, rankings and trends. The formulas are shown on screen.
  - Reports also flag strong students, students needing support, weak topics and gaps between assessments, and can be exported to Word or PDF.
- **Research Assistant**:
  - Articles from OpenAlex and arXiv, with real metadata and DOI links.
  - Openly licensed images from Wikimedia Commons, with licence and author shown.
  - YouTube videos. Results can be saved to a class, unit, topic or lecture notes.
- **Backup and sync**:
  - Cloud backups only when you choose, with checksum (SHA-256) integrity checks. Restore to a new device, synchronise manually, or use backup files.
  - Conflicts are always shown for review — nothing is overwritten silently.
- **Sharing and security**:
  - Share a class with another tutor as a package; students and files are included only if you tick them.
  - Each account has its own private workspace, API keys stay on the server, and sensitive actions are logged.

## Server

- The server uses OpenAI when the `OPENAI_API_KEY` repository secret is set, otherwise Gemini. Optional `YOUTUBE_API_KEY` for video search. See `deploy/README.md`.

## Known limitations

- AI generation and research need an internet connection.
- No OCR for scanned PDFs.
- School-wide shared classes with per-class roles are not included yet; tutors share classes with share packages.
- The Windows installer is unsigned. Android is installed through Chrome; there is no APK yet.

Full guide: [`docs/tutor-companion.md`](https://github.com/DeeJayKyle/DeepTutor/blob/main/docs/tutor-companion.md)
