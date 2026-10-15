// Phone-sized checks (Android form factor): navigation drawer, no horizontal
// scrolling, and core forms usable on a small screen.
import { expect, test } from "@playwright/test";

const SHOTS = process.env.TC_SCREENSHOTS;

test("mobile layout and navigation", async ({ page }) => {
  await page.goto("/companion/index.html");
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
  await expect(page.locator("#nav")).not.toBeInViewport();
  await page.click("#nav-toggle");
  await expect(page.locator("#nav")).toBeInViewport();
  await page.click("#nav a[data-route=classes]");
  await expect(page.locator("#nav")).not.toBeInViewport();
  await page.getByRole("button", { name: "＋ Create a class" }).click();
  await page.fill("input[name=name]", "Form 2 Biology");
  await page.locator(".modal button[type=submit]").click();
  await expect(page.locator(".class-card")).toContainText("Form 2 Biology");
  for (const route of ["dashboard", "students", "library", "assistant", "reports", "backup", "settings"]) {
    await page.goto(`/companion/index.html#/${route}`);
    await page.waitForSelector(".view");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${route}`).toBeLessThanOrEqual(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/mobile-${route}.png`, fullPage: false });
  }
});
