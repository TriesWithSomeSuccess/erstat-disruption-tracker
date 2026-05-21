// lib/fetch.js
// Wraps /opt/erstat/bin/curl-impersonate-chrome to bypass Cloudflare WAF
// when scraping nshealth.ca from the erstat-support LXC.

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileP = promisify(execFile);

const CURL = process.env.CURL_IMPERSONATE_PATH || '/opt/erstat/bin/curl-impersonate-chrome';

async function fetchHtml(url, { timeoutMs = 30_000 } = {}) {
  const t0 = Date.now();
  try {
    const { stdout, stderr } = await execFileP(
      CURL,
      [
        '-s',
        '--compressed',
        '--max-time', String(Math.ceil(timeoutMs / 1000)),
        url,
      ],
      {
        timeout: timeoutMs + 2_000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    const elapsed = Date.now() - t0;
    if (!stdout || stdout.length < 500) {
      throw new Error(`Suspiciously small response (${stdout?.length ?? 0} bytes) from ${url}; likely WAF challenge. stderr=${stderr?.slice(0, 200)}`);
    }
    if (process.env.NSHEALTH_FETCH_DEBUG === '1') {
      console.error(`[fetch] ${elapsed}ms ${stdout.length}B ${url}`);
    }
    return stdout;
  } catch (err) {
    throw new Error(`fetchHtml(${url}) failed after ${Date.now() - t0}ms: ${err.message}`);
  }
}

module.exports = { fetchHtml };
