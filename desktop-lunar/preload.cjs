const { ipcRenderer } = require("electron");

// مؤقّت احتياطي تقوده العملية الرئيسية كي لا تتوقف التنبيهات عند إخفاء النافذة
const nativeSetInterval = window.setInterval.bind(window);
const nativeClearInterval = window.clearInterval.bind(window);
const backgroundIntervals = new Map();

window.__miqatNativeAlarm = (soundSrc, volume, soundKey) =>
  ipcRenderer.send(
    "miqat:play-alarm",
    soundSrc || null,
    volume ?? 1,
    soundKey || "prayer",
  );

// تسليم المواعيد القادمة للعملية الرئيسية كي لا تعتمد على مؤقّت الصفحة.
window.__miqatSyncAlarms = (alarms) =>
  ipcRenderer.send("miqat:sync-alarms", Array.isArray(alarms) ? alarms : []);

window.setInterval = (handler, delay, ...args) => {
  const id = nativeSetInterval(handler, delay, ...args);
  if (typeof handler === "function" && Number(delay) >= 900 && Number(delay) <= 1500) {
    backgroundIntervals.set(id, () => handler(...args));
  }
  return id;
};

window.clearInterval = (id) => {
  backgroundIntervals.delete(id);
  return nativeClearInterval(id);
};

ipcRenderer.on("miqat:heartbeat", () => {
  if (!document.hidden) return;
  for (const run of backgroundIntervals.values()) {
    try {
      run();
    } catch {
      /* تجاهل خطأ مؤقت منفرد */
    }
  }
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const context = window.__miqatAC;
    if (AudioContext && context && context.state === "suspended") {
      context.resume().catch(() => {});
    }
  } catch {
    /* تجاهل */
  }
});

// ============ 1) فتح التصدير/الطباعة في المتصفح الافتراضي ============
(function patchWindowOpen() {
  const nativeOpen = window.open.bind(window);
  window.open = function (url, target, features) {
    // نافذة فارغة تُكتب فيها صفحة الطباعة => نحوّلها للمتصفح الافتراضي
    if (!url || url === "" || url === "about:blank") {
      let buffer = "";
      const fake = {
        closed: false,
        document: {
          write(chunk) {
            buffer += chunk;
          },
          writeln(chunk) {
            buffer += chunk + "\n";
          },
          close() {
            if (buffer.trim()) ipcRenderer.invoke("miqat:open-html", buffer);
            buffer = "";
          },
        },
        focus() {},
        close() {
          this.closed = true;
        },
        print() {},
      };
      return fake;
    }
    if (/^https?:/i.test(url)) {
      ipcRenderer.invoke("miqat:open-html", `<meta http-equiv="refresh" content="0;url=${url}">`);
      return null;
    }
    return nativeOpen(url, target, features);
  };
})();

// ============ 2) شريط الأزرار الثلاثة أعلى الصفحة ============
const STYLE = `
#miqat-desktop-bar{position:fixed;top:0;left:0;right:0;z-index:2147483000;
  display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:wrap;
  padding:8px 12px;background:#0d1520;border-bottom:1px solid rgba(212,175,55,.45);
  font-family:system-ui,"Segoe UI",Tahoma,sans-serif;direction:rtl}
#miqat-desktop-bar button{cursor:pointer;border-radius:999px;padding:6px 14px;
  font-size:13px;font-weight:700;color:#d4af37;background:transparent;
  border:1px solid rgba(212,175,55,.55);transition:all .15s ease}
#miqat-desktop-bar button:hover{background:rgba(212,175,55,.14)}
#miqat-desktop-bar button.on{background:#d4af37;color:#101820;border-color:#d4af37}
body{padding-top:46px !important}
@media print{#miqat-desktop-bar{display:none !important}body{padding-top:0 !important}}
`;

function buildBar(state) {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "miqat-desktop-bar";

  const bMin = document.createElement("button");
  bMin.textContent = "تصغير إلى شريط المهام";
  bMin.onclick = () => ipcRenderer.send("miqat:hide");

  const bStartMin = document.createElement("button");
  bStartMin.textContent = "البدء مصغّرًا في شريط المهام";

  const bStartWin = document.createElement("button");
  bStartWin.textContent = "البدء مع ويندوز مصغّرًا";

  const sync = (s) => {
    bStartMin.classList.toggle("on", !!s.startMinimized);
    bStartWin.classList.toggle("on", !!s.startWithWindows);
  };
  sync(state);

  bStartMin.onclick = async () => {
    const s = await ipcRenderer.invoke(
      "miqat:set-setting",
      "startMinimized",
      !bStartMin.classList.contains("on"),
    );
    sync(s);
  };
  bStartWin.onclick = async () => {
    const s = await ipcRenderer.invoke(
      "miqat:set-setting",
      "startWithWindows",
      !bStartWin.classList.contains("on"),
    );
    sync(s);
  };

  bar.append(bMin, bStartMin, bStartWin);
  document.body.appendChild(bar);
}

// ============ 3) أيقونة شريط المهام (اسم الصلاة + الوقت المتبقي) ============
const AR_DIGITS = ["٠", "١", "٢", "٣", "٤", "٥", "٦", "٧", "٨", "٩"];
const toAr = (n) => String(n).replace(/[0-9]/g, (d) => AR_DIGITS[Number(d)]);
const toLatin = (s) =>
  String(s).replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));

function readNext() {
  let name = "";
  let text = "";
  const nodes = document.querySelectorAll("p");
  for (const p of nodes) {
    const t = (p.textContent || "").trim();
    if (t.startsWith("المتبقي لصلاة")) {
      name = t.replace("المتبقي لصلاة", "").trim();
      const sib = p.nextElementSibling;
      if (sib) text = (sib.textContent || "").trim();
      break;
    }
  }
  if (!name || !text) return null;
  const parts = toLatin(text).split(":").map((x) => parseInt(x, 10));
  if (parts.some((x) => Number.isNaN(x))) return null;
  const h = parts.length >= 3 ? parts[0] : 0;
  const m = parts.length >= 3 ? parts[1] : parts[0] || 0;
  const s = parts.length >= 3 ? parts[2] : parts[1] || 0;
  return { name, h, m, s };
}

function drawIcon(info, alertOn) {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const g = c.getContext("2d");

  // خلفية سوداء خالصة — أو حمراء وامضة قبل الصلاة بخمس دقائق
  g.fillStyle = alertOn ? "#c1121f" : "#000000";
  g.fillRect(0, 0, S, S);
  // إطار ذهبي
  g.strokeStyle = "#d4af37";
  g.lineWidth = 8;
  g.strokeRect(4, 4, S - 8, S - 8);

  g.textAlign = "center";
  g.textBaseline = "middle";

  if (!info) {
    g.fillStyle = "#d4af37";
    g.font = "bold 46px 'Segoe UI', Tahoma, sans-serif";
    g.fillText("الميقات", S / 2, S / 2);
    return c.toDataURL("image/png");
  }

  // اسم الصلاة بالذهبي العريض
  g.fillStyle = alertOn ? "#ffffff" : "#d4af37";
  let fs = 46;
  g.font = `bold ${fs}px 'Segoe UI', Tahoma, sans-serif`;
  while (g.measureText(info.name).width > S - 20 && fs > 20) {
    fs -= 2;
    g.font = `bold ${fs}px 'Segoe UI', Tahoma, sans-serif`;
  }
  g.fillText(info.name, S / 2, 40);

  // الوقت المتبقي بالأبيض العريض بالأرقام العربية الشرقية بدون أصفار بادئة
  const time = info.h > 0 ? `${toAr(info.h)}:${toAr(info.m)}` : toAr(info.m);
  g.fillStyle = "#ffffff";
  let ts = 62;
  g.font = `bold ${ts}px 'Segoe UI', Tahoma, sans-serif`;
  while (g.measureText(time).width > S - 18 && ts > 24) {
    ts -= 2;
    g.font = `bold ${ts}px 'Segoe UI', Tahoma, sans-serif`;
  }
  g.fillText(time, S / 2, 90);

  return c.toDataURL("image/png");
}

let lastKey = "";
let lastTip = "";
let flashPhase = false;
function tickTray() {
  const info = readNext();

  // وضع التنبيه: آخر خمس دقائق قبل الصلاة
  const totalSec = info ? info.h * 3600 + info.m * 60 + info.s : Infinity;
  const alerting = info && totalSec > 0 && totalSec <= 300;
  flashPhase = alerting ? !flashPhase : false;
  const alertOn = alerting && flashPhase;

  // الأيقونة: ساعة ودقيقة فقط — تُحدَّث عند تغيّرهما (أو مع كل وميض)
  const key = info
    ? `${info.name}|${info.h}|${info.m}|${alerting ? (alertOn ? "a" : "b") : ""}`
    : "none";
  if (key !== lastKey) {
    lastKey = key;
    ipcRenderer.send("miqat:tray-icon", drawIcon(info, alertOn));
  }

  // الفقاعة: ساعة ودقيقة وثانية — تُحدَّث كل ثانية
  const tip = info
    ? `المتبقي لصلاة ${info.name}: ${toAr(info.h)} س ${toAr(info.m)} د ${toAr(info.s)} ث`
    : "الميقات — مواقيت الصلاة";
  if (tip !== lastTip) {
    lastTip = tip;
    ipcRenderer.send("miqat:tray-tooltip", tip);
  }
}


window.addEventListener("DOMContentLoaded", async () => {
  let state = { startMinimized: false, startWithWindows: false };
  try {
    state = await ipcRenderer.invoke("miqat:get-settings");
  } catch {
    /* تجاهل */
  }
  buildBar(state);
  setTimeout(tickTray, 2500);
  setInterval(tickTray, 1000);
});
