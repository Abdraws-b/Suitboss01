import {
  collection,
  query,
  where,
  onSnapshot,
  orderBy,
  doc,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { db } from "./app.js";
import { showAtelierNotification } from "./ui-feedback.js";
import { initClientChat, initAdminChat, teardownChatWidget } from "./chat-engine.js";

// Ensure global operational tracking hook sits safely at window runtime space
if (!window.activeDashboardUnsubscribe) {
  window.activeDashboardUnsubscribe = null;
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

export async function mountAtelierDashboard(uid) {
  const mainContent = document.getElementById("main-content");
  if (!mainContent) return;

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
  // The boutique orders modal itself, if it happened to be open when the
  // dashboard remounted, shouldn't survive into the fresh render.
  closeBoutiqueOrdersModal();

  // Same for the chat widget — its listeners (thread/list/badge) are all
  // independent of the streams above and need their own explicit teardown.
  teardownChatWidget();

  // Fix header color when staging content over transparent areas
  const headerEl = document.querySelector(".atelier-header");
  if (headerEl) {
    headerEl.classList.add("internal-header");
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
        renderClientLedgerDashboard(uid);
      }
    } else {
      mainContent.innerHTML = `<p class="error-text" style="text-align:center; padding: 5rem;">Atelier profile record not found in system registers.</p>`;
    }
  } catch (error) {
    console.error("Dashboard router authentication intercept failure:", error);
    mainContent.innerHTML = `<p class="error-text" style="text-align:center; padding: 5rem;">System validation error. Please try logging in again.</p>`;
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
    const blueprint = profileData.measurementBlueprint || {};

    mainContent.innerHTML = `
      <div class="dashboard-wrapper">
        <div class="dashboard-header-row">
          <div class="dash-greeting-block">
            <p class="dash-greeting-eyebrow">Private Studio Ledger</p>
            <h1 class="dash-welcome-title dash-greeting-title">
              ${getTimeBasedGreeting()}, <span class="dash-greeting-name">${extractFirstNameFromEmail(profileData.email)}</span>
            </h1>
            <p class="dash-welcome-sub dash-greeting-fade">Manage your anatomical blueprint and track active commissions.</p>
          </div>
          <div class="client-meta-badge">Profile: ${profileData.email || 'Bespoke Client'}</div>
        </div>

        <div class="dashboard-grid-layout">
          <div class="dashboard-card-pane">
            <h3 class="card-pane-title">Archived Blueprint Proportions</h3>
            <p class="card-pane-sub">Adjust your stored metrics below. Active cuts will update instantly upon saving.</p>
            
            <form id="dashboard-blueprint-form" class="blueprint-inline-form">
              <div class="blueprint-input-grid">
                <div class="metric-input-field">
                  <label for="dash-neck">Neck (cm)</label>
                  <input type="number" id="dash-neck" value="${blueprint.neck || ''}" step="0.1" placeholder="--">
                </div>
                <div class="metric-input-field">
                  <label for="dash-chest">Chest (cm)</label>
                  <input type="number" id="dash-chest" value="${blueprint.chest || ''}" step="0.1" placeholder="--">
                </div>
                <div class="metric-input-field">
                  <label for="dash-shoulder">Shoulder (cm)</label>
                  <input type="number" id="dash-shoulder" value="${blueprint.shoulder || ''}" step="0.1" placeholder="--">
                </div>
                <div class="metric-input-field">
                  <label for="dash-sleeve">Sleeve (cm)</label>
                  <input type="number" id="dash-sleeve" value="${blueprint.sleeve || ''}" step="0.1" placeholder="--">
                </div>
                <div class="metric-input-field">
                  <label for="dash-waist">Waist (cm)</label>
                  <input type="number" id="dash-waist" value="${blueprint.waist || ''}" step="0.1" placeholder="--">
                </div>
                <div class="metric-input-field">
                  <label for="dash-hips">Hips (cm)</label>
                  <input type="number" id="dash-hips" value="${blueprint.hips || ''}" step="0.1" placeholder="--">
                </div>
                <div class="metric-input-field">
                  <label for="dash-outseam">Outseam (cm)</label>
                  <input type="number" id="dash-outseam" value="${blueprint.outseam || ''}" step="0.1" placeholder="--">
                </div>
                <div class="metric-input-field">
                  <label for="dash-inseam">Inseam (cm)</label>
                  <input type="number" id="dash-inseam" value="${blueprint.inseam || ''}" step="0.1" placeholder="--">
                </div>
              </div>
              <button type="submit" class="btn-dashboard-save">Save Metric Shifts</button>
            </form>
          </div>

          <div class="dashboard-card-pane">
            <h3 class="card-pane-title">Active Production Tracker</h3>
            <p class="card-pane-sub">Real-time pipeline overview directly from our cutting room floor.</p>
            <div id="client-active-orders-stream" class="orders-stream-box">
              <p class="loading-mini">Synchronizing server records...</p>
            </div>
          </div>
        </div>
      </div>
    `;

    const blueprintForm = document.getElementById("dashboard-blueprint-form");
    blueprintForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const freshBlueprint = {
        neck: parseFloat(document.getElementById("dash-neck").value) || null,
        chest: parseFloat(document.getElementById("dash-chest").value) || null,
        shoulder: parseFloat(document.getElementById("dash-shoulder").value) || null,
        sleeve: parseFloat(document.getElementById("dash-sleeve").value) || null,
        waist: parseFloat(document.getElementById("dash-waist").value) || null,
        hips: parseFloat(document.getElementById("dash-hips").value) || null,
        outseam: parseFloat(document.getElementById("dash-outseam").value) || null,
        inseam: parseFloat(document.getElementById("dash-inseam").value) || null,
      };

      const ValidationBounds = { min: 30, max: 200 };
      let validationError = null;

      for (const [key, val] of Object.entries(freshBlueprint)) {
        if (val !== null && (val < ValidationBounds.min || val > ValidationBounds.max)) {
          validationError = `The entry for ${key} must sit between valid dimensions (${ValidationBounds.min}cm - ${ValidationBounds.max}cm).`;
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
            ...freshBlueprint,
            lastUpdated: serverTimestamp()
          }
        });
        showAtelierNotification("Anatomical configuration updated securely inside your ledger.");
      } catch (err) {
        console.error("Failed to post blueprint shift edits to Firestore:", err);
        showAtelierNotification("Database sync failed. Please check network protocols.", "error");
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // TASK 1B — CLIENT ORDER LIST SNAPSHOT
    // Refactored: introduces image thumbnail frame for Ready-To-Wear orders.
    // Condition: orderType === "Ready-To-Wear" with an `apparelImage` property,
    // OR configuration.silhouette maps to a known RTW silhouette slug.
    // Thumbnail frame spec: 60×60 px, object-fit:cover, 1px solid var(--color-accent),
    // padding 2px, background #111, border-radius 2px.
    // ─────────────────────────────────────────────────────────────────────────
    const RTW_SILHOUETTE_SLUGS = new Set([
      "signature-kaftan",
      "bespoke-two-piece",
      "luxury-agbada",
      "printed-apparel",
    ]);

    const ordersStreamBox = document.getElementById("client-active-orders-stream");
    const ordersQuery = query(
      collection(db, "orders"),
      where("clientId", "==", uid)
    );

    window.activeDashboardUnsubscribe = onSnapshot(ordersQuery, (snapshot) => {
      if (snapshot.empty) {
        ordersStreamBox.innerHTML = `
          <div class="empty-stream-card">
            <p>No commissions found under your profile token.</p>
            <a href="custom-order.html" class="inline-atelier-link">File a Bespoke Pre-Order →</a>
          </div>
        `;
        return;
      }

      let ordersHtml = "";
      const sortedDocs = snapshot.docs.slice().sort((a, b) => {
        const tA = a.data().orderCreatedTimestamp?.toMillis?.() || 0;
        const tB = b.data().orderCreatedTimestamp?.toMillis?.() || 0;
        return tB - tA;
      });

      sortedDocs.forEach((orderDoc) => {
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

        // ── THUMBNAIL LOGIC ──────────────────────────────────────────────────
        // Show a thumbnail when:
        //   (a) orderType is "Ready-To-Wear" AND the doc has an `apparelImage`
        //   (b) OR the configuration.silhouette maps to a known RTW slug
        const isRTW =
          orderData.orderType === "Ready-To-Wear" ||
          RTW_SILHOUETTE_SLUGS.has(orderData.configuration?.silhouette);

        const imageUrl =
          orderData.apparelImage ||
          orderData.imageUrl ||
          "";

        let thumbnailHtml = "";
        if (isRTW && imageUrl) {
          thumbnailHtml = `
            <img
              src="${imageUrl}"
              alt="${orderData.collectionName || 'Garment preview'}"
              style="
                width: 60px;
                height: 60px;
                object-fit: cover;
                border: 1px solid var(--color-accent);
                padding: 2px;
                background: #111;
                border-radius: 2px;
                flex-shrink: 0;
              "
              loading="lazy"
            >
          `;
        }

        // Resolve display title and sub-line per order type
        const orderTitle = (orderData.orderType || "Bespoke Commission") === "Ready-To-Wear"
          ? (orderData.collectionName || "Ready-To-Wear Piece")
          : formatGarmentName(orderData.configuration?.silhouette);

        const orderSubline = (orderData.orderType || "Bespoke Commission") === "Ready-To-Wear"
          ? (orderData.selectedSize ? `Size: ${orderData.selectedSize}` : "Ready-To-Wear")
          : `Material Layer: ${formatTextileName(orderData.configuration?.textileProfile)}`;

        // ── TASK 3: STUDIO MESSAGE / DELIVERY NOTES PANEL ──────────────────
        // If the admin has written a deliveryNotes string onto this order,
        // surface it prominently in a focused gold accent panel.
        let deliveryNotesHtml = "";
        if (typeof orderData.deliveryNotes === "string" && orderData.deliveryNotes.trim().length > 0) {
          deliveryNotesHtml = `
            <div class="studio-message-panel" style="
              margin-top: 0.85rem;
              padding: 0.85rem 1rem;
              border: 1px solid var(--color-accent);
              border-left: 3px solid var(--color-accent);
              background: rgba(197, 168, 128, 0.08);
              border-radius: 2px;
            ">
              <p style="
                margin: 0 0 0.25rem 0;
                font-family: var(--font-body);
                font-size: 0.7rem;
                letter-spacing: 0.12em;
                text-transform: uppercase;
                color: var(--color-accent);
              ">Studio Message</p>
              <p style="margin: 0; font-size: 0.92rem; line-height: 1.45;">
                ${escapeHtmlForDisplay(orderData.deliveryNotes)}
              </p>
            </div>
          `;
        }

        const studioDispatchNote = `<p class="studio-dispatch-note">${
          orderData.deliveryNotes
            ? `<strong>Delivery Log:</strong> ${escapeHtmlForDisplay(orderData.deliveryNotes)}`
            : "Your garment is being meticulously curated at the studio cutting desk."
        }</p>`;

        ordersHtml += `
          <div class="client-order-row-card">
            <div class="client-order-top-row">
              ${thumbnailHtml}
              <div class="client-order-meta">
                <span class="badge-order-id">SB-${shortId}</span>
                <h4 class="client-order-title">${orderTitle}</h4>
                <p class="client-order-textile">${orderSubline}</p>
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
      });

      ordersStreamBox.innerHTML = ordersHtml;
    }, (err) => {
      console.error("Client side snapshot connection drop error:", err);
      ordersStreamBox.innerHTML = `<p class="error-text">Failed to establish active updates link with streaming servers.<br><small>${err.code || ''}: ${err.message || err}</small></p>`;
    });

    // Real-time studio support chat — floating glass launcher, single thread
    initClientChat(uid, profileData.email);

  } catch (error) {
    console.error("Failure constructing client dashboard layout sheets:", error);
    mainContent.innerHTML = `<p class="error-text" style="text-align:center; padding:5rem;">Dashboard load error. Please refresh.</p>`;
  }
}

/**
 * Renders the administrative Tailor Shop Terminal with:
 * - Phase 3: Inventory Matrix (collections) with multi-size pricing form + live stream
 * - Existing: Master orders queue with status/billing dropdowns
 */
function mountTailorShopTerminal() {
  const mainContent = document.getElementById("main-content");
  if (!mainContent) return;

  mainContent.innerHTML = `
    <div class="admin-wrapper">
      <div class="admin-banner-row">
        <div>
          <h1 class="admin-panel-title">Tailor Shop Operations Terminal</h1>
          <p class="admin-panel-sub">Live structural command center for matching active blueprints to production lines.</p>
        </div>
      </div>

      <!-- ═══════════════════════════════════════════════
           READY-TO-WEAR BOUTIQUE ORDERS — MODAL LAUNCH CARD
           Clicking opens .admin-glass-modal-backdrop (built by
           openBoutiqueOrdersModal below) rather than swapping the ledger
           view inline. The badge reflects the live RTW order count that
           mountFinancialSummaryMatrix() already computes on every snapshot.
           ═══════════════════════════════════════════════ -->
      <div class="admin-summary-grid" style="display: flex; gap: 1rem; margin-bottom: 1.75rem;">
        <button
          type="button"
          id="rtw-toggle-card"
          class="admin-summary-card rtw-summary-card"
        >
          <span class="rtw-summary-card-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"></path>
              <path d="M3 6h18"></path>
              <path d="M16 10a4 4 0 0 1-8 0"></path>
            </svg>
          </span>
          <span id="rtw-toggle-badge" class="rtw-toggle-badge" style="display: none;">0</span>
          <span class="rtw-summary-card-body">
            <span class="rtw-summary-card-eyebrow">Boutique Orders</span>
            <span class="rtw-summary-card-title">Ready-To-Wear Boutique Orders</span>
            <span class="rtw-summary-card-hint">Tap to view incoming retail orders</span>
          </span>
          <span class="rtw-summary-card-arrow" aria-hidden="true">&#8594;</span>
        </button>
      </div>

      <!-- ═══════════════════════════════════════════════
           PHASE 3: INVENTORY MATRIX MODULE
           ═══════════════════════════════════════════════ -->
      <div class="inventory-matrix-panel">
        <div class="inventory-panel-header">
          <div>
            <h2 class="inventory-panel-title">Collection Inventory Matrix</h2>
            <p class="inventory-panel-sub">Provision garment collections with size-specific pricing. All changes stream live to the public Lookbook.</p>
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
              <label for="inv-image-url">Garment Image URL</label>
              <input type="url" id="inv-image-url" placeholder="https://...image.jpg" required>
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
      </div>

      <!-- ═══════════════════════════════════════════════
           PHASE 5: ANALYTICS LEDGER HUB
           Financial Summary Matrix — real-time metric blocks
           Positioned directly above the order stream panels.
           Values hydrated by mountFinancialSummaryMatrix()
           which runs a full-collection onSnapshot over "orders".
           ═══════════════════════════════════════════════ -->
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

        <!-- Metric Block 1: Gross Studio Revenue -->
        <div class="fin-metric-block" style="
          background: var(--color-primary);
          padding: 1.4rem 1.6rem;
          position: relative;
          overflow: hidden;
        ">
          <div style="
            position: absolute;
            top: 0; right: 0;
            width: 3px;
            height: 100%;
            background: var(--color-accent);
            opacity: 0.65;
          "></div>
          <p style="
            margin: 0 0 0.55rem 0;
            font-family: var(--font-body);
            font-size: 0.65rem;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--color-accent);
            opacity: 0.9;
          ">Gross Studio Revenue</p>
          <p id="fin-metric-revenue" style="
            margin: 0 0 0.3rem 0;
            font-family: var(--font-heading);
            font-size: 2.1rem;
            font-weight: 500;
            color: #ffffff;
            letter-spacing: -0.01em;
            line-height: 1;
            transition: color 0.4s ease;
          ">—</p>
          <p style="
            margin: 0;
            font-family: var(--font-body);
            font-size: 0.68rem;
            color: rgba(255,255,255,0.35);
            letter-spacing: 0.05em;
          ">Cumulative across all order documents</p>
        </div>

        <!-- Metric Block 2: Active Bespoke Commissions -->
        <div class="fin-metric-block" style="
          background: var(--color-primary);
          padding: 1.4rem 1.6rem;
          position: relative;
          overflow: hidden;
        ">
          <div style="
            position: absolute;
            top: 0; right: 0;
            width: 3px;
            height: 100%;
            background: var(--color-accent);
            opacity: 0.65;
          "></div>
          <p style="
            margin: 0 0 0.55rem 0;
            font-family: var(--font-body);
            font-size: 0.65rem;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--color-accent);
            opacity: 0.9;
          ">Active Bespoke Commissions</p>
          <p id="fin-metric-bespoke" style="
            margin: 0 0 0.3rem 0;
            font-family: var(--font-heading);
            font-size: 2.1rem;
            font-weight: 500;
            color: #ffffff;
            letter-spacing: -0.01em;
            line-height: 1;
            transition: color 0.4s ease;
          ">—</p>
          <p style="
            margin: 0;
            font-family: var(--font-body);
            font-size: 0.68rem;
            color: rgba(255,255,255,0.35);
            letter-spacing: 0.05em;
          ">Orders where type &#8800; Ready-To-Wear</p>
        </div>

        <!-- Metric Block 3: Boutique Units Dispatched -->
        <div class="fin-metric-block" style="
          background: var(--color-primary);
          padding: 1.4rem 1.6rem;
          position: relative;
          overflow: hidden;
        ">
          <div style="
            position: absolute;
            top: 0; right: 0;
            width: 3px;
            height: 100%;
            background: var(--color-accent);
            opacity: 0.65;
          "></div>
          <p style="
            margin: 0 0 0.55rem 0;
            font-family: var(--font-body);
            font-size: 0.65rem;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--color-accent);
            opacity: 0.9;
          ">Boutique Units Dispatched</p>
          <p id="fin-metric-rtw" style="
            margin: 0 0 0.3rem 0;
            font-family: var(--font-heading);
            font-size: 2.1rem;
            font-weight: 500;
            color: #ffffff;
            letter-spacing: -0.01em;
            line-height: 1;
            transition: color 0.4s ease;
          ">—</p>
          <p style="
            margin: 0;
            font-family: var(--font-body);
            font-size: 0.68rem;
            color: rgba(255,255,255,0.35);
            letter-spacing: 0.05em;
          ">Orders where type = Ready-To-Wear</p>
        </div>

      </div>

      <!-- ═══════════════════════════════════════════════
           EXISTING: MASTER ORDER LEDGER QUEUE
           ═══════════════════════════════════════════════ -->
      <div class="admin-orders-section">
        <h2 class="inventory-panel-title" style="margin-bottom: 0.5rem;">Commission Order Ledger</h2>
        <p class="inventory-panel-sub" style="margin-bottom: 2rem;">All client bespoke submissions streaming live from the production database.</p>
        <div id="admin-orders-stream" class="admin-stream-container">
          <p class="loading-text">Subscribing to master order ledgers...</p>
        </div>
      </div>

    </div>
  `;

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
  });

  // ── INVENTORY CREATION SUBMIT ──
  const addCollectionForm = document.getElementById("add-collection-form");
  addCollectionForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const collectionName = document.getElementById("inv-collection-name").value.trim();
    const silhouetteSlug = document.getElementById("inv-silhouette-slug").value;
    const imageUrl = document.getElementById("inv-image-url").value.trim();
    const subtitle = document.getElementById("inv-subtitle").value.trim();

    const priceS   = parseFloat(document.getElementById("inv-price-S").value)   || 0;
    const priceM   = parseFloat(document.getElementById("inv-price-M").value)   || 0;
    const priceL   = parseFloat(document.getElementById("inv-price-L").value)   || 0;
    const priceXL  = parseFloat(document.getElementById("inv-price-XL").value)  || 0;
    const priceXXL = parseFloat(document.getElementById("inv-price-XXL").value) || 0;

    if (!collectionName || !silhouetteSlug || !imageUrl) {
      showAtelierNotification("Please complete all required collection fields.", "error");
      return;
    }
    if (priceM <= 0 || priceL <= 0) {
      showAtelierNotification("Prices for M and L sizes are required.", "error");
      return;
    }

    const submitBtn = addCollectionForm.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    submitBtn.textContent = "Registering Collection...";

    try {
      const collectionPayload = {
        collectionName,
        silhouetteSlug,
        imageUrl,
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

      await addDoc(collection(db, "collections"), collectionPayload);

      showAtelierNotification(`Collection "${collectionName}" locked into the live registry.`);
      addCollectionForm.reset();
      addDrawer.style.display = "none";
      toggleBtn.querySelector("span").textContent = "+ Add New Collection";
    } catch (err) {
      console.error("Collection write failure:", err);
      showAtelierNotification("Registry write rejected. Check permissions.", "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Lock Collection to Registry";
    }
  });

  // ── LIVE INVENTORY STREAM (onSnapshot → collections) ──
  mountInventoryStream();

  // ── PHASE 5: ANALYTICS LEDGER HUB — Financial Summary Matrix ──
  // Subscribes to the full "orders" collection in real time. Derives
  // grossRevenue (sum of finalPrice), bespokeCount (orderType != RTW),
  // and rtwCount (orderType == RTW) on every snapshot and pushes live
  // values into the three metric DOM nodes injected in the HTML above.
  mountFinancialSummaryMatrix();

  // ── LIVE ORDERS STREAM (defaults to Bespoke view) ──
  mountOrdersStream("bespoke");

  // ── READY-TO-WEAR BOUTIQUE ORDERS — MODAL LAUNCH WIRING ──
  // The master ledger below now permanently shows the Bespoke Commission
  // Ledger; this card no longer swaps that view in place. Clicking it opens
  // the dedicated glass, scrollable Boutique Orders modal instead.
  const rtwToggleCard = document.getElementById("rtw-toggle-card");
  if (rtwToggleCard) {
    rtwToggleCard.addEventListener("click", () => {
      openBoutiqueOrdersModal();
    });
  }

  // Real-time client messages — floating glass launcher, multi-conversation inbox
  initAdminChat();
}

// ─────────────────────────────────────────────────────────────────────────────
// READY-TO-WEAR BOUTIQUE ORDERS MODAL
//
// A frosted-glass, scrollable overlay that streams live Ready-To-Wear orders
// (placed against actual stocked inventory in the public Lookbook, as
// opposed to bespoke measurement commissions). Built once on first open and
// reused on subsequent opens; the Firestore listener itself is torn down
// every time the modal closes so it isn't billing reads while hidden.
// ─────────────────────────────────────────────────────────────────────────────

/** Builds and appends the modal shell to <body> if it isn't already there. */
function ensureBoutiqueOrdersModalShell() {
  if (document.getElementById("boutique-orders-modal-backdrop")) return;

  const shell = document.createElement("div");
  shell.innerHTML = `
    <div
      class="admin-glass-modal-backdrop"
      id="boutique-orders-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Ready-To-Wear Boutique Orders"
      aria-hidden="true"
    >
      <div class="admin-glass-modal">
        <div class="admin-glass-modal-header">
          <div>
            <p class="admin-glass-modal-eyebrow">Ready-To-Wear</p>
            <h2 class="admin-glass-modal-title">Boutique Orders</h2>
            <p class="admin-glass-modal-sub">Incoming retail orders placed against stocked Lookbook inventory — shipping details and dispatch messaging.</p>
          </div>
          <button class="admin-glass-modal-close" id="boutique-orders-modal-close" aria-label="Close boutique orders">&times;</button>
        </div>
        <div class="admin-glass-modal-body" id="boutique-orders-modal-stream">
          <p class="loading-text">Subscribing to boutique order ledgers...</p>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(shell.firstElementChild);

  const backdrop = document.getElementById("boutique-orders-modal-backdrop");
  const closeBtn = document.getElementById("boutique-orders-modal-close");

  closeBtn.addEventListener("click", closeBoutiqueOrdersModal);

  // Click the dimmed backdrop (not the glass card itself) to dismiss
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeBoutiqueOrdersModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && backdrop.classList.contains("is-active")) {
      closeBoutiqueOrdersModal();
    }
  });
}

/** Opens the modal and (re)subscribes the live RTW orders stream into it. */
function openBoutiqueOrdersModal() {
  ensureBoutiqueOrdersModalShell();

  const backdrop = document.getElementById("boutique-orders-modal-backdrop");
  const streamEl = document.getElementById("boutique-orders-modal-stream");
  if (!backdrop || !streamEl) return;

  backdrop.classList.add("is-active");
  backdrop.setAttribute("aria-hidden", "false");
  document.body.classList.add("atelier-drawer-open"); // reuses the existing scroll-lock utility

  streamEl.innerHTML = `<p class="loading-text">Subscribing to boutique order ledgers...</p>`;
  mountReadyToWearOrdersStream(streamEl);
}

/** Closes the modal and tears down its Firestore listener. */
function closeBoutiqueOrdersModal() {
  const backdrop = document.getElementById("boutique-orders-modal-backdrop");
  if (backdrop) {
    backdrop.classList.remove("is-active");
    backdrop.setAttribute("aria-hidden", "true");
  }
  document.body.classList.remove("atelier-drawer-open");

  if (window.activeRtwModalUnsubscribe) {
    window.activeRtwModalUnsubscribe();
    window.activeRtwModalUnsubscribe = null;
  }
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

    // Keep the Boutique Orders launch card's badge in sync with the same
    // count — no separate listener needed, this snapshot already has it.
    const badgeEl = document.getElementById("rtw-toggle-badge");
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

        e.currentTarget.disabled = true;
        e.currentTarget.textContent = "Removing...";

        try {
          await deleteDoc(doc(db, "collections", itemId));
          // Sleek success notification on complete deletion
          showAtelierNotification(`"${itemName}" has been cleanly removed from the registry.`);
          // The live onSnapshot listener automatically removes the card from the DOM.
        } catch (err) {
          console.error("Collection deletion failure:", err);
          showAtelierNotification("Deletion rejected by the server. Check permissions.", "error");
          e.currentTarget.disabled = false;
          e.currentTarget.textContent = "Remove from Registry";
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

    let adminHtmlBlock = "";
    bespokeDocs.forEach((orderDoc) => {
      const data = orderDoc.data();
      const orderId = orderDoc.id;
      const idShort = orderId.substring(0, 8).toUpperCase();
      const activeStatus = data.commissionStatus || "Pending Studio Review";
      const billingStatus = data.financialStatus || "Awaiting Invoice";
      const metrics = data.tailoringMetrics || {};

      adminHtmlBlock += `
        <div class="admin-order-card" data-order-id="${orderId}">
          <div class="admin-order-row">
            <div class="admin-meta-cell">
              <span class="admin-id-tag">SB-${idShort}</span>
              <p class="admin-client-email">${data.clientEmail || 'Anonymous Guest'}</p>
            </div>
            <div class="admin-details-cell">
              <h4>${formatGarmentName(data.configuration?.silhouette)}</h4>
              <p class="textile-desc">Textile: ${formatTextileName(data.configuration?.textileProfile)}</p>
              <button class="btn-inspect-metrics" data-target="drawer-${orderId}">Inspect Specs</button>
            </div>
            <div class="admin-pipeline-group-cell">
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
          </div>

          <div id="drawer-${orderId}" class="admin-metrics-drawer" style="display: none;">
            <div class="drawer-inner-grid">
              <div class="metric-pill"><span>Neck:</span> <strong>${metrics.neck || '--'} cm</strong></div>
              <div class="metric-pill"><span>Chest:</span> <strong>${metrics.chest || '--'} cm</strong></div>
              <div class="metric-pill"><span>Shoulder:</span> <strong>${metrics.shoulder || '--'} cm</strong></div>
              <div class="metric-pill"><span>Sleeve:</span> <strong>${metrics.sleeve || '--'} cm</strong></div>
              <div class="metric-pill"><span>Waist:</span> <strong>${metrics.waist || '--'} cm</strong></div>
              <div class="metric-pill"><span>Hips:</span> <strong>${metrics.hips || '--'} cm</strong></div>
              <div class="metric-pill"><span>Outseam:</span> <strong>${metrics.outseam || '--'} cm</strong></div>
              <div class="metric-pill"><span>Inseam:</span> <strong>${metrics.inseam || '--'} cm</strong></div>
            </div>
          </div>
        </div>
      `;
    });

    adminStream.innerHTML = adminHtmlBlock;

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

    let rtwHtmlBlock = "";
    snapshot.forEach((orderDoc) => {
      const data = orderDoc.data();
      const docId = orderDoc.id;
      const orderId = docId;
      const idShort = orderId.substring(0, 8).toUpperCase();
      const activeStatus = data.commissionStatus || "Pending Studio Review";
      const billingStatus = data.financialStatus || "Awaiting Invoice";

      // High-precision luxury fallback parameters
      const collectionName = data.collectionName || "Boutique Selected Apparel";
      const selectedSize = data.selectedSize || "M";
      const clientEmail = data.clientEmail || "Anonymous Patron";
      const shippingAddress = data.shippingAddress || data.deliveryAddress || "No shipping profile logged";
      const clientContact = data.contactNumber || data.phoneNumber || data.customerPhone || "No contact record";
      const apparelImage = data.apparelImage || data.imageUrl || "images/placeholder-garment.jpg";
      const deliveryNotes = typeof data.deliveryNotes === "string" ? data.deliveryNotes : "";

      const contactNumber = clientContact;
      const existingNotes = deliveryNotes;

      const thumbnailHtml = apparelImage
        ? `<img src="${apparelImage}" alt="${collectionName}" loading="lazy"
             style="width:60px;height:60px;object-fit:cover;border:1px solid var(--color-accent);padding:2px;background:#111;border-radius:2px;flex-shrink:0;">`
        : `<div style="width:60px;height:60px;border:1px solid var(--color-accent);background:#111;border-radius:2px;flex-shrink:0;"></div>`;

      rtwHtmlBlock += `
        <div class="admin-order-card rtw-order-card" data-order-id="${orderId}">
          <div class="admin-order-row">
            <div class="admin-meta-cell" style="display:flex; gap:0.75rem; align-items:flex-start;">
              ${thumbnailHtml}
              <div>
                <span class="admin-id-tag">SB-${idShort}</span>
                <p class="admin-client-email">${escapeHtmlForDisplay(clientEmail)}</p>
                <p class="rtw-contact-line" style="margin:0.15rem 0 0 0; font-size:0.85rem; opacity:0.85;">
                  📞 ${escapeHtmlForDisplay(contactNumber)}
                </p>
                <p class="rtw-address-line" style="margin:0.1rem 0 0 0; font-size:0.8rem; opacity:0.7; max-width:220px;">
                  📦 ${escapeHtmlForDisplay(shippingAddress)}
                </p>
              </div>
            </div>

            <div class="admin-details-cell">
              <h4>${escapeHtmlForDisplay(collectionName)}</h4>
              <p class="textile-desc">Size: ${escapeHtmlForDisplay(selectedSize)}</p>
            </div>

            <div class="admin-pipeline-group-cell">
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

              <!-- TASK 2: Delivery Dispatch Input Matrix -->
              <div class="admin-pipeline-cell rtw-dispatch-cell" style="display:flex; gap:0.5rem; align-items:center; margin-top:0.5rem;">
                <input
                  type="text"
                  class="rtw-delivery-dispatcher"
                  data-id="${orderId}"
                  placeholder="e.g., Dispatched via courier. Arrival Friday morning."
                  value="${escapeHtmlForAttribute(existingNotes)}"
                  style="flex:1; min-width:180px; padding:0.45rem 0.6rem; border:1px solid var(--color-border-slate); border-radius:2px; font-family: var(--font-body); font-size:0.85rem;"
                >
                <button
                  type="button"
                  class="btn-send-delivery-note"
                  data-id="${orderId}"
                  style="
                    background: var(--color-accent);
                    color: var(--color-primary);
                    border: none;
                    border-radius: 2px;
                    padding: 0.45rem 0.9rem;
                    font-size: 0.8rem;
                    font-weight: 600;
                    letter-spacing: 0.04em;
                    cursor: pointer;
                    flex-shrink: 0;
                  "
                >Send</button>
              </div>
            </div>
          </div>
        </div>
      `;
    });

    adminStream.innerHTML = rtwHtmlBlock;

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
 * Escapes text for safe injection into an HTML attribute (e.g. an
 * input's value="..." attribute), additionally escaping quote characters.
 */
function escapeHtmlForAttribute(rawText) {
  return escapeHtmlForDisplay(rawText).replace(/"/g, "&quot;");
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