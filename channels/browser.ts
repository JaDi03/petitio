import { chromium } from "playwright";

import type { FileClaim } from "../agent/actions.js";

const REFERENCE = /^[A-Z0-9][A-Z0-9-]{3,19}$/;
const TIMEOUT_MS = 30_000;

// Fills the airline's claim form in a headless browser. The page may load only from the form's
// own https host; any other request (a redirect, a script, a link) is aborted.
export const fileClaimInBrowser: FileClaim = async (formUrl, fields) => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    context.setDefaultTimeout(TIMEOUT_MS);
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === "https:" && url.host === formUrl.host) await route.continue();
      else await route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    const res = await page.goto(formUrl.href, { waitUntil: "load" });
    if (!res?.ok() || new URL(page.url()).host !== formUrl.host) throw new Error("the claim form did not load from the airline's site");

    // the field names of the airline's form
    await page.fill("[name=firstName]", fields.firstName);
    await page.fill("[name=lastName]", fields.lastName);
    await page.fill("[name=email]", fields.email);
    await page.fill("[name=bookingRef]", fields.bookingRef);
    await page.fill("[name=flightNumber]", fields.flightNumber);
    await page.fill("[name=flightDate]", fields.flightDate);
    await page.check("[name=request][value=compensation]");
    await page.fill("[name=description]", fields.description);
    await page.check("[name=privacy]");
    const before = await page.screenshot({ fullPage: true });

    await page.click("#send");
    const box = page.locator("#case-reference");
    const refused = page.locator(".field-error:not(:empty)").first();
    await Promise.race([box.waitFor({ state: "visible" }), refused.waitFor({ state: "visible" })]);
    if (await refused.isVisible()) {
      const said = ((await refused.textContent()) ?? "").replace(/\s+/g, " ").slice(0, 120);
      throw new Error(`the airline's form refused the claim: ${said}`);
    }
    const reference = (await box.textContent())?.trim() ?? "";
    const after = await page.screenshot({ fullPage: true });
    if (!REFERENCE.test(reference)) throw new Error("the airline's page did not show a case number");
    return { reference, before, after };
  } finally {
    await browser.close();
  }
};
