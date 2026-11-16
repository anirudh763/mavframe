import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, startServer, waitParsed, axeViolations } from "./browser.mjs";

let server; let base; let browser;
before(async () => { ({ server, base } = await startServer()); browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}); });
after(async () => { await browser?.close(); server?.close(); });

async function newPage(context, hash = "#/", viewport = { width: 1440, height: 900 }) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  page.errors = errors;
  await page.setViewportSize(viewport);
  page.setDefaultTimeout(30000);
  await page.goto(base + hash);
  return page;
}
async function submitAuth(page, email, password) {
  await page.locator("#auth-email").fill(email);
  await page.locator("#auth-password").fill(password);
  await page.getByRole("button", { name: /Create profile|Log in/ }).click();
}

test("landing is quiet, the demo is separate, and the preview controls work", async () => {
  const context = await browser.newContext(); const page = await newPage(context);
  assert.equal(await page.locator("#screen-landing").isVisible(), true);
  assert.equal(await page.locator("#capture-result").isVisible(), false);
  assert.equal(await page.locator(".landing-header").getByText("Pricing", { exact: true }).count(), 0);
  assert.equal(await page.locator("[data-show-slide]").count(), 4);
  await page.waitForFunction(() => !document.getElementById("load-sample").disabled);
  await page.getByRole("button", { name: "Inspect sample frame" }).click();
  await page.waitForFunction(() => document.getElementById("hero-task-status").textContent.startsWith("Inspected through the C/Wasm parser"));
  assert.match(await page.locator("#hero-task-result").innerText(), /ATTITUDE.*CRC failed/);
  assert.ok(await page.locator("#hero-task-result .hero-bytes").innerText());
  assert.equal(await page.evaluate(() => sessionStorage.getItem("mavframe_session_v1")), null, "the inline sample works without starting a guest or profile session");
  await page.waitForFunction(() => document.querySelector('[data-slide="1"]:not([hidden])'), null, { timeout: 9000 });
  await page.getByRole("button", { name: "Finding export" }).click();
  assert.equal(await page.locator('[data-slide="3"]').isVisible(), true);
  await page.getByRole("button", { name: "Pause" }).click();
  assert.equal(await page.getByRole("button", { name: "Play" }).getAttribute("aria-pressed"), "true");
  await page.waitForTimeout(6600);
  assert.equal(await page.locator('[data-slide="3"]').isVisible(), true, "an explicit pause survives the normal-motion timer");
  await page.getByRole("button", { name: "Play" }).click();
  await page.locator(".mega > summary").first().click();
  await page.locator('a[href="#/app/frames"]').click();
  await waitParsed(page, "sample-flight.tlog");
  assert.equal(new URL(page.url()).hash, "#/app/frames");
  assert.ok(await page.locator("#frame-table tbody tr").count() > 0);
  await page.evaluate(() => { location.hash = "#/"; });
  await page.locator("#screen-landing").waitFor({ state: "visible" });
  await page.evaluate(() => { location.hash = "#/signup"; });
  await page.locator("#auth-submit").waitFor({ state: "visible" });
  await page.locator("[data-demo]").first().click();
  await waitParsed(page, "sample-flight.tlog");
  assert.match(await page.locator("#account-label").textContent(), /Guest demo/);
  assert.match(await page.locator("#source").textContent(), /Synthetic sample/);
  await page.close(); await context.close();
});

test("promoting the inline C/Wasm sample updates the workspace status instead of leaving a loading message", async () => {
  const context = await browser.newContext(); const page = await newPage(context, "#/");
  await page.waitForFunction(() => !document.getElementById("load-sample").disabled);
  await page.getByRole("button", { name: "Inspect sample frame" }).click();
  await page.waitForFunction(() => document.getElementById("hero-task-status").textContent.startsWith("Inspected through the C/Wasm parser"));
  await page.locator(".hero-actions [data-launch-workspace]").click();
  await page.waitForFunction(() => location.hash.startsWith("#/frames/"));
  assert.equal(await page.locator("#status").textContent(), "sample-flight.tlog loaded.");
  assert.equal(await page.locator("#detail-title").textContent(), "ATTITUDE at offset 13,866");
  assert.deepEqual(page.errors, []);
  await page.close(); await context.close();
});

test("provenance-labelled redacted public capture matches its documented C/Wasm counters", async () => {
  const context = await browser.newContext(); const page = await newPage(context, "#/");
  await page.waitForFunction(() => !document.getElementById("load-sample").disabled);
  await page.getByRole("button", { name: "Inspect privacy-scrubbed real capture" }).click();
  await page.waitForFunction(() => /163,851 valid frames, 0 CRC failures, 388 estimated sequence gaps/.test(document.getElementById("hero-real-status").textContent), null, { timeout: 30000 });
  assert.equal(new URL(page.url()).hash, "#/frames");
  assert.match(await page.locator("#m-frames").textContent(), /^163,851/);
  assert.match(await page.locator("#m-crc").textContent(), /^0/);
  assert.match(await page.locator("#source").textContent(), /real-flight-redacted\.tlog/);
  assert.match(await page.locator("#hero-real-status").textContent(), /public test data, not independently verified flight evidence/);
  assert.deepEqual(page.errors, []);
  await page.close(); await context.close();
});

test("profile A saved view stays separate from B and returns only safe settings", async () => {
  const context = await browser.newContext(); const page = await newPage(context, "#/signup");
  const passwordA = "local profile password A 2026";
  await submitAuth(page, "a@example.test", passwordA);
  await page.waitForFunction(() => location.hash === "#/app");
  const profileA = await page.evaluate(() => {
    const index = JSON.parse(localStorage.getItem("mavframe_profiles_v1"));
    const record = JSON.parse(localStorage.getItem("mavframe_profile_v1_" + index[0].id));
    return { index, record, keys: Object.keys(localStorage) };
  });
  assert.equal(profileA.record.kdf, "pbkdf2-hmac-sha256-v1");
  assert.equal(profileA.record.iterations, 600000);
  assert.equal(atob(profileA.record.salt).length, 16);
  assert.equal(atob(profileA.record.verifier).length, 32);
  assert.equal(JSON.stringify(profileA).includes(passwordA), false);
  assert.equal(profileA.keys.includes("mavframe_preferences_v1_" + profileA.record.id), false);

  await page.getByRole("button", { name: "Load sample" }).click();
  await waitParsed(page, "sample-flight.tlog");
  await page.evaluate(() => { location.hash = "#/app/frames?check=crc"; });
  await page.waitForFunction(() => document.querySelector("#frame-table tbody tr"));
  await page.evaluate(() => { location.hash = "#/profile"; });
  await page.getByLabel("Saved view name").fill("A CRC review");
  await page.getByRole("button", { name: "Save view settings" }).click();
  await page.waitForFunction(() => /capture data is not/.test(document.querySelector("#profile-status").textContent));
  const workspaceA = await page.evaluate((id) => JSON.parse(localStorage.getItem("mavframe_workspace_v1_" + id)), profileA.record.id);
  assert.equal(workspaceA.userId, profileA.record.id);
  assert.equal(workspaceA.workspaces[0].context.screen, "frames");
  assert.equal(workspaceA.workspaces[0].context.check, "crc");
  assert.equal(JSON.stringify(workspaceA).includes("sample-flight.tlog"), false);
  const bounded = await page.evaluate(async () => {
    const service = await import("./js/local-profile.js");
    for (let index = 1; index < 10; index++) await service.saveWorkspace("Extra view " + index, { screen: "capture" }, "light");
    let limit = "";
    try { await service.saveWorkspace("Eleventh view", { screen: "capture" }, "light"); } catch (error) { limit = error.message; }
    const count = service.loadWorkspace().length;
    await service.deleteWorkspace("Extra view 1");
    const afterDelete = service.loadWorkspace().length;
    return { limit, count, afterDelete, names: service.loadWorkspace().map((item) => item.name) };
  });
  assert.match(bounded.limit, /10-saved-view limit/);
  assert.equal(bounded.count, 10);
  assert.equal(bounded.afterDelete, 9);
  assert.ok(bounded.names.includes("A CRC review"), "the oldest named view was not silently evicted");

  await page.goto(base + "#/app");
  await page.locator("#account-menu > summary").click();
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForFunction(() => location.hash === "#/");
  assert.equal(await page.locator("#capture-result").isVisible(), false);

  const passwordB = "local profile password B 2026";
  await page.goto(base + "#/signup"); await submitAuth(page, "b@example.test", passwordB);
  await page.waitForFunction(() => location.hash === "#/app");
  await page.evaluate(() => { location.hash = "#/saved"; });
  assert.match(await page.locator("#saved-list").textContent(), /No saved views yet/);
  const profiles = await page.evaluate(() => JSON.parse(localStorage.getItem("mavframe_profiles_v1")));
  assert.deepEqual(profiles.map((item) => item.email), ["a@example.test", "b@example.test"]);
  assert.equal(await page.evaluate((id) => localStorage.getItem("mavframe_workspace_v1_" + id), profiles[1].id), null);
  await page.locator("#saved-title").waitFor();
  await page.evaluate(() => { location.hash = "#/"; });
  await page.getByRole("link", { name: "Log in" }).click();
  await submitAuth(page, "a@example.test", "wrong local profile password");
  assert.match(await page.getByRole("alert").textContent(), /did not match/);
  await submitAuth(page, "a@example.test", passwordA);
  await page.waitForFunction(() => location.hash === "#/app");
  const preserved = await page.evaluate(async (id) => {
    const key = "mavframe_workspace_v1_" + id; const original = localStorage.getItem(key);
    const unsupported = JSON.stringify({ schema: 99, userId: id, workspaces: [] });
    localStorage.setItem(key, unsupported);
    const service = await import("./js/local-profile.js"); let error = "";
    try { await service.saveWorkspace("Would overwrite", { screen: "frames" }, "light"); } catch (cause) { error = cause.message; }
    const unchanged = localStorage.getItem(key) === unsupported;
    localStorage.setItem(key, original);
    return { error, unchanged };
  }, profileA.record.id);
  assert.match(preserved.error, /unsupported schema/);
  assert.equal(preserved.unchanged, true);
  await page.evaluate(() => { location.hash = "#/saved"; });
  await page.getByRole("button", { name: "Delete saved view Extra view 2" }).waitFor();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete saved view Extra view 2" }).click();
  await page.getByRole("button", { name: "Delete saved view Extra view 2" }).waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "Delete saved view Extra view 2" }).count(), 0);
  await page.getByRole("button", { name: "Open A CRC review" }).click();
  await page.waitForFunction(() => location.hash === "#/frames?check=crc");
  assert.equal(await page.evaluate((id) => localStorage.getItem("mavframe_profile_v1_" + id).includes("password"), profileA.record.id), false);
  await page.close(); await context.close();
});

test("guest save prompt can be cancelled back to the live task and later imports only its view settings", async () => {
  const context = await browser.newContext(); const page = await newPage(context, "#/signup");
  await page.getByRole("link", { name: "Continue with demo" }).click();
  await waitParsed(page, "sample-flight.tlog");
  await page.goto(base + "#/frames?check=crc");
  await page.waitForSelector("#frame-table tbody tr a");
  await page.locator("#save-profile-link").click();
  await page.locator("#auth-pending-save").waitFor({ state: "visible" });
  assert.match(await page.locator("#auth-pending-save").textContent(), /capture bytes stay in this tab/);
  await page.getByRole("link", { name: /Return to guest task/ }).click();
  await page.waitForFunction(() => location.hash === "#/frames?check=crc");
  assert.equal(await page.locator("#frame-table").isVisible(), true);
  assert.equal(await page.locator("#frame-table tbody tr").count(), 3);
  await page.locator("#save-profile-link").click();
  await submitAuth(page, "guest-save@example.test", "guest save profile password");
  await page.waitForFunction(() => location.hash === "#/profile");
  await page.getByRole("button", { name: "Save guest view settings to profile" }).click();
  await page.waitForFunction(() => /Only view settings were imported/.test(document.getElementById("profile-status").textContent));
  const stored = await page.evaluate(() => {
    const id = JSON.parse(sessionStorage.getItem("mavframe_session_v1")).id;
    return { workspace: JSON.parse(localStorage.getItem(`mavframe_workspace_v1_${id}`)), keys: Object.keys(localStorage).join(" ") };
  });
  assert.deepEqual(stored.workspace.workspaces[0].context, { screen: "frames", check: "crc", msg: null, page: 1, tab: "decoded", field: null, index: null });
  assert.doesNotMatch(stored.keys, /capture|payload|bytes/i);
  assert.doesNotMatch(JSON.stringify(stored.workspace), /sample-flight\.tlog|payload/);
  assert.match(await page.locator("#source").textContent(), /^sample-flight\.tlog/);
  await page.close(); await context.close();
});

test("local profile storage failures are announced and do not create a session", async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).includes("storage_probe")) throw new DOMException("Blocked", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  const page = await newPage(context, "#/signup");
  await page.locator("#auth-submit").waitFor({ state: "visible" });
  await submitAuth(page, "blocked@example.test", "a sufficiently long password");
  assert.match(await page.getByRole("alert").textContent(), /Browser storage is unavailable/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("mavframe_session_v1")), null);
  await page.close(); await context.close();
});

test("oversized local profile records are rejected before parsing", async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem("mavframe_profiles_v1", "x".repeat(256 * 1024 + 1)));
  const page = await newPage(context, "#/login");
  await submitAuth(page, "large@example.test", "a sufficiently long password");
  assert.match(await page.getByRole("alert").textContent(), /exceeds the 256 KiB safety limit/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem("mavframe_session_v1")), null);
  await page.close(); await context.close();
});

test("login rejects overlong passwords before Web Crypto derivation", async () => {
  const context = await browser.newContext(); const page = await newPage(context, "#/signup");
  await submitAuth(page, "bounded-login@example.test", "a sufficiently long password");
  await page.waitForFunction(() => location.hash === "#/app");
  const result = await page.evaluate(async () => {
    const service = await import("./js/local-profile.js"); let error = "";
    try { await service.login("bounded-login@example.test", "x".repeat(1025)); } catch (cause) { error = cause.message; }
    return error;
  });
  assert.match(result, /between 12 and 1,024 characters/);
  await page.close(); await context.close();
});

test("profile signup declines browsers without a cross-tab lock", async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }));
  const page = await newPage(context, "#/signup");
  await submitAuth(page, "nolock@example.test", "a sufficiently long password");
  assert.match(await page.getByRole("alert").textContent(), /Web Locks enabled/);
  assert.equal(await page.evaluate(() => localStorage.getItem("mavframe_profiles_v1")), null);
  await page.close(); await context.close();
});

test("reduced motion disables carousel autoplay without hiding manual selectors", async () => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await newPage(context);
  assert.equal(await page.locator("#showcase-pause").isDisabled(), true);
  assert.equal(await page.locator("#showcase-pause").textContent(), "Autoplay off");
  await page.getByRole("button", { name: "CRC filter" }).click();
  assert.equal(await page.locator('[data-slide="1"]').isVisible(), true);
  await page.waitForTimeout(6600);
  assert.equal(await page.locator('[data-slide="1"]').isVisible(), true);
  await page.close(); await context.close();
});

test("public, auth, profile and saved routes reflow and scan in light and dark at both requested sizes", async () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext();
      if (theme === "dark") await context.addInitScript(() => localStorage.setItem("mavframe-theme", "dark"));
      const page = await newPage(context, "#/", viewport);
      for (const route of ["#/", "#/signup", "#/login"]) {
        await page.goto(base + route);
        await page.waitForFunction((path) => location.hash === path, route);
        const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
        assert.equal(dimensions.width, dimensions.viewport, route + " has no document overflow at " + viewport.width + " in " + theme);
        assert.deepEqual((await axeViolations(page)).violations, [], route + " axe in " + theme + " at " + viewport.width);
      }
      await page.evaluate(async () => { const service = await import("./js/local-profile.js"); service.startGuest(); location.hash = "#/profile"; });
      await page.waitForFunction(() => location.hash === "#/profile");
      assert.deepEqual((await axeViolations(page)).violations, [], "#/profile axe in " + theme + " at " + viewport.width);
      await page.evaluate(() => { location.hash = "#/saved"; });
      await page.waitForFunction(() => location.hash === "#/saved");
      assert.deepEqual((await axeViolations(page)).violations, [], "#/saved axe in " + theme + " at " + viewport.width);
      const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
      assert.equal(dimensions.width, dimensions.viewport, "saved route has no document overflow");
      await page.close(); await context.close();
    }
  }
});

test("logout in one tab invalidates the same profile session in another tab", async () => {
  const context = await browser.newContext(); const first = await newPage(context, "#/signup");
  const password = "shared local profile password";
  await submitAuth(first, "tabs@example.test", password);
  await first.waitForFunction(() => location.hash === "#/app");
  const second = await newPage(context, "#/login");
  await submitAuth(second, "tabs@example.test", password);
  await second.waitForFunction(() => location.hash === "#/app");
  await first.locator("#account-menu > summary").click();
  await first.getByRole("button", { name: "Log out" }).click();
  await first.waitForFunction(() => location.hash === "#/");
  await second.waitForFunction(() => location.hash === "#/", null, { timeout: 10000 });
  assert.equal(await second.locator("#workspace-shell").isVisible(), false);
  await first.close(); await second.close(); await context.close();
});

test("removing an active profile record in another tab clears its local session", async () => {
  const context = await browser.newContext(); const first = await newPage(context, "#/signup");
  const password = "profile storage removal password";
  await submitAuth(first, "removed@example.test", password);
  await first.waitForFunction(() => location.hash === "#/app");
  const second = await newPage(context, "#/login");
  await submitAuth(second, "removed@example.test", password);
  await second.waitForFunction(() => location.hash === "#/app");
  await first.evaluate(() => {
    const index = JSON.parse(localStorage.getItem("mavframe_profiles_v1"));
    localStorage.removeItem("mavframe_profile_v1_" + index[0].id);
  });
  await second.waitForFunction(() => location.hash === "#/");
  assert.equal(await second.locator("#workspace-shell").isVisible(), false);
  await first.close(); await second.close(); await context.close();
});

test("logout while the sample fetch is pending prevents late data from appearing", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" }); const page = await context.newPage();
  page.setDefaultTimeout(30000);
  let release; const pending = new Promise((resolve) => { release = resolve; });
  let seen; const requested = new Promise((resolve) => { seen = resolve; });
  await page.route("**/sample/sample-flight.tlog", async (route) => { seen(); await pending; await route.continue(); });
  await page.goto(base + "#/signup");
  await page.locator("#auth-submit").waitFor({ state: "visible" });
  await page.locator("[data-demo]").first().click();
  await requested;
  await page.locator("#account-menu > summary").click();
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForFunction(() => location.hash === "#/");
  release();
  await page.waitForTimeout(250);
  assert.equal(await page.locator("#workspace-shell").isVisible(), false);
  assert.equal(await page.evaluate(() => document.getElementById("status").textContent.includes("loaded.")), false);
  await page.close(); await context.close();
});

test("concurrent tabs cannot create duplicate profiles or lose an index update", async () => {
  const context = await browser.newContext();
  const first = await newPage(context, "#/signup");
  const second = await newPage(context, "#/signup");
  const results = await Promise.all([first, second].map((page) => page.evaluate(async () => {
    const service = await import("./js/local-profile.js");
    try { await service.signup("race@example.test", "concurrent profile password"); return "created"; }
    catch (error) { return error.message; }
  })));
  assert.equal(results.filter((value) => value === "created").length, 1);
  assert.equal(results.filter((value) => /already exists/.test(value)).length, 1);
  assert.equal(await first.evaluate(() => JSON.parse(localStorage.getItem("mavframe_profiles_v1")).length), 1);
  assert.equal(await first.evaluate(() => Object.keys(localStorage).filter((key) => /^mavframe_profile_v1_/.test(key)).length), 1);
  await first.close(); await second.close(); await context.close();
});

test("saved view writes serialize across tabs, reject long names, and cancel after logout", async () => {
  const context = await browser.newContext(); const first = await newPage(context, "#/signup");
  const password = "shared workspace profile password";
  await submitAuth(first, "views@example.test", password);
  await first.waitForFunction(() => location.hash === "#/app");
  const second = await newPage(context, "#/login");
  await submitAuth(second, "views@example.test", password);
  await second.waitForFunction(() => location.hash === "#/app");
  const writes = await Promise.all([first, second].map((page, index) => page.evaluate(async (name) => {
    const service = await import("./js/local-profile.js");
    await service.saveWorkspace(name, { screen: "frames" }, "light");
    return service.loadWorkspace().map((item) => item.name);
  }, `Concurrent view ${index + 1}`)));
  assert.ok(writes.some((names) => names.length === 2));
  assert.equal(await first.evaluate(async () => (await import("./js/local-profile.js")).loadWorkspace().length), 2);
  const boundary = await first.evaluate(async () => {
    const service = await import("./js/local-profile.js"); let error = "";
    try { await service.saveWorkspace("x".repeat(81), { screen: "frames" }, "light"); } catch (cause) { error = cause.message; }
    return error;
  });
  assert.match(boundary, /80 characters or fewer/);
  await first.evaluate(async () => {
    const service = await import("./js/local-profile.js");
    let entered; const lockEntered = new Promise((resolve) => { entered = resolve; });
    let release; const lockHeld = new Promise((resolve) => { release = resolve; });
    window.__releaseSaveLock = release;
    window.__heldWorkspaceLock = navigator.locks.request("mavframe:workspace:v1", async () => { entered(); await lockHeld; });
    await lockEntered;
    window.__pendingSave = service.saveWorkspace("After logout", { screen: "capture" }, "light").then(() => "saved", (error) => error.name);
  });
  await first.evaluate(() => (document.getElementById("logout-button")).click());
  await first.waitForFunction(() => location.hash === "#/");
  await first.evaluate(() => window.__releaseSaveLock());
  assert.equal(await first.evaluate(() => window.__pendingSave), "AbortError");
  const keptViews = await first.evaluate((email) => {
    const profile = JSON.parse(localStorage.getItem("mavframe_profiles_v1")).find((item) => item.email === email);
    return JSON.parse(localStorage.getItem("mavframe_workspace_v1_" + profile.id)).workspaces.map((item) => item.name);
  }, "views@example.test");
  assert.deepEqual(keptViews.sort(), ["Concurrent view 1", "Concurrent view 2"], "logout preserves intentional saved settings and cancels the pending write");
  await first.close(); await second.close(); await context.close();
});

test("logout during PBKDF2 signup or login cannot resurrect a local profile session", async () => {
  const context = await browser.newContext();
  const page = await newPage(context, "#/signup");
  await page.evaluate(async () => {
    const subtle = crypto.subtle;
    const actual = subtle.deriveBits.bind(subtle);
    Object.defineProperty(subtle, "deriveBits", { configurable: true, value: (...args) => {
      window.__deriveEntered = true;
      return new Promise((resolve, reject) => { window.__releaseDerive = () => actual(...args).then(resolve, reject); });
    } });
    const service = await import("./js/local-profile.js");
    window.__pendingProfileWork = service.signup("cancel@example.test", "pending profile password").then(() => "created", (error) => error.name);
  });
  await page.waitForFunction(() => window.__deriveEntered === true);
  await page.evaluate(async () => { const service = await import("./js/local-profile.js"); service.logout(); window.__releaseDerive(); });
  assert.equal(await page.evaluate(() => window.__pendingProfileWork), "AbortError");
  assert.equal(await page.evaluate(() => localStorage.getItem("mavframe_profiles_v1")), null);
  await page.close();

  const loginPage = await newPage(context, "#/signup");
  await loginPage.evaluate(async () => {
    const service = await import("./js/local-profile.js");
    await service.signup("cancel-login@example.test", "pending login profile password");
    service.logout();
    const subtle = crypto.subtle;
    const actual = subtle.deriveBits.bind(subtle);
    Object.defineProperty(subtle, "deriveBits", { configurable: true, value: (...args) => {
      window.__loginDeriveEntered = true;
      return new Promise((resolve, reject) => { window.__releaseLoginDerive = () => actual(...args).then(resolve, reject); });
    } });
    window.__pendingLogin = service.login("cancel-login@example.test", "pending login profile password").then(() => "logged-in", (error) => error.name);
  });
  await loginPage.waitForFunction(() => window.__loginDeriveEntered === true);
  await loginPage.evaluate(async () => { const service = await import("./js/local-profile.js"); service.logout(); window.__releaseLoginDerive(); });
  assert.equal(await loginPage.evaluate(() => window.__pendingLogin), "AbortError");
  assert.equal(await loginPage.evaluate(() => sessionStorage.getItem("mavframe_session_v1")), null);
  await loginPage.close(); await context.close();
});

test("encrypted profile backup round-trips safe settings to a fresh context and rejects tampering", async () => {
  const contextA = await browser.newContext(); const source = await newPage(contextA, "#/signup");
  const password = "backup passphrase with enough length";
  const backup = await source.evaluate(async password => {
    const service = await import("./js/local-profile.js");
    await service.signup("backup@example.test", password);
    await service.savePreferences({ theme: "dark" });
    await service.saveWorkspace("Flight review", { screen: "details", check: "crc", tab: "bytes", index: 17, field: "ATTITUDE.roll" }, "dark");
    return service.createEncryptedBackup(password);
  }, password);
  const envelope = JSON.parse(backup);
  assert.equal(envelope.appId, "mavframe"); assert.equal(envelope.version, 1); assert.equal(envelope.kdf.iterations, 600000);
  assert.equal(envelope.cipher.algorithm, "AES-GCM"); assert.equal(atob(envelope.cipher.iv).length, 12);
  assert.equal(backup.includes("backup@example.test"), false);
  await contextA.close();

  const contextB = await browser.newContext(); const target = await newPage(contextB, "#/profile");
  const imported = await target.evaluate(async ({ backup, password }) => {
    const service = await import("./js/local-profile.js");
    let wrong = ""; try { await service.previewEncryptedBackup(backup, "wrong passphrase long"); } catch (error) { wrong = error.message; }
    let tampered = ""; const broken = JSON.parse(backup); broken.cipher.ciphertext = broken.cipher.ciphertext.slice(0, -4) + "AAAA";
    try { await service.previewEncryptedBackup(JSON.stringify(broken), password); } catch (error) { tampered = error.message; }
    const preview = await service.previewEncryptedBackup(backup, password);
    const result = await service.commitEncryptedBackup(preview.stageId, "restore");
    const views = service.loadWorkspace(); const prefs = service.loadPreferences();
    service.logout();
    const logged = await service.login("backup@example.test", password);
    return { wrong, tampered, result, views, prefs, email: logged.email, profileCount: service.listProfiles().length };
  }, { backup, password });
  assert.match(imported.wrong, /could not be decrypted/);
  assert.match(imported.tampered, /could not be decrypted/);
  assert.equal(imported.result.createdProfile, true);
  assert.equal(imported.views.length, 1); assert.equal(imported.views[0].name, "Flight review");
  assert.deepEqual(imported.views[0].context, { screen: "details", check: "crc", tab: "bytes", msg: null, index: 17, page: 1, field: "ATTITUDE.roll" });
  assert.equal(imported.prefs.theme, "dark"); assert.equal(imported.email, "backup@example.test"); assert.equal(imported.profileCount, 1);
  await target.close(); await contextB.close();
});

test("Account Settings exports an encrypted backup and restores it into a fresh browser context", async () => {
  const passphrase = "ui backup passphrase long enough";
  const sourceContext = await browser.newContext(); const source = await newPage(sourceContext, "#/signup");
  await submitAuth(source, "ui-backup@example.test", "source profile password long");
  await source.waitForFunction(() => location.hash === "#/app");
  await source.goto(base + "#/profile");
  await source.locator("#context-name").fill("UI backup review");
  await source.getByRole("button", { name: "Save view settings" }).click();
  await source.waitForFunction(() => /Saved “UI backup review”/.test(document.getElementById("profile-status").textContent));
  await source.locator("#backup-passphrase").fill(passphrase);
  const downloadEvent = source.waitForEvent("download");
  await source.getByRole("button", { name: "Export encrypted backup" }).click();
  const download = await downloadEvent; const backup = await fs.readFile(await download.path(), "utf8");
  const envelope = JSON.parse(backup);
  assert.equal(envelope.appId, "mavframe"); assert.equal(envelope.cipher.algorithm, "AES-GCM");
  assert.equal(backup.includes("ui-backup@example.test"), false);
  assert.equal(backup.includes("UI backup review"), false);
  await source.close(); await sourceContext.close();

  const targetContext = await browser.newContext(); const target = await newPage(targetContext, "#/signup");
  await submitAuth(target, "recipient@example.test", "recipient profile password long");
  await target.waitForFunction(() => location.hash === "#/app");
  await target.goto(base + "#/profile");
  await target.locator("#backup-passphrase").fill(passphrase);
  await target.locator("#backup-file").setInputFiles({ name: "mavframe-profile-backup.json", mimeType: "application/json", buffer: Buffer.from(backup) });
  await target.getByRole("button", { name: "Preview encrypted backup" }).click();
  await target.waitForFunction(() => /Verified encrypted backup for ui-backup@example\.test: 1 saved views/.test(document.getElementById("backup-preview-text").textContent));
  await target.getByRole("button", { name: "Restore backup" }).click();
  await target.waitForFunction(() => document.getElementById("profile-email").textContent === "ui-backup@example.test");
  assert.match(await target.locator("#backup-status").textContent(), /Backup restored locally/);
  await target.evaluate(() => { location.hash = "#/saved"; });
  await target.waitForFunction(() => location.hash === "#/saved");
  assert.match(await target.locator("#saved-list").textContent(), /UI backup review/);
  const profiles = await target.evaluate(() => JSON.parse(localStorage.getItem("mavframe_profiles_v1")).map(item => item.email));
  assert.deepEqual(profiles, ["recipient@example.test", "ui-backup@example.test"]);
  assert.deepEqual(target.errors, []);
  await target.close(); await targetContext.close();
});

test("backup merge overflow and quota-failed restore leave every existing profile key unchanged", async () => {
  const passphrase = "transfer backup phrase with length";
  const sourceContext = await browser.newContext(); const source = await newPage(sourceContext, "#/signup");
  const backup = await source.evaluate(async passphrase => {
    const service = await import("./js/local-profile.js");
    await service.signup("rollback@example.test", passphrase);
    await service.savePreferences({ theme: "dark" });
    await service.saveWorkspace("Imported review", { screen: "details", check: "crc", index: 3 }, "dark");
    return service.createEncryptedBackup(passphrase);
  }, passphrase);
  await source.close(); await sourceContext.close();

  const targetContext = await browser.newContext(); const target = await newPage(targetContext, "#/signup");
  const outcome = await target.evaluate(async ({ backup, passphrase }) => {
    const service = await import("./js/local-profile.js");
    await service.signup("rollback@example.test", "target profile password long");
    await service.savePreferences({ theme: "light" });
    for (let index = 1; index <= 10; index++) await service.saveWorkspace(`Existing ${index}`, { screen: "capture" }, "light");
    const snapshot = () => Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)]));
    const before = snapshot(); const sessionBefore = sessionStorage.getItem("mavframe_session_v1");
    const preview = await service.previewEncryptedBackup(backup, passphrase);
    let mergeError = "";
    try { await service.commitEncryptedBackup(preview.stageId, "merge"); } catch (error) { mergeError = error.message; }
    const afterMerge = snapshot();
    const originalSet = Storage.prototype.setItem; let rejectOnce = true;
    Storage.prototype.setItem = function (key, value) {
      if (rejectOnce && key === `mavframe_workspace_v1_${service.getSession().id}`) {
        rejectOnce = false; throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      return originalSet.call(this, key, value);
    };
    let restoreError = "";
    try { await service.commitEncryptedBackup(preview.stageId, "restore"); } catch (error) { restoreError = error.message; }
    Storage.prototype.setItem = originalSet;
    return { mergeError, mergeUnchanged: JSON.stringify(before) === JSON.stringify(afterMerge), restoreError,
      restoreUnchanged: JSON.stringify(before) === JSON.stringify(snapshot()), sessionUnchanged: sessionStorage.getItem("mavframe_session_v1") === sessionBefore };
  }, { backup, passphrase });
  assert.match(outcome.mergeError, /exceed the 10-view limit/);
  assert.equal(outcome.mergeUnchanged, true);
  assert.match(outcome.restoreError, /Quota exceeded/);
  assert.equal(outcome.restoreUnchanged, true);
  assert.equal(outcome.sessionUnchanged, true);
  await target.close(); await targetContext.close();
});

test("legacy colon-prefixed profile data migrates to mavframe_ keys without deleting the recovery copy", async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    localStorage.setItem("mavframe:profiles:v1", JSON.stringify([{ id, email: "legacy@example.test" }]));
    localStorage.setItem(`mavframe:profile:v1:${id}`, JSON.stringify({ schema: 1, id, email: "legacy@example.test", createdAt: "2026-01-01T00:00:00.000Z", kdf: "pbkdf2-hmac-sha256-v1", iterations: 600000, salt: btoa("\0".repeat(16)), verifier: btoa("\0".repeat(32)) }));
    localStorage.setItem(`mavframe:workspace:v1:${id}`, JSON.stringify({ schema: 1, userId: id, workspaces: [{ name: "Legacy view", savedAt: "2026-01-01T00:00:00.000Z", context: { screen: "frames" }, theme: "dark" }] }));
    localStorage.setItem(`mavframe:preferences:v1:${id}`, JSON.stringify({ schema: 1, userId: id, theme: "dark" }));
    sessionStorage.setItem("mavframe:session:v1", JSON.stringify({ schema: 1, mode: "profile", id, nonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
  });
  const page = await newPage(context, "#/profile");
  const migration = await page.evaluate(async () => {
    const service = await import("./js/local-profile.js");
    return { email: service.getProfile()?.email, views: service.loadWorkspace().map(view => view.name), theme: service.loadPreferences().theme,
      newIndex: !!localStorage.getItem("mavframe_profiles_v1"), legacyIndex: !!localStorage.getItem("mavframe:profiles:v1"),
      newWorkspace: !!localStorage.getItem("mavframe_workspace_v1_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      newSession: !!sessionStorage.getItem("mavframe_session_v1"), oldSession: !!sessionStorage.getItem("mavframe:session:v1") };
  });
  assert.deepEqual(migration, { email: "legacy@example.test", views: ["Legacy view"], theme: "dark", newIndex: true, legacyIndex: true, newWorkspace: true, newSession: true, oldSession: false });
  await page.close(); await context.close();
});
