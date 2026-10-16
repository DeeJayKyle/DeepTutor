// On-device document reading: PDF text via pdf.js, and OCR (Tesseract) for
// scanned pages and photographed documents. Runs entirely in the browser, so
// it works offline once the app has cached these libraries.

const VENDOR = new URL("../vendor/", import.meta.url).href;
const MIN_PAGE_CHARS = 25; // fewer characters than this = treat as a scanned page
export const MAX_OCR_PAGES = 150;

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(`${VENDOR}pdfjs/pdf.min.mjs`).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = `${VENDOR}pdfjs/pdf.worker.min.mjs`;
      return lib;
    });
  }
  return pdfjsPromise;
}

let tesseractPromise = null;
function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = new Promise((resolve, reject) => {
      if (globalThis.Tesseract) return resolve(globalThis.Tesseract);
      const s = document.createElement("script");
      s.src = `${VENDOR}tesseract/tesseract.min.js`;
      s.onload = () => resolve(globalThis.Tesseract);
      s.onerror = () => {
        tesseractPromise = null;
        reject(new Error("Could not load the OCR engine. Open the app online once so it can be stored for offline use."));
      };
      document.head.appendChild(s);
    });
  }
  return tesseractPromise;
}

async function createOcrWorker(onProgress) {
  const Tesseract = await loadTesseract();
  return Tesseract.createWorker("eng", 1, {
    workerPath: `${VENDOR}tesseract/worker.min.js`,
    corePath: `${VENDOR}tesseract/`,
    langPath: `${VENDOR}tesseract/`,
    gzip: true,
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === "recognizing text" && onProgress) onProgress(m.progress);
    },
  });
}

/** OCR an image (Blob, canvas or data URL). Returns plain text. */
export async function ocrImage(image, { onProgress } = {}) {
  const worker = await createOcrWorker(onProgress);
  try {
    const { data } = await worker.recognize(image);
    return (data.text || "").trim();
  } finally {
    await worker.terminate();
  }
}

/**
 * Extract text from a PDF on this device. Pages without a text layer are
 * rendered and OCR'd. Returns {text, pages, ocrPages, skippedOcrPages}.
 */
export async function readPdf(blob, { onProgress, ocr = true } = {}) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = pdfjs.getDocument({ data, isEvalSupported: false });
  const doc = await task.promise;
  const pages = [];
  const scanned = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const text = content.items
      .map((it) => (it.str || "") + (it.hasEOL ? "\n" : " "))
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
    pages.push(text);
    if (text.length < MIN_PAGE_CHARS) scanned.push(n);
    onProgress?.({ phase: "reading", page: n, pages: doc.numPages });
  }
  let ocrPages = 0;
  const toOcr = ocr ? scanned.slice(0, MAX_OCR_PAGES) : [];
  if (toOcr.length) {
    const worker = await createOcrWorker();
    try {
      for (const [i, n] of toOcr.entries()) {
        onProgress?.({ phase: "ocr", page: n, done: i, total: toOcr.length });
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport, canvas }).promise;
        const { data: result } = await worker.recognize(canvas);
        const text = (result.text || "").trim();
        if (text) {
          pages[n - 1] = text;
          ocrPages += 1;
        }
        canvas.width = canvas.height = 0;
      }
    } finally {
      await worker.terminate();
    }
  }
  await task.destroy();
  const text = pages
    .map((t, i) => (t ? `[Page ${i + 1}]\n${t}` : ""))
    .filter(Boolean)
    .join("\n\n");
  return { text, pages: pages.length, ocrPages, skippedOcrPages: Math.max(0, scanned.length - toOcr.length) };
}
