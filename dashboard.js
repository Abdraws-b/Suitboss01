import {
  collection,
  query,
  where,
  onSnapshot,
  orderBy,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { db, auth, authReady } from "./app.js";
import {
  createProductImageClient,
  validateProductImageFile,
  withTimeout,
  ProductImageError,
  removeProductAndImage,
} from "./product-image-upload.js?v=20261014-cloudinary-1";
import { showAtelierNotification } from "./ui-feedback.js";
import {
  DEFAULT_CATEGORIES,
  cleanCategoryLabel,
  categorySlug,
  resolveCategory,
  escapeHtml,
} from "./category-utils.js";
import { initClientChat, initAdminChat, teardownChatWidget } from "./chat-engine.js";

// Build marker — lets you confirm which dashboard.js a browser is really running
// (DevTools console: window.__suitbossDashboardBuild). The "?v=" on the helper
// import above and on app.js's import("./dashboard.js") must carry this same
// value; bump all three together on every deploy so cached copies can't mix.
export const DASHBOARD_BUILD = "20261014-cloudinary-1";
window.__suitbossDashboardBuild = DASHBOARD_BUILD;
console.info("[Suitboss] dashboard build", DASHBOARD_BUILD);

// Product images are uploaded through the secured PHP endpoint (Cloudinary).
// The endpoint derives the user from the verified Firebase ID token and
// re-checks users/{uid}.systemAccessLevel === "admin" server-side.
const productImageClient = createProductImageClient({
  getIdToken: async (forceRefresh) => {
    await authReady;
    const user = auth.currentUser;
    if (!user) throw new Error("Not signed in.");
    return user.getIdToken(Boolean(forceRefresh));
  },
});

// Ensure global operational tracking hook sits safely at window runtime space
if (!window.activeDashboardUnsubscribe) {
  window.activeDashboardUnsubscribe = null;
}

// Known Lookbook categories (slug → display label). Seeded with defaults and
// extended from live inventory so the admin field can suggest existing
// categories — this is what prevents "Kaftan" / "kaftans" / "Kaftans " from
// becoming three separate filters on the public Lookbook.
const knownCategoryLabels = new Map(
  DEFAULT_CATEGORIES.map((label) => [categorySlug(label), label])
);

function refreshCategoryDatalist() {
  const list = document.getElementById("inv-category-options");
  if (!list) return;
  list.innerHTML = [...knownCategoryLabels.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((label) => `<option value="${escapeHtml(label)}"></option>`)
    .join("");
}

// Secondary tracker for the inventory stream subscription in admin view
if (!window.activeInventoryUnsubscribe) {
  window.activeInventoryUnsubscribe = null;
}

// Phase 5: Analytics Ledger Hub — global metrics snapshot subscription
if (!window.activeMetricsUnsubscribe) {
  window.activeMetricsUnsubscribe = null;
}

// Ready-To-Wear Boutique Orders modal — its own tracker. The bespoke ledger
// now stays permanently mounted (see mountAtelierDashboard), so its RTW
// counterpart can no longer share window.activeDashboardUnsubscribe without
// the two clobbering each other's listener handle whenever the modal opens.
if (!window.activeRtwModalUnsubscribe) {
  window.activeRtwModalUnsubscribe = null;
}

// NEW — Date-search state for the Bespoke and Ready-To-Wear order ledgers.
// Kept on window (not a plain module `let`) so the currently-typed search
// date survives the repeated re-renders triggered by onSnapshot firing on
// every order update, and so it isn't lost if this module is re-evaluated.
if (typeof window.bespokeOrderDateFilter === "undefined") {
  window.bespokeOrderDateFilter = "";
}
if (typeof window.rtwOrderDateFilter === "undefined") {
  window.rtwOrderDateFilter = "";
}

/**
 * Root Router Hub for Account Workspace
 * Directs traffic based on authorization access parameters
 */

/** Returns a time-of-day-appropriate greeting label. */
function getTimeBasedGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return "Good Morning";
  if (hour >= 12 && hour < 17) return "Good Afternoon";
  if (hour >= 17 && hour < 21) return "Good Evening";
  return "Good Night";
}

/**
 * Derives a presentable first name from an email's local part.
 * "rashlas.mensah@gmail.com" -> "Rashlas", "j_appiah22@..." -> "J" (falls
 * back gracefully rather than guessing past what the email actually gives).
 */
function extractFirstNameFromEmail(email) {
  if (!email || typeof email !== "string") return "there";
  const localPart = email.split("@")[0] || "";
  const match = localPart.match(/^[A-Za-z]+/);
  const rawName = match ? match[0] : localPart;
  if (!rawName) return "there";
  return rawName.charAt(0).toUpperCase() + rawName.slice(1).toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD SIDEBAR SHELL — shared between client and admin dashboards
//
// One collapsible sidebar (icon + label nav, collapses to icon-only, state
// remembered across visits via localStorage) plus a single content pane
// that gets re-rendered per section. Sections mount their own Firestore
// listener when opened and tear it down when the admin/client switches
// away — teardownAllSectionListeners() below is the one place that closes
// every tracked listener, called both on dashboard remount and on every
// section switch, so nothing can leak regardless of which screen was open.
// ─────────────────────────────────────────────────────────────────────────────
const SIDEBAR_COLLAPSE_KEY = "suitboss_sidebar_collapsed";

function teardownAllSectionListeners() {
  if (window.activeDashboardUnsubscribe) {
    window.activeDashboardUnsubscribe();
    window.activeDashboardUnsubscribe = null;
  }
  if (window.activeInventoryUnsubscribe) {
    window.activeInventoryUnsubscribe();
    window.activeInventoryUnsubscribe = null;
  }
  if (window.activeMetricsUnsubscribe) {
    window.activeMetricsUnsubscribe();
    window.activeMetricsUnsubscribe = null;
  }
  if (window.activeRtwModalUnsubscribe) {
    window.activeRtwModalUnsubscribe();
    window.activeRtwModalUnsubscribe = null;
  }
}

function buildDashboardSidebarShell(sections) {
  const navItemsHtml = sections.map((s) => `
    <li>
      <button type="button" class="dash-nav-item" data-section="${s.id}" title="${s.label}">
        <span class="dash-nav-icon" aria-hidden="true">${s.icon}</span>
        <span class="dash-nav-label">${s.label}</span>
        ${s.badgeId ? `<span class="dash-nav-badge" id="${s.badgeId}" style="display: none;">0</span>` : ""}
      </button>
    </li>
  `).join("");

  return `
    <div class="dash-shell" id="dash-shell">
      <aside class="dash-sidebar" id="dash-sidebar">
        <button type="button" class="dash-sidebar-collapse-btn" id="dash-sidebar-collapse-btn" aria-label="Collapse sidebar" aria-expanded="true">
          ${chevronIconSvg()}
        </button>
        <nav class="dash-sidebar-nav" aria-label="Dashboard sections">
          <ul>${navItemsHtml}</ul>
        </nav>
        <div class="dash-sidebar-footer">
          <a href="#logout" class="dash-nav-item dash-nav-signout nav-logout js-logout-btn" title="Sign Out">
            <span class="dash-nav-icon" aria-hidden="true">${signOutIconSvg()}</span>
            <span class="dash-nav-label">Sign Out</span>
          </a>
        </div>
      </aside>
      <div class="dash-content-pane" id="dash-content-pane"></div>
    </div>
  `;
}

/**
 * Wires the collapse toggle and nav-item clicks. onSectionChange(sectionId)
 * is called with no listener bookkeeping of its own — each section-mount
 * function is responsible for calling teardownAllSectionListeners() itself
 * before setting up whatever it needs, so this stays a thin router.
 */
function wireDashboardSidebar(defaultSectionId, onSectionChange) {
  const shell = document.getElementById("dash-shell");
  const collapseBtn = document.getElementById("dash-sidebar-collapse-btn");
  if (!shell || !collapseBtn) return;

  const startCollapsed = localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "true";
  if (startCollapsed) shell.classList.add("is-collapsed");
  collapseBtn.setAttribute("aria-expanded", startCollapsed ? "false" : "true");

  collapseBtn.addEventListener("click", () => {
    const nowCollapsed = shell.classList.toggle("is-collapsed");
    collapseBtn.setAttribute("aria-expanded", nowCollapsed ? "false" : "true");
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, String(nowCollapsed));
  });

  const navButtons = shell.querySelectorAll(".dash-nav-item[data-section]");
  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      navButtons.forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      onSectionChange(btn.dataset.section);
    });
  });

  const defaultBtn = shell.querySelector(`.dash-nav-item[data-section="${defaultSectionId}"]`);
  if (defaultBtn) defaultBtn.classList.add("is-active");
}

/** Programmatically activates a sidebar section, e.g. from a "View All" link inside a section's own content. */
function navigateToSidebarSection(sectionId) {
  const btn = document.querySelector(`.dash-nav-item[data-section="${sectionId}"]`);
  if (btn) btn.click();
}

// Recognized silhouette slugs that indicate a Ready-To-Wear order even on
// older documents that predate the explicit orderType field. Hoisted to
// module scope since both the client dashboard's order sections and the
// notifications feed need the same classification logic.
const RTW_SILHOUETTE_SLUGS = new Set([
  "signature-kaftan",
  "bespoke-two-piece",
  "luxury-agbada",
  "printed-apparel",
]);

function isReadyToWearOrder(orderData) {
  return orderData.orderType === "Ready-To-Wear" ||
    RTW_SILHOUETTE_SLUGS.has(orderData.configuration?.silhouette);
}

/** Renders one client-facing order card. Shared by the overview preview, My Orders, Bespoke Orders, and Ready to Wear sections — they differ only in which documents they pass in. */
function buildClientOrderCardHtml(orderDoc) {
  const orderData = orderDoc.data();
  const shortId = orderDoc.id.substring(0, 8).toUpperCase();

  const status = orderData.commissionStatus || "Pending Studio Review";
  let progressWidth = "15%";
  let statusClass = "status-pending";

  if (status === "In Cutting Stage") {
    progressWidth = "45%";
    statusClass = "status-cutting";
  } else if (status === "Assembled & Awaiting Fitting") {
    progressWidth = "75%";
    statusClass = "status-fitting";
  } else if (status === "Completed & Shipped") {
    progressWidth = "100%";
    statusClass = "status-completed";
  }

  const isRTW = isReadyToWearOrder(orderData);
  const imageUrl = orderData.apparelImage || orderData.imageUrl || orderData.configuration?.customSilhouetteImageUrl || "";

  let thumbnailHtml = "";
  if (imageUrl && (isRTW || orderData.configuration?.customSilhouetteImageUrl)) {
    thumbnailHtml = `
      <img
        src="${imageUrl}"
        alt="${orderData.collectionName || 'Garment preview'}"
        style="width: 60px; height: 60px; object-fit: cover; border: 1px solid var(--color-accent); padding: 2px; background: #111; border-radius: 2px; flex-shrink: 0;"
        loading="lazy"
      >
    `;
  }

  const orderTitle = isRTW
    ? (orderData.collectionName || "Ready-To-Wear Piece")
    : resolveSilhouetteLabel(orderData.configuration);

  const orderSubline = isRTW
    ? (orderData.selectedSize ? `Size: ${orderData.selectedSize}` : "Ready-To-Wear")
    : `Material Layer: ${resolveTextileLabel(orderData.configuration)}`;

  let deliveryNotesHtml = "";
  if (typeof orderData.deliveryNotes === "string" && orderData.deliveryNotes.trim().length > 0) {
    deliveryNotesHtml = `
      <div class="studio-message-panel" style="margin-top: 0.85rem; padding: 0.85rem 1rem; border: 1px solid var(--color-accent); border-left: 3px solid var(--color-accent); background: rgba(197, 168, 128, 0.08); border-radius: 2px;">
        <p style="margin: 0 0 0.25rem 0; font-family: var(--font-body); font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-accent);">Studio Message</p>
        <p style="margin: 0; font-size: 0.92rem; line-height: 1.45;">${escapeHtmlForDisplay(orderData.deliveryNotes)}</p>
      </div>
    `;
  }

  const studioDispatchNote = `<p class="studio-dispatch-note">${
    orderData.deliveryNotes
      ? `<strong>Delivery Log:</strong> ${escapeHtmlForDisplay(orderData.deliveryNotes)}`
      : "Your garment is being meticulously curated at the studio cutting desk."
  }</p>`;

  return `
    <div class="client-order-row-card">
      <div class="client-order-top-row">
        ${thumbnailHtml}
        <div class="client-order-meta">
          <span class="badge-order-id">SB-${shortId}</span>
          <h4 class="client-order-title">${escapeHtmlForDisplay(orderTitle)}</h4>
          <p class="client-order-textile">${escapeHtmlForDisplay(orderSubline)}</p>
        </div>
        <div class="client-order-status-block">
          <div class="pipeline-indicator-pill ${statusClass}">${status}</div>
          <div class="financial-indicator-pill ${orderData.financialStatus === 'Settled' ? 'paid-token' : 'unpaid-token'}">
            ${orderData.financialStatus || "Awaiting Invoice"}
          </div>
        </div>
      </div>
      <div class="atelier-progress-track">
        <div class="atelier-progress-bar ${statusClass}" style="width: ${progressWidth}"></div>
      </div>
      ${deliveryNotesHtml}
      ${studioDispatchNote}
    </div>
  `;
}

export async function mountAtelierDashboard(uid) {
  const mainContent = document.getElementById("main-content");
  if (!mainContent) return;

  // This whole cleanup/setup block used to run unprotected, outside any
  // try/catch — every step below it (the actual role-based rendering) had
  // its own dedicated try/catch, but this one didn't. A failure here would
  // skip straight past mountAtelierDashboard's own error handling and
  // surface only as handleAppRouting's generic "Couldn't load the
  // dashboard" toast, with no indication of what actually failed. Wrapping
  // it here means any future issue in teardown/cleanup gets its own
  // specific, logged, in-page message instead.
  try {
    // Clean up any active dangling database streams to prevent memory compounding
    if (window.activeDashboardUnsubscribe) {
      window.activeDashboardUnsubscribe();
      window.activeDashboardUnsubscribe = null;
    }
    if (window.activeInventoryUnsubscribe) {
      window.activeInventoryUnsubscribe();
      window.activeInventoryUnsubscribe = null;
    }
    if (window.activeMetricsUnsubscribe) {
      window.activeMetricsUnsubscribe();
      window.activeMetricsUnsubscribe = null;
    }
    if (window.activeRtwModalUnsubscribe) {
      window.activeRtwModalUnsubscribe();
      window.activeRtwModalUnsubscribe = null;
    }

    // Same for the chat widget — its listeners (thread/list/badge) are all
    // independent of the streams above and need their own explicit teardown.
    teardownChatWidget();

    // Fix header color when staging content over transparent areas
    const headerEl = document.querySelector(".atelier-header");
    if (headerEl) {
      headerEl.classList.add("internal-header");
    }
  } catch (setupError) {
    console.error("Dashboard pre-mount cleanup failure:", setupError);
    mainContent.innerHTML = `<p class="error-text" style="text-align:center; padding: 5rem;">Couldn't reset the previous view. Please refresh and try again.<br><small>${setupError.code || ''}: ${setupError.message || setupError}</small></p>`;
    return;
  }

  mainContent.innerHTML = `<p class="loading-text" style="text-align:center; padding: 5rem;">Verifying secure studio access levels...</p>`;

  try {
    const userDocRef = doc(db, "users", uid);
    const docSnap = await getDoc(userDocRef);

    if (docSnap.exists()) {
      const profileData = docSnap.data();

      if (
        profileData.systemAccessLevel === "admin" ||
        profileData.systemAccessLevel === "tailor"
      ) {
        mountTailorShopTerminal();
      } else {
        // renderClientLedgerDashboard is an async function — awaiting it
        // here (it wasn't before) means any error anywhere in its own
        // execution is guaranteed to be caught by this try/catch, the same
        // fix applied to handleAppRouting's call into this function.
        await renderClientLedgerDashboard(uid);
      }
    } else {
      mainContent.innerHTML = `<p class="error-text" style="text-align:center; padding: 5rem;">Atelier profile record not found in system registers.</p>`;
    }
  } catch (error) {
    console.error("Dashboard router authentication intercept failure:", error);
    // Every other error handler in this file shows error.code/error.message
    // directly on screen (see the client orders stream, the metrics stream,
    // the bespoke ledger, the RTW stream) — this was the one spot that
    // didn't, which matters because this exact catch block is what runs if
    // the very first read (the user's own profile doc, right above) gets
    // rejected by Firestore for any reason, permission-denied included.
    // Without the code/message on screen, that failure was indistinguishable
    // from every other kind of error — now it isn't.
    mainContent.innerHTML = `<p class="error-text" style="text-align:center; padding: 5rem;">System validation error. Please try logging in again.<br><small>${error.code || ''}: ${error.message || error}</small></p>`;
  }
}

/**
 * Renders the Client View Dashboard with Live Blueprint Metric Modifiers
 */
async function renderClientLedgerDashboard(uid) {
  const mainContent = document.getElementById("main-content");
  if (!mainContent) return;

  try {
    const userDocRef = doc(db, "users", uid);
    const userSnap = await getDoc(userDocRef);
    const profileData = userSnap.data() || {};

    const sections = [
      { id: "overview", label: "Overview", icon: overviewIconSvg() },
      { id: "orders", label: "My Orders", icon: packageIconSvg() },
      { id: "bespoke", label: "Bespoke Orders", icon: rulerIconSvg() },
      { id: "rtw", label: "Ready to Wear", icon: hangerIconSvg() },
      { id: "notifications", label: "Notifications", icon: bellIconSvg() },
      { id: "profile", label: "My Profile", icon: personIconSvg() },
    ];

    mainContent.innerHTML = buildDashboardSidebarShell(sections);
    wireDashboardSidebar("overview", (sectionId) => mountClientSection(sectionId, uid, userDocRef, profileData));
    mountClientSection("overview", uid, userDocRef, profileData);

    // Real-time studio support chat — floating glass launcher, persists
    // across every section switch since it lives outside the content pane.
    initClientChat(uid, profileData.email);

  } catch (error) {
    console.error("Failure constructing client dashboard layout sheets:", error);
    mainContent.innerHTML = `<p class="error-text" style="text-align:center; padding:5rem;">Dashboard load error. Please refresh.</p>`;
  }
}

/** Routes a sidebar click to the right section-mount function, closing any listener the previous section had open first. */
function mountClientSection(sectionId, uid, userDocRef, profileData) {
  const pane = document.getElementById("dash-content-pane");
  if (!pane) return;

  teardownAllSectionListeners();

  if (sectionId === "profile") {
    mountClientProfileSection(pane, userDocRef, profileData);
  } else if (sectionId === "notifications") {
    mountClientNotificationsSection(pane, uid);
  } else {
    // "overview", "orders", "bespoke", and "rtw" all share the same
    // order-stream rendering — they differ only in header copy and which
    // documents get filtered in.
    mountClientOrdersSection(pane, uid, sectionId, profileData);
  }
}

/**
 * Renders the client's order list — used directly by My Orders, Bespoke
 * Orders, and Ready to Wear, and in a condensed form (greeting + quick
 * stats + 3 most recent) by Overview.
 */
function mountClientOrdersSection(pane, uid, mode, profileData) {
  const isOverview = mode === "overview";
  const headerCopy = {
    overview: { title: `${getTimeBasedGreeting()}, ${extractFirstNameFromEmail(profileData.email)}`, sub: "Manage your anatomical blueprint and track active commissions." },
    orders:   { title: "My Orders", sub: "Every bespoke commission and boutique order tied to your profile." },
    bespoke:  { title: "Bespoke Orders", sub: "Made-to-measure commissions currently in production." },
    rtw:      { title: "Ready to Wear", sub: "Boutique pieces ordered straight from the Lookbook." },
  }[mode];

  pane.innerHTML = `
    <div class="dash-section-header">
      <div>
        <p class="dash-section-eyebrow">Private Studio Ledger</p>
        <h1 class="dash-section-title">${headerCopy.title}</h1>
        <p class="dash-section-sub">${headerCopy.sub}</p>
      </div>
    </div>
    ${isOverview ? `<div class="dash-stat-row" id="dash-stat-row"></div>` : ""}
    <div class="dashboard-card-pane dash-section-body">
      <h3 class="card-pane-title">${isOverview ? "Recent Activity" : "Active Production Tracker"}</h3>
      <p class="card-pane-sub">Real-time pipeline overview directly from our cutting room floor.</p>
      <div id="client-active-orders-stream" class="orders-stream-box">
        <p class="loading-mini">Synchronizing server records...</p>
      </div>
      ${isOverview ? `<button type="button" class="btn-dash-view-all" id="dash-view-all-orders">View All Orders →</button>` : ""}
    </div>
  `;

  if (isOverview) {
    const viewAllBtn = document.getElementById("dash-view-all-orders");
    if (viewAllBtn) viewAllBtn.addEventListener("click", () => navigateToSidebarSection("orders"));
  }

  const ordersStreamBox = document.getElementById("client-active-orders-stream");
  const statRow = document.getElementById("dash-stat-row");
  const ordersQuery = query(collection(db, "orders"), where("clientId", "==", uid));

  window.activeDashboardUnsubscribe = onSnapshot(ordersQuery, (snapshot) => {
    const allDocs = snapshot.docs.slice().sort((a, b) => {
      const tA = a.data().orderCreatedTimestamp?.toMillis?.() || 0;
      const tB = b.data().orderCreatedTimestamp?.toMillis?.() || 0;
      return tB - tA;
    });

    let visibleDocs = allDocs;
    if (mode === "bespoke") visibleDocs = allDocs.filter((d) => !isReadyToWearOrder(d.data()));
    if (mode === "rtw") visibleDocs = allDocs.filter((d) => isReadyToWearOrder(d.data()));
    if (isOverview) visibleDocs = allDocs.slice(0, 3);

    if (statRow) {
      const activeCount = allDocs.filter((d) => d.data().commissionStatus !== "Completed & Shipped").length;
      const pendingCount = allDocs.filter((d) => (d.data().commissionStatus || "Pending Studio Review") === "Pending Studio Review").length;
      const completedCount = allDocs.filter((d) => d.data().commissionStatus === "Completed & Shipped").length;
      statRow.innerHTML = `
        <div class="dash-stat-card"><span class="dash-stat-value">${activeCount}</span><span class="dash-stat-label">Active Commissions</span></div>
        <div class="dash-stat-card"><span class="dash-stat-value">${pendingCount}</span><span class="dash-stat-label">Pending Review</span></div>
        <div class="dash-stat-card"><span class="dash-stat-value">${completedCount}</span><span class="dash-stat-label">Completed</span></div>
      `;
    }

    if (visibleDocs.length === 0) {
      ordersStreamBox.innerHTML = `
        <div class="empty-stream-card">
          <p>No commissions found under your profile token.</p>
          <a href="custom-order.html" class="inline-atelier-link">File a Bespoke Pre-Order →</a>
        </div>
      `;
      return;
    }

    ordersStreamBox.innerHTML = visibleDocs.map(buildClientOrderCardHtml).join("");
  }, (err) => {
    console.error("Client side snapshot connection drop error:", err);
    ordersStreamBox.innerHTML = `<p class="error-text">Failed to establish active updates link with streaming servers.<br><small>${err.code || ''}: ${err.message || err}</small></p>`;
  });
}

/**
 * Notifications: a chronological feed of studio messages (deliveryNotes)
 * left on the client's own orders — not a separate Firestore collection,
 * just a different view over data that already exists, so there's nothing
 * new to keep in sync.
 */
function mountClientNotificationsSection(pane, uid) {
  pane.innerHTML = `
    <div class="dash-section-header">
      <div>
        <p class="dash-section-eyebrow">Private Studio Ledger</p>
        <h1 class="dash-section-title">Notifications</h1>
        <p class="dash-section-sub">Studio updates left on your active and past commissions.</p>
      </div>
    </div>
    <div class="dashboard-card-pane dash-section-body">
      <div id="client-notifications-stream" class="orders-stream-box">
        <p class="loading-mini">Synchronizing server records...</p>
      </div>
    </div>
  `;

  const streamBox = document.getElementById("client-notifications-stream");
  const ordersQuery = query(collection(db, "orders"), where("clientId", "==", uid));

  window.activeDashboardUnsubscribe = onSnapshot(ordersQuery, (snapshot) => {
    const withNotes = snapshot.docs
      .filter((d) => typeof d.data().deliveryNotes === "string" && d.data().deliveryNotes.trim().length > 0)
      .sort((a, b) => {
        const tA = a.data().orderCreatedTimestamp?.toMillis?.() || 0;
        const tB = b.data().orderCreatedTimestamp?.toMillis?.() || 0;
        return tB - tA;
      });

    if (withNotes.length === 0) {
      streamBox.innerHTML = `
        <div class="empty-stream-card">
          <p>No studio notifications yet — updates on your orders will appear here.</p>
        </div>
      `;
      return;
    }

    streamBox.innerHTML = withNotes.map((orderDoc) => {
      const data = orderDoc.data();
      const shortId = orderDoc.id.substring(0, 8).toUpperCase();
      const title = isReadyToWearOrder(data)
        ? (data.collectionName || "Ready-To-Wear Piece")
        : resolveSilhouetteLabel(data.configuration);
      return `
        <div class="client-order-row-card">
          <div class="client-order-meta">
            <span class="badge-order-id">SB-${shortId}</span>
            <h4 class="client-order-title">${escapeHtmlForDisplay(title)}</h4>
          </div>
          <div class="studio-message-panel" style="margin-top: 0.6rem; padding: 0.85rem 1rem; border: 1px solid var(--color-accent); border-left: 3px solid var(--color-accent); background: rgba(197, 168, 128, 0.08); border-radius: 2px;">
            <p style="margin: 0 0 0.25rem 0; font-family: var(--font-body); font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-accent);">Studio Message</p>
            <p style="margin: 0; font-size: 0.92rem; line-height: 1.45;">${escapeHtmlForDisplay(data.deliveryNotes)}</p>
          </div>
        </div>
      `;
    }).join("");
  }, (err) => {
    console.error("Client notifications snapshot error:", err);
    streamBox.innerHTML = `<p class="error-text">Failed to load notifications.<br><small>${err.code || ''}: ${err.message || err}</small></p>`;
  });
}

/** My Profile — the measurement blueprint editor, unchanged from before, just relocated into its own section. */
function mountClientProfileSection(pane, userDocRef, profileData) {
  const blueprint = profileData.measurementBlueprint || {};
  const upperBody = blueprint.upperBody || {};
  const lowerBody = blueprint.lowerBody || {};

  pane.innerHTML = `
    <div class="dash-section-header">
      <div>
        <p class="dash-section-eyebrow">Private Studio Ledger</p>
        <h1 class="dash-section-title">My Profile</h1>
        <p class="dash-section-sub">Adjust your stored metrics below. Active cuts will update instantly upon saving.</p>
      </div>
      <div class="client-meta-badge">Profile: ${profileData.email || 'Bespoke Client'}</div>
    </div>
    <div class="dashboard-card-pane dash-section-body">
      <h3 class="card-pane-title">Archived Blueprint Proportions</h3>
      <form id="dashboard-blueprint-form" class="blueprint-inline-form">
        <div class="blueprint-input-grid">
          <div class="metric-input-field">
            <label for="dash-neck">Neck (cm)</label>
            <input type="number" id="dash-neck" value="${upperBody.neck ?? ''}" step="0.1" min="0" placeholder="--">
          </div>
          <div class="metric-input-field">
            <label for="dash-chest">Chest (cm)</label>
            <input type="number" id="dash-chest" value="${upperBody.chest ?? ''}" step="0.1" min="0" placeholder="--">
          </div>
          <div class="metric-input-field">
            <label for="dash-across-back-shoulder">Across Back / Shoulder (cm)</label>
            <input type="number" id="dash-across-back-shoulder" value="${upperBody.acrossBackShoulder ?? ''}" step="0.1" min="0" placeholder="--">
          </div>
          <div class="metric-input-field">
            <label for="dash-sleeve-length">Sleeve Length (cm)</label>
            <input type="number" id="dash-sleeve-length" value="${upperBody.sleeveLength ?? ''}" step="0.1" min="0" placeholder="--">
          </div>
          <div class="metric-input-field">
            <label for="dash-top-length">Top Length (cm)</label>
            <input type="number" id="dash-top-length" value="${upperBody.topLength ?? ''}" step="0.1" min="0" placeholder="--">
          </div>
          <div class="metric-input-field">
            <label for="dash-around-arm">Around Arm (cm)</label>
            <input type="number" id="dash-around-arm" value="${upperBody.aroundArm ?? ''}" step="0.1" min="0" placeholder="--">
          </div>
          <div class="metric-input-field">
            <label for="dash-wrist">Wrist (cm)</label>
            <input type="number" id="dash-wrist" value="${upperBody.wrist ?? ''}" step="0.1" min="0" placeholder="--">
          </div>
          <div class="metric-input-field">
            <label for="dash-waist">Waist (cm)</label>
            <input type="number" id="dash-waist" value="${lowerBody.waist ?? ''}" step="0.1" min="0" placeholder="--">
          </div>
          <div class="metric-input-field">
            <label for="dash-length">Length (cm)</label>
            <input type="number" id="dash-length" value="${lowerBody.length ?? ''}" step="0.1" min="0" placeholder="--">
          </div>
          <div class="metric-input-field">
            <label for="dash-thigh">Thigh (cm)</label>
            <input type="number" id="dash-thigh" value="${lowerBody.thigh ?? ''}" step="0.1" min="0" placeholder="--">
          </div>
          <div class="metric-input-field">
            <label for="dash-knee">Knee (cm)</label>
            <input type="number" id="dash-knee" value="${lowerBody.knee ?? ''}" step="0.1" min="0" placeholder="--">
          </div>
          <div class="metric-input-field">
            <label for="dash-bar-ankle">Bar/Ankle (cm)</label>
            <input type="number" id="dash-bar-ankle" value="${lowerBody.barAnkle ?? ''}" step="0.1" min="0" placeholder="--">
          </div>
        </div>
        <button type="submit" class="btn-dashboard-save">Save Metric Shifts</button>
      </form>
    </div>
  `;

  const blueprintForm = document.getElementById("dashboard-blueprint-form");
  blueprintForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const readMetric = (id) => {
      const val = document.getElementById(id).value;
      return val === "" ? null : parseFloat(val);
    };

    const freshUpperBody = {
      neck: readMetric("dash-neck"),
      chest: readMetric("dash-chest"),
      acrossBackShoulder: readMetric("dash-across-back-shoulder"),
      sleeveLength: readMetric("dash-sleeve-length"),
      topLength: readMetric("dash-top-length"),
      aroundArm: readMetric("dash-around-arm"),
      wrist: readMetric("dash-wrist"),
    };

    const freshLowerBody = {
      waist: readMetric("dash-waist"),
      length: readMetric("dash-length"),
      thigh: readMetric("dash-thigh"),
      knee: readMetric("dash-knee"),
      barAnkle: readMetric("dash-bar-ankle"),
    };

    let validationError = null;
    for (const [key, val] of Object.entries({ ...freshUpperBody, ...freshLowerBody })) {
      if (val !== null && (Number.isNaN(val) || val < 0)) {
        validationError = `The entry for ${key} must be a valid, non-negative measurement.`;
        break;
      }
    }

    if (validationError) {
      showAtelierNotification(validationError, "error");
      return;
    }

    try {
      await updateDoc(userDocRef, {
        measurementBlueprint: {
          upperBody: freshUpperBody,
          lowerBody: freshLowerBody,
          lastUpdated: serverTimestamp()
        }
      });
      showAtelierNotification("Anatomical configuration updated securely inside your ledger.");
    } catch (err) {
      console.error("Failed to post blueprint shift edits to Firestore:", err);
      showAtelierNotification("Database sync failed. Please check network protocols.", "error");
    }
  });
}

/**
 * Renders the administrative Tailor Shop Terminal with:
 * - Phase 3: Inventory Matrix (collections) with multi-size pricing form + live stream
 * - Existing: Master orders queue with status/billing dropdowns
 */
function mountTailorShopTerminal() {
  const mainContent = document.getElementById("main-content");
  if (!mainContent) return;

  const sections = [
    { id: "overview", label: "Overview", icon: overviewIconSvg() },
    { id: "bespoke", label: "Bespoke Orders", icon: rulerIconSvg() },
    { id: "rtw", label: "Ready to Wear", icon: hangerIconSvg(), badgeId: "sidebar-badge-rtw" },
    { id: "inventory", label: "Inventory", icon: layersIconSvg() },
  ];

  mainContent.innerHTML = buildDashboardSidebarShell(sections);
  wireDashboardSidebar("overview", (sectionId) => mountAdminSection(sectionId));
  mountAdminSection("overview");

  // Real-time client messages — floating glass launcher, multi-conversation
  // inbox, persists across every section switch.
  initAdminChat();
}

/** Routes a sidebar click to the right admin section-mount function, closing any listener the previous section had open first. */
function mountAdminSection(sectionId) {
  const pane = document.getElementById("dash-content-pane");
  if (!pane) return;

  teardownAllSectionListeners();

  if (sectionId === "bespoke") {
    mountAdminBespokeSection(pane);
  } else if (sectionId === "rtw") {
    mountAdminRtwSection(pane);
  } else if (sectionId === "inventory") {
    mountAdminInventorySection(pane);
  } else {
    mountAdminOverviewSection(pane);
  }
}

/** Overview — the financial summary matrix, reusing mountFinancialSummaryMatrix() completely unchanged since the metric node IDs it targets are identical here. */
function mountAdminOverviewSection(pane) {
  pane.innerHTML = `
    <div class="dash-section-header">
      <div>
        <p class="dash-section-eyebrow">Tailor Shop Operations</p>
        <h1 class="dash-section-title">Overview</h1>
        <p class="dash-section-sub">Live structural command center for matching active blueprints to production lines.</p>
      </div>
    </div>

    <div class="financial-matrix-hub" style="
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1px;
      margin-bottom: 2.25rem;
      border: 1px solid rgba(197,168,128,0.18);
      border-radius: 3px;
      overflow: hidden;
      background: rgba(197,168,128,0.18);
    ">
      <div class="fin-metric-block" style="background: var(--color-primary); padding: 1.4rem 1.6rem; position: relative; overflow: hidden;">
        <div style="position: absolute; top: 0; right: 0; width: 3px; height: 100%; background: var(--color-accent); opacity: 0.65;"></div>
        <p style="margin: 0 0 0.55rem 0; font-family: var(--font-body); font-size: 0.65rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--color-accent); opacity: 0.9;">Gross Studio Revenue</p>
        <p id="fin-metric-revenue" style="margin: 0 0 0.3rem 0; font-family: var(--font-heading); font-size: 2.1rem; font-weight: 500; color: #ffffff; letter-spacing: -0.01em; line-height: 1; transition: color 0.4s ease;">—</p>
        <p style="margin: 0; font-family: var(--font-body); font-size: 0.68rem; color: rgba(255,255,255,0.35); letter-spacing: 0.05em;">Cumulative across all order documents</p>
      </div>
      <div class="fin-metric-block" style="background: var(--color-primary); padding: 1.4rem 1.6rem; position: relative; overflow: hidden;">
        <div style="position: absolute; top: 0; right: 0; width: 3px; height: 100%; background: var(--color-accent); opacity: 0.65;"></div>
        <p style="margin: 0 0 0.55rem 0; font-family: var(--font-body); font-size: 0.65rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--color-accent); opacity: 0.9;">Active Bespoke Commissions</p>
        <p id="fin-metric-bespoke" style="margin: 0 0 0.3rem 0; font-family: var(--font-heading); font-size: 2.1rem; font-weight: 500; color: #ffffff; letter-spacing: -0.01em; line-height: 1; transition: color 0.4s ease;">—</p>
        <p style="margin: 0; font-family: var(--font-body); font-size: 0.68rem; color: rgba(255,255,255,0.35); letter-spacing: 0.05em;">Orders where type &#8800; Ready-To-Wear</p>
      </div>
      <div class="fin-metric-block" style="background: var(--color-primary); padding: 1.4rem 1.6rem; position: relative; overflow: hidden;">
        <div style="position: absolute; top: 0; right: 0; width: 3px; height: 100%; background: var(--color-accent); opacity: 0.65;"></div>
        <p style="margin: 0 0 0.55rem 0; font-family: var(--font-body); font-size: 0.65rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--color-accent); opacity: 0.9;">Boutique Units Dispatched</p>
        <p id="fin-metric-rtw" style="margin: 0 0 0.3rem 0; font-family: var(--font-heading); font-size: 2.1rem; font-weight: 500; color: #ffffff; letter-spacing: -0.01em; line-height: 1; transition: color 0.4s ease;">—</p>
        <p style="margin: 0; font-family: var(--font-body); font-size: 0.68rem; color: rgba(255,255,255,0.35); letter-spacing: 0.05em;">Orders where type = Ready-To-Wear</p>
      </div>
    </div>
  `;

  mountFinancialSummaryMatrix();
}

/** Bespoke Orders — the master commission ledger. mountOrdersStream("bespoke") is unchanged internally; it targets #admin-orders-stream, which this section provides. */
function mountAdminBespokeSection(pane) {
  pane.innerHTML = `
    <div class="dash-section-header">
      <div>
        <p class="dash-section-eyebrow">Tailor Shop Operations</p>
        <h1 class="dash-section-title">Bespoke Orders</h1>
        <p class="dash-section-sub">All client bespoke submissions streaming live from the production database, grouped by the date they came in.</p>
      </div>
    </div>

    ${buildOrderDateSearchBarHtml("bespoke")}

    <div id="admin-orders-stream" class="admin-stream-container">
      <p class="loading-text">Subscribing to master order ledgers...</p>
    </div>
  `;

  wireOrderDateSearchBar("bespoke");
  mountOrdersStream("bespoke");
}

/** Ready to Wear — previously a modal-only view; now a first-class section. mountReadyToWearOrdersStream() already accepts an arbitrary container element, so it needs no changes at all. */
function mountAdminRtwSection(pane) {
  pane.innerHTML = `
    <div class="dash-section-header">
      <div>
        <p class="dash-section-eyebrow">Tailor Shop Operations</p>
        <h1 class="dash-section-title">Ready to Wear</h1>
        <p class="dash-section-sub">Incoming retail orders placed against stocked Lookbook inventory, grouped by the date they came in — shipping details and dispatch messaging.</p>
      </div>
    </div>

    ${buildOrderDateSearchBarHtml("rtw")}

    <div id="admin-rtw-stream" class="admin-stream-container">
      <p class="loading-text">Subscribing to boutique order ledgers...</p>
    </div>
  `;

  wireOrderDateSearchBar("rtw");
  mountReadyToWearOrdersStream(document.getElementById("admin-rtw-stream"));
}

/** Inventory — the Collection Inventory Matrix, unchanged from before, just relocated into its own section instead of always sitting on the page. */
function mountAdminInventorySection(pane) {
  pane.innerHTML = `
    <div class="dash-section-header">
      <div>
        <p class="dash-section-eyebrow">Tailor Shop Operations</p>
        <h1 class="dash-section-title">Inventory</h1>
        <p class="dash-section-sub">Provision garment collections with size-specific pricing. All changes stream live to the public Lookbook.</p>
      </div>
      <button id="btn-toggle-add-collection" class="btn-inventory-add">
        <span>+ Add New Collection</span>
      </button>
    </div>

    <!-- New Collection Creation Form (hidden by default) -->
    <div id="add-collection-drawer" class="inventory-add-drawer" style="display: none;">
      <h3 class="drawer-form-title">New Collection Configuration</h3>
      <form id="add-collection-form" class="inventory-creation-form">

        <div class="inv-form-row inv-form-row--2col">
          <div class="inv-form-field">
            <label for="inv-collection-name">Collection Name</label>
            <input type="text" id="inv-collection-name" placeholder="e.g. Ivory Brocade Kaftan" required>
          </div>
          <div class="inv-form-field">
            <label for="inv-silhouette-slug">Silhouette Slug</label>
            <select id="inv-silhouette-slug" required>
              <option value="" disabled selected>Select Garment Silhouette</option>
              <option value="signature-kaftan">Signature Custom Kaftan</option>
              <option value="bespoke-two-piece">Premium Two-Piece Suit</option>
              <option value="luxury-agbada">Royal Agbada Masterpiece</option>
              <option value="printed-apparel">Printed Contemporary Shirt</option>
            </select>
          </div>
        </div>

        <div class="inv-form-field inv-form-field--full">
          <label for="inv-category">Lookbook Category</label>
          <input
            type="text"
            id="inv-category"
            list="inv-category-options"
            maxlength="32"
            autocomplete="off"
            placeholder="e.g. Kaftans"
            aria-describedby="inv-category-hint"
            required
          >
          <datalist id="inv-category-options"></datalist>
          <span class="inv-field-hint" id="inv-category-hint">Becomes a filter button on the public Lookbook. Choose an existing category or type a new one.</span>
        </div>

        <div class="inv-form-field inv-form-field--full">
          <label>Garment Image</label>

          <div class="inv-image-source-toggle" role="tablist">
            <button type="button" class="inv-image-source-btn is-active" data-source="upload" role="tab" aria-selected="true">Upload from Computer</button>
            <button type="button" class="inv-image-source-btn" data-source="url" role="tab" aria-selected="false">Paste Image URL</button>
          </div>

          <div class="inv-image-source-panel" data-panel="upload">
            <label for="inv-image-file" class="inv-file-drop-zone" id="inv-file-drop-zone">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="17 8 12 3 7 8"></polyline>
                <line x1="12" y1="3" x2="12" y2="15"></line>
              </svg>
              <span class="inv-file-drop-text" id="inv-file-drop-text">Click to choose an image, or drag one here</span>
              <span class="inv-file-drop-hint">JPG, PNG, or WEBP — up to 8MB</span>
              <input type="file" id="inv-image-file" accept="image/png,image/jpeg,image/webp" hidden>
            </label>
          </div>

          <div class="inv-image-source-panel" data-panel="url" style="display: none;">
            <input type="url" id="inv-image-url" placeholder="https://...image.jpg">
          </div>

          <div class="inv-image-preview-wrap" id="inv-image-preview-wrap" style="display: none;">
            <img src="" alt="Garment preview" class="inv-image-preview" id="inv-image-preview">
            <button type="button" class="inv-image-preview-clear" id="inv-image-preview-clear" aria-label="Remove selected image">&times;</button>
          </div>
          <p id="inv-upload-status" role="status" aria-live="polite" style="display: none; margin-top: 0.6rem; font-size: var(--font-size-small);"></p>
        </div>

        <div class="inv-form-field inv-form-field--full">
          <label for="inv-subtitle">Garment Subtitle / Material Description</label>
          <input type="text" id="inv-subtitle" placeholder="e.g. Polished Premium Polish Fabric">
        </div>

        <div class="inv-size-pricing-block">
          <p class="inv-size-pricing-label">Size-Specific Pricing Matrix (GH₵)</p>
          <div class="inv-size-price-grid">
            <div class="inv-size-price-cell">
              <label for="inv-price-S">S</label>
              <input type="number" id="inv-price-S" min="0" step="50" placeholder="0">
            </div>
            <div class="inv-size-price-cell">
              <label for="inv-price-M">M</label>
              <input type="number" id="inv-price-M" min="0" step="50" placeholder="0" required>
            </div>
            <div class="inv-size-price-cell">
              <label for="inv-price-L">L</label>
              <input type="number" id="inv-price-L" min="0" step="50" placeholder="0" required>
            </div>
            <div class="inv-size-price-cell">
              <label for="inv-price-XL">XL</label>
              <input type="number" id="inv-price-XL" min="0" step="50" placeholder="0">
            </div>
            <div class="inv-size-price-cell">
              <label for="inv-price-XXL">XXL</label>
              <input type="number" id="inv-price-XXL" min="0" step="50" placeholder="0">
            </div>
          </div>
        </div>

        <div class="inv-form-actions">
          <button type="submit" class="btn-inv-submit">Lock Collection to Registry</button>
          <button type="button" id="btn-cancel-add-collection" class="btn-inv-cancel">Cancel</button>
        </div>
      </form>
    </div>

    <!-- Live Inventory Stream -->
    <div id="admin-inventory-stream" class="inventory-stream-grid">
      <p class="loading-text" style="padding: 3rem; text-align: center; color: #9a9a9a;">Subscribing to collection registries...</p>
    </div>
  `;

  refreshCategoryDatalist();

  // ── INVENTORY FORM TOGGLE ──
  const toggleBtn = document.getElementById("btn-toggle-add-collection");
  const addDrawer = document.getElementById("add-collection-drawer");
  const cancelBtn = document.getElementById("btn-cancel-add-collection");

  toggleBtn.addEventListener("click", () => {
    const isOpen = addDrawer.style.display !== "none";
    addDrawer.style.display = isOpen ? "none" : "block";
    toggleBtn.querySelector("span").textContent = isOpen ? "+ Add New Collection" : "− Collapse Form";
  });

  cancelBtn.addEventListener("click", () => {
    addDrawer.style.display = "none";
    toggleBtn.querySelector("span").textContent = "+ Add New Collection";
    document.getElementById("add-collection-form").reset();
    resetImagePicker();
  });

  // ── GARMENT IMAGE PICKER — upload from computer, or paste a URL ──
  let selectedImageFile = null;
  let imageSourceMode = "upload";

  // Upload/save workflow state (see the submit handler).
  let isSubmitting = false;     // blocks duplicate submissions and mid-flight edits
  let uploadedImage = null;     // { url, publicId, file } — on Cloudinary, not yet saved to Firestore
  let pendingProductRef = null; // stable document id so a retried save can never create a duplicate
  let saveUncertain = false;    // a save timed out and may still have landed — never delete its image

  const sourceToggleBtns = document.querySelectorAll(".inv-image-source-btn");
  const sourcePanels     = document.querySelectorAll(".inv-image-source-panel");
  const fileInput        = document.getElementById("inv-image-file");
  const dropZone         = document.getElementById("inv-file-drop-zone");
  const dropZoneText     = document.getElementById("inv-file-drop-text");
  const urlInput         = document.getElementById("inv-image-url");
  const previewWrap      = document.getElementById("inv-image-preview-wrap");
  const previewImg       = document.getElementById("inv-image-preview");
  const previewClearBtn  = document.getElementById("inv-image-preview-clear");
  const uploadStatusEl   = document.getElementById("inv-upload-status");

  function setUploadStatus(message, tone = "info") {
    if (!message) {
      uploadStatusEl.style.display = "none";
      uploadStatusEl.textContent = "";
      return;
    }
    uploadStatusEl.textContent = message;
    uploadStatusEl.style.color = tone === "error" ? "#c0392b" : tone === "success" ? "#16a34a" : "inherit";
    uploadStatusEl.style.display = "block";
  }

  // Remove an image that was uploaded but never attached to a saved product.
  // Best-effort and silent: a failed cleanup only leaves an unused file.
  function discardUploadedImage() {
    const orphan = uploadedImage;
    uploadedImage = null;
    if (!orphan) return;
    if (saveUncertain) {
      console.warn("Keeping uploaded image: a product save may have succeeded.", orphan.publicId);
      return;
    }
    pendingProductRef = null;
    setUploadStatus("");
    productImageClient.deleteImage(orphan.publicId);
  }

  function resetImagePicker() {
    discardUploadedImage();
    selectedImageFile = null;
    imageSourceMode = "upload";
    fileInput.value = "";
    urlInput.value = "";
    dropZoneText.textContent = "Click to choose an image, or drag one here";
    previewWrap.style.display = "none";
    previewImg.src = "";
    sourceToggleBtns.forEach((b) => {
      b.classList.toggle("is-active", b.dataset.source === "upload");
      b.setAttribute("aria-selected", b.dataset.source === "upload" ? "true" : "false");
    });
    sourcePanels.forEach((p) => { p.style.display = p.dataset.panel === "upload" ? "" : "none"; });
  }

  function updateImagePreview() {
    if (imageSourceMode === "upload" && selectedImageFile) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        previewImg.src = ev.target.result;
        previewWrap.style.display = "flex";
      };
      reader.readAsDataURL(selectedImageFile);
    } else if (imageSourceMode === "url" && urlInput.value.trim()) {
      previewImg.src = urlInput.value.trim();
      previewWrap.style.display = "flex";
    } else {
      previewWrap.style.display = "none";
      previewImg.src = "";
    }
  }

  function applySelectedFile(file) {
    if (!file || isSubmitting) return;
    const problem = validateProductImageFile(file);
    if (problem) {
      showAtelierNotification(problem, "error");
      fileInput.value = "";
      return;
    }
    // A different file invalidates any image already uploaded for this form.
    if (uploadedImage && uploadedImage.file !== file) discardUploadedImage();
    selectedImageFile = file;
    dropZoneText.textContent = file.name;
    updateImagePreview();
  }

  sourceToggleBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (isSubmitting) return;
      if (btn.dataset.source !== "upload") discardUploadedImage();
      imageSourceMode = btn.dataset.source;
      sourceToggleBtns.forEach((b) => {
        b.classList.toggle("is-active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });
      sourcePanels.forEach((p) => { p.style.display = p.dataset.panel === imageSourceMode ? "" : "none"; });

      if (imageSourceMode === "upload") {
        urlInput.value = "";
      } else {
        selectedImageFile = null;
        fileInput.value = "";
        dropZoneText.textContent = "Click to choose an image, or drag one here";
      }
      updateImagePreview();
    });
  });

  fileInput.addEventListener("change", (e) => applySelectedFile(e.target.files[0]));

  ["dragenter", "dragover"].forEach((evtName) => {
    dropZone.addEventListener(evtName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.add("is-drag-active");
    });
  });
  ["dragleave", "drop"].forEach((evtName) => {
    dropZone.addEventListener(evtName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove("is-drag-active");
    });
  });
  dropZone.addEventListener("drop", (e) => {
    if (isSubmitting) return;
    const file = e.dataTransfer?.files?.[0];
    if (file) applySelectedFile(file);
  });

  urlInput.addEventListener("input", () => updateImagePreview());

  previewClearBtn.addEventListener("click", () => {
    if (isSubmitting) return;
    discardUploadedImage();
    selectedImageFile = null;
    fileInput.value = "";
    urlInput.value = "";
    dropZoneText.textContent = "Click to choose an image, or drag one here";
    updateImagePreview();
  });

  // ── INVENTORY CREATION SUBMIT ──
  const addCollectionForm = document.getElementById("add-collection-form");
  addCollectionForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const collectionName = document.getElementById("inv-collection-name").value.trim();
    const silhouetteSlug = document.getElementById("inv-silhouette-slug").value;
    const rawCategory = cleanCategoryLabel(document.getElementById("inv-category").value);
    const categoryKey = categorySlug(rawCategory);
    // Reuse the existing label for a known category so casing stays consistent.
    const categoryLabel = knownCategoryLabels.get(categoryKey) || rawCategory;
    const pastedImageUrl = urlInput.value.trim();
    const subtitle = document.getElementById("inv-subtitle").value.trim();

    const priceS   = parseFloat(document.getElementById("inv-price-S").value)   || 0;
    const priceM   = parseFloat(document.getElementById("inv-price-M").value)   || 0;
    const priceL   = parseFloat(document.getElementById("inv-price-L").value)   || 0;
    const priceXL  = parseFloat(document.getElementById("inv-price-XL").value)  || 0;
    const priceXXL = parseFloat(document.getElementById("inv-price-XXL").value) || 0;

    if (!collectionName || !silhouetteSlug) {
      showAtelierNotification("Please complete all required collection fields.", "error");
      return;
    }
    if (!categoryKey) {
      showAtelierNotification("Please enter a Lookbook category (letters or numbers).", "error");
      return;
    }
    if (imageSourceMode === "upload" && !selectedImageFile) {
      showAtelierNotification("Please choose an image to upload, or switch to Paste Image URL.", "error");
      return;
    }
    if (imageSourceMode === "url" && !pastedImageUrl) {
      showAtelierNotification("Please paste an image URL, or switch to Upload from Computer.", "error");
      return;
    }
    if (priceM <= 0 || priceL <= 0) {
      showAtelierNotification("Prices for M and L sizes are required.", "error");
      return;
    }

    // ── Duplicate-submission guard: ignore anything while a request is in flight ──
    if (isSubmitting) return;
    isSubmitting = true;

    const submitBtn = addCollectionForm.querySelector("button[type='submit']");
    const idleLabel = () => (uploadedImage ? "Retry Saving Collection" : "Lock Collection to Registry");
    const setBusy = (label) => {
      submitBtn.disabled = true;
      cancelBtn.disabled = true;
      fileInput.disabled = true;
      submitBtn.textContent = label;
    };

    let stage = "upload"; // "upload" | "save" — decides which error message applies

    try {
      let imageUrl;
      let imagePublicId = null;

      if (imageSourceMode === "upload") {
        if (!uploadedImage || uploadedImage.file !== selectedImageFile) {
          setBusy("Uploading image...");
          setUploadStatus("Uploading image — please keep this page open...");
          const uploaded = await productImageClient.upload(selectedImageFile);
          uploadedImage = { url: uploaded.imageUrl, publicId: uploaded.publicId, file: selectedImageFile };
          setUploadStatus("Image uploaded.", "success");
        }
        imageUrl = uploadedImage.url;
        imagePublicId = uploadedImage.publicId;
      } else {
        imageUrl = pastedImageUrl;
      }

      stage = "save";
      setBusy("Registering Collection...");

      // One stable document id per form attempt: if a save is retried, setDoc
      // rewrites the SAME document instead of creating a second product.
      if (!pendingProductRef) pendingProductRef = doc(collection(db, "collections"));

      const collectionPayload = {
        collectionName,
        silhouetteSlug,
        category: categoryLabel,
        categorySlug: categoryKey,
        imageUrl,
        ...(imagePublicId ? { imagePublicId } : {}),
        subtitle: subtitle || "",
        prices: {
          S:   priceS,
          M:   priceM,
          L:   priceL,
          XL:  priceXL,
          XXL: priceXXL,
        },
        stockStatus: "In Stock",
        lastUpdated: serverTimestamp(),
      };

      await withTimeout(
        setDoc(pendingProductRef, collectionPayload),
        30000,
        "Saving is taking longer than expected."
      );

      // Saved: the image now belongs to a product, so it must never be cleaned up.
      uploadedImage = null;
      pendingProductRef = null;
      saveUncertain = false;

      showAtelierNotification(`Collection "${collectionName}" locked into the live registry.`);
      addCollectionForm.reset();
      resetImagePicker();
      setUploadStatus("");
      addDrawer.style.display = "none";
      toggleBtn.querySelector("span").textContent = "+ Add New Collection";
    } catch (err) {
      console.error(`Collection ${stage} failure:`, err);

      if (stage === "upload") {
        const message = err instanceof ProductImageError
          ? err.message
          : "The image could not be uploaded. Please try again.";
        setUploadStatus(message, "error");
        showAtelierNotification(message, "error");
      } else if (err instanceof ProductImageError && err.code === "timeout") {
        // The write may still reach the server — keep the image and the same
        // document id so a retry is safe and cannot duplicate the product.
        saveUncertain = true;
        const message = "Saving is taking longer than expected. Check the inventory list below, then press the button again if the collection isn't there.";
        setUploadStatus(message, "error");
        showAtelierNotification(message, "error");
      } else {
        const permission = err?.code === "permission-denied";
        const message = permission
          ? "Registry write rejected. Check permissions — the image is uploaded and will be kept for a retry."
          : "The image uploaded but the collection could not be saved. Press the button again to retry; the image won't be uploaded twice.";
        setUploadStatus(message, "error");
        showAtelierNotification(message, "error");
      }
    } finally {
      isSubmitting = false;
      fileInput.disabled = false;
      cancelBtn.disabled = false;
      submitBtn.disabled = false;
      submitBtn.textContent = idleLabel();
    }
  });

  mountInventoryStream();
}


// ─────────────────────────────────────────────────────────────────────────────
// PHASE 5 — ANALYTICS LEDGER HUB: Financial Summary Matrix
//
// Attaches a single real-time onSnapshot listener to the entire "orders"
// collection (no server-side filter needed — we aggregate all documents).
// On every change event the callback:
//   1. Iterates every order document and accumulates:
//        grossRevenue  → sum of each doc's `finalPrice` field (numeric; skips
//                         missing or non-numeric values gracefully)
//        bespokeCount  → count of docs where orderType != "Ready-To-Wear"
//        rtwCount      → count of docs where orderType == "Ready-To-Wear"
//   2. Writes the formatted values directly into the three metric DOM nodes
//      that mountTailorShopTerminal() injected above the order stream.
//
// The subscription handle is stored on window.activeMetricsUnsubscribe so it
// is properly torn down by mountAtelierDashboard() on every re-mount, which
// prevents memory leaks when the admin signs out and back in within the same
// page session.
// ─────────────────────────────────────────────────────────────────────────────
function mountFinancialSummaryMatrix() {
  // Tear down any prior subscription cleanly
  if (window.activeMetricsUnsubscribe) {
    window.activeMetricsUnsubscribe();
    window.activeMetricsUnsubscribe = null;
  }

  const revenueEl = document.getElementById("fin-metric-revenue");
  const bespokeEl = document.getElementById("fin-metric-bespoke");
  const rtwEl     = document.getElementById("fin-metric-rtw");

  // Guard: if the DOM nodes are absent the admin panel isn't mounted yet
  if (!revenueEl || !bespokeEl || !rtwEl) return;

  // Set skeleton loading state
  [revenueEl, bespokeEl, rtwEl].forEach(el => {
    el.textContent = "…";
    el.style.opacity = "0.45";
  });

  const ordersCollectionRef = collection(db, "orders");

  window.activeMetricsUnsubscribe = onSnapshot(ordersCollectionRef, (snapshot) => {
    let grossRevenue  = 0;
    let bespokeCount  = 0;
    let rtwCount      = 0;

    snapshot.forEach((orderDoc) => {
      const data = orderDoc.data();

      // ── Revenue accumulation ──────────────────────────────────────────────
      // Accept `finalPrice` as the canonical revenue field. Fall back to
      // `price` for legacy documents. Skip docs where neither field is a
      // valid positive number to prevent NaN contaminating the sum.
      const priceValue = typeof data.finalPrice === "number"
        ? data.finalPrice
        : (typeof data.price === "number" ? data.price : 0);

      if (Number.isFinite(priceValue) && priceValue > 0) {
        grossRevenue += priceValue;
      }

      // ── Type classification ───────────────────────────────────────────────
      if (data.orderType === "Ready-To-Wear") {
        rtwCount += 1;
      } else {
        bespokeCount += 1;
      }
    });

    // ── Format currency with Ghanaian Cedis symbol and thousands separator ──
    const formattedRevenue = grossRevenue === 0
      ? "GH₵ 0"
      : "GH₵ " + grossRevenue.toLocaleString("en-GH", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0
        });

    // ── Push values into DOM with a brief accent-gold flash on update ──────
    function flashUpdate(el, newValue) {
      el.style.opacity    = "1";
      el.style.color      = "var(--color-accent)";
      el.textContent      = newValue;
      setTimeout(() => {
        el.style.color = "#ffffff";
      }, 520);
    }

    flashUpdate(revenueEl, formattedRevenue);
    flashUpdate(bespokeEl, bespokeCount.toLocaleString());
    flashUpdate(rtwEl,     rtwCount.toLocaleString());

    // Keep the "Ready to Wear" sidebar nav item's badge in sync with the
    // same count — no separate listener needed, this snapshot already has
    // it. Only present when the admin dashboard's sidebar is mounted.
    const badgeEl = document.getElementById("sidebar-badge-rtw");
    if (badgeEl) {
      if (rtwCount > 0) {
        badgeEl.textContent = rtwCount > 99 ? "99+" : String(rtwCount);
        badgeEl.style.display = "inline-flex";
      } else {
        badgeEl.style.display = "none";
      }
    }

  }, (error) => {
    console.error("Financial Summary Matrix stream failure:", error);
    [revenueEl, bespokeEl, rtwEl].forEach(el => {
      el.textContent  = "ERR";
      el.style.color  = "#e74c3c";
      el.style.opacity = "1";
    });
  });
}

/**
 * Real-time onSnapshot listener for the "collections" Firestore root.
 * Renders each garment with its full size-price mini-grid and inline update inputs.
 *
 * 
 * Each card now renders a .btn-delete-inventory button. Inside the onSnapshot
 * loop, after innerHTML is set, every .btn-delete-inventory is bound to
 * deleteDoc(doc(db, "collections", itemId)).
 * On resolve, showAtelierNotification fires the sleek success message.
 */
function mountInventoryStream() {
  const inventoryStream = document.getElementById("admin-inventory-stream");
  if (!inventoryStream) return;

  const collectionsQuery = query(
    collection(db, "collections"),
    orderBy("lastUpdated", "desc")
  );

  window.activeInventoryUnsubscribe = onSnapshot(collectionsQuery, (snapshot) => {
    // Learn every category currently in use so the admin field can suggest them.
    snapshot.forEach((colDoc) => {
      const cat = resolveCategory(colDoc.data());
      if (!cat.isFallback) knownCategoryLabels.set(cat.slug, cat.label);
    });
    refreshCategoryDatalist();

    if (snapshot.empty) {
      inventoryStream.innerHTML = `
        <div style="grid-column: 1/-1; text-align: center; padding: 3rem; border: 1px dashed rgba(255,255,255,0.1);">
          <p style="color: #7f8c8d; font-size: 0.9rem;">No collections provisioned yet. Use the form above to register your first garment.</p>
        </div>`;
      return;
    }

    let inventoryHtml = "";
    snapshot.forEach((colDoc) => {
      const d = colDoc.data();
      const docId = colDoc.id;
      const prices = d.prices || {};
      const sizes = ["S", "M", "L", "XL", "XXL"];
      const cat = resolveCategory(d);

      const sizePriceInputs = sizes.map(sz => `
        <div class="inv-card-size-cell">
          <span class="inv-card-size-label">${sz}</span>
          <input
            type="number"
            class="inv-price-live-input"
            data-doc-id="${docId}"
            data-size="${sz}"
            value="${prices[sz] || 0}"
            min="0"
            step="50"
            aria-label="Price for size ${sz}"
          >
        </div>
      `).join("");

      inventoryHtml += `
        <div class="inv-collection-card" data-doc-id="${docId}">
          <div class="inv-card-image-wrap">
            <img src="${d.imageUrl || ''}" alt="${d.collectionName || 'Garment'}" class="inv-card-image" loading="lazy">
            <span class="inv-card-stock-badge ${d.stockStatus === 'In Stock' ? 'badge-in-stock' : 'badge-out-stock'}">${d.stockStatus || 'In Stock'}</span>
          </div>
          <div class="inv-card-body">
            <h4 class="inv-card-name">${d.collectionName || 'Unnamed Collection'}</h4>
            <p class="inv-card-subtitle">${d.subtitle || formatGarmentName(d.silhouetteSlug)}</p>
            <div class="inv-card-category">
              <label class="inv-card-category-label" for="inv-cat-${docId}">Category</label>
              <input
                type="text"
                id="inv-cat-${docId}"
                class="inv-category-live-input"
                list="inv-category-options"
                maxlength="32"
                autocomplete="off"
                value="${escapeHtml(cat.label)}"
                data-doc-id="${docId}"
                data-original="${escapeHtml(cat.label)}"
              >
            </div>
            <div class="inv-card-price-grid">
              ${sizePriceInputs}
            </div>
            <div class="inv-card-actions">
              <button class="btn-inv-toggle-stock" data-doc-id="${docId}" data-current-status="${d.stockStatus || 'In Stock'}">
                ${d.stockStatus === 'In Stock' ? 'Mark Out of Stock' : 'Mark In Stock'}
              </button>
              <!-- TASK 1A: Delete button — bound to deleteDoc(doc(db,"collections",itemId)) below -->
              <button
                class="btn-delete-inventory"
                data-doc-id="${docId}"
                data-name="${d.collectionName || 'this collection'}"
                data-image-public-id="${escapeHtml(d.imagePublicId || '')}"
                data-image-url="${escapeHtml(d.imageUrl || '')}"
              >Remove from Registry</button>
            </div>
          </div>
        </div>
      `;
    });

    inventoryStream.innerHTML = inventoryHtml;

    // ── Bind live price update inputs ──
    inventoryStream.querySelectorAll(".inv-price-live-input").forEach(input => {
      // Debounce: fire Firestore write 600ms after user stops typing
      let debounceTimer = null;
      input.addEventListener("input", (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
          const targetDocId = e.target.dataset.docId;
          const sizeKey = e.target.dataset.size;
          const newPrice = parseFloat(e.target.value) || 0;

          try {
            const colRef = doc(db, "collections", targetDocId);
            await updateDoc(colRef, {
              [`prices.${sizeKey}`]: newPrice,
              lastUpdated: serverTimestamp(),
            });
            // Subtle flash feedback on the input
            e.target.style.borderColor = "#16a34a";
            setTimeout(() => { e.target.style.borderColor = ""; }, 1200);
          } catch (err) {
            console.error(`Failed to update price for size ${sizeKey}:`, err);
            showAtelierNotification(`Price update for ${sizeKey} rejected by server.`, "error");
          }
        }, 600);
      });
    });

    // ── Bind live category inputs (commit on change: blur / Enter / datalist pick) ──
    inventoryStream.querySelectorAll(".inv-category-live-input").forEach(input => {
      input.addEventListener("change", async (e) => {
        const el = e.target;
        const original = el.dataset.original;
        const typed = cleanCategoryLabel(el.value);
        const key = categorySlug(typed);

        if (!key) {
          el.value = original;
          showAtelierNotification("Category can't be empty.", "error");
          return;
        }
        const nextLabel = knownCategoryLabels.get(key) || typed;
        if (nextLabel === original) {
          el.value = original;
          return;
        }

        try {
          await updateDoc(doc(db, "collections", el.dataset.docId), {
            category: nextLabel,
            categorySlug: key,
            lastUpdated: serverTimestamp(),
          });
          showAtelierNotification(`Category set to ${nextLabel}.`);
        } catch (err) {
          console.error("Failed to update category:", err);
          el.value = original;
          showAtelierNotification("Category update rejected.", "error");
        }
      });
    });

    // ── Bind stock toggle buttons ──
    inventoryStream.querySelectorAll(".btn-inv-toggle-stock").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const targetDocId = e.target.dataset.docId;
        const currentStatus = e.target.dataset.currentStatus;
        const newStatus = currentStatus === "In Stock" ? "Out of Stock" : "In Stock";

        try {
          const colRef = doc(db, "collections", targetDocId);
          await updateDoc(colRef, {
            stockStatus: newStatus,
            lastUpdated: serverTimestamp(),
          });
          showAtelierNotification(`Stock status updated to: ${newStatus}`);
        } catch (err) {
          console.error("Failed to update stock status:", err);
          showAtelierNotification("Stock status update rejected.", "error");
        }
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TASK 1A — DELETE BUTTON BINDING (inside onSnapshot loop)
    // Each .btn-delete-inventory is bound here after every innerHTML repaint.
    // Calls deleteDoc(doc(db, "collections", itemId)).
    // On success: sleek showAtelierNotification confirms the deletion.
    // onSnapshot automatically removes the card from the DOM on resolve.
    // ─────────────────────────────────────────────────────────────────────────
    inventoryStream.querySelectorAll(".btn-delete-inventory").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const itemId   = e.currentTarget.dataset.docId;
        const itemName = e.currentTarget.dataset.name;

        const confirmed = window.confirm(
          `Permanently remove "${itemName}" from the collection registry?\n\nThis action cannot be reversed.`
        );
        if (!confirmed) return;

        // e.currentTarget is null after the first await, so capture it now.
        const deleteBtn = e.currentTarget;
        if (deleteBtn.disabled) return; // a removal for this card is already running
        const imagePublicId = deleteBtn.dataset.imagePublicId || "";
        const imageUrl = deleteBtn.dataset.imageUrl || "";
        deleteBtn.disabled = true;
        deleteBtn.textContent = "Removing...";

        try {
          // Order matters: the Cloudinary image is deleted (and confirmed) FIRST.
          // If that fails the Firestore record is left intact, so nothing is lost
          // and pressing "Remove from Registry" again is a safe retry.
          await removeProductAndImage({
            client: productImageClient,
            imagePublicId,
            imageUrl,
            deleteRecord: () => deleteDoc(doc(db, "collections", itemId)),
          });
          // Sleek success notification on complete deletion
          showAtelierNotification(`"${itemName}" has been cleanly removed from the registry.`);
          // The live onSnapshot listener automatically removes the card from the DOM.
        } catch (err) {
          // Diagnostics only: ids and codes, never tokens or credentials.
          console.error("Collection removal failure:", {
            itemId,
            stage: err?.stage || "unknown",
            code: err?.code,
            status: err?.status,
            publicId: err?.publicId || imagePublicId || null,
            cause: err?.cause?.message || err?.message,
          });
          if (err?.stage === "image") {
            showAtelierNotification(
              `${err.message} "${escapeHtml(itemName)}" was NOT removed — press Remove again to retry.`,
              "error"
            );
          } else if (err?.stage === "record") {
            showAtelierNotification(
              "The product image was removed but the registry entry could not be deleted. Check permissions, then press Remove again to finish.",
              "error"
            );
          } else {
            showAtelierNotification("Deletion rejected by the server. Check permissions.", "error");
          }
          deleteBtn.disabled = false;
          deleteBtn.textContent = "Remove from Registry";
        }
      });
    });

  }, (error) => {
    console.error("Inventory stream synchronization lost:", error);
    document.getElementById("admin-inventory-stream").innerHTML =
      `<p style="color:#e74c3c; padding:2rem;">Failed to load inventory registry: ${error.message}</p>`;
  });
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * ORDER DATE GROUPING + SEARCH
 *
 * Both admin ledgers (Bespoke and Ready-To-Wear) now bucket their incoming
 * orders by calendar day — using `orderCreatedTimestamp` — and render a
 * date-search bar above the stream so the admin can jump straight to every
 * order that arrived on a given day. Orders within a day are shown in the
 * order they actually came in (earliest first), while days themselves are
 * listed most-recent-first so the freshest activity stays at the top.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Renders the "Search by date" bar markup shared by both ledgers. `scope` is "bespoke" or "rtw" and namespaces the element ids. */
function buildOrderDateSearchBarHtml(scope) {
  return `
    <div class="order-date-search-bar">
      <div class="order-date-search-field">
        <label for="${scope}-order-date-search">Search by date received</label>
        <input type="date" id="${scope}-order-date-search" class="order-date-search-input" autocomplete="off">
      </div>
      <button type="button" id="${scope}-order-date-clear" class="btn-date-clear">Clear</button>
      <p class="order-date-search-status" id="${scope}-order-date-status" aria-live="polite"></p>
    </div>
  `;
}

/** Wires the search input + clear button for a ledger scope to the shared filter/apply logic. */
function wireOrderDateSearchBar(scope) {
  const input = document.getElementById(`${scope}-order-date-search`);
  const clearBtn = document.getElementById(`${scope}-order-date-clear`);
  const filterKey = scope === "rtw" ? "rtwOrderDateFilter" : "bespokeOrderDateFilter";
  const streamId = scope === "rtw" ? "admin-rtw-stream" : "admin-orders-stream";

  if (input) {
    input.value = window[filterKey] || "";
    input.addEventListener("change", (e) => {
      window[filterKey] = e.target.value || "";
      applyOrderDateFilter(document.getElementById(streamId), window[filterKey], scope);
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      window[filterKey] = "";
      if (input) input.value = "";
      applyOrderDateFilter(document.getElementById(streamId), "", scope);
    });
  }
}

/**
 * Derives a local-time "YYYY-MM-DD" bucket key from a Firestore Timestamp
 * (as written by serverTimestamp() on `orderCreatedTimestamp`). Falls back
 * to null for orders whose timestamp hasn't resolved yet (e.g. an optimistic
 * local write still pending server confirmation) — those get grouped last,
 * under "Date Pending".
 */
function getOrderDateKey(timestamp) {
  const jsDate = timestamp?.toDate?.();
  if (!jsDate || Number.isNaN(jsDate.getTime())) return null;
  const year = jsDate.getFullYear();
  const month = String(jsDate.getMonth() + 1).padStart(2, "0");
  const day = String(jsDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Readable heading for a date group, e.g. "September 14, 2026". Mirrors the input's local-time parsing so it never rolls back a day. */
function formatDateGroupHeading(dateKey) {
  if (!dateKey) return "Date Pending";
  const [year, month, day] = dateKey.split("-").map(Number);
  const parsedDate = new Date(year, month - 1, day);
  if (Number.isNaN(parsedDate.getTime())) return "Date Pending";
  return parsedDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Groups an array of Firestore QueryDocumentSnapshots (already sorted
 * newest-first by the caller's query) into date buckets, returning them as
 * an array of { dateKey, docs } ordered most-recent-day-first. Within each
 * bucket the docs are reversed to ascending order, so orders render in the
 * sequence they actually arrived that day rather than newest-first.
 */
function groupOrderDocsByDate(sortedDocsDesc) {
  const buckets = new Map();
  sortedDocsDesc.forEach((docSnap) => {
    const dateKey = getOrderDateKey(docSnap.data().orderCreatedTimestamp);
    const bucketKey = dateKey || "__pending__";
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(docSnap);
  });

  return Array.from(buckets.entries()).map(([bucketKey, docs]) => ({
    dateKey: bucketKey === "__pending__" ? null : bucketKey,
    // Reverse so the earliest order of that day comes first ("the order they came in").
    docs: docs.slice().reverse(),
  }));
}

/** Shows/hides rendered `.order-date-group` blocks to match the active search date, and updates the status line + empty-state messaging. `scope` selects which status element and empty-copy to use. */
function applyOrderDateFilter(containerEl, filterValue, scope) {
  if (!containerEl) return;

  const groups = containerEl.querySelectorAll(".order-date-group");
  let visibleDayCount = 0;
  let visibleOrderCount = 0;

  groups.forEach((group) => {
    const matches = !filterValue || group.dataset.orderDate === filterValue;
    group.style.display = matches ? "" : "none";
    if (matches) {
      visibleDayCount += 1;
      visibleOrderCount += group.querySelectorAll(".admin-order-card").length;
    }
  });

  let emptyNotice = containerEl.querySelector(".order-date-empty-notice");
  if (filterValue && visibleDayCount === 0) {
    if (!emptyNotice) {
      emptyNotice = document.createElement("p");
      emptyNotice.className = "empty-notice order-date-empty-notice";
      containerEl.appendChild(emptyNotice);
    }
    emptyNotice.textContent = `No ${scope === "rtw" ? "Ready-To-Wear" : "bespoke"} orders came in on ${formatDateGroupHeading(filterValue)}.`;
  } else if (emptyNotice) {
    emptyNotice.remove();
  }

  const statusEl = document.getElementById(`${scope}-order-date-status`);
  if (statusEl) {
    statusEl.textContent = filterValue
      ? `Showing ${visibleOrderCount} order${visibleOrderCount === 1 ? "" : "s"} from ${formatDateGroupHeading(filterValue)}`
      : "";
  }
}

/**
 * Real-time onSnapshot listener for the master "orders" queue.
 *
 * @param {"bespoke"|"rtw"} mode - which slice of the orders collection to stream.
 *   "bespoke" → all orders WITHOUT orderType "Ready-To-Wear" (the existing ledger).
 *   "rtw"     → orders WHERE orderType == "Ready-To-Wear" (Task 1/2 boutique view).
 *
 * Always tears down the previous subscription first so toggling modes never
 * leaves two listeners writing into the same DOM node.
 */
function mountOrdersStream(mode = "bespoke") {
  const adminStream = document.getElementById("admin-orders-stream");
  if (!adminStream) return;

  // Isolate this stream's subscription from any prior mode's listener
  if (window.activeDashboardUnsubscribe) {
    window.activeDashboardUnsubscribe();
    window.activeDashboardUnsubscribe = null;
  }

  adminStream.innerHTML = `<p class="loading-text">Subscribing to ${mode === "rtw" ? "boutique" : "master"} order ledgers...</p>`;

  if (mode === "rtw") {
    mountReadyToWearOrdersStream(adminStream);
  } else {
    mountBespokeOrdersStream(adminStream);
  }
}

/**
 * Bespoke commission ledger (original behavior, isolated into its own function).
 */
function mountBespokeOrdersStream(adminStream) {
  const masterOrdersQuery = query(collection(db, "orders"), orderBy("orderCreatedTimestamp", "desc"));

  window.activeDashboardUnsubscribe = onSnapshot(masterOrdersQuery, (snapshot) => {
    // Filter out Ready-To-Wear entries client-side so this ledger only ever
    // shows measurement-heavy bespoke commissions.
    const bespokeDocs = snapshot.docs.filter((d) => d.data().orderType !== "Ready-To-Wear");

    if (bespokeDocs.length === 0) {
      adminStream.innerHTML = `<p class="empty-notice" style="color:#7f8c8d; padding: 2rem; text-align:center;">No client commissions have been submitted yet.</p>`;
      return;
    }

    const dateGroups = groupOrderDocsByDate(bespokeDocs);

    let adminHtmlBlock = "";
    dateGroups.forEach(({ dateKey, docs }) => {
      adminHtmlBlock += `
        <div class="order-date-group" data-order-date="${dateKey || ""}">
          <div class="order-date-group-header">
            <h3 class="order-date-heading">${formatDateGroupHeading(dateKey)}</h3>
            <span class="order-date-count">${docs.length} order${docs.length === 1 ? "" : "s"}</span>
          </div>
      `;

      docs.forEach((orderDoc) => {
      const data = orderDoc.data();
      const orderId = orderDoc.id;
      const idShort = orderId.substring(0, 8).toUpperCase();
      const activeStatus = data.commissionStatus || "Pending Studio Review";
      const billingStatus = data.financialStatus || "Awaiting Invoice";
      // Older commissions predate the Upper/Lower Body restructure and the
      // Atelier Specification, so every lookup below falls back gracefully
      // rather than throwing on a missing nested object.
      const upperMetrics = data.tailoringMetrics?.upperBody || {};
      const lowerMetrics = data.tailoringMetrics?.lowerBody || {};
      const atelierSpec = data.atelierSpecification || {};
      const atelierLabel = formatAtelierName(atelierSpec.selectedAtelier);

      const clientFullName = data.clientName || "";
      const clientEmail = data.clientEmail || "Anonymous Guest";
      const contactPhone = data.contactPhone || "No contact record";
      const shippingAddress = data.shippingAddress || "No shipping profile logged";
      const deliveryDate = formatDeliveryDate(data.preferredDeliveryDate);

      const isAttended = !!data.attended;

      adminHtmlBlock += `
        <div class="admin-order-card${isAttended ? " is-attended" : ""}" data-order-id="${orderId}">

          ${buildOrderUtilityBarHtml(orderId, isAttended)}

          <!-- Header: commission identity, always the first thing read -->
          <div class="rtw-card-header">
            <div class="rtw-card-id-block">
              <span class="admin-id-tag">SB-${idShort}</span>
              <h4 class="rtw-garment-name">${escapeHtmlForDisplay(resolveSilhouetteLabel(data.configuration))}</h4>
              <p class="textile-desc">Textile: ${escapeHtmlForDisplay(resolveTextileLabel(data.configuration))}</p>
              ${data.configuration?.customSilhouetteImageUrl ? `
              <a href="${data.configuration.customSilhouetteImageUrl}" target="_blank" rel="noopener noreferrer" class="admin-reference-image-link">
                <img src="${data.configuration.customSilhouetteImageUrl}" alt="Customer-submitted reference image" class="admin-reference-image-thumb" loading="lazy">
                <span>View reference image</span>
              </a>` : ""}
            </div>
          </div>

          <div class="rtw-card-divider"></div>

          <!-- Customer + delivery details — one fact per line, own icon -->
          <div class="rtw-customer-info">
            ${clientFullName ? `
            <div class="rtw-info-row">
              <span class="rtw-info-icon" aria-hidden="true">${personIconSvg()}</span>
              <span class="rtw-info-text">${escapeHtmlForDisplay(clientFullName)}</span>
            </div>
            ` : ""}
            <div class="rtw-info-row">
              <span class="rtw-info-icon" aria-hidden="true">${mailIconSvg()}</span>
              <span class="rtw-info-text">${escapeHtmlForDisplay(clientEmail)}</span>
            </div>
            <div class="rtw-info-row">
              <span class="rtw-info-icon" aria-hidden="true">${phoneIconSvg()}</span>
              <span class="rtw-info-text">${escapeHtmlForDisplay(contactPhone)}</span>
            </div>
            <div class="rtw-info-row">
              <span class="rtw-info-icon" aria-hidden="true">${pinIconSvg()}</span>
              <span class="rtw-info-text">${escapeHtmlForDisplay(shippingAddress)}</span>
            </div>
            ${deliveryDate ? `
            <div class="rtw-info-row">
              <span class="rtw-info-icon" aria-hidden="true">${calendarIconSvg()}</span>
              <span class="rtw-info-text">Preferred delivery: ${deliveryDate}</span>
            </div>
            ` : ""}
          </div>

          <div class="rtw-card-divider"></div>

          <!-- Pipeline controls — side by side -->
          <div class="rtw-pipeline-controls">
            <div class="admin-pipeline-cell">
              <label class="pipeline-label">Production Pipeline</label>
              <select class="status-modifier-dropdown" data-id="${orderId}">
                <option value="Pending Studio Review" ${activeStatus === "Pending Studio Review" ? "selected" : ""}>Pending Review</option>
                <option value="In Cutting Stage" ${activeStatus === "In Cutting Stage" ? "selected" : ""}>In Cutting Stage</option>
                <option value="Assembled & Awaiting Fitting" ${activeStatus === "Assembled & Awaiting Fitting" ? "selected" : ""}>Awaiting Fitting</option>
                <option value="Completed & Shipped" ${activeStatus === "Completed & Shipped" ? "selected" : ""}>Completed & Dispatched</option>
              </select>
            </div>
            <div class="admin-pipeline-cell">
              <label class="pipeline-label">Financial Ledger Status</label>
              <select class="billing-modifier-dropdown" data-id="${orderId}">
                <option value="Awaiting Invoice" ${billingStatus === "Awaiting Invoice" ? "selected" : ""}>Awaiting Invoice</option>
                <option value="Invoice Sent" ${billingStatus === "Invoice Sent" ? "selected" : ""}>Invoice Sent</option>
                <option value="Settled" ${billingStatus === "Settled" ? "selected" : ""}>Settled & Paid</option>
              </select>
            </div>
          </div>

          <div class="rtw-card-divider"></div>

          <button class="btn-inspect-metrics" data-target="drawer-${orderId}">Inspect Specs</button>
          <div id="drawer-${orderId}" class="admin-metrics-drawer" style="display: none;">
            <p class="pipeline-label" style="margin: 0.75rem 0 0.4rem;">Upper Body</p>
            <div class="drawer-inner-grid">
              <div class="metric-pill"><span>Neck:</span> <strong>${upperMetrics.neck ?? '--'} cm</strong></div>
              <div class="metric-pill"><span>Chest:</span> <strong>${upperMetrics.chest ?? '--'} cm</strong></div>
              <div class="metric-pill"><span>Across Back / Shoulder:</span> <strong>${upperMetrics.acrossBackShoulder ?? '--'} cm</strong></div>
              <div class="metric-pill"><span>Sleeve Length:</span> <strong>${upperMetrics.sleeveLength ?? '--'} cm</strong></div>
              <div class="metric-pill"><span>Top Length:</span> <strong>${upperMetrics.topLength ?? '--'} cm</strong></div>
              <div class="metric-pill"><span>Around Arm:</span> <strong>${upperMetrics.aroundArm ?? '--'} cm</strong></div>
              <div class="metric-pill"><span>Wrist:</span> <strong>${upperMetrics.wrist ?? '--'} cm</strong></div>
            </div>
            <p class="pipeline-label" style="margin: 0.75rem 0 0.4rem;">Lower Body</p>
            <div class="drawer-inner-grid">
              <div class="metric-pill"><span>Waist:</span> <strong>${lowerMetrics.waist ?? '--'} cm</strong></div>
              <div class="metric-pill"><span>Length:</span> <strong>${lowerMetrics.length ?? '--'} cm</strong></div>
              <div class="metric-pill"><span>Thigh:</span> <strong>${lowerMetrics.thigh ?? '--'} cm</strong></div>
              <div class="metric-pill"><span>Knee:</span> <strong>${lowerMetrics.knee ?? '--'} cm</strong></div>
              <div class="metric-pill"><span>Bar/Ankle:</span> <strong>${lowerMetrics.barAnkle ?? '--'} cm</strong></div>
            </div>
            <p class="pipeline-label" style="margin: 0.75rem 0 0.4rem;">Atelier Specification</p>
            <div class="drawer-inner-grid">
              <div class="metric-pill"><span>Atelier:</span> <strong>${atelierLabel}</strong></div>
              ${atelierSpec.customAtelierName ? `<div class="metric-pill"><span>Custom Atelier:</span> <strong>${escapeHtmlForDisplay(atelierSpec.customAtelierName)}</strong></div>` : ""}
            </div>
          </div>
        </div>
      `;
      });

      adminHtmlBlock += `</div>`; // close .order-date-group
    });

    adminStream.innerHTML = adminHtmlBlock;

    // Re-apply whatever date search the admin currently has active, since
    // onSnapshot re-renders this container on every order/status change.
    applyOrderDateFilter(adminStream, window.bespokeOrderDateFilter, "bespoke");

    // Specs drawer toggles
    adminStream.querySelectorAll(".btn-inspect-metrics").forEach(button => {
      button.addEventListener("click", (e) => {
        const drawerId = e.target.dataset.target;
        const drawer = document.getElementById(drawerId);
        if (!drawer) return;
        const isHidden = drawer.style.display === "none";
        drawer.style.display = isHidden ? "block" : "none";
        e.target.textContent = isHidden ? "Collapse Specs" : "Inspect Specs";
      });
    });

    // Pipeline status dropdowns
    adminStream.querySelectorAll(".status-modifier-dropdown").forEach(dropdown => {
      dropdown.addEventListener("change", async (e) => {
        const targetOrderId = e.target.dataset.id;
        const freshStatusValue = e.target.value;
        try {
          await updateDoc(doc(db, "orders", targetOrderId), { commissionStatus: freshStatusValue });
          showAtelierNotification(`Order SB-${targetOrderId.substring(0,8).toUpperCase()} moved to: ${freshStatusValue}`);
        } catch (err) {
          console.error("Failed to alter server pipeline index:", err);
          showAtelierNotification("Server rejected pipeline change status update.", "error");
        }
      });
    });

    // Billing status dropdowns
    adminStream.querySelectorAll(".billing-modifier-dropdown").forEach(dropdown => {
      dropdown.addEventListener("change", async (e) => {
        const targetOrderId = e.target.dataset.id;
        const freshBillingValue = e.target.value;
        try {
          await updateDoc(doc(db, "orders", targetOrderId), { financialStatus: freshBillingValue });
          showAtelierNotification(`Order SB-${targetOrderId.substring(0,8).toUpperCase()} balance updated to: ${freshBillingValue}`);
        } catch (err) {
          console.error("Failed to alter ledger status index:", err);
          showAtelierNotification("Server rejected ledger status update.", "error");
        }
      });
    });

    // NEW: Attended checkbox + Delete button
    wireOrderUtilityBarHandlers(adminStream);

  }, (error) => {
    console.error("Admin stream synchronization lost:", error);
    adminStream.innerHTML = `<p style="color:#e74c3c; padding:2rem;">Stream error: ${error.message}</p>`;
  });
}

/**
 * TASK 1 & 2 — Ready-To-Wear Boutique Orders Stream.
 *
 * Queries orders WHERE orderType == "Ready-To-Wear" and renders the
 * Delivery Dispatch Input Matrix: thumbnail, customer contact number,
 * shipping address, status/billing dropdowns, and an inline dispatch
 * message field + Send button that writes `deliveryNotes` onto the order.
 */
function mountReadyToWearOrdersStream(adminStream) {
  const rtwOrdersQuery = query(
    collection(db, "orders"),
    where("orderType", "==", "Ready-To-Wear"),
    orderBy("orderCreatedTimestamp", "desc")
  );

  window.activeRtwModalUnsubscribe = onSnapshot(rtwOrdersQuery, (snapshot) => {
    if (snapshot.empty) {
      adminStream.innerHTML = `<p class="empty-notice" style="color:#7f8c8d; padding: 2rem; text-align:center;">No Ready-To-Wear boutique orders have come in yet.</p>`;
      return;
    }

    const dateGroups = groupOrderDocsByDate(snapshot.docs);

    let rtwHtmlBlock = "";
    dateGroups.forEach(({ dateKey, docs }) => {
      rtwHtmlBlock += `
        <div class="order-date-group" data-order-date="${dateKey || ""}">
          <div class="order-date-group-header">
            <h3 class="order-date-heading">${formatDateGroupHeading(dateKey)}</h3>
            <span class="order-date-count">${docs.length} order${docs.length === 1 ? "" : "s"}</span>
          </div>
      `;

      docs.forEach((orderDoc) => {
      const data = orderDoc.data();
      const docId = orderDoc.id;
      const orderId = docId;
      const idShort = orderId.substring(0, 8).toUpperCase();
      const activeStatus = data.commissionStatus || "Pending Studio Review";
      const billingStatus = data.financialStatus || "Awaiting Invoice";

      // High-precision luxury fallback parameters
      const collectionName = data.collectionName || "Boutique Selected Apparel";
      const selectedSize = data.selectedSize || "M";
      const clientFullName = data.clientName || data.fullName || data.customerName || "";
      const clientEmail = data.clientEmail || "Anonymous Patron";
      const shippingAddress = data.shippingAddress || data.deliveryAddress || "No shipping profile logged";
      // THE FIX: openRTWCheckoutModal (app.js) writes this field as
      // `contactPhone` — this fallback chain was checking contactNumber /
      // phoneNumber / customerPhone first, none of which are ever actually
      // written by the checkout form, so every real order fell straight
      // through to "No contact record" even when the customer had entered
      // their number correctly. contactPhone now checked first; the other
      // names stay as fallbacks for any differently-sourced legacy data.
      const clientContact = data.contactPhone || data.contactNumber || data.phoneNumber || data.customerPhone || "No contact record";
      const apparelImage = data.apparelImage || data.imageUrl || "images/placeholder-garment.jpg";
      const deliveryNotes = typeof data.deliveryNotes === "string" ? data.deliveryNotes : "";

      const contactNumber = clientContact;
      const existingNotes = deliveryNotes;

      const thumbnailHtml = apparelImage
        ? `<img src="${apparelImage}" alt="${collectionName}" loading="lazy" class="rtw-card-thumb">`
        : `<div class="rtw-card-thumb rtw-card-thumb--empty"></div>`;

      const isAttended = !!data.attended;

      rtwHtmlBlock += `
        <div class="admin-order-card rtw-order-card${isAttended ? " is-attended" : ""}" data-order-id="${orderId}">

          ${buildOrderUtilityBarHtml(orderId, isAttended)}

          <!-- Header: garment identity + thumbnail, always the first thing read -->
          <div class="rtw-card-header">
            <div class="rtw-card-id-block">
              <span class="admin-id-tag">SB-${idShort}</span>
              <h4 class="rtw-garment-name">${escapeHtmlForDisplay(collectionName)}</h4>
              <p class="textile-desc">Size ${escapeHtmlForDisplay(selectedSize)}</p>
            </div>
            ${thumbnailHtml}
          </div>

          <div class="rtw-card-divider"></div>

          <!-- Customer contact — one fact per line, own icon, consistent legible color -->
          <div class="rtw-customer-info">
            ${clientFullName ? `
            <div class="rtw-info-row">
              <span class="rtw-info-icon" aria-hidden="true">${personIconSvg()}</span>
              <span class="rtw-info-text">${escapeHtmlForDisplay(clientFullName)}</span>
            </div>
            ` : ""}
            <div class="rtw-info-row">
              <span class="rtw-info-icon" aria-hidden="true">${mailIconSvg()}</span>
              <span class="rtw-info-text">${escapeHtmlForDisplay(clientEmail)}</span>
            </div>
            <div class="rtw-info-row">
              <span class="rtw-info-icon" aria-hidden="true">${phoneIconSvg()}</span>
              <span class="rtw-info-text">${escapeHtmlForDisplay(contactNumber)}</span>
            </div>
            <div class="rtw-info-row">
              <span class="rtw-info-icon" aria-hidden="true">${pinIconSvg()}</span>
              <span class="rtw-info-text">${escapeHtmlForDisplay(shippingAddress)}</span>
            </div>
          </div>

          <div class="rtw-card-divider"></div>

          <!-- Pipeline controls — side by side, own labels, no longer squeezed against the contact block -->
          <div class="rtw-pipeline-controls">
            <div class="admin-pipeline-cell">
              <label class="pipeline-label">Production Pipeline</label>
              <select class="status-modifier-dropdown" data-id="${orderId}">
                <option value="Pending Studio Review" ${activeStatus === "Pending Studio Review" ? "selected" : ""}>Pending Review</option>
                <option value="In Cutting Stage" ${activeStatus === "In Cutting Stage" ? "selected" : ""}>Preparing Order</option>
                <option value="Assembled & Awaiting Fitting" ${activeStatus === "Assembled & Awaiting Fitting" ? "selected" : ""}>Packed</option>
                <option value="Completed & Shipped" ${activeStatus === "Completed & Shipped" ? "selected" : ""}>Dispatched</option>
              </select>
            </div>
            <div class="admin-pipeline-cell">
              <label class="pipeline-label">Financial Ledger Status</label>
              <select class="billing-modifier-dropdown" data-id="${orderId}">
                <option value="Awaiting Invoice" ${billingStatus === "Awaiting Invoice" ? "selected" : ""}>Awaiting Invoice</option>
                <option value="Invoice Sent" ${billingStatus === "Invoice Sent" ? "selected" : ""}>Invoice Sent</option>
                <option value="Settled" ${billingStatus === "Settled" ? "selected" : ""}>Settled & Paid</option>
              </select>
            </div>
          </div>

          <div class="rtw-card-divider"></div>

          <!-- Delivery update — a real textarea now, not a single-line input that
               hid everything past its visible width. Grows with content up to a
               cap, then scrolls internally, same pattern as the chat composer. -->
          <div class="rtw-dispatch-section">
            <label class="pipeline-label" for="dispatch-${orderId}">Delivery Update to Client</label>
            <div class="rtw-dispatch-cell">
              <textarea
                id="dispatch-${orderId}"
                class="rtw-delivery-dispatcher"
                data-id="${orderId}"
                rows="1"
                placeholder="e.g., Dispatched via courier. Arrival Friday morning."
              >${escapeHtmlForDisplay(existingNotes)}</textarea>
              <button type="button" class="btn-send-delivery-note" data-id="${orderId}">Send</button>
            </div>
          </div>
        </div>
      `;
      });

      rtwHtmlBlock += `</div>`; // close .order-date-group
    });

    adminStream.innerHTML = rtwHtmlBlock;

    // Re-apply whatever date search the admin currently has active, since
    // onSnapshot re-renders this container on every order/status change.
    applyOrderDateFilter(adminStream, window.rtwOrderDateFilter, "rtw");

    // Delivery update textareas: autosize as the admin types, same 140px cap
    // and internal-scroll behavior as the chat widget's composer.
    adminStream.querySelectorAll(".rtw-delivery-dispatcher").forEach((textarea) => {
      autoGrowDispatchTextarea(textarea);
      textarea.addEventListener("input", () => autoGrowDispatchTextarea(textarea));
    });

    // Pipeline status dropdowns (shared logic with bespoke view)
    adminStream.querySelectorAll(".status-modifier-dropdown").forEach(dropdown => {
      dropdown.addEventListener("change", async (e) => {
        const targetOrderId = e.target.dataset.id;
        const freshStatusValue = e.target.value;
        try {
          await updateDoc(doc(db, "orders", targetOrderId), { commissionStatus: freshStatusValue });
          showAtelierNotification(`Order SB-${targetOrderId.substring(0,8).toUpperCase()} moved to: ${freshStatusValue}`);
        } catch (err) {
          console.error("Failed to alter server pipeline index:", err);
          showAtelierNotification("Server rejected pipeline change status update.", "error");
        }
      });
    });

    // Billing status dropdowns
    adminStream.querySelectorAll(".billing-modifier-dropdown").forEach(dropdown => {
      dropdown.addEventListener("change", async (e) => {
        const targetOrderId = e.target.dataset.id;
        const freshBillingValue = e.target.value;
        try {
          await updateDoc(doc(db, "orders", targetOrderId), { financialStatus: freshBillingValue });
          showAtelierNotification(`Order SB-${targetOrderId.substring(0,8).toUpperCase()} balance updated to: ${freshBillingValue}`);
        } catch (err) {
          console.error("Failed to alter ledger status index:", err);
          showAtelierNotification("Server rejected ledger status update.", "error");
        }
      });
    });

    // TASK 2: Send button → writes deliveryNotes onto the target order document
    adminStream.querySelectorAll(".btn-send-delivery-note").forEach(button => {
      button.addEventListener("click", async (e) => {
        const targetOrderId = e.currentTarget.dataset.id;
        const inputEl = adminStream.querySelector(`.rtw-delivery-dispatcher[data-id="${targetOrderId}"]`);
        if (!inputEl) return;

        const noteText = inputEl.value.trim();
        if (!noteText) {
          showAtelierNotification("Write a delivery message before sending.", "error");
          return;
        }

        const originalLabel = e.currentTarget.textContent;
        e.currentTarget.disabled = true;
        e.currentTarget.textContent = "Sending...";

        try {
          await updateDoc(doc(db, "orders", targetOrderId), { deliveryNotes: noteText });
          showAtelierNotification(`Delivery note sent for SB-${targetOrderId.substring(0,8).toUpperCase()}.`);
        } catch (err) {
          console.error("Failed to write deliveryNotes field:", err);
          showAtelierNotification("Server rejected the delivery note update.", "error");
        } finally {
          e.currentTarget.disabled = false;
          e.currentTarget.textContent = originalLabel;
        }
      });
    });

    // NEW: Attended checkbox + Delete button
    wireOrderUtilityBarHandlers(adminStream);

  }, (error) => {
    console.error("Ready-To-Wear admin stream synchronization lost:", error);
    adminStream.innerHTML = `<p style="color:#e74c3c; padding:2rem;">Stream error: ${error.message}</p>`;
  });
}

// ── Helper formatting utilities ──

/**
 * Escapes text for safe injection into innerHTML text nodes (deliveryNotes,
 * contact numbers, shipping addresses pulled straight from Firestore).
 */
function escapeHtmlForDisplay(rawText) {
  if (typeof rawText !== "string") return "";
  return rawText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Autosizes a delivery-update textarea as the admin types — grows with
 * content up to a cap, then scrolls internally rather than either hiding
 * text (the old single-line input's problem) or growing the card forever.
 */
function autoGrowDispatchTextarea(textarea) {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
}

function mailIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z" opacity="0"></path><path d="M22 6c0-1.1-.9-2-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6Z"></path><path d="m22 6-10 7L2 6"></path></svg>`;
}

function phoneIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92Z"></path></svg>`;
}

function pinIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
}

function personIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
}

function calendarIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><path d="M16 2v4"></path><path d="M8 2v4"></path><path d="M3 10h18"></path></svg>`;
}

/**
 * NEW FEATURE: Order attended-state + delete controls.
 * Trash icon used by .btn-delete-order across both the bespoke and
 * Ready-To-Wear admin order cards.
 */
function trashIconSvg() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>`;
}

/**
 * Builds the shared "Mark as Attended" checkbox + "Delete" button row shown
 * at the top of every admin order card (bespoke and Ready-To-Wear alike).
 * `attended` reflects the order doc's `attended` boolean (missing/false =
 * a fresh, unattended order — the default for anything that predates this
 * field). Both handlers are wired once per render in
 * wireOrderUtilityBarHandlers() below, shared by both streams.
 */
function buildOrderUtilityBarHtml(orderId, attended) {
  return `
    <div class="order-utility-bar">
      <label class="order-attended-toggle">
        <input type="checkbox" class="order-attended-checkbox" data-id="${orderId}" ${attended ? "checked" : ""}>
        <span class="custom-checkbox"></span>
        <span class="attended-toggle-label">${attended ? "Attended" : "Mark as Attended"}</span>
      </label>
      <button type="button" class="btn-delete-order" data-id="${orderId}" aria-label="Delete this order permanently">
        ${trashIconSvg()}
        <span>Delete</span>
      </button>
    </div>
  `;
}

/**
 * Wires the attended checkbox and delete button for every card currently
 * rendered inside `adminStream`. Called once per onSnapshot render in both
 * mountBespokeOrdersStream() and mountReadyToWearOrdersStream() — identical
 * behavior in both, so it lives here instead of being duplicated twice.
 *
 * Attended: writes `attended: true/false` onto the order doc. The onSnapshot
 * listener re-renders on that write anyway, but we also toggle the class
 * and label immediately so the UI doesn't wait a round trip to feel
 * responsive, and revert the checkbox if the write fails.
 *
 * Delete: confirms first (destructive, no undo), then deletes the order doc.
 * The onSnapshot listener removes the card from the list automatically once
 * Firestore confirms the delete, so no manual DOM removal is needed here.
 */
function wireOrderUtilityBarHandlers(adminStream) {
  adminStream.querySelectorAll(".order-attended-checkbox").forEach((checkbox) => {
    checkbox.addEventListener("change", async (e) => {
      const targetOrderId = e.target.dataset.id;
      const isAttended = e.target.checked;
      const idShort = targetOrderId.substring(0, 8).toUpperCase();
      const card = adminStream.querySelector(`.admin-order-card[data-order-id="${targetOrderId}"]`);
      const labelEl = e.target.closest(".order-attended-toggle")?.querySelector(".attended-toggle-label");

      // Optimistic UI update
      if (card) card.classList.toggle("is-attended", isAttended);
      if (labelEl) labelEl.textContent = isAttended ? "Attended" : "Mark as Attended";

      try {
        await updateDoc(doc(db, "orders", targetOrderId), { attended: isAttended });
        showAtelierNotification(`Order SB-${idShort} marked as ${isAttended ? "attended" : "not yet attended"}.`);
      } catch (err) {
        console.error("Failed to update attended flag:", err);
        // Revert optimistic update on failure
        e.target.checked = !isAttended;
        if (card) card.classList.toggle("is-attended", !isAttended);
        if (labelEl) labelEl.textContent = !isAttended ? "Attended" : "Mark as Attended";
        showAtelierNotification("Server rejected the attended status update.", "error");
      }
    });
  });

  adminStream.querySelectorAll(".btn-delete-order").forEach((button) => {
    button.addEventListener("click", async (e) => {
      const targetOrderId = e.currentTarget.dataset.id;
      const idShort = targetOrderId.substring(0, 8).toUpperCase();
      const confirmed = window.confirm(`Delete order SB-${idShort}? This cannot be undone.`);
      if (!confirmed) return;

      e.currentTarget.disabled = true;
      try {
        await deleteDoc(doc(db, "orders", targetOrderId));
        showAtelierNotification(`Order SB-${idShort} deleted.`);
      } catch (err) {
        console.error("Failed to delete order:", err);
        e.currentTarget.disabled = false;
        showAtelierNotification("Server rejected the delete request.", "error");
      }
    });
  });
}

// ── SIDEBAR NAV ICONS ──
// Standard, plain stroke icons matching the Lucide-style set already used
// throughout the app (mailIconSvg, phoneIconSvg, etc.) — no filled shapes,
// no decorative flourish, sized by CSS (.dash-nav-icon svg) rather than
// their own attributes so every nav icon renders at one consistent size
// regardless of which helper it came from.
function overviewIconSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"></rect><rect x="14" y="3" width="7" height="5"></rect><rect x="14" y="12" width="7" height="9"></rect><rect x="3" y="16" width="7" height="5"></rect></svg>`;
}

function packageIconSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.73Z"></path><path d="M3.3 7 12 12l8.7-5"></path><path d="M12 22V12"></path></svg>`;
}

function rulerIconSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.3 8.7 15.3 2.7a1 1 0 0 0-1.4 0L2.7 13.9a1 1 0 0 0 0 1.4l6 6a1 1 0 0 0 1.4 0L21.3 10.1a1 1 0 0 0 0-1.4Z"></path><path d="m7.5 10.5 2 2"></path><path d="m10.5 7.5 2 2"></path><path d="m13.5 4.5 2 2"></path><path d="m4.5 13.5 2 2"></path></svg>`;
}

function hangerIconSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"></path><path d="M3 6h18"></path><path d="M16 10a4 4 0 0 1-8 0"></path></svg>`;
}

function bellIconSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path></svg>`;
}

function layersIconSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"></path><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"></path><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"></path></svg>`;
}

function chevronIconSvg() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>`;
}

function signOutIconSvg() {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>`;
}

/**
 * Formats the raw "YYYY-MM-DD" value from the checkout modal's date input
 * into a readable label (e.g. "Aug 15, 2026"). Returns an empty string for
 * anything missing or unparseable so the calling template's conditional
 * cleanly omits the row instead of showing "Invalid Date" or similar.
 */
function formatDeliveryDate(rawDate) {
  if (!rawDate || typeof rawDate !== "string") return "";
  // Parsed as local time, not UTC — a bare "YYYY-MM-DD" string passed to
  // `new Date()` directly is interpreted as UTC midnight, which can quietly
  // roll the displayed date back a day for anyone west of UTC. Splitting
  // and constructing with explicit local-time arguments avoids that.
  const parts = rawDate.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return "";
  const [year, month, day] = parts;
  const parsedDate = new Date(year, month - 1, day);
  if (Number.isNaN(parsedDate.getTime())) return "";
  return parsedDate.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Resolves the display label for an order's silhouette: when the client
 * chose "Other / Custom Silhouette" and typed a name, that free-text name
 * takes priority over the generic mapped fallback. Mirrors the existing
 * atelierSpecification.customAtelierName pattern used elsewhere in this
 * file. Callers are responsible for HTML-escaping the result before
 * inserting it into innerHTML, since this may return raw client-entered text.
 */
function resolveSilhouetteLabel(configuration) {
  const config = configuration || {};
  if (config.silhouette === "other" && config.customSilhouetteName) {
    return config.customSilhouetteName;
  }
  return formatGarmentName(config.silhouette);
}

/**
 * Same resolution rule as resolveSilhouetteLabel, for the fabric/textile
 * selection.
 */
function resolveTextileLabel(configuration) {
  const config = configuration || {};
  if (config.textileProfile === "other" && config.customTextileName) {
    return config.customTextileName;
  }
  return formatTextileName(config.textileProfile);
}

function formatGarmentName(slug) {
  const mappings = {
    "signature-kaftan": "Signature Custom Kaftan",
    "bespoke-two-piece": "Premium Two-Piece Suit",
    "luxury-agbada": "Royal Agbada Masterpiece",
    "printed-apparel": "Printed Contemporary Shirt",
  };
  return mappings[slug] || "Bespoke Garment Configuration";
}

function formatTextileName(slug) {
  const mappings = {
    "premium-wool": "Super 120s Premium Wool",
    "polished-linen": "Polished Tropical Linen",
    "luxury-brocade": "Hand-Woven Luxury Brocade",
    "deluxe-cotton": "High-Thread Deluxe Cotton",
  };
  return mappings[slug] || "Selected Material Profile";
}

function formatAtelierName(slug) {
  if (!slug) return "Not provided";
  const mappings = {
    "accra-flagship": "Suit Boss Flagship Atelier — Accra",
    "kumasi-studio": "Suit Boss Kumasi Studio",
    "takoradi-workshop": "Suit Boss Takoradi Workshop",
    "other": "Other / Custom Atelier",
  };
  return mappings[slug] || slug;
}