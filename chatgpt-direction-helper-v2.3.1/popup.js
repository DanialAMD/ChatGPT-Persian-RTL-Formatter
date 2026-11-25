(() => {
  "use strict";

  const STORAGE_KEY = "chatgptRtlHelperSettings";
  const DEFAULTS = {
    mode: "auto",
    showToolbar: true,
    forceCodeLtr: true,
    autoMessageDirection: true,
    perParagraphPrompt: true,
    rememberLastMode: true,
    draftAutosave: true,
    showCounter: true,
    codeCopyButtons: true,
    showTextTools: true,
    focusMode: false,
    fontFamily: "system",
    fontSize: 16,
    chatWidth: 768
  };



  const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
  const SESSION_ENDPOINT = "https://chatgpt.com/api/auth/session";

  function decodeJwtPayload(token) {
    try {
      const part = token.split(".")[1];
      if (!part) return {};
      const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      const bytes = atob(padded);
      const json = decodeURIComponent(Array.from(bytes, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
      return JSON.parse(json);
    } catch {
      return {};
    }
  }

  function humanReset(resetAt) {
    const ts = Number(resetAt || 0) * 1000;
    if (!ts) return "زمان ریست نامشخص";
    const diff = ts - Date.now();
    if (diff <= 0) return "در حال ریست";

    const totalMinutes = Math.max(1, Math.ceil(diff / 60000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (!days && minutes) parts.push(`${minutes}m`);
    return `reset in ${parts.join(" ")}`;
  }

  function classifyUsageWindows(rateLimit) {
    const candidates = [rateLimit?.primary_window, rateLimit?.secondary_window].filter(Boolean);
    const result = { fiveHour: null, weekly: null };

    for (const windowInfo of candidates) {
      const seconds = Number(windowInfo?.limit_window_seconds || 0);
      if (!seconds) continue;
      if (seconds >= 172800) {
        if (!result.weekly || seconds > Number(result.weekly.limit_window_seconds || 0)) result.weekly = windowInfo;
      } else {
        if (!result.fiveHour || Math.abs(seconds - 18000) < Math.abs(Number(result.fiveHour.limit_window_seconds || 0) - 18000)) {
          result.fiveHour = windowInfo;
        }
      }
    }
    return result;
  }

  function renderUsageWindow(id, info) {
    const root = document.getElementById(id);
    if (!root) return false;
    if (!info) {
      root.hidden = true;
      return false;
    }

    const used = Math.min(100, Math.max(0, Number(info.used_percent || 0)));
    const left = Math.max(0, 100 - used);
    root.hidden = false;
    root.querySelector(".usage-left").textContent = `${Math.round(left)}%`;
    root.querySelector(".usage-used").textContent = `${Math.round(used)}% used`;
    root.querySelector(".usage-reset").textContent = humanReset(info.reset_at);
    root.querySelector(".usage-progress i").style.width = `${left}%`;
    return true;
  }

  async function fetchUsage() {
    const state = document.getElementById("usageState");
    const content = document.getElementById("usageContent");
    const plan = document.getElementById("usagePlan");
    const refresh = document.getElementById("refreshUsage");

    state.classList.remove("error");
    state.hidden = false;
    state.textContent = "در حال دریافت Usage...";
    content.hidden = true;
    plan.textContent = "در حال دریافت...";
    refresh?.classList.add("loading");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
      const sessionRes = await fetch(SESSION_ENDPOINT, {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json" },
        signal: controller.signal
      });
      if (!sessionRes.ok) throw new Error(`session HTTP ${sessionRes.status}`);

      const session = await sessionRes.json();
      const token = session?.accessToken;
      if (!token) throw new Error("NO_TOKEN");

      const payload = decodeJwtPayload(token);
      const auth = payload?.["https://api.openai.com/auth"] || {};
      const accountId = session?.account?.id || auth.chatgpt_account_id || auth.account_id || "";
      const planType = session?.account?.planType || session?.account?.plan_type || auth.chatgpt_plan_type || auth.plan_type || "";

      const headers = {
        accept: "application/json",
        authorization: `Bearer ${token}`
      };
      if (accountId) headers["ChatGPT-Account-Id"] = accountId;

      const usageRes = await fetch(USAGE_ENDPOINT, {
        method: "GET",
        credentials: "include",
        headers,
        signal: controller.signal
      });
      if (!usageRes.ok) throw new Error(`usage HTTP ${usageRes.status}`);

      const usage = await usageRes.json();
      const windows = classifyUsageWindows(usage?.rate_limit);
      const has5h = renderUsageWindow("usage5h", windows.fiveHour);
      const hasWeekly = renderUsageWindow("usageWeekly", windows.weekly);

      plan.textContent = [usage?.plan_type || planType, accountId ? `…${accountId.slice(-6)}` : ""].filter(Boolean).join(" · ") || "ChatGPT";
      content.hidden = !(has5h || hasWeekly);

      if (has5h || hasWeekly) {
        state.hidden = true;
      } else {
        state.hidden = false;
        state.textContent = "برای این حساب پنجره ۵ ساعته/هفتگی برگردانده نشد.";
      }
    } catch (error) {
      state.hidden = false;
      state.classList.add("error");
      if (error?.name === "AbortError") {
        state.textContent = "دریافت Usage بیش از حد طول کشید. دوباره امتحان کن.";
      } else if (error?.message === "NO_TOKEN") {
        state.textContent = "Session پیدا نشد؛ اول در chatgpt.com وارد حساب شو.";
      } else {
        state.textContent = `Usage در دسترس نیست (${error?.message || "unknown error"}).`;
      }
      plan.textContent = "Unavailable";
    } finally {
      clearTimeout(timeout);
      refresh?.classList.remove("loading");
    }
  }

  const CHECKBOX_KEYS = [
    "showToolbar",
    "forceCodeLtr",
    "autoMessageDirection",
    "perParagraphPrompt",
    "rememberLastMode",
    "draftAutosave",
    "showCounter",
    "codeCopyButtons",
    "showTextTools",
    "focusMode"
  ];

  let settings = { ...DEFAULTS };
  let toastTimer = null;

  const manifestVersion = chrome.runtime.getManifest().version;
  const appVersion = document.getElementById("appVersion");
  const footerVersion = document.getElementById("footerVersion");
  if (appVersion) appVersion.textContent = `v${manifestVersion}`;
  if (footerVersion) footerVersion.textContent = `v${manifestVersion}`;

  function save(patch) {
    settings = { ...settings, ...patch };
    chrome.storage.sync.set({ [STORAGE_KEY]: settings });
    render();
  }

  function render() {
    document.querySelectorAll("[data-mode]").forEach((button) => {
      button.classList.toggle("active", button.dataset.mode === settings.mode);
    });

    CHECKBOX_KEYS.forEach((key) => {
      const input = document.getElementById(key);
      if (input) input.checked = !!settings[key];
    });

    const fontFamily = document.getElementById("fontFamily");
    const fontSize = document.getElementById("fontSize");
    const chatWidth = document.getElementById("chatWidth");
    if (fontFamily) fontFamily.value = settings.fontFamily;
    if (fontSize) fontSize.value = settings.fontSize;
    if (chatWidth) chatWidth.value = settings.chatWidth;
    document.getElementById("fontSizeValue").textContent = `${settings.fontSize}px`;
    document.getElementById("chatWidthValue").textContent = `${settings.chatWidth}px`;
  }

  function showToast(message) {
    const toast = document.getElementById("toast");
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("show");
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
  }

  function exportSettings() {
    const payload = {
      app: "ChatGPT RTL/LTR Helper Pro",
      version: 3,
      exportedAt: new Date().toISOString(),
      settings
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "chatgpt-rtl-helper-settings.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    showToast("تنظیمات خروجی گرفته شد");
  }

  async function importSettings(file) {
    try {
      const data = JSON.parse(await file.text());
      const incoming = data?.settings || data;
      if (!incoming || typeof incoming !== "object") throw new Error("invalid");
      settings = { ...DEFAULTS, ...incoming };
      await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
      render();
      showToast("تنظیمات وارد شد");
    } catch {
      showToast("فایل تنظیمات معتبر نیست");
    }
  }

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => save({ mode: button.dataset.mode }));
  });

  CHECKBOX_KEYS.forEach((key) => {
    document.getElementById(key)?.addEventListener("change", (event) => {
      save({ [key]: event.target.checked });
    });
  });

  document.getElementById("fontFamily")?.addEventListener("change", (event) => save({ fontFamily: event.target.value }));
  document.getElementById("fontSize")?.addEventListener("input", (event) => save({ fontSize: Number(event.target.value) }));
  document.getElementById("chatWidth")?.addEventListener("input", (event) => save({ chatWidth: Number(event.target.value) }));

  document.getElementById("exportSettings")?.addEventListener("click", exportSettings);
  document.getElementById("importSettings")?.addEventListener("click", () => document.getElementById("importFile")?.click());
  document.getElementById("importFile")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) importSettings(file);
    event.target.value = "";
  });
  document.getElementById("resetSettings")?.addEventListener("click", async () => {
    settings = { ...DEFAULTS };
    await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
    render();
    showToast("تنظیمات ریست شد");
  });

  document.getElementById("refreshUsage")?.addEventListener("click", fetchUsage);

  // Usage is fetched only when the popup opens or the user refreshes it.
  fetchUsage();

  chrome.storage.sync.get([STORAGE_KEY], (result) => {
    settings = { ...DEFAULTS, ...(result[STORAGE_KEY] || {}) };
    render();
  });
})();
