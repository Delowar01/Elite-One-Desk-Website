/**
 * What every browser probe shares: the browser, and nothing else.
 *
 * Playwright's own Chromium by default — `npx playwright install chromium`
 * puts it where Playwright looks for it. A machine that already carries a
 * Chromium (a sandbox, a CI image with one preinstalled) can name it with
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE` instead. No path is written here: a probe
 * that only runs on the machine it was written on is not a test anybody else
 * can repeat.
 *
 * The full Chromium in its new headless mode either way (`channel:
 * "chromium"`), never Playwright's separate headless shell, which a plain
 * headless launch would otherwise pick: the shell is a different build of the
 * engine, and the probes measure scrolling, frames and hit-testing — they
 * should measure the browser people use, the same kind on every machine.
 */
import { chromium, type Browser, type LaunchOptions } from "playwright";

export function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?.trim() || undefined;
  return chromium.launch({ ...options, ...(executablePath ? { executablePath } : { channel: "chromium" }) });
}
