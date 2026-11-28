import { expect, test } from "@playwright/test";
import { CAUSE_TITLE, EVIDENCE_SUMMARY, INCIDENT_ID, INCIDENT_TITLE, WEB_DOWN_PORT, WEB_PORT } from "./fixture.mjs";

const web = `http://127.0.0.1:${WEB_PORT}`;
const webDown = `http://127.0.0.1:${WEB_DOWN_PORT}`;

const noHorizontalOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("the list shows the seeded incident and links to it", async ({ page }) => {
  await page.goto(web);
  await expect(page.getByRole("heading", { name: "Incidents" })).toBeVisible();
  const link = page.getByRole("link", { name: INCIDENT_TITLE });
  await expect(link).toBeVisible();
  await expect(page.getByText("shop/checkout")).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(`${web}/incidents/${INCIDENT_ID}`);
});

test("the detail page shows the likely cause and the cited evidence", async ({ page }) => {
  await page.goto(`${web}/incidents/${INCIDENT_ID}`);
  await expect(page.getByRole("heading", { name: INCIDENT_TITLE })).toBeVisible();
  await expect(page.getByText(CAUSE_TITLE)).toBeVisible();
  await expect(page.getByText(EVIDENCE_SUMMARY)).toBeVisible();
  await expect(page.getByText("Based on evidence [1]")).toBeVisible();
});

test("an unreachable API shows the error page and leaks no detail", async ({ page }) => {
  await page.goto(webDown);
  await expect(page.getByRole("heading", { name: "Cannot load incidents" })).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain("ECONNREFUSED");
  expect(html).not.toContain("kt_e2e");
});

test("an id that is not a UUID gives the 404 page", async ({ page }) => {
  const res = await page.goto(`${web}/incidents/not-a-uuid`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Incident not found" })).toBeVisible();
});

test("an unknown UUID gives the 404 page", async ({ page }) => {
  const res = await page.goto(`${web}/incidents/ffffffff-ffff-4fff-8fff-ffffffffffff`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Incident not found" })).toBeVisible();
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 375, height: 700 } });

  test("neither page scrolls horizontally", async ({ page }) => {
    await page.goto(web);
    await expect(page.getByRole("link", { name: INCIDENT_TITLE })).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    await page.goto(`${web}/incidents/${INCIDENT_ID}`);
    await expect(page.getByText(EVIDENCE_SUMMARY)).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
  });
});
