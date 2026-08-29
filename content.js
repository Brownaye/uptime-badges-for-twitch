// Uptime Badges for Twitch - content script
//
// Finds channel cards on the page, resolves each channel's stream start
// time through the Helix API (batched and cached), and overlays an
// uptime badge aligned with Twitch's own viewer-count pill.

const TICK_MS = 30 * 1000; // refresh badge text/color
const REFRESH_MS = 60 * 1000; // recheck badged channels (catch stream endings)
const CACHE_TTL = 5 * 60 * 1000; // how long a "live/not live" answer stays fresh

const DEFAULT_SETTINGS = {
  enabled: true,
  colors: true,
  size: 100, // percent
  corner: "bottom-right", // bottom-right | bottom-left | top-right | top-left
  thresholds: [2, 5, 8], // hours: green until t1, blue until t2, yellow until t3, red after
  sidebar: false, // compact times on the left sidebar channel list
};

let settings = { ...DEFAULT_SETTINGS };
let cache = new Map(); // login -> { startedAt: Date|null, at: msTimestamp }
let pendingLogins = new Set();
let fetchInFlight = false;

/* ---------- formatting ---------- */

function formatUptime(startedAt) {
  const ms = Date.now() - startedAt.getTime();
  if (ms < 0) return "";
  const totalMinutes = Math.floor(ms / 60000);
  const hh = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const mm = String(totalMinutes % 60).padStart(2, "0");
  return `${hh}h:${mm}m`;
}

function formatUptimeCompact(startedAt) {
  const ms = Date.now() - startedAt.getTime();
  if (ms < 0) return "";
  const totalMinutes = Math.floor(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}m`;
}

function uptimeColor(startedAt) {
  if (!settings.colors) return "#ffffff";
  const t = settings.thresholds || [2, 5, 8];
  const hours = (Date.now() - startedAt.getTime()) / 3600000;
  if (hours < t[0]) return "#00e676"; // green: just started
  if (hours < t[1]) return "#4fc3f7"; // blue: settled in
  if (hours < t[2]) return "#ffd740"; // yellow: long session
  return "#ff5252"; // red: marathon
}

/* ---------- DOM discovery ---------- */

function getLoginFromHref(href) {
  try {
    const url = new URL(href, location.origin);
    if (url.hostname !== "www.twitch.tv" && url.hostname !== "twitch.tv") return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!path || path.includes("/")) return null; // only /channelname links
    if (
      ["directory", "videos", "settings", "subscriptions", "wallet", "drops",
       "p", "downloads", "jobs", "turbo", "search", "friends"].includes(path.toLowerCase())
    ) {
      return null;
    }
    return path.toLowerCase();
  } catch {
    return null;
  }
}

function findViewerCountTextEl(anchor) {
  // Matches "1.2K viewers", including guest-star cards where the element
  // wraps an icon. Shortest matching text = innermost element; the
  // length cap avoids matching large containers.
  let scope = anchor;
  for (let i = 0; i < 6 && scope; i++) {
    let best = null;
    const candidates = scope.querySelectorAll("div, span, p");
    for (const el of candidates) {
      const t = el.textContent.trim();
      if (t.length <= 20 && /viewers?$/i.test(t)) {
        if (!best || t.length < best.textContent.trim().length) best = el;
      }
    }
    if (best) return best;
    scope = scope.parentElement;
  }
  return null;
}

function findViewerPill(anchor) {
  // The positioned ancestor of the viewer text is Twitch's pill overlay.
  // Rendering the badge as its sibling gives both the same containing
  // block, so mirrored insets stay symmetric across card variants.
  const viewerEl = findViewerCountTextEl(anchor);
  if (!viewerEl) return null;
  let node = viewerEl;
  for (let i = 0; i < 5 && node && node !== document.body; i++) {
    if (getComputedStyle(node).position === "absolute") return node;
    node = node.parentElement;
  }
  return null;
}

function findThumbnailFrame(anchor) {
  // Fallback anchor: the container whose size matches the thumbnail.
  const img = anchor.querySelector("img");
  if (!img) return null;
  const imgRect = img.getBoundingClientRect();
  if (imgRect.width < 100 || imgRect.height < 50) return null; // skip avatars/icons

  let node = img.parentElement;
  for (let i = 0; i < 8 && node; i++) {
    const r = node.getBoundingClientRect();
    const widthClose = r.width >= imgRect.width * 0.9 && r.width <= imgRect.width * 1.3;
    const heightClose = r.height >= imgRect.height * 0.9 && r.height <= imgRect.height * 1.6;
    if (widthClose && heightClose) return node;
    node = node.parentElement;
  }
  return null;
}

/* ---------- badge placement ---------- */

function cornerStyles(corner, insetX, insetY, pill) {
  const s = { top: "auto", bottom: "auto", left: "auto", right: "auto" };
  const y = parseFloat(insetY) || 6;
  const x = insetX;

  if (corner === "top-right") {
    s.top = `${y}px`;
    s.right = x;
  } else if (corner === "top-left") {
    // Sit below the LIVE tag zone so we don't cover it.
    s.top = `${y + 26}px`;
    s.left = x;
  } else if (corner === "bottom-left") {
    // Stack above Twitch's viewer pill so we don't cover it.
    const lift = pill ? pill.offsetHeight + 4 : 0;
    s.bottom = `${y + lift}px`;
    s.left = x;
  } else {
    s.bottom = `${y}px`;
    s.right = x;
  }
  return s;
}

const TRANSFORM_ORIGINS = {
  "bottom-right": "100% 100%",
  "bottom-left": "0 100%",
  "top-right": "100% 0",
  "top-left": "0 0",
};

function buildSidebarBadge(anchor, login, startedAt) {
  const img = anchor.querySelector("img");
  if (!img || !img.parentElement) return false;
  const box = img.parentElement;
  if (box.querySelector(".tub-uptime-badge")) return false;
  if (getComputedStyle(box).position === "static") {
    box.style.position = "relative";
  }

  const badge = document.createElement("div");
  badge.className = "tub-uptime-badge";
  badge.dataset.login = login;
  badge.dataset.compact = "1";
  badge.textContent = formatUptimeCompact(startedAt);

  const styles = {
    position: "absolute",
    bottom: "-4px",
    left: "50%",
    transform: "translateX(-50%)",
    "z-index": "1000",
    background: "rgba(0, 0, 0, 0.85)",
    color: uptimeColor(startedAt),
    "font-size": "9px",
    "font-weight": "700",
    "line-height": "1",
    padding: "2px 4px",
    "border-radius": "4px",
    "font-family": '-apple-system, "Helvetica Neue", Arial, sans-serif',
    "pointer-events": "none",
    "white-space": "nowrap",
  };
  for (const [prop, value] of Object.entries(styles)) {
    badge.style.setProperty(prop, value, "important");
  }
  box.appendChild(badge);
  return true;
}

function buildBadge(anchor, login, startedAt) {
  // Left sidebar entries get their own compact treatment, and only when
  // the user has switched it on.
  if (anchor.closest("nav")) {
    if (!settings.sidebar) return false;
    return buildSidebarBadge(anchor, login, startedAt);
  }

  // On a channel's own page, Twitch already shows a session timer in the
  // player bar; a badge here would just cover the stream title.
  const watching = getLoginFromHref(location.pathname);
  if (watching && watching === login) return false;

  const pill = findViewerPill(anchor);
  let box = null;
  let insetX = "6px";
  let insetY = "6px";
  let pillCs = null;

  if (pill && pill.parentElement) {
    box = pill.parentElement;
    pillCs = getComputedStyle(pill);
    if (/px$/.test(pillCs.bottom)) insetY = pillCs.bottom;
    if (/px$/.test(pillCs.left)) insetX = pillCs.left; // mirrored horizontally
  } else {
    box = findThumbnailFrame(anchor);
    if (box && getComputedStyle(box).position === "static") {
      box.style.position = "relative";
    }
  }

  if (!box) return;
  if (box.querySelector(".tub-uptime-badge")) return;

  const badge = document.createElement("div");
  badge.className = "tub-uptime-badge";
  badge.dataset.login = login;
  badge.textContent = formatUptime(startedAt);

  // Inline !important styles so page CSS cannot reflow or restyle the badge.
  const styles = {
    position: "absolute",
    width: "auto",
    height: "auto",
    margin: "0",
    "z-index": "1000",
    background: "rgba(0, 0, 0, 0.6)",
    color: uptimeColor(startedAt),
    "font-size": "13px",
    "font-weight": "600",
    "line-height": "1",
    padding: "4px 6px",
    "border-radius": "4px",
    "font-family": '-apple-system, "Helvetica Neue", Arial, sans-serif',
    "pointer-events": "none",
    transform: `scale(${(settings.size || 100) / 100})`,
    "transform-origin": TRANSFORM_ORIGINS[settings.corner] || "100% 100%",
  };

  Object.assign(styles, cornerStyles(settings.corner, insetX, insetY, pill));

  // Mirror the native pill's visual style when available.
  if (pillCs) {
    const bg = pillCs.backgroundColor;
    const invisible = !bg || bg === "transparent" || /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(bg);
    if (!invisible) {
      styles.background = bg;
      styles.padding = pillCs.padding;
      styles["border-radius"] = pillCs.borderRadius;
      styles["line-height"] = pillCs.lineHeight;
    }
  }
  const viewerEl = findViewerCountTextEl(anchor);
  if (viewerEl) {
    const cs = getComputedStyle(viewerEl);
    styles["font-size"] = cs.fontSize;
    styles["font-weight"] = cs.fontWeight;
    styles["font-family"] = cs.fontFamily;
    styles["letter-spacing"] = cs.letterSpacing;
  }

  for (const [prop, value] of Object.entries(styles)) {
    badge.style.setProperty(prop, value, "important");
  }

  box.appendChild(badge);
}

/* ---------- data flow ---------- */

function collectVisibleLogins() {
  const logins = new Set();
  document.querySelectorAll("a[href]").forEach((a) => {
    const login = getLoginFromHref(a.getAttribute("href"));
    if (login) logins.add(login);
  });
  return logins;
}

function scanPage() {
  if (!settings.enabled) return;

  const now = Date.now();
  for (const login of collectVisibleLogins()) {
    const entry = cache.get(login);
    if (!entry || now - entry.at > CACHE_TTL) {
      pendingLogins.add(login);
    }
  }
  if (pendingLogins.size > 0) requestBatch();
  badgeVisible();
}

function requestBatch() {
  if (fetchInFlight || pendingLogins.size === 0) return;
  fetchInFlight = true;

  const batch = [...pendingLogins].slice(0, 300);
  batch.forEach((l) => pendingLogins.delete(l));

  chrome.runtime.sendMessage(
    { type: "GET_STREAMS_BY_LOGIN", logins: batch },
    (res) => {
      fetchInFlight = false;
      if (chrome.runtime.lastError) return;
      if (!res || !res.ok) {
        if (res && (res.error === "unauthorized" || res.error === "not_connected")) {
          console.info(
            "[Uptime Badges] Not connected to Twitch. Click the extension icon and connect to show badges."
          );
        }
        return;
      }

      const now = Date.now();
      const liveByLogin = new Map(res.streams.map((s) => [s.login, s.startedAt]));
      for (const login of res.queried) {
        const startedAt = liveByLogin.has(login)
          ? new Date(liveByLogin.get(login))
          : null;
        cache.set(login, { startedAt, at: now });
      }

      badgeVisible();
      if (pendingLogins.size > 0) setTimeout(requestBatch, 1000);
    }
  );
}

function badgeVisible() {
  if (!settings.enabled) return;
  document.querySelectorAll("a[href]").forEach((anchor) => {
    const login = getLoginFromHref(anchor.getAttribute("href"));
    if (!login) return;
    const entry = cache.get(login);
    if (entry && entry.startedAt) buildBadge(anchor, login, entry.startedAt);
  });
}

function tick() {
  document.querySelectorAll(".tub-uptime-badge").forEach((badge) => {
    const login = badge.dataset.login;
    const entry = login ? cache.get(login) : null;
    if (entry && entry.startedAt) {
      const text = badge.dataset.compact
        ? formatUptimeCompact(entry.startedAt)
        : formatUptime(entry.startedAt);
      if (badge.textContent !== text) badge.textContent = text;
      badge.style.setProperty("color", uptimeColor(entry.startedAt), "important");
    } else {
      badge.remove(); // went offline or unknown again
    }
  });
}

function refreshBadgedChannels() {
  // Invalidate badged channels so the next scan re-verifies live status.
  document.querySelectorAll(".tub-uptime-badge").forEach((badge) => {
    const login = badge.dataset.login;
    if (login) {
      const entry = cache.get(login);
      if (entry) entry.at = 0;
    }
  });
  scanPage();
}

/* ---------- settings ---------- */

function removeAllBadges() {
  document.querySelectorAll(".tub-uptime-badge").forEach((b) => b.remove());
}

function applySettingsChange() {
  removeAllBadges();
  if (settings.enabled) scanPage();
}

function loadSettings(cb) {
  chrome.storage.local.get("settings", (data) => {
    settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
    cb && cb();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
    applySettingsChange();
  }
});

/* ---------- init ---------- */

function init() {
  loadSettings(() => {
    scanPage();
  });

  setInterval(tick, TICK_MS);
  setInterval(refreshBadgedChannels, REFRESH_MS);

  // Debounced rescan on DOM changes (infinite scroll, tab switches).
  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scanPage();
    }, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Catch SPA navigations.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      setTimeout(scanPage, 800);
    }
  }, 1000);
}

init();
