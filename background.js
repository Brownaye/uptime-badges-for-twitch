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

async function login() {
  const authUrl =
    "https://id.twitch.tv/oauth2/authorize" +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    "&response_type=token" +
    "&scope=user:read:follows" +
    "&force_verify=true";

  const redirectResponse = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  const params = new URLSearchParams(new URL(redirectResponse).hash.substring(1));
  const accessToken = params.get("access_token");
  if (!accessToken) throw new Error("Twitch did not return an access token.");

  await setStored({ accessToken, connected: true });
}

async function logout() {
  await setStored({ accessToken: null, connected: false });
}

// Look up live status and start time for a batch of channel logins.
// Helix accepts up to 100 user_login params per request.
async function getStreamsByLogin(logins) {
  const { accessToken } = await getStored(["accessToken"]);
  if (!accessToken) return { ok: false, error: "not_connected" };

  const unique = [...new Set((logins || []).filter(Boolean))].slice(0, 300);
  if (unique.length === 0) return { ok: true, streams: [], queried: [] };

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Client-Id": CLIENT_ID,
  };

  const streams = [];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const qs = chunk.map((l) => "user_login=" + encodeURIComponent(l)).join("&");
    const resp = await fetch(`https://api.twitch.tv/helix/streams?first=100&${qs}`, { headers });

    if (resp.status === 401) {
      await setStored({ connected: false, accessToken: null });
      return { ok: false, error: "unauthorized" };
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
