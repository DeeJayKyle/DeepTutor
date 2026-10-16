// Tutor Companion for Windows — a desktop window around the hosted app.
//
// The app itself (pages, offline cache, local database) is the same one served
// at <server>/companion; Chromium's storage inside this window keeps classes,
// marks and library files on this computer and serves the app offline after
// the first signed-in visit. No API keys are stored here.

const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

function loadConfig() {
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  // A user override lets a school point the app at its own server.
  const override = path.join(app.getPath("userData"), "server.json");
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(override, "utf8")) };
  } catch {
    return defaults;
  }
}

const config = loadConfig();
const SERVER = String(config.serverUrl).replace(/\/+$/, "");
const START = `${SERVER}/companion/index.html`;
let win = null;

function isAppUrl(url) {
  return url.startsWith(`${SERVER}/`) || url.startsWith("blob:") || url.startsWith("about:blank");
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 520,
    title: "Tutor Companion",
    icon: path.join(__dirname, "build", "icon.png"),
    backgroundColor: "#f5f7fa",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true },
  });
  win.once("ready-to-show", () => win.show());

  // Links to other websites (articles, YouTube, image sources) open in the
  // default browser; the app's own pages and file previews stay inside.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // First start without internet (nothing cached yet): explain instead of a blank page.
  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navigation aborted
    win.loadFile(path.join(__dirname, "offline.html"), { query: { server: SERVER, failed: url } });
  });

  win.loadURL(START);
}

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { label: "Home", accelerator: "CmdOrCtrl+H", click: () => win?.loadURL(START) },
        { role: "reload" },
        { type: "separator" },
        {
          label: "Server address…",
          click: async () => {
            const file = path.join(app.getPath("userData"), "server.json");
            if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ serverUrl: SERVER }, null, 2));
            await dialog.showMessageBox(win, {
              type: "info",
              title: "Server address",
              message: `Tutor Companion connects to:\n${SERVER}`,
              detail: `To use another server, edit this file and restart the app:\n${file}`,
            });
            shell.showItemInFolder(file);
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" }, { type: "separator" }, { role: "togglefullscreen" }] },
    {
      label: "Help",
      submenu: [
        { label: "Open in browser", click: () => shell.openExternal(START) },
        { label: "User guide", click: () => shell.openExternal(config.guideUrl) },
        {
          label: "About Tutor Companion",
          click: () =>
            dialog.showMessageBox(win, {
              type: "info",
              title: "About",
              message: `Tutor Companion ${app.getVersion()}`,
              detail: `Server: ${SERVER}\nYour classes, students and marks are stored on this computer.`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    app.setAppUserModelId("org.tutorcompanion.desktop");
    buildMenu();
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
