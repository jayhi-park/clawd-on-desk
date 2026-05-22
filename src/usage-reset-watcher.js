"use strict";

// Polls the Anthropic /api/oauth/usage endpoint to get current session usage.
// Calls onChange({ resetAt, percent }) where resetAt is a UTC ms timestamp
// (or null) and percent is 0-100 (or null).

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CREDENTIALS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const POLL_MS = 60000; // every 60 seconds
const FAST_POLL_MS = 15000; // faster when near limit

function readAccessToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    return raw && raw.claudeAiOauth && typeof raw.claudeAiOauth.accessToken === "string"
      ? raw.claudeAiOauth.accessToken
      : null;
  } catch { return null; }
}

function fetchUsage(token) {
  return new Promise((resolve) => {
    const req = https.get(USAGE_URL, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
      },
      timeout: 8000,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) { resolve(null); return; }
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function parseStatus(data) {
  if (!data || typeof data !== "object") return { resetAt: null, percent: null };
  const fiveHour = data.five_hour;
  if (!fiveHour || typeof fiveHour !== "object") return { resetAt: null, percent: null };
  const utilization = typeof fiveHour.utilization === "number" ? fiveHour.utilization : null;
  const resetsAt = typeof fiveHour.resets_at === "string" ? fiveHour.resets_at : null;
  const percent = utilization !== null ? Math.round(Math.max(0, Math.min(100, utilization))) : null;
  const resetAt = resetsAt ? new Date(resetsAt).getTime() : null;
  return {
    resetAt: (resetAt && resetAt > Date.now()) ? resetAt : null,
    percent,
  };
}

function createUsageResetWatcher(onChange) {
  let timer = null;
  let lastKey = "";
  let stopped = false;

  async function poll(resetLastKey = false) {
    if (stopped) return;
    timer = null;
    if (resetLastKey) lastKey = "";

    let status = { resetAt: null, percent: null };
    try {
      const token = readAccessToken();
      if (token) {
        const data = await fetchUsage(token);
        status = parseStatus(data);
      }
    } catch {}

    const key = `${status.resetAt}|${status.percent}`;
    if (key !== lastKey) {
      lastKey = key;
      try { onChange(status); } catch {}
    }

    if (!stopped) {
      // Poll faster when usage is high (>= 80%) so the display stays fresh
      const delay = (status.percent !== null && status.percent >= 80) ? FAST_POLL_MS : POLL_MS;
      timer = setTimeout(poll, delay);
    }
  }

  poll();

  return {
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    forcePoll() {
      if (stopped) return;
      if (timer) { clearTimeout(timer); timer = null; }
      poll(true);
    },
  };
}

module.exports = { createUsageResetWatcher };
