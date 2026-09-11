const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  powerSaveBlocker,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { pathToFileURL } = require("url");

// السماح بتشغيل صوت التنبيه دون الحاجة إلى تفاعل المستخدم
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("disable-features", "MediaSessionService");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// ---------- إعدادات محمولة (تُحفظ بجانب الملف التنفيذي إن أمكن) ----------
function settingsFile() {
  const portableDir = path.dirname(app.getPath("exe"));
  const portablePath = path.join(portableDir, "miqat-settings.json");
  try {
    fs.accessSync(portableDir, fs.constants.W_OK);
    return portablePath;
  } catch {
    return path.join(app.getPath("userData"), "miqat-settings.json");
  }
}

let settings = { startMinimized: false, startWithWindows: false };
const SETTINGS_PATH = () => settingsFile();

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH(), "utf8");
    settings = { ...settings, ...JSON.parse(raw) };
  } catch {
    /* أول تشغيل */
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_PATH(), JSON.stringify(settings, null, 2), "utf8");
  } catch {
    /* تجاهل */
  }
}

function applyAutoLaunch() {
  if (process.platform !== "win32") return;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.startWithWindows,
      path: app.getPath("exe"),
      args: ["--minimized"],
    });
  } catch {
    /* تجاهل */
  }
}

let win = null;
let alarmPlayer = null;
let alarmPlayerReady = false;
let tray = null;
let isQuitting = false;
let heartbeatTimer = null;
let powerSaveBlockerId = null;
let alarmTimers = [];
let alarmSchedulerTimer = null;
const scheduledAlarms = new Map();
const firedAlarmOccurrences = new Map();
const ALARM_GRACE_MS = 20 * 1000;

const startedMinimized =
  process.argv.includes("--minimized") || process.argv.includes("--hidden");

function defaultTrayImage() {
  const p = path.join(__dirname, "tray-default.png");
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

function buildTray() {
  tray = new Tray(defaultTrayImage());
  tray.setToolTip("الميقات — مواقيت الصلاة");
  const menu = Menu.buildFromTemplate([
    {
      label: "إظهار التطبيق",
      click: () => showWindow(),
    },
    { type: "separator" },
    {
      label: "خروج",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (win && win.isVisible() && !win.isMinimized()) hideWindow();
    else showWindow();
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function hideWindow() {
  if (!win) return;
  win.hide();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#16202e",
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "tray-default.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.setBackgroundThrottling(false);
  win.webContents.setAudioMuted(false);
  // فك قفل الصوت تلقائيًا بعد تحميل الصفحة
  win.webContents.on("did-finish-load", () => {
    win.webContents
      .executeJavaScript(
        "(function(){try{var A=window.AudioContext||window.webkitAudioContext;if(!A)return;if(!window.__miqatAC||window.__miqatAC.state==='closed')window.__miqatAC=new A;var c=window.__miqatAC;var go=function(){try{var b=c.createBuffer(1,1,c.sampleRate),s=c.createBufferSource(),g=c.createGain();g.gain.value=0.0001;s.buffer=b;s.connect(g);g.connect(c.destination);s.start(0);window.__miqatAudioReady=true;}catch(e){}};if(c.state==='suspended'){c.resume().then(go).catch(function(){})}else{go()}}catch(e){}})()",
        true,
      )
      .catch(() => {});
  });

  win.once("ready-to-show", () => {
    if (!(startedMinimized || settings.startMinimized)) win.show();
  });

  // نبضة من العملية الرئيسية تضمن استمرار عدّاد التنبيهات حين تكون النافذة مخفية
  heartbeatTimer = setInterval(() => {
    if (win && !win.isDestroyed()) win.webContents.send("miqat:heartbeat");
  }, 1000);

  // إغلاق النافذة = تصغير إلى شريط المهام
  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      hideWindow();
    }
  });
}

function createAlarmPlayer() {
  alarmPlayer = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  alarmPlayer.loadFile(path.join(__dirname, "alarm-player.html"));
  alarmPlayer.webContents.setBackgroundThrottling(false);
  alarmPlayer.webContents.setAudioMuted(false);
  alarmPlayer.webContents.on("did-finish-load", () => {
    alarmPlayerReady = true;
  });
}

function alarmSoundsDir() {
  return path.join(app.getPath("userData"), "alarm-sounds");
}

function safeSoundKey(value) {
  return String(value || "prayer").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

function soundExtension(mime) {
  const extensions = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/aac": ".aac",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/flac": ".flac",
  };
  return extensions[mime.toLowerCase()] || ".audio";
}

function persistAlarmSound(soundKey, dataUrl) {
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(dataUrl || "");
  if (!match) return null;
  const dir = alarmSoundsDir();
  const key = safeSoundKey(soundKey);
  const bytes = Buffer.from(match[2], "base64");
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).find((file) => file.startsWith(`${key}.`));
  if (existing) {
    const existingPath = path.join(dir, existing);
    try {
      if (fs.readFileSync(existingPath).equals(bytes)) return existingPath;
    } catch {
      /* أعد إنشاء النسخة التالفة */
    }
  }
  for (const file of fs.readdirSync(dir)) {
    if (file.startsWith(`${key}.`)) {
      try {
        fs.unlinkSync(path.join(dir, file));
      } catch {
        /* تجاهل ملف قديم مقفول مؤقتًا */
      }
    }
  }
  const target = path.join(dir, `${key}${soundExtension(match[1])}`);
  const temporary = `${target}.new`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, target);
  return target;
}

function storedAlarmSound(soundKey) {
  try {
    const dir = alarmSoundsDir();
    const key = safeSoundKey(soundKey);
    const file = fs.readdirSync(dir).find((name) => name.startsWith(`${key}.`));
    return file ? path.join(dir, file) : null;
  } catch {
    return null;
  }
}

function fallbackAlarm() {
  const ring = () => {
    try {
      shell.beep();
    } catch {
      /* تجاهل */
    }
  };
  ring();
  for (const delay of [900, 1800, 2700, 3600]) {
    alarmTimers.push(setTimeout(ring, delay));
  }
}

async function playAlarm(soundSrc, volume, soundKey) {
  for (const timer of alarmTimers) clearTimeout(timer);
  alarmTimers = [];
  let storedPath = null;
  try {
    storedPath = soundSrc
      ? persistAlarmSound(soundKey, soundSrc)
      : storedAlarmSound(soundKey);
  } catch {
    storedPath = storedAlarmSound(soundKey);
  }
  if (alarmPlayer && !alarmPlayer.isDestroyed() && alarmPlayerReady && storedPath) {
    const safeSource = JSON.stringify(pathToFileURL(storedPath).href);
    const safeVolume = Math.min(1, Math.max(0, Number(volume) || 1));
    try {
      const played = await alarmPlayer.webContents.executeJavaScript(
        `window.playMiqatAlarm(${safeSource}, ${safeVolume})`,
        true,
      );
      if (played) return;
    } catch {
      /* استخدم صوت النظام الاحتياطي */
    }
  }
  fallbackAlarm();
}

function alarmOccurrenceKey(soundKey, targetTime) {
  return `${safeSoundKey(soundKey)}:${Math.round(Number(targetTime) || 0)}`;
}

function markAlarmOccurrence(key, now) {
  firedAlarmOccurrences.set(key, now);
  for (const [oldKey, firedAt] of firedAlarmOccurrences) {
    if (now - firedAt > 48 * 60 * 60 * 1000) firedAlarmOccurrences.delete(oldKey);
  }
}

function checkScheduledAlarms() {
  const now = Date.now();
  for (const [key, alarm] of scheduledAlarms) {
    if (now < alarm.targetTime) continue;
    scheduledAlarms.delete(key);
    if (firedAlarmOccurrences.has(key)) continue;
    markAlarmOccurrence(key, now);
    // بعد السكون أو قفل الجهاز لا نشغّل صلاة انتهى وقتها.
    if (now - alarm.targetTime > ALARM_GRACE_MS) continue;
    void playAlarm(null, alarm.volume, alarm.soundKey);
  }
}

// ---------- IPC ----------
ipcMain.handle("miqat:get-settings", () => ({
  ...settings,
  platform: process.platform,
}));

ipcMain.handle("miqat:set-setting", (_e, key, value) => {
  if (key === "startMinimized" || key === "startWithWindows") {
    settings[key] = !!value;
    saveSettings();
    if (key === "startWithWindows") applyAutoLaunch();
  }
  return { ...settings };
});

ipcMain.on("miqat:hide", () => hideWindow());

ipcMain.on("miqat:tray-icon", (_e, dataUrl) => {
  if (!tray || !dataUrl) return;
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (!img.isEmpty()) tray.setImage(img);
  } catch {
    /* تجاهل */
  }
});

ipcMain.on("miqat:tray-tooltip", (_e, text) => {
  if (tray && typeof text === "string") tray.setToolTip(text);
});

ipcMain.on("miqat:sync-alarms", (_event, alarms) => {
  if (!Array.isArray(alarms)) return;
  const nextKeys = new Set();
  for (const alarm of alarms.slice(0, 100)) {
    const targetTime = Number(alarm?.targetTime);
    const soundKey = safeSoundKey(alarm?.soundKey);
    if (!Number.isFinite(targetTime) || !soundKey) continue;
    const key = alarmOccurrenceKey(soundKey, targetTime);
    nextKeys.add(key);
    try {
      if (alarm?.soundSrc) persistAlarmSound(soundKey, alarm.soundSrc);
    } catch {
      /* تبقى النسخة المحفوظة السابقة متاحة */
    }
    if (!firedAlarmOccurrences.has(key)) {
      scheduledAlarms.set(key, {
        targetTime,
        soundKey,
        volume: Math.min(1, Math.max(0, Number(alarm?.volume) || 1)),
      });
    }
  }
  for (const key of scheduledAlarms.keys()) {
    const alarm = scheduledAlarms.get(key);
    const isAtTriggerBoundary = alarm && alarm.targetTime <= Date.now() + ALARM_GRACE_MS;
    if (!nextKeys.has(key) && !isAtTriggerBoundary) scheduledAlarms.delete(key);
  }
  checkScheduledAlarms();
});

// صوت نظام أصلي مستقل عن النافذة والمتصفح ويعمل حتى عند التصغير إلى الشريط
ipcMain.on("miqat:play-alarm", (_event, soundSrc, volume, soundKey) => {
  const now = Date.now();
  const matching = [...scheduledAlarms.entries()].find(
    ([, alarm]) =>
      alarm.soundKey === safeSoundKey(soundKey) &&
      Math.abs(now - alarm.targetTime) <= ALARM_GRACE_MS,
  );
  if (matching) {
    const [key] = matching;
    scheduledAlarms.delete(key);
    if (firedAlarmOccurrences.has(key)) return;
    markAlarmOccurrence(key, now);
  }
  void playAlarm(soundSrc, volume, soundKey);
});

// فتح صفحة الطباعة/التصدير في المتصفح الافتراضي
ipcMain.handle("miqat:open-html", async (_e, html) => {
  try {
    const dir = path.join(os.tmpdir(), "miqat-print");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `miqat-${Date.now()}.html`);
    fs.writeFileSync(file, html, "utf8");
    await shell.openPath(file);
    return true;
  } catch {
    return false;
  }
});

// ---------- دورة الحياة ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
    loadSettings();
    applyAutoLaunch();
    createAlarmPlayer();
    createWindow();
    buildTray();
    alarmSchedulerTimer = setInterval(checkScheduledAlarms, 500);
  });

  app.on("window-all-closed", (e) => {
    e?.preventDefault?.();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (alarmSchedulerTimer) clearInterval(alarmSchedulerTimer);
    for (const timer of alarmTimers) clearTimeout(timer);
    if (
      powerSaveBlockerId !== null &&
      powerSaveBlocker.isStarted(powerSaveBlockerId)
    ) {
      powerSaveBlocker.stop(powerSaveBlockerId);
    }
  });
}
