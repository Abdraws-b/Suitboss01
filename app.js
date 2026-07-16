import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-analytics.js";
import {
  getFirestore,
  collection,
  query,
  orderBy,
  onSnapshot,
  doc,
  getDoc,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { initAuthEngine } from "./auth.js";
import { initOrderCommissionEngine } from "./order-engine.js";
import { mountAtelierDashboard } from "./dashboard.js";
import { showAtelierNotification } from "./ui-feedback.js";

// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE CONFIGURATION MATRIX
// ─────────────────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDfovlZutG1amXRQCimaMv3cRxzuQEl2oA",
  authDomain: "suitboss.firebaseapp.com",
  projectId: "suitboss",
  storageBucket: "suitboss.firebasestorage.app",
  messagingSenderId: "705673809150",
  appId: "1:705673809150:web:403cde069eacacde6fa9af",
  measurementId: "G-4DH8EEGYLR",
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);

export const auth = getAuth(app);
export const db = getFirestore(app);

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL UNSUBSCRIBE HANDLES
// ─────────────────────────────────────────────────────────────────────────────
let activeBlueprintUnsubscribe = null;
let activeLookbookUnsubscribe  = null;

// ─────────────────────────────────────────────────────────────────────────────
// AUDIO SESSION GUARD KEY
// Canonical sessionStorage key for the per-login voice welcome gate.
// — Persists across SPA hash-route switches within the same browser tab.
// — Resets automatically when the tab is closed (sessionStorage lifecycle).
// — Cleared explicitly on logout so every fresh login re-triggers the announcement
//   even within the same tab session.
// ─────────────────────────────────────────────────────────────────────────────
const AUDIO_GUARD_KEY = "suitboss_audio_welcome_dispatched";

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE HAMBURGER + GLASS DRAWER CONTROLLER
//
// Every lookup here is guarded, so this quietly no-ops on any page that
// doesn't render the trigger/drawer markup — safe to call unconditionally
// from every page that loads app.js.
// ─────────────────────────────────────────────────────────────────────────────
function initMobileDrawer() {
  const toggle   = document.getElementById("atelier-hamburger-toggle");
  const drawer   = document.getElementById("atelier-mobile-drawer");
  const backdrop = document.getElementById("atelier-drawer-backdrop");

  if (!toggle || !drawer) return;

  function openDrawer() {
    toggle.classList.add("is-active");
    toggle.setAttribute("aria-expanded", "true");
    drawer.classList.add("drawer-active");
    drawer.setAttribute("aria-hidden", "false");
    if (backdrop) backdrop.classList.add("is-active");
    document.body.classList.add("atelier-drawer-open");
    document.body.style.overflow = "hidden"; // block underlying scroll bleed
  }

  function closeDrawer() {
    toggle.classList.remove("is-active");
    toggle.setAttribute("aria-expanded", "false");
    drawer.classList.remove("drawer-active");
    drawer.setAttribute("aria-hidden", "true");
    if (backdrop) backdrop.classList.remove("is-active");
    document.body.classList.remove("atelier-drawer-open");
    document.body.style.overflow = "";
  }

  toggle.addEventListener("click", () => {
    drawer.classList.contains("drawer-active") ? closeDrawer() : openDrawer();
  });

  if (backdrop) {
    backdrop.addEventListener("click", closeDrawer);
  }

  // Auto-dismiss the moment any internal nav/hash link inside the drawer
  // is triggered, so state views (e.g. #dashboard) mount cleanly underneath.
  drawer.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", closeDrawer);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer.classList.contains("drawer-active")) {
      closeDrawer();
    }
  });

  // Auto-collapse if the viewport is resized back up to desktop while open
  window.addEventListener("resize", () => {
    if (window.innerWidth > 768 && drawer.classList.contains("drawer-active")) {
      closeDrawer();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NAV ACTIVE STATE MANAGER
//
// Clears ALL .active classes — including any baked into HTML — then re-applies
// exclusively to the link matching the current URL page / hash.
//
// CUSTOM-ORDER.HTML VALIDATION LAYER:
//   When currentPage === "custom-order.html" an explicit sanitization pass fires:
//   • Strips .active from all lookbook section anchor links (#kaftans, #shirts …)
//   • Appends .active cleanly and exclusively onto the Bespoke Pre-Order anchor.
//   • Returns early — the general matching loop below never runs for this page.
// ─────────────────────────────────────────────────────────────────────────────
function syncNavActiveState() {
  const navLinks    = document.querySelectorAll(".nav-links a");
  const rawPage     = window.location.pathname.split("/").pop();
  const currentPage = rawPage === "" || rawPage === "/" ? "index.html" : rawPage;
  const currentHash = window.location.hash;

  // Section anchors that must never carry the active underline under any route
  const SECTION_ANCHORS = new Set([
    "#kaftans", "#shirts", "#support",
    "#measurement-guide", "#consultations",
  ]);

  // ── CUSTOM-ORDER.HTML EXPLICIT VALIDATION LAYER ───────────────────────────
  if (currentPage === "custom-order.html") {
    navLinks.forEach(link => {
      link.classList.remove("active");

      const href     = link.getAttribute("href") || "";
      const hrefHash = href.includes("#") ? "#" + href.split("#")[1] : "";

      // Section anchors must never be active here — strip and skip
      if (SECTION_ANCHORS.has(hrefHash)) return;

      // Exclusively activate the Bespoke Pre-Order anchor
      const hrefPage = href.split("/").pop().split("#")[0];
      if (hrefPage === "custom-order.html") {
        link.classList.add("active");
      }
    });
    return; // Validation complete — do not run general logic below
  }
  // ── END CUSTOM-ORDER.HTML VALIDATION LAYER ────────────────────────────────

  // General matching loop for all other pages / hash routes
  navLinks.forEach(link => {
    link.classList.remove("active"); // Unconditional wipe first

    const href     = link.getAttribute("href") || "";
    const hrefPage = href.split("/").pop().split("#")[0];
    const hrefHash = href.includes("#") ? "#" + href.split("#")[1] : "";

    // 1. Section anchor jumps — never active
    if (SECTION_ANCHORS.has(hrefHash)) return;

    // 2. SPA hash routes: #dashboard / #account
    if (hrefHash === "#dashboard" || hrefHash === "#account") {
      if (currentHash === "#dashboard" || currentHash === "#account") {
        link.classList.add("active");
      }
      return;
    }

    // 3. Standard page-level match
    //    Guard against currentHash so the Lookbook link doesn't re-activate
    //    while a dashboard hash is present on index.html.
    const targetPage = hrefPage || "index.html";
    if (targetPage === currentPage && !currentHash) {
      link.classList.add("active");
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SPA ROUTER
// ─────────────────────────────────────────────────────────────────────────────
function handleAppRouting(user) {
  const currentHash = window.location.hash;

  syncNavActiveState();

  if (currentHash === "#dashboard" || currentHash === "#account") {
    if (user) {
      mountAtelierDashboard(user.uid);
    } else {
      window.location.href = "auth.html";
    }
  } else if (!currentHash || currentHash === "" || currentHash === "#") {
    mountLookbookStream();
  } else {
    console.log("Alternate hash detected:", currentHash);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4: AUDIO SPATIAL WELCOME SYSTEM
//
// Triggers the Web Speech API welcome announcement for every authenticated user
// on their first interaction after login — exactly once per login session.
//
// HOW IT WORKS:
//   triggerWelcomeVoice() is called from inside onAuthStateChanged whenever a
//   user object is present AND the sessionStorage guard key is absent.
//
//   Because browsers block SpeechSynthesis.speak() until the user has made a
//   genuine interaction (click, keydown, etc.) on the page, the function
//   registers a one-time interaction listener the moment auth resolves. The
//   very next thing the user touches — whether that is clicking a nav link,
//   scrolling via keyboard, or tapping anywhere — fires the utterance.
//
//   The sessionStorage key is written BEFORE speak() executes so that concurrent
//   auth state evaluations, SPA hash-route switches, or rapid repeat clicks
//   cannot slip a second call through the gate.
//
// SESSION LIFECYCLE:
//   — Key is absent  → welcome fires, key is set.
//   — Key is present → function returns immediately; no replay.
//   — User logs out  → key is cleared by the logout handler.
//   — Tab closes     → sessionStorage resets automatically; next login fires fresh.
// ─────────────────────────────────────────────────────────────────────────────
function triggerWelcomeVoice() {
  // ── SESSION STORAGE VOICE GUARD ──────────────────────────────────────────
  const hasSpokenWelcome = sessionStorage.getItem(AUDIO_GUARD_KEY);
  if (hasSpokenWelcome) {
    // Already announced this login session — do not replay under any circumstance.
    return;
  }

  // Claim the guard immediately before any async work so no concurrent path
  // can slip through while the interaction listener is pending.
  sessionStorage.setItem(AUDIO_GUARD_KEY, "true");
  // ── END SESSION STORAGE VOICE GUARD ──────────────────────────────────────

  if (!window.speechSynthesis) return;

  // Inner delivery function — isolated so it can be called directly or via
  // the voiceschanged event without duplication.
  const deliverWelcomeUtterance = () => {
    const utterance = new SpeechSynthesisUtterance(
      "Welcome to Suit Boss Studio. Feel free to select from our meticulously crafted apparels."
    );

    // Prefer a premium English voice when available
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice =
      voices.find(v =>
        v.lang.startsWith("en") && (
          v.name.toLowerCase().includes("daniel")    ||
          v.name.toLowerCase().includes("karen")     ||
          v.name.toLowerCase().includes("samantha")  ||
          v.name.toLowerCase().includes("google uk") ||
          v.name.toLowerCase().includes("premium")
        )
      ) ||
      voices.find(v => v.lang.startsWith("en")) ||
      null;

    if (preferredVoice) utterance.voice = preferredVoice;

    utterance.rate   = 0.9;
    utterance.pitch  = 1.0;
    utterance.volume = 0.9;

    window.speechSynthesis.cancel(); // Clear any pending speech queue
    window.speechSynthesis.speak(utterance);
  };

  // Wrapper that resolves the voices-loaded concern before speaking.
  // Tries immediately; falls back to voiceschanged if the browser
  // hasn't populated the voice list yet (common on first page load).
  const speakWhenVoicesReady = () => {
    if (window.speechSynthesis.getVoices().length > 0) {
      deliverWelcomeUtterance();
    } else {
      window.speechSynthesis.addEventListener("voiceschanged", deliverWelcomeUtterance, { once: true });
    }
  };

  // ── INTERACTION GATE ─────────────────────────────────────────────────────
  // Browsers require a user gesture before SpeechSynthesis.speak() is allowed.
  // We register a one-time listener on the next genuine interaction event so
  // the welcome fires the very first time the logged-in user touches the page.
  // Using { once: true } ensures the listener self-removes after a single fire.
  //
  // Both "click" and "keydown" are captured so the announcement works whether
  // the user reaches for the mouse or navigates via keyboard.
  // ─────────────────────────────────────────────────────────────────────────
  const onFirstInteraction = () => {
    document.removeEventListener("click",   onFirstInteraction);
    document.removeEventListener("keydown", onFirstInteraction);
    speakWhenVoicesReady();
  };

  document.addEventListener("click",   onFirstInteraction, { once: true });
  document.addEventListener("keydown", onFirstInteraction, { once: true });

  // Also attempt an immediate speak in case the page already received an
  // interaction before auth resolved (e.g. user clicked the Login button,
  // then Firebase returned the user object synchronously within that same
  // event call stack). If the browser allows it, the utterance plays at once
  // and the interaction listeners above will be cleaned up harmlessly by
  // { once: true } on their next natural fire without speaking again because
  // speechSynthesis.cancel() + speak() is idempotent on an already-speaking queue.
  speakWhenVoicesReady();
}

// ─────────────────────────────────────────────────────────────────────────────
// TASK 3A — READY-TO-WEAR GLASS CHECKOUT MODAL
//
// openRTWCheckoutModal(docId, collectionName, selectedSize, finalPrice, apparelImage)
// Populates the #ready-order-modal-portal with a frosted glass modal overlay
// containing:
//   - Full Shipping Address (textarea)
//   - Contact Phone (input)
//   - Non-editable confirmation of Selected Size and Dynamic Price
// On submit, writes the exact order document schema to "orders".
// On success: hides modal, fires toast notification, fires Web Speech voice agent.
// ─────────────────────────────────────────────────────────────────────────────
function openRTWCheckoutModal(docId, collectionName, selectedSize, finalPrice, apparelImage) {
  const portal = document.getElementById("ready-order-modal-portal");
  if (!portal) return;

  portal.innerHTML = `
    <div class="atelier-glass-modal-backdrop" id="rtw-modal-backdrop" role="dialog" aria-modal="true" aria-label="Complete Your Order">
      <div class="atelier-glass-modal-card">

        <div class="rtw-modal-header">
          <p class="rtw-modal-eyebrow">Ready-To-Wear</p>
          <h2 class="rtw-modal-title">${collectionName}</h2>
          <button class="rtw-modal-close" id="rtw-modal-close" aria-label="Close checkout">&times;</button>
        </div>

        <div class="rtw-modal-confirmation-row">
          <div class="rtw-confirmation-chip">
            <span class="rtw-chip-label">Selected Size</span>
            <span class="rtw-chip-value">${selectedSize}</span>
          </div>
          <div class="rtw-confirmation-chip">
            <span class="rtw-chip-label">Total Price</span>
            <span class="rtw-chip-value rtw-price-value">GH₵ ${Number(finalPrice).toLocaleString()}</span>
          </div>
        </div>

        <div class="rtw-modal-form">
          <div class="rtw-field">
            <label for="rtw-address" class="rtw-label">Full Shipping Address</label>
            <textarea
              id="rtw-address"
              class="rtw-input rtw-textarea"
              placeholder="Street, City, Region, Country"
              rows="3"
              required
            ></textarea>
          </div>

          <div class="rtw-field">
            <label for="rtw-phone" class="rtw-label">Contact Phone Number</label>
            <input
              type="tel"
              id="rtw-phone"
              class="rtw-input"
              placeholder="+233 XX XXX XXXX"
              required
            >
          </div>

          <button class="rtw-modal-submit" id="rtw-modal-submit">
            Confirm & Place Order
          </button>
        </div>

        <p class="rtw-modal-security-note">Your order is secured and encrypted. The studio will contact you within 24 hours.</p>
      </div>
    </div>
  `;

  portal.style.display = "block";

  // ── Close button ──
  document.getElementById("rtw-modal-close").addEventListener("click", () => {
    closeRTWCheckoutModal();
  });

  // ── Click backdrop to dismiss ──
  document.getElementById("rtw-modal-backdrop").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeRTWCheckoutModal();
  });

  // ── FORM SUBMIT HANDLER ──────────────────────────────────────────────────────
  document.getElementById("rtw-modal-submit").addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user) {
      showAtelierNotification("You must be signed in to place an order.", "error");
      return;
    }

    const shippingAddress = document.getElementById("rtw-address").value.trim();
    const contactPhone    = document.getElementById("rtw-phone").value.trim();

    if (!shippingAddress) {
      showAtelierNotification("Please enter your full shipping address.", "error");
      return;
    }
    if (!contactPhone) {
      showAtelierNotification("Please enter your contact phone number.", "error");
      return;
    }

    const submitBtn = document.getElementById("rtw-modal-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Processing Order...";

    try {
      const orderPayload = {
        clientId:              user.uid,
        clientEmail:           user.email,
        orderType:             "Ready-To-Wear",
        collectionItemId:      docId,
        collectionName:        collectionName,
        selectedSize:          selectedSize,
        finalPrice:            Number(finalPrice),
        apparelImage:          apparelImage || null,
        shippingAddress:       shippingAddress,
        contactPhone:          contactPhone,
        commissionStatus:      "Pending Studio Review",
        financialStatus:       "Awaiting Invoice",
        orderCreatedTimestamp: serverTimestamp(),
      };

      await addDoc(collection(db, "orders"), orderPayload);

      closeRTWCheckoutModal();
      showAtelierNotification("Your order has been beautifully received. Check your dashboard for live production status.");

      // Post-order voice confirmation (separate from the login welcome — not gated)
      if (window.speechSynthesis) {
        const orderUtterance = new SpeechSynthesisUtterance(
          "Your order has been beautifully received. The production timeline status is now active on your dashboard."
        );

        const voices = window.speechSynthesis.getVoices();
        const preferredVoice =
          voices.find(v =>
            v.lang.startsWith("en") && (
              v.name.toLowerCase().includes("daniel")    ||
              v.name.toLowerCase().includes("karen")     ||
              v.name.toLowerCase().includes("samantha")  ||
              v.name.toLowerCase().includes("google uk") ||
              v.name.toLowerCase().includes("premium")
            )
          ) ||
          voices.find(v => v.lang.startsWith("en")) ||
          null;

        if (preferredVoice) orderUtterance.voice = preferredVoice;

        orderUtterance.rate   = 0.88;
        orderUtterance.pitch  = 1.0;
        orderUtterance.volume = 0.95;

        window.speechSynthesis.cancel();

        if (voices.length > 0) {
          window.speechSynthesis.speak(orderUtterance);
        } else {
          window.speechSynthesis.addEventListener("voiceschanged", () => {
            window.speechSynthesis.speak(orderUtterance);
          }, { once: true });
        }
      }

    } catch (err) {
      console.error("RTW order write failure:", err);
      showAtelierNotification("Order could not be placed. Please try again.", "error");
      submitBtn.disabled = false;
      submitBtn.textContent = "Confirm & Place Order";
    }
  });
}

/**
 * Hides and empties the modal portal cleanly.
 */
function closeRTWCheckoutModal() {
  const portal = document.getElementById("ready-order-modal-portal");
  if (!portal) return;
  portal.style.display = "none";
  portal.innerHTML = "";
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 4: LIVE LOOKBOOK STREAM
// Replaces static HTML cards with a real-time onSnapshot from "collections".
// Dynamically renders cards with S/M/L/XL/XXL size toggles + live price switching.
//
// TASK 3B — Acquire Piece button injected into each card's size selector group.
// A single delegated click listener on the grid binds .btn-acquire-piece clicks,
// reads the active size + price from the card context, and calls openRTWCheckoutModal().
// ─────────────────────────────────────────────────────────────────────────────
function mountLookbookStream() {
  const atelierGrid = document.querySelector(".atelier-grid");
  if (!atelierGrid) return;

  // Clean up previous subscription if navigating back
  if (activeLookbookUnsubscribe) {
    activeLookbookUnsubscribe();
    activeLookbookUnsubscribe = null;
  }

  atelierGrid.innerHTML = `
    <div style="grid-column: 1/-1; padding: 5rem; text-align: center;">
      <p style="font-family: var(--font-body); font-size: var(--font-size-small); color: var(--color-accent); text-transform: uppercase; letter-spacing: 0.15em;">
        Synchronizing Collection Registries...
      </p>
    </div>
  `;

  const collectionsQuery = query(
    collection(db, "collections"),
    orderBy("lastUpdated", "desc")
  );

  activeLookbookUnsubscribe = onSnapshot(collectionsQuery, (snapshot) => {

    const ctaCard = `
      <article class="atelier-card"
        style="grid-column: span 4; background-color: var(--color-secondary); border-color: var(--color-secondary); color: var(--text-light); padding: 3rem 2.5rem; display: flex; flex-direction: column; justify-content: center;">
        <p style="color: var(--color-accent); text-transform: uppercase; font-size: var(--font-size-small); letter-spacing: 0.15em; margin-bottom: 1rem;">Made-To-Measure Engine</p>
        <h3 style="font-family: var(--font-heading); font-size: var(--font-size-h1); color:white; font-weight: 400; line-height: 1.2; margin-bottom: 1.5rem;">Commission Your Exact Proportions</h3>
        <p style="font-size: var(--font-size-body); font-weight: 300; opacity: 0.85; color:white; margin-bottom: 3rem; line-height: 1.6;">Skip generalized structural grids. Submit your precise physical measurement metrics and correspond directly with our master tailors.</p>
        <a href="custom-order.html" class="btn-premium-pill" style="align-self: flex-start; background-color: var(--color-accent); border-color: var(--color-accent); color: var(--color-primary);">Begin Proportions</a>
      </article>
    `;

    if (snapshot.empty) {
      atelierGrid.innerHTML = `
        <div style="grid-column: 1/-1; padding: 4rem 2rem; text-align: center; border: 1px dashed var(--color-border-slate);">
          <p style="font-family: var(--font-body); color: #7f8c8d;">The collection registry is being curated. Check back shortly.</p>
        </div>
        ${ctaCard}
      `;
      return;
    }

    let cardsHtml = "";
    snapshot.forEach((colDoc) => {
      const d     = colDoc.data();
      const docId = colDoc.id;

      if (d.stockStatus === "Out of Stock") return;

      const prices = d.prices || {};
      const sizes  = ["S", "M", "L", "XL", "XXL"];

      const defaultSize  = prices["M"] > 0 ? "M" : (sizes.find(s => (prices[s] || 0) > 0) || "M");
      const defaultPrice = prices[defaultSize] || 0;

      const sizeBtns = sizes.map(sz => {
        const hasPrice  = (prices[sz] || 0) > 0;
        const isDefault = sz === defaultSize;
        return `
          <button
            class="lookbook-size-btn${isDefault ? ' is-active' : ''}${!hasPrice ? ' is-unavailable' : ''}"
            data-size="${sz}"
            data-price="${prices[sz] || 0}"
            data-doc-id="${docId}"
            ${!hasPrice ? 'disabled aria-disabled="true"' : ''}
            aria-label="Select size ${sz}"
            aria-pressed="${isDefault}"
          >${sz}</button>
        `;
      }).join("");

      cardsHtml += `
        <article class="atelier-card" itemscope itemtype="https://schema.org/Product" data-collection-id="${docId}">
          <div class="product-media">
            <img
              src="${d.imageUrl || ''}"
              alt="${d.collectionName || 'Garment'}"
              itemprop="image"
              loading="lazy"
            >
          </div>
          <div class="product-details">
            <header class="product-meta-row">
              <div>
                <h3 itemprop="name" class="product-name">${d.collectionName || 'Unnamed Piece'}</h3>
                <p class="product-subtitle" style="color: var(--text-muted); font-size: var(--font-size-small);">${d.subtitle || ''}</p>
              </div>
              <span
                class="product-price lookbook-price-display"
                data-doc-id="${docId}"
                itemprop="offers"
                itemscope
                itemtype="https://schema.org/Offer"
              >
                <meta itemprop="priceCurrency" content="GHS">
                <span itemprop="price" class="lookbook-price-value">GH₵ ${defaultPrice.toLocaleString()}</span>
              </span>
            </header>

            <!-- product-action-footer: margin-top: auto (see main.css) pins the
                 size matrix, Acquire Piece button, and bespoke link to the
                 bottom of the card so buttons stay aligned row-to-row even
                 when the apparel description/subtitle above runs longer. -->
            <div class="product-action-footer">
              <fieldset style="border: none;">
                <legend style="font-size: var(--font-size-small); color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.5rem;">Size Matrix</legend>

                <div class="size-selector-group lookbook-size-group" data-doc-id="${docId}">
                  ${sizeBtns}
                </div>

                <button
                  class="btn-acquire-piece"
                  data-id="${docId}"
                  data-collection-name="${d.collectionName || 'Unnamed Piece'}"
                  data-apparel-image="${d.imageUrl || ''}"
                  data-default-size="${defaultSize}"
                  data-default-price="${defaultPrice}"
                >Acquire Piece</button>
              </fieldset>

              <a href="custom-order.html" class="lookbook-order-cta">Order Bespoke →</a>
            </div>
          </div>
        </article>
      `;
    });

    atelierGrid.innerHTML = cardsHtml + ctaCard;

    // ── Size switch click events ──────────────────────────────────────────────
    atelierGrid.querySelectorAll(".lookbook-size-group").forEach(group => {
      group.addEventListener("click", (e) => {
        const btn = e.target.closest(".lookbook-size-btn");
        if (!btn || btn.disabled) return;

        const docId    = btn.dataset.docId;
        const newPrice = parseFloat(btn.dataset.price) || 0;

        group.querySelectorAll(".lookbook-size-btn").forEach(b => {
          b.classList.remove("is-active");
          b.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("is-active");
        btn.setAttribute("aria-pressed", "true");

        // Animate price: fade-out → update → fade-in
        const priceEl = atelierGrid.querySelector(`.lookbook-price-display[data-doc-id="${docId}"] .lookbook-price-value`);
        if (priceEl) {
          priceEl.style.transition = "opacity 0.2s ease, transform 0.2s ease";
          priceEl.style.opacity    = "0";
          priceEl.style.transform  = "translateY(-4px)";

          setTimeout(() => {
            priceEl.textContent     = `GH₵ ${newPrice.toLocaleString()}`;
            priceEl.style.opacity   = "1";
            priceEl.style.transform = "translateY(0)";
          }, 200);
        }

        // Keep btn-acquire-piece data attributes in sync with selected size
        const card = group.closest(".atelier-card");
        if (card) {
          const acquireBtn = card.querySelector(".btn-acquire-piece");
          if (acquireBtn) {
            acquireBtn.dataset.defaultSize  = btn.dataset.size;
            acquireBtn.dataset.defaultPrice = newPrice;
          }
        }
      });
    });

    // ── TASK 3B: Acquire Piece delegated click listener ───────────────────────
    atelierGrid.addEventListener("click", (e) => {
      const acquireBtn = e.target.closest(".btn-acquire-piece");
      if (!acquireBtn) return;

      if (!auth.currentUser) {
        showAtelierNotification("Please sign in to acquire a piece.", "error");
        setTimeout(() => { window.location.href = "auth.html"; }, 1200);
        return;
      }

      const docId          = acquireBtn.dataset.id;
      const collectionName = acquireBtn.dataset.collectionName;
      const apparelImage   = acquireBtn.dataset.apparelImage || null;
      const selectedSize   = acquireBtn.dataset.defaultSize;
      const finalPrice     = parseFloat(acquireBtn.dataset.defaultPrice) || 0;

      if (!selectedSize || finalPrice <= 0) {
        showAtelierNotification("Please select an available size before acquiring.", "error");
        return;
      }

      openRTWCheckoutModal(docId, collectionName, selectedSize, finalPrice, apparelImage);
    });

  }, (error) => {
    console.error("Lookbook stream sync error:", error);
    const grid = document.querySelector(".atelier-grid");
    if (grid) {
      grid.innerHTML = `
        <div style="grid-column:1/-1; padding:4rem; text-align:center;">
          <p style="color:#e74c3c; font-size:0.9rem;">Collection feed temporarily unavailable. Please refresh.</p>
        </div>
      `;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ORCHESTRATION: DOMContentLoaded
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {

  // 1. Initialize Authorization Forms if present
  initAuthEngine();

  // 2. Initialize Order Commission Form if present
  if (document.getElementById("bespoke-proportion-form")) {
    initOrderCommissionEngine();
  }

  // 3. Sync nav active state immediately on page load.
  //    The custom-order.html validation layer fires here on cold load.
  syncNavActiveState();

  // 3b. Wire up the mobile hamburger + glass drawer (no-ops if absent)
  initMobileDrawer();

  // 4. Hash change router — re-run full active state sync on every navigation event
  window.addEventListener("hashchange", () => {
    syncNavActiveState();
    handleAppRouting(auth.currentUser);
  });

  // 5. Fire the lookbook stream immediately if the grid mount point is present
  if (document.querySelector(".atelier-grid")) {
    mountLookbookStream();
  }

  // 6. AUTH STATE OBSERVER — master orchestrator
  //
  //    onAuthStateChanged fires:
  //    a) On initial page load with the persisted user object (if already logged in)
  //    b) Immediately after a successful login completes
  //    c) After logout (user === null)
  //
  //    In cases (a) and (b), triggerWelcomeVoice() is called. The sessionStorage
  //    guard inside that function ensures the utterance only executes once per
  //    login session, regardless of how many times this observer fires.
  onAuthStateChanged(auth, (user) => {
    // Class-based, not ID-based: index.html and custom-order.html now render
    // TWO copies of each control (desktop .nav-links + the mobile drawer's
    // .drawer-nav-links). getElementById would only ever reach the first
    // match in the DOM, silently leaving the drawer's copy stuck in the
    // wrong state. querySelectorAll + forEach keeps every copy in sync.
    const authLinks  = document.querySelectorAll(".js-auth-link");
    const dashLinks  = document.querySelectorAll(".js-dash-link");
    const logoutBtns = document.querySelectorAll(".js-logout-btn");

    // Clean up blueprint snapshot on auth state changes
    if (activeBlueprintUnsubscribe) {
      activeBlueprintUnsubscribe();
      activeBlueprintUnsubscribe = null;
    }

    if (user) {
      console.log(`Authenticated entry secured for profile: ${user.email}`);

      authLinks.forEach(el  => el.style.display = "none");
      dashLinks.forEach(el  => el.style.display = "inline-block");
      logoutBtns.forEach(el => el.style.display = "inline-block");

      // ── VOICE WELCOME — fires once per login session ──────────────────────
      // triggerWelcomeVoice() contains the full sessionStorage gate. Calling it
      // here on every auth state resolution is intentional and safe: the guard
      // key check at the top of the function makes it a no-op if the welcome
      // has already played. On first call per login it schedules the utterance
      // for the very next user interaction to satisfy browser autoplay policy.
      triggerWelcomeVoice();
      // ── END VOICE WELCOME ─────────────────────────────────────────────────

      // Run routing check matching the current URL hash
      handleAppRouting(user);

      // Dynamic blueprint form population for custom-order.html
      if (document.getElementById("bespoke-proportion-form")) {
        const userDocRef = doc(db, "users", user.uid);
        activeBlueprintUnsubscribe = onSnapshot(userDocRef, (docSnap) => {
          if (docSnap.exists() && docSnap.data().measurementBlueprint) {
            const blueprint = docSnap.data().measurementBlueprint;
            const fieldMappings = {
              "measure-neck":     blueprint.neck,
              "measure-chest":    blueprint.chest,
              "measure-shoulder": blueprint.shoulder,
              "measure-sleeve":   blueprint.sleeve,
              "measure-waist":    blueprint.waist,
              "measure-hips":     blueprint.hips,
              "measure-outseam":  blueprint.outseam,
              "measure-inseam":   blueprint.inseam,
            };

            for (const [elementId, metricValue] of Object.entries(fieldMappings)) {
              const inputElement = document.getElementById(elementId);
              if (inputElement && metricValue !== null && document.activeElement !== inputElement) {
                inputElement.value = metricValue;
              }
            }
          }
        });
      }

    } else {
      console.log("No active atelier profile detected in memory scope.");
      authLinks.forEach(el  => el.style.display = "inline-block");
      dashLinks.forEach(el  => el.style.display = "none");
      logoutBtns.forEach(el => el.style.display = "none");

      // If signed out while on a secure hash route, return to lookbook root
      if (window.location.hash === "#dashboard" || window.location.hash === "#account") {
        window.location.hash = "";
      }

      syncNavActiveState();
    }
  });

  // 7. LOGOUT HANDLER — bind to every instance (desktop nav + mobile drawer)
  document.querySelectorAll(".js-logout-btn").forEach((logoutActionTrigger) => {
    logoutActionTrigger.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        await signOut(auth);
        showAtelierNotification("Securely signed out of the Atelier terminal sessions.");

        // ── AUDIO GUARD RESET ─────────────────────────────────────────────────
        // Clear the session storage flag so the welcome announcement fires again
        // on the next login within this same tab. Without this explicit removal,
        // sessionStorage would retain the flag for the lifetime of the tab and
        // a second login in the same tab would never hear the greeting.
        sessionStorage.removeItem(AUDIO_GUARD_KEY);
        // ── END AUDIO GUARD RESET ─────────────────────────────────────────────

        // Clear active nav state immediately on logout
        document.querySelectorAll(".nav-links a").forEach(a => a.classList.remove("active"));

        // Cancel lookbook stream subscription before redirect
        if (activeLookbookUnsubscribe) {
          activeLookbookUnsubscribe();
          activeLookbookUnsubscribe = null;
        }

        setTimeout(() => {
          window.location.href = "index.html";
        }, 1500);

      } catch (error) {
        console.error("Sign-out failure event:", error);
        showAtelierNotification("Authentication server rejected cancellation requests.", "error");
      }
    });
  });

});