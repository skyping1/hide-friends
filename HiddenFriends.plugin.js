/**
 * @name Hidden Friends
 * @author euro
 * @authorId 293042396554330112
 * @description Right-click a friend to hide them from your friends list (they stay added). Hidden friends live in a "Hidden" tab where you can right-click to unhide them.
 * @version 1.0.0
 */

module.exports = class HiddenFriends {
  constructor(meta) {
    this.api = new BdApi(meta.name);
    this.hidden = {};
    this.lists = new Set();
    this.observer = null;
    this.raf = null;
    this.overlay = null;
    this.styleEl = null;
    this.boundList = null;
    this.listHandler = null;
    this.columnPrevPosition = null;
    this.menuPatch = this.menuPatch.bind(this);
  }

  /* ------------------------------ lifecycle ------------------------------ */

  start() {
    this.hidden = this.api.Data.load("hidden") || {};
    this.RelationshipStore =
      this.api.Webpack.getStore("RelationshipStore") ||
      this.api.Webpack.getByKeys("getFriendIDs", "isFriend");
    this.UserStore = this.api.Webpack.getStore("UserStore");

    this.styleEl = document.createElement("style");
    this.styleEl.id = "hidden-friends-style";
    document.head.appendChild(this.styleEl);
    this.updateCSS();

    this.patchStore();
    this.api.ContextMenu.patch("user-context", this.menuPatch);

    this.observer = new MutationObserver(() => {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = null;
        this.ensureTab();
        this.scanRows();
      });
    });
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    this.ensureTab();
    this.scanRows();
  }

  stop() {
    if (this.observer) this.observer.disconnect();
    this.observer = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;

    this.api.Patcher.unpatchAll();
    this.api.ContextMenu.unpatch("user-context", this.menuPatch);

    this.closeOverlay();
    if (this.boundList && this.listHandler) {
      this.boundList.removeEventListener("click", this.listHandler, true);
    }
    this.boundList = null;
    this.listHandler = null;
    document.querySelectorAll("[data-hf-tab]").forEach((el) => el.remove());
    document.querySelectorAll("[data-hf-hidden]").forEach((el) => el.removeAttribute("data-hf-hidden"));

    if (this.styleEl) this.styleEl.remove();
    this.styleEl = null;
    this.lists.clear();

    // Make hidden friends show up again in the native list.
    this.emitStoreChange();
  }

  /* ------------------------------ data ------------------------------ */

  isHidden(id) {
    return Object.prototype.hasOwnProperty.call(this.hidden, id);
  }

  save() {
    this.api.Data.save("hidden", this.hidden);
  }

  hide(user) {
    this.hidden[user.id] = {
      username: user.globalName || user.username || "Unknown user",
      avatar: user.avatar || null,
    };
    this.save();
    this.refresh();
    this.api.UI.showToast(`Hid ${this.hidden[user.id].username}`, { type: "success" });
  }

  unhide(id) {
    const name = this.hidden[id]?.username || "friend";
    delete this.hidden[id];
    this.save();
    this.refresh();
    this.api.UI.showToast(`Unhid ${name}`, { type: "success" });
  }

  refresh() {
    this.updateCSS();
    this.emitStoreChange();
    this.scanRows();
    setTimeout(() => this.scanRows(), 150);
    for (const root of [...this.lists]) {
      if (!root.isConnected) this.lists.delete(root);
      else root._render();
    }
  }

  emitStoreChange() {
    try {
      this.RelationshipStore?.emitChange?.();
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------------ hiding from the friends list ------------------------------ */

  patchStore() {
    const S = this.RelationshipStore;
    if (!S) {
      this.api.UI.showToast("HiddenFriends: couldn't find Discord's friend store.", { type: "error" });
      return;
    }

    // Collect every friend/relationship getter on the store (own + inherited),
    // since different Discord versions feed the friends list from different ones.
    const names = new Set();
    let o = S;
    while (o && o !== Object.prototype) {
      Object.getOwnPropertyNames(o).forEach((n) => names.add(n));
      o = Object.getPrototypeOf(o);
    }
    const skip = /^(getRelationshipType|getRelationshipCounts|getFriendCount|getNickname|getSince|getSinceDate)$/;
    const targets = [...names].filter((n) => {
      try {
        return typeof S[n] === "function" && /^get(Friend|Relationship|Sorted|Mutable)/.test(n) && !skip.test(n);
      } catch (e) {
        return false;
      }
    });

    targets.forEach((n) => {
      try {
        this.api.Patcher.after(S, n, (_, __, ret) => this.filterHidden(ret));
      } catch (e) {
        console.warn("[HiddenFriends] couldn't patch", n, e);
      }
    });
    console.log("[HiddenFriends] patched store methods:", targets);
  }

  // Removes hidden user IDs from whatever shape a store getter returns.
  filterHidden(ret) {
    if (ret == null || !Object.keys(this.hidden).length) return ret;
    const has = (v) => typeof v === "string" && this.isHidden(v);
    const itemHidden = (v) => has(v) || has(v?.id) || has(v?.userId) || has(v?.user?.id);

    if (Array.isArray(ret)) {
      return ret.some(itemHidden) ? ret.filter((v) => !itemHidden(v)) : ret;
    }
    if (ret instanceof Set) {
      return [...ret].some(itemHidden) ? new Set([...ret].filter((v) => !itemHidden(v))) : ret;
    }
    if (ret instanceof Map) {
      if (![...ret.keys()].some(has)) return ret;
      const copy = new Map(ret);
      [...copy.keys()].forEach((k) => has(k) && copy.delete(k));
      return copy;
    }
    const proto = typeof ret === "object" ? Object.getPrototypeOf(ret) : undefined;
    if (proto === Object.prototype || proto === null) {
      const ids = Object.keys(this.hidden).filter((id) => id in ret);
      if (!ids.length) return ret;
      const copy = { ...ret };
      ids.forEach((id) => delete copy[id]);
      return copy;
    }
    return ret;
  }

  /* ------------------------------ hiding rows on screen ------------------------------ */

  // Guaranteed layer: find each rendered friend row, work out which user it is
  // (from its attribute or React props) and hide it if that user is hidden.
  scanRows() {
    if (!this.styleEl) return;
    const SEL = '[data-list-item-id^="people-list"], [class*="peopleListItem"]';
    document.querySelectorAll(SEL).forEach((row) => {
      if (row.closest(".hf-overlay")) return;
      if (row.parentElement && row.parentElement.closest(SEL)) return; // only the outermost row
      const id = this.rowUserId(row);
      if (id && this.isHidden(id)) row.setAttribute("data-hf-hidden", "1");
      else row.removeAttribute("data-hf-hidden");
    });
  }

  rowUserId(row) {
    const attr = row.getAttribute("data-list-item-id");
    const m = attr && attr.match(/(\d{15,})$/);
    if (m) return m[1];

    const key = Object.keys(row).find((k) => k.startsWith("__reactFiber$"));
    let fiber = key ? row[key] : null;
    for (let i = 0; fiber && i < 30; i++, fiber = fiber.return) {
      const p = fiber.memoizedProps;
      if (p && typeof p === "object") {
        const id = (p.user && p.user.id) || p.userId || p.userID;
        if (typeof id === "string" && /^\d{15,}$/.test(id)) return id;
      }
    }
    return null;
  }

  // Fallback in case a row is still rendered by the native list.
  updateCSS() {
    if (!this.styleEl) return;
    const rules = Object.keys(this.hidden)
      .map((id) => `[data-list-item-id="people-list___${id}"]{display:none!important}`)
      .join("\n");

    this.styleEl.textContent = `
${rules}
[data-hf-hidden] { display: none !important; }

.hf-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  overflow-y: auto;
  padding: 16px 30px;
  background: var(--bg-overlay-chat, var(--background-primary, #313338));
  color: var(--text-normal, #dbdee1);
}
.hf-root { padding: 8px 0; }
.hf-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .02em;
  color: var(--header-secondary, #b5bac1);
  margin-bottom: 8px;
}
.hf-empty {
  padding: 24px 0;
  color: var(--text-muted, #949ba4);
  font-size: 14px;
}
.hf-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 8px;
  border-top: 1px solid var(--background-modifier-accent, rgba(255,255,255,.06));
  border-radius: 6px;
  cursor: default;
}
.hf-row:hover { background: var(--background-modifier-hover, rgba(255,255,255,.06)); }
.hf-avatar { width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0; }
.hf-name { font-size: 16px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hf-hint { font-size: 12px; color: var(--text-muted, #949ba4); }
`;
  }

  /* ------------------------------ context menu ------------------------------ */

  menuPatch(tree, props) {
    const user = props?.user;
    if (!user || !user.id) return;
    const children = tree?.props?.children;
    if (!Array.isArray(children)) return;

    const me = this.UserStore?.getCurrentUser?.();
    if (me && me.id === user.id) return;

    let item = null;
    if (this.isHidden(user.id)) {
      item = {
        type: "text",
        id: "hf-unhide",
        label: "Unhide Friend",
        action: () => this.unhide(user.id),
      };
    } else if (this.RelationshipStore?.isFriend?.(user.id)) {
      item = {
        type: "text",
        id: "hf-hide",
        label: "Hide Friend",
        action: () => this.hide(user),
      };
    }
    if (!item) return;

    children.push(
      ...this.api.ContextMenu.buildMenuChildren([{ type: "group", items: [item] }])
    );
  }

  /* ------------------------------ hidden list UI ------------------------------ */

  avatarURL(id, hash) {
    if (hash) {
      return `https://cdn.discordapp.com/avatars/${id}/${hash}.png?size=64`;
    }
    let idx = 0;
    try {
      idx = Number((BigInt(id) >> 22n) % 6n);
    } catch (e) {
      /* ignore */
    }
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  }

  makeList() {
    const root = document.createElement("div");
    root.className = "hf-root";

    root._render = () => {
      root.textContent = "";
      const ids = Object.keys(this.hidden);

      const title = document.createElement("div");
      title.className = "hf-title";
      title.textContent = `Hidden \u2014 ${ids.length}`;
      root.appendChild(title);

      if (!ids.length) {
        const empty = document.createElement("div");
        empty.className = "hf-empty";
        empty.textContent = "No hidden friends. Right-click a friend and choose \u201cHide Friend\u201d.";
        root.appendChild(empty);
        return;
      }

      ids
        .sort((a, b) =>
          (this.hidden[a].username || "").localeCompare(this.hidden[b].username || "", undefined, {
            sensitivity: "base",
          })
        )
        .forEach((id) => {
          const data = this.hidden[id];
          // Prefer fresh info from Discord's cache if we have it.
          const live = this.UserStore?.getUser?.(id);
          const name = live ? live.globalName || live.username : data.username;
          const avatar = live ? live.avatar : data.avatar;

          const row = document.createElement("div");
          row.className = "hf-row";

          const img = document.createElement("img");
          img.className = "hf-avatar";
          img.src = this.avatarURL(id, avatar);
          img.alt = "";

          const nameEl = document.createElement("div");
          nameEl.className = "hf-name";
          nameEl.textContent = name;

          const hint = document.createElement("div");
          hint.className = "hf-hint";
          hint.textContent = "Right-click to unhide";

          row.append(img, nameEl, hint);
          row.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            this.api.ContextMenu.open(
              e,
              this.api.ContextMenu.buildMenu([
                {
                  type: "text",
                  id: "hf-unhide-row",
                  label: "Unhide Friend",
                  action: () => this.unhide(id),
                },
              ])
            );
          });
          root.appendChild(row);
        });
    };

    this.lists.add(root);
    root._render();
    return root;
  }

  // Shown in Settings > Plugins > HiddenFriends (always works, even if the tab can't be injected).
  getSettingsPanel() {
    const wrap = document.createElement("div");
    wrap.style.padding = "8px 0";
    wrap.appendChild(this.makeList());
    return wrap;
  }

  /* ------------------------------ "Hidden" tab on the Friends page ------------------------------ */

  ensureTab() {
    const tablist = [...document.querySelectorAll('[role="tablist"]')].find((l) => {
      const labels = [...l.children].map((c) => c.textContent.trim());
      return labels.some((t) => t.startsWith("Pending")) && labels.some((t) => t.startsWith("Blocked"));
    });

    if (!tablist) {
      if (this.overlay) this.closeOverlay();
      return;
    }

    // Close the Hidden view whenever another tab is clicked.
    if (this.boundList !== tablist) {
      if (this.boundList && this.listHandler) {
        this.boundList.removeEventListener("click", this.listHandler, true);
      }
      this.listHandler = (e) => {
        if (!e.target.closest("[data-hf-tab]")) this.closeOverlay();
      };
      tablist.addEventListener("click", this.listHandler, true);
      this.boundList = tablist;
    }

    if (tablist.querySelector("[data-hf-tab]")) return;

    const kids = [...tablist.children];
    const anchor = kids.find((c) => c.textContent.trim().startsWith("Blocked"));
    // Clone an unselected plain tab so our tab inherits normal (unselected) styling.
    const proto = kids.find(
      (c) =>
        c.getAttribute("aria-selected") !== "true" &&
        ["Blocked", "All", "Online"].includes(c.textContent.trim())
    );
    if (!anchor || !proto) return;

    const tab = proto.cloneNode(true);
    tab.setAttribute("data-hf-tab", "1");
    tab.setAttribute("aria-selected", "false");
    tab.removeAttribute("id");
    tab.removeAttribute("aria-controls");

    const walker = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
    let node;
    let set = false;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue.trim()) continue;
      node.nodeValue = set ? "" : "Hidden";
      set = true;
    }
    if (!set) tab.textContent = "Hidden";

    tab.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openOverlay(tab);
    });

    anchor.after(tab);
  }

  openOverlay(tab) {
    if (this.overlay) return;
    const column = document.querySelector('[class*="peopleColumn"]');
    if (!column) {
      this.api.UI.showToast("Open Settings \u2192 Plugins \u2192 HiddenFriends to see hidden friends.", {
        type: "info",
      });
      return;
    }
    this.columnPrevPosition = column.style.position;
    column.style.position = "relative";

    const overlay = document.createElement("div");
    overlay.className = "hf-overlay";
    overlay.appendChild(this.makeList());
    column.appendChild(overlay);
    this.overlay = overlay;

    if (tab) {
      tab.style.backgroundColor = "var(--background-modifier-selected)";
      tab.style.color = "var(--interactive-active)";
    }
  }

  closeOverlay() {
    if (this.overlay) {
      const column = this.overlay.parentElement;
      this.overlay.remove();
      if (column && this.columnPrevPosition !== null) column.style.position = this.columnPrevPosition;
    }
    this.overlay = null;
    this.columnPrevPosition = null;
    document.querySelectorAll("[data-hf-tab]").forEach((t) => {
      t.style.backgroundColor = "";
      t.style.color = "";
    });
  }
};
