// Find a Chromium the browser suites can launch.
//
// Four scripts used to hardcode `chromium-1228`, which worked only as long as
// that exact build happened to be the one on this machine: playwright-core
// already expects a newer one, so `npx playwright install` would fetch a
// different build and leave the hardcoded path pointing at something that may
// later be pruned. It also made the suites unrunnable anywhere else, CI
// included.
//
// Resolution order, first hit wins:
//   1. $PLAYWRIGHT_CHROMIUM or $CHROME_PATH  — how CI (and anyone with a
//      system Chrome) says exactly which binary to use.
//   2. playwright-core's own expected path, if it is actually on disk.
//   3. The newest chromium-* in the Playwright cache that exists.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function cacheRoot() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  }
  return path.join(os.homedir(), ".cache", "ms-playwright");
}

/** Candidate binaries inside one chromium-<build> directory. */
function binariesIn(dir) {
  return [
    path.join(dir, "chrome-linux64", "chrome"),
    path.join(dir, "chrome-linux", "chrome"),
    path.join(dir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
    path.join(dir, "chrome-win", "chrome.exe"),
  ];
}

export async function chromiumPath() {
  const explicit = process.env.PLAYWRIGHT_CHROMIUM || process.env.CHROME_PATH;
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`PLAYWRIGHT_CHROMIUM/CHROME_PATH is set but missing: ${explicit}`);
    }
    return explicit;
  }

  try {
    const { chromium } = await import("playwright-core");
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {
    // playwright-core could not resolve one; fall through to the cache scan.
  }

  const root = cacheRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    entries = [];
  }
  const builds = entries
    .filter((e) => /^chromium-\d+$/.test(e))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const build of builds) {
    for (const bin of binariesIn(path.join(root, build))) {
      if (fs.existsSync(bin)) return bin;
    }
  }

  throw new Error(
    "no Chromium found. Install one with `npx playwright install chromium`, " +
      "or point PLAYWRIGHT_CHROMIUM at a Chrome/Chromium binary.",
  );
}
