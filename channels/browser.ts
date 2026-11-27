import { chromium, type Page } from "playwright";

import { CASE_REFERENCE, ClaimRefused, UnconfirmedClaim, type FileClaim } from "../agent/actions.js";

const TIMEOUT_MS = 30_000;

async function shots(page: Page, before: Buffer): Promise<Buffer[]> {
  const after = await page.screenshot({ fullPage: true }).catch(() => null);
  return after ? [before, after] : [before];
}

// Fills the airline's claim form in a headless browser. The page may load only from the form's
// own https host; any other request (a redirect, a script, a link) is aborted.
export const fileClaimInBrowser: FileClaim = async (formUrl, fields, hooks) => {
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

    const box = page.locator("#case-reference");
    const refused = page.locator(".field-error:not(:empty)").first();
    hooks.beforeSend();
    // from here the form may be with the airline: only a case number or a plain refusal is certain
    let outcome: { reference: string } | { refusal: string } | null = null;
    try {
      await page.click("#send");
      await Promise.race([box.waitFor({ state: "visible" }), refused.waitFor({ state: "visible" })]);
      const reference = (await box.isVisible()) ? ((await box.textContent())?.trim() ?? "") : "";
      if (CASE_REFERENCE.test(reference)) outcome = { reference };
      else if (reference === "" && (await refused.isVisible())) {
        outcome = { refusal: ((await refused.textContent()) ?? "").replace(/\s+/g, " ").slice(0, 120) };
      }
    } catch {
      outcome = null;
    }
    const photos = await shots(page, before);
    if (outcome && "reference" in outcome) return { reference: outcome.reference, before, after: photos[1] ?? before };
    if (outcome) throw new ClaimRefused(`the airline's form refused the claim: ${outcome.refusal}`);
    throw new UnconfirmedClaim("the form was sent but the airline's page showed no case number", photos);
  } finally {
    await browser.close().catch(() => undefined);
  }
};
