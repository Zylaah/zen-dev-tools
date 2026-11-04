// ==UserScript==
// @name        Arc Developer Toolbar
// @include     main
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "1.0.0";
  const SESSION_KEY = "arc-developer-toolbar-enabled";
  const ATTR_ACTIVE = "arc-developer-active";
  const SITE_SETTING_ID = "arc-developer-site-setting";
  const PORTRAIT_PANEL_ID = "arc-portrait-panel";
  const SPLIT_MENU_ID = "arc-developer-split-menu";
  const TOAST_ID = "arc-developer-toast-container";
  const ICON_BASE = "chrome://sine/content/arc-developer-toolbar/icons/";
  const ZEN_ICON_BASE = "chrome://browser/skin/zen-icons/";
  const BLOCKED_SCHEMES = new Set([
    "chrome",
    "resource",
    "javascript",
    "moz-icon",
    "moz-extension",
  ]);

  if (window.__arcDeveloperToolbar?.destroy) {
    try {
      window.__arcDeveloperToolbar.destroy();
    } catch (error) {
      console.error("[Arc Developer Toolbar] Previous instance cleanup failed", error);
    }
  }

  function getSessionStore() {
    try {
      return (
        window.SessionStore ||
        ChromeUtils.importESModule(
          "resource:///modules/sessionstore/SessionStore.sys.mjs"
        ).SessionStore
      );
    } catch (error) {
      console.error("[Arc Developer Toolbar] SessionStore unavailable", error);
      return null;
    }
  }

  function getClipboardHelper() {
    return Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
      Ci.nsIClipboardHelper
    );
  }

  function icon(name) {
    if (name.startsWith("chrome://") || name.startsWith("resource://")) {
      return name;
    }
    return `${ICON_BASE}${name}.svg`;
  }

  function zenIcon(name) {
    return `${ZEN_ICON_BASE}${name}.svg`;
  }

  class ArcDeveloperToolbarController {
    constructor(win) {
      this.window = win;
      this.document = win.document;
      this.sessionStore = getSessionStore();
      this.enabledTabs = new WeakSet();
      this.toolbars = new WeakMap();
      this.destroyed = false;
      this._siteSettingInstalled = false;
      this._siteObserver = null;
      this._panelListener = null;
      this._splitObserver = null;
      this._reconcileTimer = null;
      this._siteSettingTimer = null;
      this._progressListener = null;
      this._bound = {
        onTabSelect: this.onTabSelect.bind(this),
        onTabOpen: this.onTabOpen.bind(this),
        onTabClose: this.onTabClose.bind(this),
        onTabRestored: this.onTabRestored.bind(this),
        onWindowRestored: this.restoreTabs.bind(this),
        onFullscreen: this.reconcileToolbars.bind(this),
        onSplitEvent: this.scheduleReconcile.bind(this),
      };
      this._portrait = {
        panel: null,
        bitmap: null,
        browser: null,
        mode: "gradient",
        hue: null,
        preview: null,
        logo: null,
      };
    }

    get gBrowser() {
      return this.window.gBrowser;
    }

    init() {
      if (this.document.documentElement?.hasAttribute("zen-little-window")) {
        return;
      }

      this.installListeners();
      this.ensurePortraitPanel();
      this.ensureSplitMenu();
      this.installSiteControlsSetting();
      this.restoreTabs();
      this.scheduleReconcile();

      this.sessionStore?.promiseAllWindowsRestored
        ?.then(() => {
          if (!this.destroyed) {
            this.restoreTabs();
          }
        })
        .catch(error => {
          console.error("[Arc Developer Toolbar] Session restore failed", error);
        });

      window.__arcDeveloperToolbar = {
        version: VERSION,
        destroy: () => this.destroy(),
      };

      if (typeof this.window.addUnloadListener === "function") {
        this.window.addUnloadListener(() => this.destroy());
      }

      console.log(`[Arc Developer Toolbar] Initialized v${VERSION}`);
    }

    destroy() {
      if (this.destroyed) {
        return;
      }
      this.destroyed = true;

      this.window.clearTimeout(this._reconcileTimer);
      this.window.clearTimeout(this._siteSettingTimer);

      this.removeListeners();
      this.teardownSiteControlsSetting();

      for (const toolbar of this.document.querySelectorAll(
        ".arc-developer-toolbar"
      )) {
        toolbar.remove();
      }

      for (const tab of this.gBrowser?.tabs || []) {
        tab.removeAttribute(ATTR_ACTIVE);
      }

      this.document.getElementById(SITE_SETTING_ID)?.remove();
      this.document.getElementById(PORTRAIT_PANEL_ID)?.remove();
      this.document.getElementById(SPLIT_MENU_ID)?.remove();
      this.document.getElementById(TOAST_ID)?.remove();

      this._portrait.bitmap?.close?.();
      this._portrait.bitmap = null;
      this._splitMenu = null;
      this._splitMenuTab = null;

      if (window.__arcDeveloperToolbar?.version === VERSION) {
        delete window.__arcDeveloperToolbar;
      }

      console.log("[Arc Developer Toolbar] Destroyed");
    }

    installListeners() {
      const { window: win } = this;
      win.addEventListener("TabSelect", this._bound.onTabSelect);
      win.addEventListener("TabOpen", this._bound.onTabOpen);
      win.addEventListener("TabClose", this._bound.onTabClose);
      win.addEventListener("SSTabRestored", this._bound.onTabRestored);
      win.addEventListener("SSWindowRestored", this._bound.onWindowRestored);
      win.addEventListener("MozDOMFullscreen:Entered", this._bound.onFullscreen);
      win.addEventListener("MozDOMFullscreen:Exited", this._bound.onFullscreen);
      win.addEventListener("fullscreen", this._bound.onFullscreen);

      for (const name of [
        "ZenViewSplitter:SplitViewActivated",
        "ZenViewSplitter:SplitViewDeactivated",
        "ZenSplitViewTabsSplit",
        "ZenTabRemovedFromSplit",
      ]) {
        win.addEventListener(name, this._bound.onSplitEvent);
      }

      this._progressListener = {
        onLocationChange: (browser, webProgress) => {
          if (!webProgress?.isTopLevel) {
            return;
          }
          const tab = this.gBrowser?.getTabForBrowser(browser);
          if (tab && this.isEnabled(tab)) {
            this.updateToolbarForTab(tab);
          }
        },
      };
      this.gBrowser?.addTabsProgressListener(this._progressListener);

      const panels = this.gBrowser?.tabpanels;
      if (panels) {
        this._splitObserver = new this.window.MutationObserver(() => {
          this.scheduleReconcile();
        });
        this._splitObserver.observe(panels, {
          attributes: true,
          attributeFilter: ["zen-split-view"],
          childList: true,
        });
      }
    }

    removeListeners() {
      const { window: win } = this;
      win.removeEventListener("TabSelect", this._bound.onTabSelect);
      win.removeEventListener("TabOpen", this._bound.onTabOpen);
      win.removeEventListener("TabClose", this._bound.onTabClose);
      win.removeEventListener("SSTabRestored", this._bound.onTabRestored);
      win.removeEventListener("SSWindowRestored", this._bound.onWindowRestored);
      win.removeEventListener(
        "MozDOMFullscreen:Entered",
        this._bound.onFullscreen
      );
      win.removeEventListener(
        "MozDOMFullscreen:Exited",
        this._bound.onFullscreen
      );
      win.removeEventListener("fullscreen", this._bound.onFullscreen);

      for (const name of [
        "ZenViewSplitter:SplitViewActivated",
        "ZenViewSplitter:SplitViewDeactivated",
        "ZenSplitViewTabsSplit",
        "ZenTabRemovedFromSplit",
      ]) {
        win.removeEventListener(name, this._bound.onSplitEvent);
      }

      if (this._progressListener) {
        try {
          this.gBrowser?.removeTabsProgressListener(this._progressListener);
        } catch (_) {}
        this._progressListener = null;
      }

      this._splitObserver?.disconnect();
      this._splitObserver = null;
    }

    isEnabled(tab) {
      if (!tab) {
        return false;
      }
      if (this.enabledTabs.has(tab)) {
        return true;
      }
      try {
        if (this.sessionStore?.getCustomTabValue(tab, SESSION_KEY) === "true") {
          this.enabledTabs.add(tab);
          return true;
        }
      } catch (_) {}
      return false;
    }

    setEnabled(tab, enabled) {
      if (!tab) {
        return;
      }
      if (enabled) {
        this.enabledTabs.add(tab);
        try {
          this.sessionStore?.setCustomTabValue(tab, SESSION_KEY, "true");
        } catch (error) {
          console.error("[Arc Developer Toolbar] Failed to persist enable", error);
        }
        tab.setAttribute(ATTR_ACTIVE, "true");
      } else {
        this.enabledTabs.delete(tab);
        try {
          this.sessionStore?.deleteCustomTabValue(tab, SESSION_KEY);
        } catch (error) {
          console.error("[Arc Developer Toolbar] Failed to clear state", error);
        }
        tab.removeAttribute(ATTR_ACTIVE);
        this.removeToolbar(tab);
      }
      this.reconcileToolbars();
      this.updateSiteSetting();
    }

    restoreTabs() {
      for (const tab of this.gBrowser?.tabs || []) {
        try {
          if (
            this.sessionStore?.getCustomTabValue(tab, SESSION_KEY) === "true"
          ) {
            this.enabledTabs.add(tab);
            tab.setAttribute(ATTR_ACTIVE, "true");
          }
        } catch (_) {}
      }
      this.reconcileToolbars();
      this.updateSiteSetting();
    }

    onTabSelect() {
      this.updateSiteSetting();
      this.scheduleReconcile();
    }

    onTabOpen(event) {
      const tab = event.target;
      if (tab && this.isEnabled(tab)) {
        this.scheduleReconcile();
      }
    }

    onTabClose(event) {
      const tab = event.target;
      if (!tab) {
        return;
      }
      this.removeToolbar(tab);
      this.enabledTabs.delete(tab);
      this.scheduleReconcile();
    }

    onTabRestored(event) {
      const tab = event.target;
      if (!tab) {
        return;
      }
      try {
        if (this.sessionStore?.getCustomTabValue(tab, SESSION_KEY) === "true") {
          this.enabledTabs.add(tab);
          tab.setAttribute(ATTR_ACTIVE, "true");
        }
      } catch (_) {}
      this.scheduleReconcile();
    }

    scheduleReconcile() {
      if (this.destroyed) {
        return;
      }
      this.window.clearTimeout(this._reconcileTimer);
      this._reconcileTimer = this.window.setTimeout(() => {
        this.reconcileToolbars();
      }, 16);
    }

    browserContainerFor(browser) {
      return (
        browser?.closest?.(".browserContainer") ||
        browser?.parentNode?.parentNode ||
        null
      );
    }

    toolbarForTab(tab) {
      return this.toolbars.get(tab) || null;
    }

    removeToolbar(tab) {
      const toolbar = this.toolbars.get(tab);
      if (toolbar) {
        toolbar.remove();
        this.toolbars.delete(tab);
      }
    }

    ensureToolbar(tab) {
      if (!tab?.linkedBrowser) {
        return null;
      }

      let toolbar = this.toolbars.get(tab);
      if (toolbar?.isConnected) {
        const container = this.browserContainerFor(tab.linkedBrowser);
        if (container && toolbar.parentElement !== container) {
          container.insertBefore(toolbar, container.firstChild);
        }
        return toolbar;
      }

      toolbar = this.createToolbar(tab);
      const container = this.browserContainerFor(tab.linkedBrowser);
      if (!container) {
        return null;
      }
      container.insertBefore(toolbar, container.firstChild);
      this.toolbars.set(tab, toolbar);
      return toolbar;
    }

    createToolbar(tab) {
      const doc = this.document;
      const toolbar = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      toolbar.className = "arc-developer-toolbar";
      toolbar.setAttribute("role", "toolbar");
      toolbar.setAttribute("aria-label", "Developer Mode");
      if (tab._tId != null) {
        toolbar.dataset.tabId = String(tab._tId);
      }

      const url = doc.createElementNS("http://www.w3.org/1999/xhtml", "input");
      url.className = "arc-developer-url";
      url.type = "text";
      url.spellcheck = false;
      url.setAttribute("aria-label", "Page URL");
      url.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.navigateFromInput(tab, url.value);
          url.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          this.syncUrl(toolbar, tab);
          url.blur();
        }
      });
      url.addEventListener("focus", () => {
        this.selectTab(tab);
        url.select();
      });

      const actions = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      actions.className = "arc-developer-actions";

      const addAction = (label, title, file, handler, className = "") => {
        const button = doc.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "button"
        );
        button.type = "button";
        button.className = ["arc-developer-action", className]
          .filter(Boolean)
          .join(" ");
        button.title = title;
        button.setAttribute("aria-label", title);
        const img = doc.createElementNS("http://www.w3.org/1999/xhtml", "img");
        img.src = icon(file);
        img.alt = "";
        button.appendChild(img);
        button.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          this.selectTab(tab);
          handler(button);
        });
        actions.appendChild(button);
        return button;
      };

      const addDivider = () => {
        const divider = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
        divider.className = "arc-developer-divider";
        actions.appendChild(divider);
      };

      addAction("Copy", "Copy URL", zenIcon("link"), () => this.copyUrl(tab));
      addDivider();
      addAction("Capture", "Take screenshot", zenIcon("screenshot"), () =>
        this.startCapture(tab)
      );
      addAction("Portrait", "Capture in Portrait Mode", "portrait", button =>
        this.openPortrait(tab, button)
      );
      addDivider();
      addAction("Console", "Toggle Console", "console", () =>
        this.openTool(tab, "webconsole")
      );
      addAction("Network", "Toggle Network", "network", () =>
        this.openTool(tab, "netmonitor")
      );
      addAction(
        "Inspect",
        "Inspect Element",
        "inspect",
        () => this.openTool(tab, "inspector"),
        "arc-developer-action-inspect"
      );
      addDivider();
      addAction(
        "Split",
        "Split View",
        zenIcon("split"),
        button => this.openSplitMenu(tab, button)
      );
      addAction("Close", "Turn off Developer Mode", "close", () =>
        this.setEnabled(tab, false)
      );

      toolbar.append(url, actions);
      toolbar._urlInput = url;

      toolbar.addEventListener("mousedown", () => this.selectTab(tab));
      return toolbar;
    }

    selectTab(tab) {
      if (tab && this.gBrowser && this.gBrowser.selectedTab !== tab) {
        this.gBrowser.selectedTab = tab;
      }
    }

    reconcileToolbars() {
      if (this.destroyed || !this.gBrowser) {
        return;
      }

      const live = new Set();
      for (const tab of this.gBrowser.tabs) {
        if (!this.isEnabled(tab)) {
          this.removeToolbar(tab);
          tab.removeAttribute(ATTR_ACTIVE);
          continue;
        }
        tab.setAttribute(ATTR_ACTIVE, "true");
        const toolbar = this.ensureToolbar(tab);
        if (!toolbar) {
          continue;
        }
        live.add(toolbar);
        toolbar.hidden = false;
        this.updateToolbarForTab(tab);
      }

      for (const node of this.document.querySelectorAll(".arc-developer-toolbar")) {
        if (!live.has(node)) {
          node.remove();
        }
      }
    }

    updateToolbarForTab(tab) {
      const toolbar = this.toolbars.get(tab);
      if (!toolbar?.isConnected) {
        return;
      }
      this.syncUrl(toolbar, tab);
    }

    syncUrl(toolbar, tab) {
      const input = toolbar._urlInput;
      if (!input || this.document.activeElement === input) {
        return;
      }
      const spec = tab?.linkedBrowser?.currentURI?.displaySpec || "";
      input.value = spec;
      input.title = spec;
    }

    navigateFromInput(tab, rawValue) {
      const browser = tab?.linkedBrowser;
      if (!browser) {
        return;
      }
      const value = String(rawValue || "").trim();
      if (!value) {
        this.syncUrl(this.toolbars.get(tab), tab);
        return;
      }

      let uri;
      try {
        const info = Services.uriFixup.getFixupURIInfo(
          value,
          Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS |
            Ci.nsIURIFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP
        );
        uri = info.preferredURI;
      } catch (error) {
        console.error("[Arc Developer Toolbar] URL fixup failed", error);
        return;
      }

      if (!uri) {
        return;
      }

      if (BLOCKED_SCHEMES.has(uri.scheme)) {
        console.warn(
          "[Arc Developer Toolbar] Blocked privileged navigation",
          uri.scheme
        );
        this.syncUrl(this.toolbars.get(tab), tab);
        return;
      }

      try {
        browser.loadURI(uri, {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
      } catch (error) {
        console.error("[Arc Developer Toolbar] Navigation failed", error);
      }
    }

    copyUrl(tab) {
      const browser = tab?.linkedBrowser;
      const spec = browser?.currentURI?.displaySpec;
      if (!spec) {
        return;
      }
      try {
        getClipboardHelper().copyString(spec);
        this.showToast("URL copied");
      } catch (error) {
        console.error("[Arc Developer Toolbar] Copy failed", error);
      }
    }

    startCapture(tab) {
      this.selectTab(tab);
      try {
        Services.obs.notifyObservers(this.window, "menuitem-screenshot", "Toolbar");
      } catch (error) {
        console.error("[Arc Developer Toolbar] Screenshot failed", error);
      }
    }

    ensureSplitMenu() {
      let menu = this.document.getElementById(SPLIT_MENU_ID);
      if (menu) {
        this._splitMenu = menu;
        return menu;
      }

      menu = this.document.createXULElement("menupopup");
      menu.id = SPLIT_MENU_ID;
      menu.classList.add("arc-developer-split-menu");

      const options = [
        ["Add Right Split", "right", "split-right"],
        ["Add Left Split", "left", "split-left"],
        null,
        ["Add Top Split", "top", "split-top"],
        ["Add Bottom Split", "bottom", "split-bottom"],
      ];

      for (const option of options) {
        if (!option) {
          menu.appendChild(this.document.createXULElement("menuseparator"));
          continue;
        }
        const [label, side, iconName] = option;
        const item = this.document.createXULElement("menuitem");
        item.classList.add("menuitem-iconic", "arc-developer-split-menuitem");
        item.setAttribute("label", label);
        item.setAttribute("image", icon(iconName));
        item.addEventListener("command", () => {
          const tab = this._splitMenuTab;
          if (tab) {
            this.selectTab(tab);
          }
          this.createDirectionalSplit(side);
        });
        menu.appendChild(item);
      }

      this.document.getElementById("mainPopupSet")?.appendChild(menu);
      this._splitMenu = menu;
      return menu;
    }

    createDirectionalSplit(side) {
      try {
        const splitter = this.window.gZenViewSplitter;
        if (!splitter?.createEmptySplit) {
          console.error("[Arc Developer Toolbar] Split View API unavailable");
          return;
        }
        splitter.createEmptySplit(side);
      } catch (error) {
        console.error("[Arc Developer Toolbar] Split failed", error);
      }
    }

    openSplitMenu(tab, anchor) {
      const menu = this.ensureSplitMenu();
      if (!menu || !anchor) {
        return;
      }
      this._splitMenuTab = tab;
      this.selectTab(tab);
      if (menu.state !== "closed") {
        menu.hidePopup();
      }
      menu.openPopup(anchor, "after_start", 0, 4);
    }

    async openTool(tab, toolId) {
      if (!tab) {
        return;
      }
      try {
        const { require } = ChromeUtils.importESModule(
          "resource://devtools/shared/loader/Loader.sys.mjs"
        );
        const { gDevTools } = require("devtools/client/framework/devtools");
        const toolbox = gDevTools.getToolboxForTab(tab);
        if (toolbox) {
          const current = toolbox.currentToolId;
          if (current === toolId) {
            await gDevTools.closeToolboxForTab(tab);
            return;
          }
          await toolbox.selectTool(toolId);
          return;
        }
        await gDevTools.showToolboxForTab(tab, { toolId });
      } catch (error) {
        console.error("[Arc Developer Toolbar] DevTools failed", error);
      }
    }

    ensurePortraitPanel() {
      if (this.document.getElementById(PORTRAIT_PANEL_ID)) {
        this._portrait.panel = this.document.getElementById(PORTRAIT_PANEL_ID);
        return;
      }

      const doc = this.document;
      const panel = doc.createXULElement("panel");
      panel.id = PORTRAIT_PANEL_ID;
      panel.setAttribute("type", "arrow");
      panel.setAttribute("noautofocus", "true");

      const content = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      content.className = "arc-portrait-content";

      const capture = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button"
      );
      capture.type = "button";
      capture.className = "arc-portrait-capture";
      capture.textContent = "Capture in Portrait Mode";

      const preview = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      preview.width = 320;
      preview.height = 180;
      preview.className = "arc-portrait-preview";

      const controls = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      controls.className = "arc-portrait-controls";

      const gradient = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      gradient.className = "arc-portrait-swatch arc-portrait-gradient";
      gradient.title = "Gradient background";

      const hue = doc.createElementNS("http://www.w3.org/1999/xhtml", "input");
      hue.type = "range";
      hue.min = "0";
      hue.max = "359";
      hue.value = "20";
      hue.className = "arc-portrait-hue";
      hue.title = "Background color shade";

      const solid = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      solid.className = "arc-portrait-swatch arc-portrait-solid";
      solid.title = "Solid color background";

      controls.append(gradient, hue, solid);
      content.append(capture, preview, controls);
      panel.appendChild(content);
      doc.getElementById("mainPopupSet")?.appendChild(panel);

      const logo = doc.createElementNS("http://www.w3.org/1999/xhtml", "img");
      logo.src = icon("zen-watermark");
      logo.addEventListener("load", () => this.drawPortrait(preview));

      this._portrait.panel = panel;
      this._portrait.preview = preview;
      this._portrait.hue = hue;
      this._portrait.logo = logo;
      this._portrait.mode = "gradient";

      hue.addEventListener("input", () => this.drawPortrait(preview));
      gradient.addEventListener("click", () => {
        this._portrait.mode = "gradient";
        this.drawPortrait(preview);
      });
      solid.addEventListener("click", () => {
        this._portrait.mode = "solid";
        this.drawPortrait(preview);
      });
      capture.addEventListener("click", () => this.exportPortrait());
      panel.addEventListener("popuphidden", () => {
        this._portrait.bitmap?.close?.();
        this._portrait.bitmap = null;
        this._portrait.browser = null;
      });
    }

    choosePortraitHue(image) {
      const hue = this._portrait.hue;
      if (!hue || !image) {
        return;
      }
      try {
        const sample = this.document.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "canvas"
        );
        sample.width = 24;
        sample.height = 24;
        const context = sample.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0, 24, 24);
        const pixels = context.getImageData(0, 0, 24, 24).data;
        let x = 0;
        let y = 0;
        let weight = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i] / 255;
          const g = pixels[i + 1] / 255;
          const b = pixels[i + 2] / 255;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const delta = max - min;
          if (delta < 0.12 || max < 0.13) {
            continue;
          }
          let angle =
            max === r
              ? ((g - b) / delta) % 6
              : max === g
                ? (b - r) / delta + 2
                : (r - g) / delta + 4;
          angle *= Math.PI / 3;
          const importance = delta * (0.5 + max);
          x += Math.cos(angle) * importance;
          y += Math.sin(angle) * importance;
          weight += importance;
        }
        if (weight > 0.5) {
          hue.value = String(
            Math.round(((Math.atan2(y, x) * 180) / Math.PI + 540) % 360)
          );
        }
      } catch (_) {}
    }

    drawPortrait(canvas = this._portrait.preview) {
      const { bitmap, hue, logo, mode, panel } = this._portrait;
      if (!canvas || !hue) {
        return;
      }
      const ctx = canvas.getContext("2d");
      const { width, height } = canvas;
      const angle = Number(hue.value);
      hue.style.setProperty("--arc-portrait-hue", angle);

      const solid = panel?.querySelector(".arc-portrait-solid");
      const gradient = panel?.querySelector(".arc-portrait-gradient");
      if (solid) {
        solid.style.backgroundColor = `hsl(${angle} 90% 68%)`;
      }
      if (gradient) {
        gradient.style.background = `linear-gradient(135deg, hsl(${angle} 90% 72%), hsl(${
          (angle + 55) % 360
        } 95% 65%))`;
        gradient.setAttribute("aria-pressed", String(mode === "gradient"));
      }
      solid?.setAttribute("aria-pressed", String(mode === "solid"));

      if (mode === "solid") {
        ctx.fillStyle = `hsl(${angle} 90% 68%)`;
      } else {
        const background = ctx.createLinearGradient(0, 0, width, height);
        background.addColorStop(0, `hsl(${angle} 90% 72%)`);
        background.addColorStop(1, `hsl(${(angle + 55) % 360} 95% 65%)`);
        ctx.fillStyle = background;
      }
      ctx.fillRect(0, 0, width, height);

      if (!bitmap) {
        return;
      }

      const padding = Math.min(width, height) * 0.09;
      const scale = Math.min(
        (width - padding * 2) / bitmap.width,
        (height - padding * 2) / bitmap.height
      );
      const imageWidth = bitmap.width * scale;
      const imageHeight = bitmap.height * scale;
      const x = (width - imageWidth) / 2;
      const y = (height - imageHeight) / 2;
      const radius = Math.min(width, height) * 0.025;

      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.24)";
      ctx.shadowBlur = width * 0.035;
      ctx.shadowOffsetY = width * 0.02;
      ctx.fillStyle = "white";
      ctx.beginPath();
      ctx.roundRect(x, y, imageWidth, imageHeight, radius);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, imageWidth, imageHeight, radius);
      ctx.clip();
      ctx.drawImage(bitmap, x, y, imageWidth, imageHeight);
      ctx.restore();

      if (logo?.complete && logo.naturalWidth) {
        const size = Math.min(width, height) * 0.047;
        ctx.drawImage(
          logo,
          padding * 0.35,
          height - padding * 0.35 - size,
          size,
          size
        );
      }
    }

    async openPortrait(tab, anchor) {
      this.ensurePortraitPanel();
      const browser = tab?.linkedBrowser;
      const panel = this._portrait.panel;
      const preview = this._portrait.preview;
      if (!browser || !panel || !preview) {
        return;
      }

      this._portrait.bitmap?.close?.();
      this._portrait.bitmap = null;
      this._portrait.browser = browser;

      const width = Math.max(1, Math.round(browser.clientWidth || 320));
      const height = Math.max(1, Math.round(browser.clientHeight || 180));
      preview.width = width;
      preview.height = height;

      try {
        const global = browser.browsingContext?.currentWindowGlobal;
        if (!global?.drawSnapshot) {
          throw new Error("drawSnapshot unavailable");
        }
        this._portrait.bitmap = await global.drawSnapshot(
          new DOMRect(0, 0, width, height),
          1,
          "white",
          { drawView: true }
        );
        this.choosePortraitHue(this._portrait.bitmap);
        this.drawPortrait(preview);
        panel.openPopup(anchor, "after_start", 0, 4);
      } catch (error) {
        console.error("[Arc Developer Toolbar] Portrait preview failed", error);
        this.showToast("Portrait capture unavailable");
      }
    }

    async exportPortrait() {
      const { bitmap, browser, panel, preview } = this._portrait;
      if (!bitmap || !browser || !preview) {
        return;
      }
      try {
        const output = this.document.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "canvas"
        );
        output.width = preview.width;
        output.height = preview.height;
        this.drawPortrait(output);
        const blob = await new Promise(resolve =>
          output.toBlob(resolve, "image/png")
        );
        if (!blob) {
          throw new Error("Could not encode portrait screenshot");
        }
        const bytes = await blob.arrayBuffer();
        const { BrowserUtils } = ChromeUtils.importESModule(
          "resource://gre/modules/BrowserUtils.sys.mjs"
        );
        BrowserUtils.copyImageToClipboard(bytes);
        panel?.hidePopup();
        this.showToast("Portrait copied to clipboard");
      } catch (error) {
        console.error("[Arc Developer Toolbar] Portrait capture failed", error);
        this.showToast("Portrait copy failed");
      }
    }

    showToast(message) {
      let container = this.document.getElementById("zen-toast-container");
      if (!container) {
        container = this.document.getElementById(TOAST_ID);
        if (!container) {
          container = this.document.createXULElement("vbox");
          container.id = TOAST_ID;
          container.style.cssText =
            "position: fixed; right: 24px; bottom: 24px; z-index: 2147483647;";
          this.document.documentElement.appendChild(container);
        }
      }
      const toast = this.document.createXULElement("hbox");
      toast.className = "zen-toast";
      toast.style.cssText =
        "align-items: center; padding: 10px 16px; background: var(--arrowpanel-background, #2b2d33); color: var(--arrowpanel-color, white); border-radius: 9px; box-shadow: 0 6px 22px rgba(0,0,0,.3);";
      const label = this.document.createXULElement("label");
      label.textContent = message;
      label.style.margin = "0";
      toast.appendChild(label);
      container.removeAttribute("hidden");
      container.appendChild(toast);
      this.window.setTimeout(() => {
        toast.remove();
        if (!container.children.length && container.id === TOAST_ID) {
          container.setAttribute("hidden", "true");
        }
      }, 2200);
    }

    installSiteControlsSetting() {
      if (this._siteSettingInstalled) {
        return true;
      }
      const panel = this.document.getElementById("zen-unified-site-data-panel");
      const list = this.document.getElementById("zen-site-data-settings-list");
      if (!panel || !list) {
        if (!this._bootObserver) {
          this._bootObserver = new this.window.MutationObserver(() => {
            if (this.installSiteControlsSetting()) {
              this._bootObserver.disconnect();
              this._bootObserver = null;
            }
          });
          this._bootObserver.observe(this.document.documentElement, {
            childList: true,
            subtree: true,
          });
        }
        return false;
      }

      this._panelListener = () => {
        this.window.setTimeout(() => this.updateSiteSetting(), 0);
      };
      panel.addEventListener("popupshowing", this._panelListener, true);

      this._siteObserver = new this.window.MutationObserver(() => {
        this.scheduleSiteSetting();
      });
      this._siteObserver.observe(list, { childList: true });

      this._siteSettingInstalled = true;
      this.updateSiteSetting();
      return true;
    }

    teardownSiteControlsSetting() {
      const panel = this.document.getElementById("zen-unified-site-data-panel");
      if (panel && this._panelListener) {
        panel.removeEventListener("popupshowing", this._panelListener, true);
      }
      this._panelListener = null;
      this._siteObserver?.disconnect();
      this._siteObserver = null;
      this._bootObserver?.disconnect();
      this._bootObserver = null;
      this._siteSettingInstalled = false;
    }

    scheduleSiteSetting() {
      this.window.clearTimeout(this._siteSettingTimer);
      this._siteSettingTimer = this.window.setTimeout(() => {
        this.updateSiteSetting();
      }, 0);
    }

    updateSiteSetting() {
      if (this.destroyed) {
        return;
      }
      const list = this.document.getElementById("zen-site-data-settings-list");
      if (!list) {
        return;
      }

      const tab = this.gBrowser?.selectedTab;
      const enabled = !!tab && this.isEnabled(tab);
      let row = this.document.getElementById(SITE_SETTING_ID);

      if (!row) {
        row = this.document.createXULElement("hbox");
        row.id = SITE_SETTING_ID;
        row.classList.add("permission-popup-permission-item");
        row.setAttribute("align", "center");
        row.setAttribute("role", "group");

        const iconButton = this.document.createXULElement("toolbarbutton");
        iconButton.classList.add(
          "permission-popup-permission-icon",
          "zen-site-data-permission-icon"
        );
        iconButton.setAttribute("image", zenIcon("hammer"));
        iconButton.setAttribute("closemenu", "none");

        const labels = this.document.createXULElement("vbox");
        labels.classList.add("permission-popup-permission-label-container");
        labels.setAttribute("flex", "1");
        labels.setAttribute("align", "start");

        const name = this.document.createXULElement("label");
        name.classList.add("permission-popup-permission-label");
        name.textContent = "Developer Mode";

        const state = this.document.createXULElement("label");
        state.classList.add("zen-permission-popup-permission-state-label");

        labels.append(name, state);
        row.append(iconButton, labels);
        row.addEventListener(
          "click",
          event => {
            event.preventDefault();
            event.stopPropagation();
            const selected = this.gBrowser?.selectedTab;
            if (!selected) {
              return;
            }
            this.setEnabled(selected, !this.isEnabled(selected));
          },
          true
        );
      }

      row.setAttribute("state", enabled ? "allow" : "block");
      const stateLabel = row.querySelector(
        ".zen-permission-popup-permission-state-label"
      );
      if (stateLabel) {
        stateLabel.textContent = enabled ? "On" : "Off";
      }

      if (row.parentElement !== list) {
        const separator = list.querySelector("toolbarseparator");
        if (separator) {
          separator.before(row);
        } else {
          list.appendChild(row);
        }
      }

      const section = list.closest(".zen-site-data-section");
      if (section) {
        section.hidden = false;
      }
    }
  }

  function start() {
    const controller = new ArcDeveloperToolbarController(window);
    controller.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
