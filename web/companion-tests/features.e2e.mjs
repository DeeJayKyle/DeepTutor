// End-to-end tests for OCR, DeepTutor features and school sharing.
import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function newTutor(browser, user) {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-test-user": user } });
  const page = await context.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto("/companion/index.html");
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
  return page;
}

const db = (page, fn, arg) =>
  page.evaluate(
    async ([src, a]) => {
      const { ctx } = await import("/companion/js/app.js");
      return new Function("ctx", "arg", `return (async () => { ${src} })()`)(ctx, a);
    },
    [fn, arg],
  );

test("scanned PDF is read with OCR on the device", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const page = await newTutor(browser, "ocr-user");
  const pdf = await (await request.get("/__fixtures/scanned.pdf")).body();
  await page.goto("/companion/index.html#/library?upload=1");
  await page.setInputFiles("input[name=files]", { name: "scanned-handout.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.locator(".modal").getByRole("button", { name: "Upload" }).click();
  await expect(page.locator("#lib-results")).toContainText("OCR", { timeout: 150_000 });
  const text = await db(page, "return (await ctx.db.all('resources'))[0].text;");
  expect(text.toLowerCase()).toContain("bioavailability");
  await page.context().close();
});

test("DeepTutor answers with knowledge bases and saves to materials", async ({ browser }) => {
  const page = await newTutor(browser, "dt-user");
  await page.goto("/companion/index.html#/deeptutor");
  await page.check("input[name=kb][value=pharm-kb]");
  await page.check("input[name=cap][value=deep_solve]");
  await page.fill("textarea[name=message]", "Explain first-pass metabolism");
  await page.click("#dt-form button[type=submit]");
  const answer = page.locator(".dt-ai").last();
  await expect(answer).toContainText("deep_solve answer: first-pass metabolism reduces oral bioavailability.");
  await expect(answer).toContainText("Sources (1)");
  await answer.getByRole("button", { name: "Save as teaching material" }).click();
  await expect(page.locator(".md-preview")).toContainText("first-pass metabolism");
  await expect(page.locator(".md-preview")).toContainText("Pharmacology textbook");
  await page.context().close();
});

test("school sharing with per-class roles, sync and conflict review", async ({ browser }) => {
  test.setTimeout(120_000);
  const lead = await newTutor(browser, "tutor-a");
  const classId = await db(
    lead,
    `const c = await ctx.db.put("classes", { name: "Shared Biology" });
     const u = await ctx.db.put("units", { classId: c.id, title: "Cells", topics: [] });
     await ctx.db.put("students", { classId: c.id, firstName: "Zara", lastName: "Ali", regNo: "B1" });
     await ctx.db.put("assessments", { classId: c.id, unitId: u.id, title: "Quiz 1", maxScore: 10, weight: 1 });
     return c.id;`,
  );

  // Lead creates a school, adds a colleague, publishes the class, assigns a role.
  await lead.goto("/companion/index.html#/school");
  await lead.getByRole("button", { name: "＋ Create a school" }).click();
  await lead.fill("input[name=name]", "Test School");
  await lead.locator(".modal button[type=submit]").click();
  await expect(lead.getByRole("heading", { name: "Test School" })).toBeVisible();
  await lead.getByRole("link", { name: /Members/ }).click();
  await lead.fill("#add-member input[name=username]", "tutor-b");
  await lead.click("#add-member button[type=submit]");
  await expect(lead.locator(".tab-body")).toContainText("tutor-b");
  await lead.getByRole("link", { name: /Shared classes/ }).click();
  await lead.getByRole("button", { name: "⇪ Publish a class" }).click();
  await lead.locator(".modal button[type=submit]").click();
  await expect(lead.locator(".tab-body")).toContainText("Shared Biology");
  await lead.getByRole("button", { name: "Roles…" }).click();
  await lead.selectOption("select[name='role:tutor-b']", "assistant");
  await lead.locator(".modal button[type=submit]").click();
  await expect(lead.locator(".tab-body")).toContainText("tutor-b (assistant)");

  // Assistant downloads the class: can record marks, cannot register students.
  const assistant = await newTutor(browser, "tutor-b");
  await assistant.goto("/companion/index.html#/school");
  await assistant.getByRole("link", { name: "Test School" }).click();
  await assistant.getByRole("button", { name: "⤓ Download" }).click();
  await expect(assistant.locator(".tab-body")).toContainText("on this device");
  await assistant.goto(`/companion/index.html#/students?class=${classId}&tab=roster`);
  await expect(assistant.locator(".tab-body")).toContainText("Zara");
  await expect(assistant.getByRole("button", { name: "＋ Register student" })).toHaveCount(0);
  await assistant.goto(`/companion/index.html#/students?class=${classId}&tab=marks`);
  await assistant.locator("tr", { hasText: "Zara" }).locator("input.score").fill("8");
  await assistant.click("text=Save marks");
  await expect(assistant.locator(".toast-success").last()).toContainText("Saved 1");
  await assistant.goto(`/companion/index.html#/classes/${classId}`);
  await expect(assistant.locator(".alert-info")).toContainText("Assistant");
  await assistant.getByRole("button", { name: "⇅ Sync with school" }).click();
  await expect(assistant.locator(".toast-success").last()).toContainText("Uploaded changes (marks)");

  // Lead pulls the mark.
  await lead.goto(`/companion/index.html#/classes/${classId}`);
  await lead.getByRole("button", { name: "⇅ Sync with school" }).click();
  await expect(lead.locator(".toast-success").last()).toContainText("Downloaded changes from tutor-b");
  await lead.goto(`/companion/index.html#/students?class=${classId}&tab=sheet`);
  await expect(lead.locator(".marksheet")).toContainText("80"); // 8/10

  // Both change the same mark offline; the second sync shows a conflict.
  for (const [page, score] of [[lead, "6"], [assistant, "7"]]) {
    await page.goto(`/companion/index.html#/students?class=${classId}&tab=marks`);
    await page.locator("tr", { hasText: "Zara" }).locator("input.score").fill(score);
    await page.click("text=Save marks");
    await expect(page.locator(".toast-success").last()).toContainText("Saved 1");
  }
  await lead.goto(`/companion/index.html#/classes/${classId}`);
  await lead.getByRole("button", { name: "⇅ Sync with school" }).click();
  await expect(lead.locator(".toast-success").last()).toContainText("Uploaded changes (marks)");
  await assistant.goto(`/companion/index.html#/classes/${classId}`);
  await assistant.getByRole("button", { name: "⇅ Sync with school" }).click();
  await expect(assistant.locator(".modal")).toContainText("differ between this device and the backup");
  await assistant.locator(".modal input[value=incoming]").first().check();
  await assistant.locator(".modal").getByRole("button", { name: "Apply restore" }).click();
  await expect(assistant.locator(".toast-success").last()).toContainText(/up to date|Uploaded/);
  await assistant.goto(`/companion/index.html#/students?class=${classId}&tab=sheet`);
  await expect(assistant.locator(".marksheet")).toContainText("60"); // took the lead's 6/10

  // The assistant cannot change students even by editing locally: the server refuses.
  await db(assistant, `await ctx.db.put("students", { classId: arg, firstName: "Intruder" });`, classId);
  await assistant.goto(`/companion/index.html#/classes/${classId}`);
  await assistant.getByRole("button", { name: "⇅ Sync with school" }).click();
  await expect(assistant.locator(".toast-error").last()).toContainText("cannot change: students");
});
