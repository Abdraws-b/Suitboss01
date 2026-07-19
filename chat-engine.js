import {
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  increment,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { auth, db } from "./app.js";
import { showAtelierNotification } from "./ui-feedback.js";

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL STREAM TRACKERS
// Three independent listeners can be live at once (conversation list, active
// thread, and the badge-driving doc/collection watch). Tracked on window so
// dashboard.js's mount/teardown cycle can always find and kill them, the same
// pattern used for every other live stream in this app.
// ─────────────────────────────────────────────────────────────────────────────
if (!window.activeChatThreadUnsubscribe) window.activeChatThreadUnsubscribe = null;
if (!window.activeChatListUnsubscribe) window.activeChatListUnsubscribe = null;
if (!window.activeChatBadgeUnsubscribe) window.activeChatBadgeUnsubscribe = null;

let onPanelOpenCallback = null;

// Message-menu state — who's looking at what, and what's mid-edit right now.
let currentViewerRole = null; // 'client' | 'staff', whoever is looking at the open thread
let currentConversationId = null; // the conversation whose thread is currently rendered
let editingMessageId = null; // non-null while the composer is in "edit" mode
let currentThreadMessages = []; // ordered {id, text, senderRole, isDeleted, createdAt} for the open thread — refreshed every render, read by copy/edit/forward and by the preview-sync logic below
let cachedConversationSummaries = []; // [{ id, email }] — admin's conversation list, feeds the Forward picker

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/** Mounts the client-facing single-thread support chat widget. */
export function initClientChat(uid, email) {
  teardownChatWidget();
  buildChatShell({ eyebrow: "Studio Support", heading: "Messages" });

  currentViewerRole = "client";
  currentConversationId = uid;

  const bodyEl = document.getElementById("atelier-chat-body");
  bodyEl.innerHTML = `
    <div class="chat-thread-scroll" id="chat-thread-scroll">
      <p class="loading-mini">Loading conversation...</p>
    </div>
    <form class="chat-input-row" id="chat-input-row" autocomplete="off">
      <input id="chat-input" placeholder="Message the studio..." autocomplete="off" maxlength="1000">
      <button type="submit" class="chat-send-btn" aria-label="Send message">${sendIconSvg()}</button>
    </form>
  `;

  const convoRef = doc(db, "conversations", uid);
  const threadEl = document.getElementById("chat-thread-scroll");

  ensureConversationDoc(uid, email).then(() => {
    const messagesQuery = query(
      collection(db, "conversations", uid, "messages"),
      orderBy("createdAt", "asc")
    );

    window.activeChatThreadUnsubscribe = onSnapshot(messagesQuery, (snap) => {
      renderMessageBubbles(threadEl, snap.docs, "client");
    });
  });

  // Live badge — reflects unreadForClient on the conversation doc itself,
  // which staff replies increment and the client's own reads reset to 0.
  window.activeChatBadgeUnsubscribe = onSnapshot(convoRef, (snap) => {
    updateChatBadge(snap.data()?.unreadForClient || 0);
  });

  onPanelOpenCallback = () => {
    updateDoc(convoRef, { unreadForClient: 0 }).catch(() => {});
  };

  const form = document.getElementById("chat-input-row");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;

    // Edit mode: this submit saves a change to an existing message instead
    // of sending a new one.
    if (editingMessageId) {
      const messageIdBeingEdited = editingMessageId;
      input.value = "";
      cancelEditing();
      try {
        await updateDoc(doc(db, "conversations", uid, "messages", messageIdBeingEdited), {
          text,
          isEdited: true,
        });
        await syncConversationPreview(uid, messageIdBeingEdited, { text, isDeleted: false });
      } catch (err) {
        console.error("Client message edit failure:", err);
        showAtelierNotification("Couldn't save that edit. Please try again.", "error");
      }
      return;
    }

    input.value = "";
    try {
      await addDoc(collection(db, "conversations", uid, "messages"), {
        senderId: uid,
        senderRole: "client",
        senderEmail: email,
        text,
        createdAt: serverTimestamp(),
      });
      await updateDoc(convoRef, {
        lastMessageText: text,
        lastMessageAt: serverTimestamp(),
        lastSenderRole: "client",
        unreadForStaff: increment(1),
        unreadForClient: 0,
      });
    } catch (err) {
      console.error("Client chat send failure:", err);
      showAtelierNotification("Message failed to send. Please try again.", "error");
    }
  });
}

/** Mounts the staff-facing multi-conversation inbox chat widget. */
export function initAdminChat() {
  teardownChatWidget();
  buildChatShell({ eyebrow: "Boutique Inbox", heading: "Client Messages" });

  const bodyEl = document.getElementById("atelier-chat-body");
  bodyEl.innerHTML = `
    <div class="chat-admin-layout" id="chat-admin-layout">
      <div class="chat-admin-list" id="chat-admin-list">
        <p class="loading-mini">Loading conversations...</p>
      </div>
      <div class="chat-admin-thread" id="chat-admin-thread">
        <button type="button" class="chat-admin-back" id="chat-admin-back">${backIconSvg()} Conversations</button>
        <div class="chat-thread-scroll" id="chat-thread-scroll">
          <p class="chat-empty-state">Select a conversation to view messages.</p>
        </div>
        <form class="chat-input-row" id="chat-input-row" style="display: none;" autocomplete="off">
          <input id="chat-input" placeholder="Type a reply..." autocomplete="off" maxlength="1000">
          <button type="submit" class="chat-send-btn" aria-label="Send message">${sendIconSvg()}</button>
        </form>
      </div>
    </div>
  `;

  const listEl = document.getElementById("chat-admin-list");
  const layoutEl = document.getElementById("chat-admin-layout");
  const convosQuery = query(collection(db, "conversations"), orderBy("lastMessageAt", "desc"));

  window.activeChatListUnsubscribe = onSnapshot(convosQuery, (snap) => {
    renderConversationList(listEl, snap.docs);
    cachedConversationSummaries = snap.docs.map((d) => ({
      id: d.id,
      email: d.data().clientEmail || "Unknown client",
    }));
    const totalUnread = snap.docs.reduce((sum, d) => sum + (d.data().unreadForStaff || 0), 0);
    updateChatBadge(totalUnread);
  });

  listEl.addEventListener("click", (e) => {
    const item = e.target.closest(".chat-convo-item");
    if (!item) return;
    openAdminThread(item.dataset.clientId, item.dataset.clientEmail);
  });

  document.getElementById("chat-admin-back").addEventListener("click", () => {
    layoutEl.classList.remove("is-thread-active");
  });

  // Admin badge reflects the sum across every conversation, so opening the
  // panel alone doesn't clear it — only actually opening a thread does
  // (handled per-thread inside openAdminThread below).
  onPanelOpenCallback = null;
}

/** Tears down every live chat listener and removes the widget from the DOM. */
export function teardownChatWidget() {
  if (window.activeChatThreadUnsubscribe) {
    window.activeChatThreadUnsubscribe();
    window.activeChatThreadUnsubscribe = null;
  }
  if (window.activeChatListUnsubscribe) {
    window.activeChatListUnsubscribe();
    window.activeChatListUnsubscribe = null;
  }
  if (window.activeChatBadgeUnsubscribe) {
    window.activeChatBadgeUnsubscribe();
    window.activeChatBadgeUnsubscribe = null;
  }
  onPanelOpenCallback = null;
  currentViewerRole = null;
  currentConversationId = null;
  editingMessageId = null;
  currentThreadMessages = [];
  cachedConversationSummaries = [];

  const widget = document.getElementById("atelier-chat-widget");
  if (widget) widget.remove();
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN THREAD SWITCHING
// ─────────────────────────────────────────────────────────────────────────────
function openAdminThread(clientId, clientEmail) {
  if (window.activeChatThreadUnsubscribe) {
    window.activeChatThreadUnsubscribe();
    window.activeChatThreadUnsubscribe = null;
  }

  const layoutEl = document.getElementById("chat-admin-layout");
  const threadEl = document.getElementById("chat-thread-scroll");
  const inputRow = document.getElementById("chat-input-row");
  if (!layoutEl || !threadEl || !inputRow) return;

  currentViewerRole = "staff";
  currentConversationId = clientId;
  currentThreadMessages = [];
  cancelEditing(); // switching threads abandons any in-progress edit from the last one

  layoutEl.classList.add("is-thread-active");
  layoutEl.dataset.activeClientId = clientId;
  threadEl.innerHTML = `<p class="loading-mini">Loading conversation...</p>`;
  inputRow.style.display = "flex";

  // Highlight the active row in the list
  document.querySelectorAll(".chat-convo-item").forEach((el) => {
    el.classList.toggle("is-active", el.dataset.clientId === clientId);
  });

  const messagesQuery = query(
    collection(db, "conversations", clientId, "messages"),
    orderBy("createdAt", "asc")
  );

  window.activeChatThreadUnsubscribe = onSnapshot(messagesQuery, (snap) => {
    renderMessageBubbles(threadEl, snap.docs, "staff");
  });

  // Opening the thread is the "read" action for staff
  updateDoc(doc(db, "conversations", clientId), { unreadForStaff: 0 }).catch(() => {});

  // Rebind the send handler for this specific client thread each time —
  // cloning the node first strips any listener from a previously open thread.
  const freshInputRow = inputRow.cloneNode(true);
  inputRow.replaceWith(freshInputRow);

  freshInputRow.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = freshInputRow.querySelector("#chat-input");
    const text = input.value.trim();
    if (!text) return;

    const staffUser = auth.currentUser;
    if (!staffUser) return;

    if (editingMessageId) {
      const messageIdBeingEdited = editingMessageId;
      input.value = "";
      cancelEditing();
      try {
        await updateDoc(doc(db, "conversations", clientId, "messages", messageIdBeingEdited), {
          text,
          isEdited: true,
        });
        await syncConversationPreview(clientId, messageIdBeingEdited, { text, isDeleted: false });
      } catch (err) {
        console.error("Admin message edit failure:", err);
        showAtelierNotification("Couldn't save that edit. Please try again.", "error");
      }
      return;
    }

    input.value = "";
    try {
      await addDoc(collection(db, "conversations", clientId, "messages"), {
        senderId: staffUser.uid,
        senderRole: "staff",
        senderEmail: staffUser.email,
        text,
        createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, "conversations", clientId), {
        lastMessageText: text,
        lastMessageAt: serverTimestamp(),
        lastSenderRole: "staff",
        unreadForClient: increment(1),
        unreadForStaff: 0,
      });
    } catch (err) {
      console.error("Admin chat reply failure:", err);
      showAtelierNotification("Reply failed to send. Please try again.", "error");
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED SHELL — glassmorphic launcher + panel, built once per role mount
// ─────────────────────────────────────────────────────────────────────────────
function buildChatShell({ eyebrow, heading }) {
  const shell = document.createElement("div");
  shell.innerHTML = `
    <div class="atelier-chat-widget" id="atelier-chat-widget">
      <button type="button" class="atelier-chat-launcher" id="atelier-chat-launcher" aria-label="Open messages" aria-expanded="false">
        ${chatIconSvg()}
        <span class="atelier-chat-badge" id="atelier-chat-badge" style="display: none;">0</span>
      </button>

      <div class="atelier-chat-panel" id="atelier-chat-panel" aria-hidden="true">
        <div class="atelier-chat-panel-header">
          <div>
            <p class="atelier-chat-eyebrow">${escapeHtml(eyebrow)}</p>
            <h3 class="atelier-chat-title">${escapeHtml(heading)}</h3>
          </div>
          <button type="button" class="atelier-chat-close" id="atelier-chat-close" aria-label="Close messages">&times;</button>
        </div>
        <div class="atelier-chat-body" id="atelier-chat-body"></div>
      </div>

      <div class="chat-bubble-context-menu" id="chat-bubble-context-menu" hidden></div>
    </div>
  `;
  document.body.appendChild(shell.firstElementChild);

  const widget = document.getElementById("atelier-chat-widget");
  const launcher = document.getElementById("atelier-chat-launcher");
  const panel = document.getElementById("atelier-chat-panel");
  const closeBtn = document.getElementById("atelier-chat-close");

  launcher.addEventListener("click", () => {
    const isOpen = panel.classList.toggle("is-active");
    launcher.setAttribute("aria-expanded", String(isOpen));
    panel.setAttribute("aria-hidden", String(!isOpen));
    if (isOpen && typeof onPanelOpenCallback === "function") {
      onPanelOpenCallback();
    }
    if (!isOpen) closeBubbleContextMenu();
  });

  closeBtn.addEventListener("click", () => {
    panel.classList.remove("is-active");
    launcher.setAttribute("aria-expanded", "false");
    panel.setAttribute("aria-hidden", "true");
    closeBubbleContextMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeBubbleContextMenu();
      if (panel.classList.contains("is-active")) {
        panel.classList.remove("is-active");
        launcher.setAttribute("aria-expanded", "false");
        panel.setAttribute("aria-hidden", "true");
      }
    }
  });

  // Message action menu — event delegation on the whole widget so it works
  // regardless of which role's markup (client thread vs admin inbox) is
  // currently mounted inside .atelier-chat-body.
  widget.addEventListener("click", (e) => {
    const menuBtn = e.target.closest(".chat-bubble-menu-btn");
    if (menuBtn) {
      e.stopPropagation();
      openBubbleContextMenu(menuBtn);
      return;
    }
    if (!e.target.closest(".chat-bubble-context-menu")) {
      closeBubbleContextMenu();
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#atelier-chat-widget")) {
      closeBubbleContextMenu();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE ACTION MENU — copy / edit / delete / forward
// ─────────────────────────────────────────────────────────────────────────────
function openBubbleContextMenu(triggerBtn) {
  const menu = document.getElementById("chat-bubble-context-menu");
  if (!menu) return;

  const messageId = triggerBtn.dataset.messageId;
  const canForward = currentViewerRole === "staff" && cachedConversationSummaries.length > 1;

  menu.innerHTML = `
    <button type="button" data-action="copy">${copyIconSvg()}<span>Copy</span></button>
    <button type="button" data-action="edit">${editIconSvg()}<span>Edit</span></button>
    ${canForward ? `<button type="button" data-action="forward">${forwardIconSvg()}<span>Forward</span></button>` : ""}
    <button type="button" data-action="delete" class="is-danger">${trashIconSvg()}<span>Delete</span></button>
  `;
  menu.dataset.messageId = messageId;
  menu.hidden = false;

  // Position near the trigger, flipping upward if it would overflow past
  // the bottom of the (usually screen-edge-adjacent) chat panel.
  const rect = triggerBtn.getBoundingClientRect();
  const menuHeight = menu.offsetHeight || 170;
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow > menuHeight ? rect.bottom + 4 : rect.top - menuHeight - 4;

  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 176)}px`;
  menu.style.right = "";
  menu.style.bottom = "";

  menu.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      handleBubbleMenuAction(btn.dataset.action, messageId);
      if (btn.dataset.action !== "forward") closeBubbleContextMenu();
    });
  });
}

function closeBubbleContextMenu() {
  const menu = document.getElementById("chat-bubble-context-menu");
  if (menu) menu.hidden = true;
}

async function handleBubbleMenuAction(action, messageId) {
  const conversationId = currentConversationId;
  if (!conversationId) return;
  const cached = getCachedMessage(messageId);
  const text = cached?.text || "";

  if (action === "copy") {
    try {
      await navigator.clipboard.writeText(text);
      showAtelierNotification("Message copied to clipboard.");
    } catch {
      showAtelierNotification("Couldn't copy — your browser blocked clipboard access.", "error");
    }
    return;
  }

  if (action === "edit") {
    const input = document.getElementById("chat-input");
    if (!input) return;
    input.value = text;
    input.focus();
    editingMessageId = messageId;
    showEditingBanner();
    return;
  }

  if (action === "delete") {
    const confirmed = window.confirm("Delete this message? This can't be undone.");
    if (!confirmed) return;
    try {
      await updateDoc(doc(db, "conversations", conversationId, "messages", messageId), {
        isDeleted: true,
        text: "",
      });
      await syncConversationPreview(conversationId, messageId, { isDeleted: true, text: "" });
    } catch (err) {
      console.error("Message delete failure:", err);
      showAtelierNotification("Couldn't delete that message. Please try again.", "error");
    }
    return;
  }

  if (action === "forward") {
    openForwardPicker(text);
    return;
  }
}

function openForwardPicker(text) {
  const menu = document.getElementById("chat-bubble-context-menu");
  if (!menu) return;

  const targets = cachedConversationSummaries.filter((c) => c.id !== currentConversationId);
  if (!targets.length) {
    showAtelierNotification("No other conversations to forward to.", "error");
    closeBubbleContextMenu();
    return;
  }

  menu.innerHTML = `
    <p class="chat-menu-label">Forward to&hellip;</p>
    ${targets
      .map(
        (t) =>
          `<button type="button" data-forward-target="${escapeHtml(t.id)}">${escapeHtml(t.email)}</button>`
      )
      .join("")}
  `;
  menu.dataset.messageId = "";
  menu.hidden = false;

  // Anchor this picker to the bottom of the panel rather than the original
  // kebab position — the conversation list can be longer than the copy/
  // edit/delete menu it's replacing.
  menu.style.top = "";
  menu.style.left = "1.5rem";
  menu.style.right = "1.5rem";
  menu.style.bottom = "5.5rem";

  menu.querySelectorAll("[data-forward-target]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await forwardMessageToConversation(btn.dataset.forwardTarget, text);
      closeBubbleContextMenu();
    });
  });
}

async function forwardMessageToConversation(targetClientId, text) {
  const staffUser = auth.currentUser;
  if (!staffUser) return;
  const forwardedText = `Forwarded: ${text}`;

  try {
    await addDoc(collection(db, "conversations", targetClientId, "messages"), {
      senderId: staffUser.uid,
      senderRole: "staff",
      senderEmail: staffUser.email,
      text: forwardedText,
      createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "conversations", targetClientId), {
      lastMessageText: forwardedText,
      lastMessageAt: serverTimestamp(),
      lastSenderRole: "staff",
      unreadForClient: increment(1),
      unreadForStaff: 0,
    });
    showAtelierNotification("Message forwarded.");
  } catch (err) {
    console.error("Forward failure:", err);
    showAtelierNotification("Couldn't forward that message. Please try again.", "error");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EDIT-MODE COMPOSER BANNER
// ─────────────────────────────────────────────────────────────────────────────
function showEditingBanner() {
  removeEditingBanner();
  const form = document.getElementById("chat-input-row");
  if (!form || !form.parentElement) return;

  const banner = document.createElement("div");
  banner.className = "chat-editing-banner";
  banner.id = "chat-editing-banner";
  banner.innerHTML = `
    <span>${editIconSvg()} Editing message</span>
    <button type="button" id="chat-editing-cancel">Cancel</button>
  `;
  form.parentElement.insertBefore(banner, form);

  document.getElementById("chat-editing-cancel").addEventListener("click", () => {
    cancelEditing();
  });
}

function removeEditingBanner() {
  const existing = document.getElementById("chat-editing-banner");
  if (existing) existing.remove();
}

function cancelEditing() {
  editingMessageId = null;
  removeEditingBanner();
  const input = document.getElementById("chat-input");
  if (input) input.value = "";
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function renderMessageBubbles(container, docs, viewerRole) {
  currentThreadMessages = docs.map((docSnap) => {
    const m = docSnap.data();
    return {
      id: docSnap.id,
      text: m.text || "",
      senderRole: m.senderRole,
      isDeleted: !!m.isDeleted,
      createdAt: m.createdAt || null,
    };
  });

  if (!docs.length) {
    container.innerHTML = `<p class="chat-empty-state">No messages yet. Say hello!</p>`;
    return;
  }

  container.innerHTML = docs
    .map((docSnap) => {
      const m = docSnap.data();
      const isMine = m.senderRole === viewerRole;
      const messageId = docSnap.id;

      if (m.isDeleted) {
        return `
          <div class="chat-bubble-row ${isMine ? "is-mine" : ""}" data-message-id="${messageId}">
            <div class="chat-bubble is-deleted">
              <p class="chat-bubble-text chat-bubble-deleted-text">Message deleted</p>
            </div>
          </div>
        `;
      }

      const timeLabel = formatChatTimestamp(m.createdAt);
      const editedTag = m.isEdited ? `<span class="chat-bubble-edited-tag">&middot; Edited</span>` : "";

      // The action menu is only offered on messages the current viewer sent
      // themself — matches how every other chat surface scopes edit/delete.
      const menuBtn = isMine
        ? `<button type="button" class="chat-bubble-menu-btn" data-message-id="${messageId}" aria-label="Message options" aria-haspopup="true">${kebabIconSvg()}</button>`
        : "";

      return `
        <div class="chat-bubble-row ${isMine ? "is-mine" : ""}" data-message-id="${messageId}">
          <div class="chat-bubble">
            ${menuBtn}
            <p class="chat-bubble-text">${escapeHtml(m.text || "")}</p>
            <span class="chat-bubble-time">${timeLabel}${editedTag}</span>
          </div>
        </div>
      `;
    })
    .join("");

  container.scrollTop = container.scrollHeight;
}

function renderConversationList(container, docs) {
  if (!docs.length) {
    container.innerHTML = `<p class="chat-empty-state">No client conversations yet.</p>`;
    return;
  }

  const activeClientId = document.getElementById("chat-admin-layout")?.dataset.activeClientId;

  container.innerHTML = docs
    .map((docSnap) => {
      const c = docSnap.data();
      const unread = c.unreadForStaff || 0;
      const preview = c.lastMessageText
        ? escapeHtml(c.lastMessageText).slice(0, 60)
        : "No messages yet";
      const rolePrefix = c.lastSenderRole === "staff" ? "You: " : "";
      const isActive = docSnap.id === activeClientId;

      return `
        <button
          type="button"
          class="chat-convo-item ${unread > 0 ? "has-unread" : ""} ${isActive ? "is-active" : ""}"
          data-client-id="${docSnap.id}"
          data-client-email="${escapeHtml(c.clientEmail || "")}"
        >
          <span class="chat-convo-email">${escapeHtml(c.clientEmail || "Unknown client")}</span>
          <span class="chat-convo-preview">${rolePrefix}${preview}</span>
          ${unread > 0 ? `<span class="chat-convo-unread-dot">${unread > 9 ? "9+" : unread}</span>` : ""}
        </button>
      `;
    })
    .join("");
}

function updateChatBadge(count) {
  const badge = document.getElementById("atelier-chat-badge");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? "9+" : String(count);
    badge.style.display = "flex";
  } else {
    badge.style.display = "none";
  }
}

/**
 * Recomputes and writes the conversation's lastMessageText/lastSenderRole/
 * lastMessageAt after an edit or soft-delete, so the admin inbox preview
 * and client badge never show stale text once the most recent message has
 * been changed or removed.
 *
 * mutatedOverride describes the POST-mutation state of the message that was
 * just edited/deleted — currentThreadMessages still holds the PRE-mutation
 * snapshot at this point (the next onSnapshot fire hasn't landed yet), so
 * the override is applied on top of the cache rather than trusting it as-is.
 */
async function syncConversationPreview(conversationId, mutatedMessageId, mutatedOverride) {
  const effectiveList = currentThreadMessages.map((m) =>
    m.id === mutatedMessageId ? { ...m, ...mutatedOverride } : m
  );

  let latest = null;
  for (let i = effectiveList.length - 1; i >= 0; i--) {
    if (!effectiveList[i].isDeleted) {
      latest = effectiveList[i];
      break;
    }
  }

  const convoRef = doc(db, "conversations", conversationId);
  try {
    if (latest) {
      await updateDoc(convoRef, {
        lastMessageText: latest.text,
        lastSenderRole: latest.senderRole,
        lastMessageAt: latest.createdAt || serverTimestamp(),
      });
    } else {
      await updateDoc(convoRef, { lastMessageText: "" });
    }
  } catch (err) {
    console.error("Conversation preview sync failure:", err);
  }
}

/** Looks up a message's cached data by ID — used by copy/edit/forward. */
function getCachedMessage(messageId) {
  return currentThreadMessages.find((m) => m.id === messageId) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FIRESTORE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
async function ensureConversationDoc(uid, email) {
  const convoRef = doc(db, "conversations", uid);
  const snap = await getDoc(convoRef);
  if (!snap.exists()) {
    await setDoc(convoRef, {
      clientId: uid,
      clientEmail: email,
      createdAt: serverTimestamp(),
      lastMessageText: "",
      lastMessageAt: serverTimestamp(),
      lastSenderRole: null,
      unreadForClient: 0,
      unreadForStaff: 0,
    });
  }
  return convoRef;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function formatChatTimestamp(timestamp) {
  if (!timestamp?.toDate) return "Sending...";
  const date = timestamp.toDate();
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Escapes untrusted message text before it's injected via innerHTML. */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function chatIconSvg() {
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`;
}

function sendIconSvg() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
}

function backIconSvg() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>`;
}

function kebabIconSvg() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="12" cy="19" r="1.8"></circle></svg>`;
}

function copyIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
}

function editIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
}

function trashIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
}

function forwardIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"></polyline><path d="M4 18v-2a4 4 0 0 1 4-4h12"></path></svg>`;
}