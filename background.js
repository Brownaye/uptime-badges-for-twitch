// Background service worker.
// Handles the Twitch OAuth flow and batched stream lookups through the
// official Helix API. The access token never leaves the browser.

// Twitch application client ID (public identifier, safe to ship).
const CLIENT_ID = "esq1714wfjvm7k032ldtdwqkjx7q6o";

const REDIRECT_URI = chrome.identity.getRedirectURL();

function getStored(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStored(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

// Red "!" on the toolbar icon while the stored token is expired.
function setAuthAlert(on) {
  chrome.action.setBadgeText({ text: on ? "!" : "" });
  if (on) chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
}

// Run the implicit grant flow. Non-interactive succeeds only while the
// user's twitch.tv session cookie is still valid, which lets us renew an
// expired token without any UI.
async function authorize(interactive) {
  const authUrl =
    "https://id.twitch.tv/oauth2/authorize" +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    "&response_type=token" +
    "&scope=user:read:follows" +
    (interactive ? "&force_verify=true" : "");

  const redirectResponse = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive,
  });

  const params = new URLSearchParams(new URL(redirectResponse).hash.substring(1));
  const accessToken = params.get("access_token");
  if (!accessToken) throw new Error("Twitch did not return an access token.");

  await setStored({
    accessToken,
    connected: true,
    authExpired: false,
    authBannerDismissed: false,
  });
  setAuthAlert(false);
  return accessToken;
}

function login() {
  return authorize(true);
}

async function logout() {
  await setStored({
    accessToken: null,
    connected: false,
    authExpired: false,
    authBannerDismissed: false,
  });
  setAuthAlert(false);
}

// Token came back 401: try a silent renewal first, and only surface the
// expiry (toolbar alert + content-script banner) if that fails too.
async function handleExpiredToken() {
  try {
    return await authorize(false);
  } catch {
    await setStored({ accessToken: null, connected: false, authExpired: true });
    setAuthAlert(true);
    return null;
  }
}

// Look up live status and start time for a batch of channel logins.
// Helix accepts up to 100 user_login params per request.
async function getStreamsByLogin(logins) {
  let { accessToken } = await getStored(["accessToken"]);
  if (!accessToken) return { ok: false, error: "not_connected" };

  const unique = [...new Set((logins || []).filter(Boolean))].slice(0, 300);
  if (unique.length === 0) return { ok: true, streams: [], queried: [] };

  const streams = [];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const qs = chunk.map((l) => "user_login=" + encodeURIComponent(l)).join("&");
    const url = `https://api.twitch.tv/helix/streams?first=100&${qs}`;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": CLIENT_ID,
    };

    let resp = await fetch(url, { headers });

    if (resp.status === 401) {
      accessToken = await handleExpiredToken();
      if (!accessToken) return { ok: false, error: "unauthorized" };
      headers.Authorization = `Bearer ${accessToken}`;
      resp = await fetch(url, { headers });
      if (resp.status === 401) return { ok: false, error: "unauthorized" };
    }
    if (!resp.ok) continue;

    const json = await resp.json();
    for (const s of json.data || []) {
      streams.push({
        login: (s.user_login || "").toLowerCase(),
        startedAt: s.started_at,
      });
    }
  }

  return { ok: true, streams, queried: unique };
}

// Toolbar badge text does not survive a browser restart; restore it
// whenever the worker spins up with an expired login still on record.
getStored(["authExpired"]).then((data) => setAuthAlert(!!data.authExpired));

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case "GET_STREAMS_BY_LOGIN":
      getStreamsByLogin(message.logins).then(sendResponse);
      return true;
    case "LOGIN":
      login()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    case "LOGOUT":
      logout().then(() => sendResponse({ ok: true }));
      return true;
    case "GET_STATUS":
      getStored(["connected"]).then((data) => sendResponse({ ok: true, ...data }));
      return true;
  }
});
