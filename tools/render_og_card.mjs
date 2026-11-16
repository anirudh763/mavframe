#!/usr/bin/env node
// Render the editable docs/og-card.svg to the fixed 1200x630 PNG used by social metadata.
// Usage: node tools/render_og_card.mjs (requires tests/web npm dependencies)
import { chromium } from '../tests/web/node_modules/playwright/index.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(root, 'docs/og-card.svg')).href);
  await page.screenshot({ path: path.join(root, 'docs/og-card.png'), type: 'png' });
} finally { await browser.close(); }
