const DEFAULT_SETTINGS = {
  enabled: true,
  colors: true,
  size: 100,
  corner: "bottom-right",
  thresholds: [2, 5, 8],
  sidebar: false,
};

const els = {
  enabled: document.getElementById("enabled"),
  colors: document.getElementById("colors"),
  sidebar: document.getElementById("sidebar"),
  size: document.getElementById("size"),
  sizeValue: document.getElementById("sizeValue"),
  corner: document.getElementById("corner"),
  setup: document.getElementById("setup"),
  connectedView: document.getElementById("connectedView"),
  status: document.getElementById("status"),
  optionsBtn: document.getElementById("optionsBtn"),
  optionsPanel: document.getElementById("optionsPanel"),
  t1: document.getElementById("t1"),
  t2: document.getElementById("t2"),
  t3: document.getElementById("t3"),
  thresholdError: document.getElementById("thresholdError"),
  lgGreen: document.getElementById("lgGreen"),
  lgBlue: document.getElementById("lgBlue"),
  lgYellow: document.getElementById("lgYellow"),
  lgRed: document.getElementById("lgRed"),
};

let settings = { ...DEFAULT_SETTINGS };

function saveSettings() {
  chrome.storage.local.set({ settings });
}

function fmtH(n) {
  return Number.isInteger(n) ? String(n) : String(n);
}

function renderLegend() {
  const [a, b, c] = settings.thresholds;
  els.lgGreen.textContent = `Under ${fmtH(a)}h`;
  els.lgBlue.textContent = `${fmtH(a)}-${fmtH(b)}h`;
  els.lgYellow.textContent = `${fmtH(b)}-${fmtH(c)}h`;
  els.lgRed.textContent = `${fmtH(c)}h+`;
}

function renderSettings() {
  els.enabled.checked = settings.enabled;
  els.colors.checked = settings.colors;
  els.sidebar.checked = settings.sidebar;
  els.size.value = settings.size;
  els.sizeValue.textContent = settings.size + "%";
  els.corner.value = settings.corner;
  els.t1.value = settings.thresholds[0];
  els.t2.value = settings.thresholds[1];
  els.t3.value = settings.thresholds[2];
  renderLegend();
}

function renderConnection(status) {
  if (status.connected) {
    els.setup.style.display = "none";
    els.connectedView.style.display = "block";
    els.status.textContent = "Connected. Badges active on twitch.tv.";
  } else {
    els.setup.style.display = "block";
    els.connectedView.style.display = "none";
    els.status.textContent = "Not connected yet. One quick Twitch login and badges appear.";
  }
}

/* load */
chrome.storage.local.get("settings", (data) => {
  settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  renderSettings();
});
chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
  renderConnection(res || {});
});

/* settings handlers */
els.enabled.addEventListener("change", () => {
  settings.enabled = els.enabled.checked;
  saveSettings();
});
els.colors.addEventListener("change", () => {
  settings.colors = els.colors.checked;
  saveSettings();
});
els.sidebar.addEventListener("change", () => {
  settings.sidebar = els.sidebar.checked;
  saveSettings();
});
els.size.addEventListener("input", () => {
  settings.size = Number(els.size.value);
  els.sizeValue.textContent = settings.size + "%";
});
els.size.addEventListener("change", saveSettings);
els.corner.addEventListener("change", () => {
  settings.corner = els.corner.value;
  saveSettings();
});

/* threshold options */
els.optionsBtn.addEventListener("click", () => {
  const open = els.optionsPanel.style.display !== "none";
  els.optionsPanel.style.display = open ? "none" : "block";
  els.optionsBtn.textContent = open ? "Options" : "Close";
});

function tryToSaveThresholds() {
  const a = parseFloat(els.t1.value);
  const b = parseFloat(els.t2.value);
  const c = parseFloat(els.t3.value);

  if ([a, b, c].some((n) => !Number.isFinite(n) || n <= 0)) {
    els.thresholdError.textContent = "All three times need to be numbers above 0.";
    return;
  }
  if (!(a < b && b < c)) {
    els.thresholdError.textContent = "Times must increase in order (e.g. 2, 5, 8).";
    return;
  }

  els.thresholdError.textContent = "";
  settings.thresholds = [a, b, c];
  renderLegend();
  saveSettings();
}

[els.t1, els.t2, els.t3].forEach((input) => {
  input.addEventListener("change", tryToSaveThresholds);
});

/* connection handlers */
document.getElementById("connectBtn").addEventListener("click", () => {
  els.status.textContent = "Opening Twitch login...";
  chrome.runtime.sendMessage({ type: "LOGIN" }, (res) => {
    if (res && res.ok) {
      renderConnection({ connected: true });
    } else {
      els.status.textContent = "Couldn't connect: " + (res?.error || "unknown error");
    }
  });
});

document.getElementById("disconnectBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "LOGOUT" }, () => {
    renderConnection({ connected: false });
  });
});
