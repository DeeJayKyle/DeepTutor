**Tutor Companion 1.0** — AI-assisted teaching and academic management for tutors, lecturers and schools, with DeepTutor's AI built in.

## Get it

| Platform | How |
| --- | --- |
| **Android** | Download **`Tutor-Companion-1.0.0.apk`** below, open it and allow *Install unknown apps* for your browser or file manager when asked. |
| **Windows** | Download **`Tutor-Companion-Setup-1.0.0.exe`** below and run it. It adds Start-menu and desktop shortcuts. |
| **Web** | Open **{{APP_URL}}/companion** in any modern browser (Chrome → ⋮ → *Install app* also works on Android). |

Sign in with your DeepTutor account the first time (online). After that the app opens and works without internet. Your classes, students, marks and files are stored on your own device.

## What's in 1.0

- **Dashboard**: classes, units, library, materials and students at a glance; upcoming assessments; recent performance; storage, connection and backup status; quick actions.
- **Classes and course units**: up to 20 classes per workspace. Units hold their code, hours, learning outcomes, topics and subtopics, curriculum and course outline.
- **Digital library**:
  - Upload PDF, Word, PowerPoint, Excel, text and image files (up to 40 MB each), with full metadata, search and filters.
  - PDFs are read on your device, and **scanned pages and photographed documents are read with OCR**, also offline.
- **AI Teaching Assistant**: lecture notes, topic summaries, PowerPoint decks, examinations, quizzes, assignments with rubrics, case studies, marking guides, and AI revision of drafts.
  - Your uploaded materials are used first and cited as `[Source: S#]`; AI-only explanations are marked.
  - Every output stays a draft until you mark it as reviewed.
- **DeepTutor AI inside the app**:
  - DeepTutor's tutor chat (with web, paper and reasoning tools), Deep Solve for step-by-step worked solutions, Deep Research reports with sources, and DeepTutor's question generator.
  - Turn a course unit's library into a DeepTutor knowledge base so answers are grounded in your textbooks.
  - Save any answer as a teaching material, with links to DeepTutor's Co-Writer, Notebooks and Guided Learning.
- **Exports**: Word, PowerPoint, Excel and PDF, generated on your device (also offline). On Android, files are saved to *Documents › Tutor Companion* and can be shared.
- **Students, marks and grading**:
  - CSV import; validated marks with absent, exempt and lock options.
  - Configurable grade bands, weighted finals, rankings and trends; formulas are shown.
  - Reports flag strong students, students needing support and weak topics.
- **School workspaces**:
  - A school admin adds tutors by account name. Any member can publish a class.
  - The class lead gives colleagues a role:
    - **Lead**: full control
    - **Teacher**: content, students and marks
    - **Assistant**: marks only
    - **Viewer**: read only
  - Roles are enforced on the server.
  - Shared classes work offline and are kept up to date with *Sync*. If two people change the same record, both versions are shown and you choose.
  - Admins get institution reports across all shared classes and an activity log. Private workspaces stay private.
- **Research Assistant**: articles from OpenAlex and arXiv, openly licensed images from Wikimedia Commons, and YouTube videos (when the server has a YouTube key). Results can be saved to classes, units and topics.
- **Backup and sync**: optional cloud backups with SHA-256 checksums, restore to a new device, backup files, and conflict review.
- **Mobile networks**: the server is now reached through Cloudflare and kept awake, so it opens on mobile data.

## Signing

The Windows installer and the Android APK are signed. Until a commercial code-signing certificate is added (see `deploy/README.md`), Windows shows *Unknown publisher*: choose *More info → Run anyway*. If the APK was built without the permanent release key, a future version may need the old one uninstalled first. Make a backup first.

## Known limitations

- AI generation, DeepTutor and research need an internet connection; OCR, exports, marks and everything else work offline.
- OCR covers English text, up to 150 scanned pages per document.
- Library files themselves are not copied into shared classes (their catalogue entries and extracted text are).

Full guide: [`docs/tutor-companion.md`](https://github.com/DeeJayKyle/DeepTutor/blob/main/docs/tutor-companion.md)
