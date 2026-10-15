// End-to-end test of Tutor Companion in a real browser: classes, units,
// library, AI drafts, review, exports (verified by opening the files),
// students, marks, reports, backup/restore with conflicts, offline reload and
// the 20-class limit.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { expect, test } from "@playwright/test";

const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const ExcelJS = require("exceljs");

test.describe.configure({ mode: "serial" });
const shot = (name) => (process.env.TC_SCREENSHOTS ? page.screenshot({ path: `${process.env.TC_SCREENSHOTS}/desktop-${name}.png` }) : null);

/** @type {import('@playwright/test').Page} */
let page;
const errors = [];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ acceptDownloads: true });
  // Force the download path (headless Chromium cannot show a Save-as dialog).
  await context.addInitScript(() => {
    delete window.showSaveFilePicker;
  });
  page = await context.newPage();
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/favicon|net::ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(msg.text())) errors.push(msg.text());
  });
  page.on("dialog", (d) => d.accept());
});

async function submitModal(label = null) {
  const modal = page.locator(".modal").last();
  await (label ? modal.getByRole("button", { name: label }) : modal.locator("button[type=submit]")).click();
}

async function download(trigger) {
  const [dl] = await Promise.all([page.waitForEvent("download"), trigger()]);
  const path = await dl.path();
  return { name: dl.suggestedFilename(), data: readFileSync(path) };
}

test("dashboard loads with navigation and status", async () => {
  await page.goto("/companion/index.html");
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
  const nav = page.locator("#nav a");
  await expect(nav).toHaveCount(13);
  await expect(page.locator("#conn")).toContainText("AI ready");
  await expect(page.locator(".stats")).toContainText("0/20");
});

test("create a class and a course unit", async () => {
  await page.click("text=＋ New class");
  await page.fill("input[name=name]", "Diploma in Pharmacy — Year One");
  await page.fill("input[name=level]", "Diploma, Year 1");
  await submitModal();
  await expect(page.locator(".class-card")).toHaveCount(1);
  await page.click(".class-card h2 a");
  await page.getByRole("button", { name: "＋ Add course unit" }).first().click();
  await page.fill("input[name=code]", "PHA101");
  await page.fill("input[name=title]", "Pharmacology I");
  await page.fill("textarea[name=objectives]", "Explain drug absorption\nDescribe distribution");
  await page.fill("textarea[name=topics]", "Pharmacokinetics\n  - Absorption\n  - Distribution\nDosage calculation");
  await submitModal();
  await expect(page.getByRole("heading", { name: "PHA101 — Pharmacology I" })).toBeVisible();
  await expect(page.locator(".tab-body")).toContainText("Absorption");
});

test("upload a source to the digital library", async () => {
  await page.goto("/companion/index.html#/library?upload=1");
  await page.setInputFiles("input[name=files]", {
    name: "rang-dale-chapter-2.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Absorption is the passage of a drug from its site of administration into the plasma.\n\nDistribution follows absorption."),
  });
  await page.selectOption(".modal select[name=unitId]", { index: 1 });
  await submitModal("Upload");
  await expect(page.locator("#lib-results")).toContainText("rang dale chapter 2");
  await expect(page.locator("#lib-results")).toContainText("chars");
  await expect(page.locator("#lib-results")).toContainText("on device");
});

test("generate lecture notes, review and export DOCX / PDF / PPTX", async () => {
  await page.goto("/companion/index.html#/assistant?kind=lecture_notes");
  await page.check("input[name=topics][value=Pharmacokinetics]");
  await expect(page.locator("input[name=sources]")).toBeChecked();
  await page.click("text=✦ Generate draft");
  await expect(page.locator(".md-preview")).toContainText("Absorption is the movement", { timeout: 20_000 });
  await expect(page.locator(".src-tag").first()).toBeVisible();
  await expect(page.locator(".status-row")).toContainText("Draft");
  await expect(page.locator(".status-row")).toContainText("tagged to your sources");

  // Edit, then mark reviewed.
  await page.locator(".md-input").fill(`${await page.locator(".md-input").inputValue()}\n\nTutor addition: check renal function.`);
  await expect(page.locator("#save-state")).toContainText("Saved", { timeout: 5000 });
  await page.getByRole("button", { name: "Mark as reviewed" }).click();
  await page.check("input[name=content]");
  await page.check("input[name=refs]");
  await submitModal("Mark as reviewed");
  await expect(page.locator(".status-row")).toContainText("Reviewed");
  await shot("editor");

  await page.click("text=⤓ Export");
  const docx = await download(() => page.click("button[data-export=docx]"));
  expect(docx.name).toMatch(/\.docx$/);
  const docXml = await (await JSZip.loadAsync(docx.data)).file("word/document.xml").async("string");
  expect(docXml).toContain("Absorption is the movement");
  expect(docXml).toContain("Tutor addition: check renal function.");
  expect(docXml).toContain("<w:tbl>");

  await page.click("text=⤓ Export");
  const pdf = await download(() => page.click("button[data-export=pdf]"));
  expect(pdf.data.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf.data.toString("latin1")).toContain("Pharmacokinetics");

  await page.click("text=⤓ Export");
  const pptx = await download(() => page.click("button[data-export=pptx]"));
  const deck = await JSZip.loadAsync(pptx.data);
  const slides = Object.keys(deck.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  expect(slides.length).toBeGreaterThan(2);
  const slideXml = await Promise.all(slides.map((f) => deck.file(f).async("string")));
  expect(slideXml.some((x) => x.includes("Learning objectives") && x.includes("Explain drug absorption"))).toBe(true);
  expect(slideXml.some((x) => x.includes("<a:tbl>"))).toBe(true);
});

test("generate a quiz and use interactive mode", async () => {
  await page.goto("/companion/index.html#/assistant?kind=quiz");
  await page.check("input[name=topics][value=Pharmacokinetics]");
  await page.click("text=✦ Generate draft");
  await expect(page.locator(".md-preview")).toContainText("Which organ", { timeout: 20_000 });
  await page.click("text=▶ Interactive mode");
  await page.click(".quiz-opt[data-opt=B]");
  await expect(page.locator(".quiz-opt.correct")).toContainText("Liver");
  await expect(page.locator(".modal")).toContainText("Score: 1/1");
  await page.click("[data-x]");
  await expect(page.locator("#nav a[data-route=exams]")).toHaveClass(/active/);
});

test("register students, validate and record marks, export marksheet", async () => {
  await page.goto("/companion/index.html#/students");
  for (const [first, last, reg] of [["Amina", "Otieno", "P1"], ["Brian", "Kamau", "P2"]]) {
    await page.getByRole("button", { name: "＋ Register student" }).first().click();
    await page.fill("input[name=firstName]", first);
    await page.fill("input[name=lastName]", last);
    await page.fill("input[name=regNo]", reg);
    await submitModal();
    await expect(page.locator(".tab-body")).toContainText(first);
  }
  // Duplicate registration number is rejected.
  await page.getByRole("button", { name: "＋ Register student" }).first().click();
  await page.fill("input[name=firstName]", "Dup");
  await page.fill("input[name=regNo]", "P1");
  await submitModal();
  await expect(page.locator(".form-error")).toContainText("already used");
  await page.locator(".modal [data-close]").first().click();

  await page.click("text=Assessments & marks entry");
  await page.getByRole("button", { name: "＋ New assessment" }).first().click();
  await page.fill("input[name=title]", "CAT 1");
  await page.fill("input[name=maxScore]", "30");
  await page.fill("input[name=weight]", "40");
  await page.fill("input[name=date]", "2099-01-15");
  await page.check("input[name=topics][value=Pharmacokinetics]");
  await submitModal();
  await page.getByRole("button", { name: "＋ New assessment" }).first().click();
  await page.fill("input[name=title]", "Final exam");
  await page.fill("input[name=maxScore]", "100");
  await page.fill("input[name=weight]", "60");
  await submitModal();

  await expect(page.locator(".marks thead")).toContainText("Score / 100");
  const score = (name) => page.locator("tr", { hasText: name }).locator("input.score");

  // Back to CAT 1: an invalid score blocks saving.
  await page.selectOption("[data-act=pick-assessment]", { label: "CAT 1 (PHA101 — Pharmacology I)" });
  await expect(page.locator(".marks thead")).toContainText("Score / 30");
  await score("Amina").fill("35");
  await expect(page.locator("tr", { hasText: "Amina" }).locator(".cell-error")).toContainText("cannot exceed 30");
  await page.click("text=Save marks");
  await expect(page.locator(".toast-error")).toContainText("invalid");
  await score("Amina").fill("24"); // 80%
  await score("Brian").fill("12"); // 40%
  await page.click("text=Save marks");
  await expect(page.locator(".toast-success").last()).toContainText("Saved 2");

  await page.selectOption("[data-act=pick-assessment]", { label: "Final exam (PHA101 — Pharmacology I)" });
  await expect(page.locator(".marks thead")).toContainText("Score / 100");
  await score("Amina").fill("70"); // 70%
  await score("Brian").fill("45"); // 45%
  await page.click("text=Save marks");
  await expect(page.locator(".toast-success").last()).toContainText("Saved 2");

  // Amina: 0.8*40 + 0.7*60 = 74.0 (B); Brian: 0.4*40 + 0.45*60 = 43.0 (F)
  await page.click("text=Marksheet & grades");
  const rows = page.locator(".marksheet tbody tr");
  await expect(rows.nth(0)).toContainText("74");
  await expect(rows.nth(0)).toContainText("B");
  await expect(rows.nth(1)).toContainText("43");
  await expect(rows.nth(1)).toContainText("F");

  await shot("marksheet");
  const xlsx = await download(() => page.click("text=⤓ Export marksheet (.xlsx)"));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx.data);
  const ws = wb.getWorksheet("Marksheet");
  const values = [];
  ws.eachRow((row) => values.push(row.values.slice(1)));
  expect(values[0]).toContain("Final %");
  expect(values.find((r) => r.includes("Amina Otieno"))).toContain(74);
});

test("reports are calculated from recorded marks", async () => {
  await page.goto("/companion/index.html#/reports");
  await expect(page.locator(".stats")).toContainText("58.5%"); // (74 + 43) / 2
  await expect(page.locator(".stats")).toContainText("50%"); // 1 of 2 pass
  await expect(page.locator(".findings")).toContainText("Brian Kamau");
  await shot("reports");
  const report = await download(() => page.click("button[data-export=docx]"));
  const xml = await (await JSZip.loadAsync(report.data)).file("word/document.xml").async("string");
  expect(xml).toContain("Class average");
  expect(xml).toContain("58.5%");
});

test("dashboard shows activity", async () => {
  await page.goto("/companion/index.html#/dashboard");
  await expect(page.locator(".stats")).toContainText("1/20");
  await expect(page.locator("main")).toContainText("CAT 1"); // upcoming assessment
  await expect(page.locator("main")).toContainText("Lecture notes — Pharmacology I");
  await shot("dashboard");
});

test("cloud backup, conflict review and restore after data loss", async () => {
  await page.goto("/companion/index.html#/backup");
  await page.click("text=⇪ Back up now…");
  await page.fill("input[name=label]", "E2E backup");
  await submitModal("Upload backup");
  await expect(page.locator(".toast-success").last()).toContainText("verified");
  await expect(page.locator("main")).toContainText("E2E backup");

  // Change a record locally, then restore: a conflict must be offered.
  await page.goto("/companion/index.html#/classes");
  await page.click(".class-card [data-act=edit]");
  await page.fill("input[name=name]", "Pharmacy Y1 (renamed)");
  await submitModal();
  await page.goto("/companion/index.html#/backup");
  await page.getByRole("button", { name: "Restore…" }).first().click();
  await expect(page.locator(".modal")).toContainText("differ between this device and the backup");
  await expect(page.locator(".modal")).toContainText("Pharmacy Y1 (renamed)");
  await submitModal("Apply restore"); // default: keep mine
  await expect(page.locator(".modal")).toContainText("kept as they were");
  await page.locator(".modal [data-close]").first().click();

  // Erase everything, then restore from the cloud.
  await page.goto("/companion/index.html#/settings");
  await page.click("text=Erase local data…");
  await page.fill("input[name=typed]", "ERASE");
  await submitModal("Erase everything");
  await expect(page.locator(".stats")).toContainText("0/20");
  await page.goto("/companion/index.html#/backup");
  await page.getByRole("button", { name: "Restore…" }).first().click();
  await expect(page.locator(".modal")).toContainText("No conflicts");
  await submitModal("Restore");
  await expect(page.locator(".modal")).toContainText("Restore complete");
  await page.locator(".modal [data-close]").first().click();
  await page.goto("/companion/index.html#/students?tab=sheet");
  await expect(page.locator(".marksheet")).toContainText("Amina Otieno");
  await expect(page.locator(".marksheet")).toContainText("74");
});

test("works offline after the first visit", async () => {
  await page.goto("/companion/index.html#/classes");
  await page.waitForFunction(() => navigator.serviceWorker?.controller);
  await page.context().setOffline(true);
  await page.reload();
  await expect(page.locator("#conn")).toContainText("Offline");
  await expect(page.locator(".class-card")).toContainText("Diploma in Pharmacy");
  // Offline exports still work (libraries are cached).
  await page.goto("/companion/index.html#/students?tab=sheet");
  const xlsx = await download(() => page.click("text=⤓ Export marksheet (.xlsx)"));
  expect(xlsx.data.length).toBeGreaterThan(1000);
  // AI generation is clearly unavailable.
  await page.goto("/companion/index.html#/assistant");
  await expect(page.locator("main")).toContainText("You are offline");
  await page.context().setOffline(false);
});

test("enforces the 20-class limit", async () => {
  await page.goto("/companion/index.html#/classes");
  await page.evaluate(async () => {
    const { ctx } = await import("/companion/js/app.js");
    for (let i = 2; i <= 20; i += 1) await ctx.db.put("classes", { name: `Class ${i}` });
  });
  await page.reload();
  await expect(page.locator(".alert-warn")).toContainText("maximum of 20 classes");
  await expect(page.getByRole("button", { name: "＋ New class" })).toBeDisabled();
});

test("no unexpected browser errors", async () => {
  expect(errors).toEqual([]);
});
