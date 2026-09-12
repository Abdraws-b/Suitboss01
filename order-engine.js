import {
  collection,
  addDoc,
  doc,
  updateDoc,
  increment,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { auth, db, authReady } from "./app.js";
import { showAtelierNotification } from "./ui-feedback.js";

// Holds the validated measurement/garment selection between form submission
// and the checkout modal's confirmation — the actual Firestore write now
// only happens once name/contact/address/delivery-date are collected too,
// so this bridges the two steps without re-reading the (possibly already
// re-focused/edited) form fields a second time.
let pendingBespokeSubmission = null;

// ─────────────────────────────────────────────────────────────────────────────
// PROPORTION BLUEPRINT — field maps + label constants
// Centralizes the mapping between the form's input IDs and the data-model
// keys they feed. Both the Bespoke Order form (custom-order.html) and the
// dashboard's "My Profile" blueprint editor persist under this same key set,
// so any future field rename only has to happen here.
// ─────────────────────────────────────────────────────────────────────────────
const UPPER_BODY_FIELD_MAP = {
  neck: "measure-neck",
  chest: "measure-chest",
  acrossBackShoulder: "measure-across-back-shoulder",
  sleeveLength: "measure-sleeve-length",
  topLength: "measure-top-length",
  aroundArm: "measure-around-arm",
  wrist: "measure-wrist",
};

const LOWER_BODY_FIELD_MAP = {
  waist: "measure-waist",
  length: "measure-length",
  thigh: "measure-thigh",
  knee: "measure-knee",
  barAnkle: "measure-bar-ankle",
};

const MEASUREMENT_LABELS = {
  neck: "Neck",
  chest: "Chest",
  acrossBackShoulder: "Across Back / Shoulder",
  sleeveLength: "Sleeve Length",
  topLength: "Top Length",
  aroundArm: "Around Arm",
  wrist: "Wrist",
  waist: "Waist",
  length: "Length",
  thigh: "Thigh",
  knee: "Knee",
  barAnkle: "Bar/Ankle",
};

const CUSTOM_ATELIER_VALUE = "other";
const CUSTOM_STYLE_VALUE = "other";
const CUSTOM_FABRIC_VALUE = "other";

/**
 * Minimal HTML escaper for free-text values (custom silhouette/fabric names)
 * that get interpolated into the checkout modal's innerHTML. Mirrors
 * dashboard.js's escapeHtmlForDisplay so user-typed text can never break out
 * of its container or inject markup.
 */
function escapeHtmlForModal(rawText) {
  if (rawText === null || rawText === undefined) return "";
  return String(rawText)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Reads a group of measurement inputs (upper or lower body) off the live
 * DOM, using each input's own min/max attributes (already set in the HTML)
 * as the validity bounds rather than hardcoding a second copy of them here.
 * Rejects missing, non-numeric, and negative values. Decimal values are
 * allowed since the inputs already carry step="0.1".
 */
function collectMeasurementGroup(fieldMap) {
  const values = {};
  let firstError = null;

  for (const [metricKey, elementId] of Object.entries(fieldMap)) {
    const inputEl = document.getElementById(elementId);
    const label = MEASUREMENT_LABELS[metricKey] || metricKey;

    if (!inputEl) {
      values[metricKey] = null;
      continue;
    }

    const rawValue = inputEl.value;
    if (rawValue === "" || rawValue === null) {
      firstError = firstError || `Please enter your ${label} measurement.`;
      values[metricKey] = null;
      continue;
    }

    const numericValue = parseFloat(rawValue);
    if (Number.isNaN(numericValue) || numericValue < 0) {
      firstError = firstError || `Please enter a valid, non-negative measurement for ${label}.`;
      values[metricKey] = null;
      continue;
    }

    const minBound = inputEl.min !== "" ? parseFloat(inputEl.min) : null;
    const maxBound = inputEl.max !== "" ? parseFloat(inputEl.max) : null;
    if ((minBound !== null && numericValue < minBound) || (maxBound !== null && numericValue > maxBound)) {
      const rangeNote = minBound !== null && maxBound !== null ? ` (${minBound}cm - ${maxBound}cm)` : "";
      firstError = firstError || `Please enter a realistic ${label} measurement${rangeNote}.`;
      values[metricKey] = null;
      continue;
    }

    values[metricKey] = numericValue;
  }

  return { values, error: firstError };
}

/**
 * Wires the Atelier <select> to its "Other / Custom Atelier" text input:
 * shown + required only when the custom option is active, hidden + cleared
 * otherwise. Exported so the checkout/edit surfaces could reuse it later,
 * but currently only called from initOrderCommissionEngine.
 */
function syncCustomAtelierField() {
  const atelierSelect = document.getElementById("order-atelier");
  const customCell = document.getElementById("order-atelier-custom-cell");
  const customInput = document.getElementById("order-atelier-custom");
  if (!atelierSelect || !customCell || !customInput) return;

  const isCustom = atelierSelect.value === CUSTOM_ATELIER_VALUE;
  customCell.style.display = isCustom ? "" : "none";
  customInput.required = isCustom;
  if (!isCustom) customInput.value = "";
}

/**
 * Same wiring as syncCustomAtelierField, applied to the Apparel Silhouette
 * dropdown: reveals + requires the free-text "Custom Silhouette Name" field
 * only while "Other / Custom Silhouette" is selected.
 */
function syncCustomStyleField() {
  const styleSelect = document.getElementById("order-style");
  const customCell = document.getElementById("order-style-custom-cell");
  const customInput = document.getElementById("order-style-custom");
  if (!styleSelect || !customCell || !customInput) return;

  const isCustom = styleSelect.value === CUSTOM_STYLE_VALUE;
  customCell.style.display = isCustom ? "" : "none";
  customInput.required = isCustom;
  if (!isCustom) customInput.value = "";
}

/**
 * Same wiring again, for the Fabric Selection dropdown's "Custom Fabric
 * Name" field.
 */
function syncCustomFabricField() {
  const fabricSelect = document.getElementById("order-fabric");
  const customCell = document.getElementById("order-fabric-custom-cell");
  const customInput = document.getElementById("order-fabric-custom");
  if (!fabricSelect || !customCell || !customInput) return;

  const isCustom = fabricSelect.value === CUSTOM_FABRIC_VALUE;
  customCell.style.display = isCustom ? "" : "none";
  customInput.required = isCustom;
  if (!isCustom) customInput.value = "";
}

export function initOrderCommissionEngine() {
  const form = document.getElementById("bespoke-proportion-form");
  if (!form) return;

  // Atelier Specification: toggle the custom-name field's visibility any
  // time the Atelier selection changes, and run once up front so a
  // pre-selected "Other" option (e.g. browser form-restore on reload)
  // starts in the correct state.
  const atelierSelectEl = document.getElementById("order-atelier");
  if (atelierSelectEl) {
    atelierSelectEl.addEventListener("change", syncCustomAtelierField);
    syncCustomAtelierField();
  }

  // Apparel Silhouette + Fabric Selection: identical "Other" reveal pattern.
  const styleSelectEl = document.getElementById("order-style");
  if (styleSelectEl) {
    styleSelectEl.addEventListener("change", syncCustomStyleField);
    syncCustomStyleField();
  }

  const fabricSelectEl = document.getElementById("order-fabric");
  if (fabricSelectEl) {
    fabricSelectEl.addEventListener("change", syncCustomFabricField);
    syncCustomFabricField();
  }

  form.addEventListener("submit", async (e) => {
    // Prevent default submission behavior entirely to manage network calls manually
    e.preventDefault();

    // THE FIX: auth.js sends brand-new users straight to this page via a
    // hard window.location.href redirect immediately after signup — a full
    // page reload. On that fresh load, Firebase Auth hasn't necessarily
    // finished asynchronously rehydrating the session yet. Reading
    // auth.currentUser synchronously here could see null for someone who
    // WAS actually signed in, wrongly reject them with "Session validation
    // failed," and the order would never be created — the exact loophole
    // that kept this form from reaching the success page. authReady
    // resolves once Firebase has actually determined the real state, and
    // costs nothing to await on every submission after the first.
    await authReady;

    const currentUser = auth.currentUser;
    if (!currentUser) {
      showAtelierNotification(
        "Session validation failed. Please log in.",
        "error",
      );
      return;
    }

    // 1. Gather selected garment specs
    const styleInput = document.getElementById("order-style");
    const fabricInput = document.getElementById("order-fabric");

    // Skip process if user didn't complete atelier fields
    if (
      !styleInput ||
      !fabricInput ||
      !styleInput.value ||
      !fabricInput.value
    ) {
      showAtelierNotification(
        "Please configure your silhouette and fabric choices.",
        "error",
      );
      return;
    }

    // 2. Capture the Proportion Blueprint from the active form state —
    // grouped into Upper Body / Lower Body per the current measurement
    // parameters, using each input's own min/max bounds for validation.
    const upperBodyResult = collectMeasurementGroup(UPPER_BODY_FIELD_MAP);
    const lowerBodyResult = collectMeasurementGroup(LOWER_BODY_FIELD_MAP);

    const measurementValidationError = upperBodyResult.error || lowerBodyResult.error;
    if (measurementValidationError) {
      showAtelierNotification(measurementValidationError, "error");
      return;
    }

    const dimensionalBlueprint = {
      upperBody: upperBodyResult.values,
      lowerBody: lowerBodyResult.values,
    };

    // 3. Capture the Atelier Specification — the existing Atelier dropdown,
    // plus the "Other / Custom Atelier" free-text name when selected.
    const atelierSelect = document.getElementById("order-atelier");
    const customAtelierInput = document.getElementById("order-atelier-custom");

    if (!atelierSelect || !atelierSelect.value) {
      showAtelierNotification("Please select an Atelier.", "error");
      return;
    }

    const selectedAtelier = atelierSelect.value;
    let customAtelierName = null;

    if (selectedAtelier === CUSTOM_ATELIER_VALUE) {
      const enteredName = customAtelierInput ? customAtelierInput.value.trim() : "";
      if (!enteredName) {
        showAtelierNotification("Please enter your custom Atelier name.", "error");
        return;
      }
      customAtelierName = enteredName;
    }

    // 4. Capture the free-text Custom Silhouette / Custom Fabric names when
    // "Other" is selected in either dropdown — same validation shape as the
    // Custom Atelier field above.
    const customStyleInput = document.getElementById("order-style-custom");
    const customFabricInput = document.getElementById("order-fabric-custom");
    let customSilhouetteName = null;
    let customTextileName = null;

    if (styleInput.value === CUSTOM_STYLE_VALUE) {
      const enteredStyle = customStyleInput ? customStyleInput.value.trim() : "";
      if (!enteredStyle) {
        showAtelierNotification("Please enter your custom silhouette name.", "error");
        return;
      }
      customSilhouetteName = enteredStyle;
    }

    if (fabricInput.value === CUSTOM_FABRIC_VALUE) {
      const enteredFabric = customFabricInput ? customFabricInput.value.trim() : "";
      if (!enteredFabric) {
        showAtelierNotification("Please enter your custom fabric name.", "error");
        return;
      }
      customTextileName = enteredFabric;
    }

    // Measurements, Atelier Specification, and garment selection are all
    // validated — stash them and move to checkout instead of writing to
    // Firestore immediately. The actual order isn't created until the
    // checkout modal is confirmed.
    pendingBespokeSubmission = {
      dimensionalBlueprint,
      silhouette: styleInput.value,
      customSilhouetteName,
      textileProfile: fabricInput.value,
      customTextileName,
      atelierSpecification: {
        selectedAtelier,
        customAtelierName,
      },
    };

    openBespokeCheckoutModal();
  }); // Closes addEventListener
} // Closes initOrderCommissionEngine

// ─────────────────────────────────────────────────────────────────────────────
// CHECKOUT MODAL — collects name, contact, shipping address, and preferred
// delivery date before the commission is actually written. Reuses the exact
// modal/form classes already established for the Ready-To-Wear checkout
// (atelier-glass-modal-backdrop, rtw-modal-*, rtw-field, rtw-input, etc.) so
// this looks and behaves identically rather than introducing a second,
// slightly-different modal pattern into the codebase.
// ─────────────────────────────────────────────────────────────────────────────
function openBespokeCheckoutModal() {
  const portal = document.getElementById("bespoke-checkout-modal-portal");
  if (!portal || !pendingBespokeSubmission) return;

  const { silhouette, customSilhouetteName, textileProfile, customTextileName } = pendingBespokeSubmission;

  // Delivery date can't be set in the past — floor it at tomorrow, in the
  // visitor's own local date rather than UTC, so "today" matches what they
  // actually see on their own calendar.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const minDeliveryDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

  portal.innerHTML = `
    <div class="atelier-glass-modal-backdrop" id="bespoke-modal-backdrop" role="dialog" aria-modal="true" aria-label="Complete Your Commission">
      <div class="atelier-glass-modal-card">

        <div class="rtw-modal-header">
          <p class="rtw-modal-eyebrow">Bespoke Commission</p>
          <h2 class="rtw-modal-title">${escapeHtmlForModal(formatGarmentSlug(silhouette, customSilhouetteName))}</h2>
          <button class="rtw-modal-close" id="bespoke-modal-close" aria-label="Close checkout">&times;</button>
        </div>

        <div class="rtw-modal-confirmation-row">
          <div class="rtw-confirmation-chip">
            <span class="rtw-chip-label">Fabric</span>
            <span class="rtw-chip-value">${escapeHtmlForModal(formatTextileSlug(textileProfile, customTextileName))}</span>
          </div>
        </div>

        <div class="rtw-modal-form">
          <div class="rtw-field">
            <label for="bespoke-fullname" class="rtw-label">Full Name</label>
            <input
              type="text"
              id="bespoke-fullname"
              class="rtw-input"
              placeholder="e.g. Bernard Aboagye"
              required
            >
          </div>

          <div class="rtw-field">
            <label for="bespoke-phone" class="rtw-label">Contact Phone Number</label>
            <input
              type="tel"
              id="bespoke-phone"
              class="rtw-input"
              placeholder="+233 XX XXX XXXX"
              required
            >
          </div>

          <div class="rtw-field">
            <label for="bespoke-address" class="rtw-label">Full Shipping Address</label>
            <textarea
              id="bespoke-address"
              class="rtw-input rtw-textarea"
              placeholder="Street, City, Region, Country"
              rows="3"
              required
            ></textarea>
          </div>

          <div class="rtw-field">
            <label for="bespoke-delivery-date" class="rtw-label">Preferred Delivery Date</label>
            <input
              type="date"
              id="bespoke-delivery-date"
              class="rtw-input"
              min="${minDeliveryDate}"
              required
            >
          </div>

          <button class="rtw-modal-submit" id="bespoke-modal-submit">
            Confirm & Place Commission
          </button>
        </div>

        <p class="rtw-modal-security-note">Your order is secured and encrypted. The studio will contact you within 24 hours.</p>
      </div>
    </div>
  `;

  portal.style.display = "block";

  // ── Close button ──
  document.getElementById("bespoke-modal-close").addEventListener("click", () => {
    closeBespokeCheckoutModal();
  });

  // ── Click backdrop to dismiss ──
  document.getElementById("bespoke-modal-backdrop").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeBespokeCheckoutModal();
  });

  // ── FORM SUBMIT HANDLER ──────────────────────────────────────────────────
  document.getElementById("bespoke-modal-submit").addEventListener("click", async () => {
    const fullName             = document.getElementById("bespoke-fullname").value.trim();
    const contactPhone         = document.getElementById("bespoke-phone").value.trim();
    const shippingAddress      = document.getElementById("bespoke-address").value.trim();
    const preferredDeliveryDate = document.getElementById("bespoke-delivery-date").value;

    if (!fullName) {
      showAtelierNotification("Please enter your full name.", "error");
      return;
    }
    if (!contactPhone) {
      showAtelierNotification("Please enter your contact phone number.", "error");
      return;
    }
    if (!shippingAddress) {
      showAtelierNotification("Please enter your full shipping address.", "error");
      return;
    }
    if (!preferredDeliveryDate) {
      showAtelierNotification("Please select a preferred delivery date.", "error");
      return;
    }

    await finalizeBespokeSubmission({
      fullName,
      contactPhone,
      shippingAddress,
      preferredDeliveryDate,
    });
  });
}

function closeBespokeCheckoutModal() {
  const portal = document.getElementById("bespoke-checkout-modal-portal");
  if (!portal) return;
  portal.style.display = "none";
  portal.innerHTML = "";
}

// ─────────────────────────────────────────────────────────────────────────────
// FINALIZE — the actual Firestore write, now gated behind the checkout
// modal instead of firing directly off the measurement form. Everything
// from here down is the original Steps A–D, unchanged in substance, just
// merging in the checkout details and now awaited from the modal's confirm
// handler above instead of the form's submit handler.
// ─────────────────────────────────────────────────────────────────────────────
async function finalizeBespokeSubmission(checkoutDetails) {
  await authReady;
  const currentUser = auth.currentUser;
  if (!currentUser || !pendingBespokeSubmission) {
    showAtelierNotification("Session validation failed. Please log in.", "error");
    return;
  }

  const { dimensionalBlueprint, silhouette, customSilhouetteName, textileProfile, customTextileName, atelierSpecification } = pendingBespokeSubmission;

  const commissionOrderPayload = {
    clientId: currentUser.uid,
    clientEmail: currentUser.email,
    clientName: checkoutDetails.fullName,
    contactPhone: checkoutDetails.contactPhone,
    shippingAddress: checkoutDetails.shippingAddress,
    preferredDeliveryDate: checkoutDetails.preferredDeliveryDate,
    configuration: {
      silhouette,
      customSilhouetteName,
      textileProfile,
      customTextileName,
    },
    tailoringMetrics: dimensionalBlueprint,
    atelierSpecification,
    commissionStatus: "Pending Studio Review",
    financialStatus: "Awaiting Invoice",
    orderCreatedTimestamp: serverTimestamp(),
  };

  // Change UI state to prevent multi-click replication anomalies
  const submitBtn = document.getElementById("bespoke-modal-submit");
  const originalBtnText = submitBtn ? submitBtn.textContent : "Confirm & Place Commission";
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Securing Registry Slots...";
  }

  try {
    // Step A: Write standalone document to primary orders collection
    const orderCollectionRef = collection(db, "orders");
    const structuralOrderRef = await addDoc(
      orderCollectionRef,
      commissionOrderPayload,
    );

    // Step B: Atomically update the user account document to track the new active commission
    const userProfileRef = doc(db, "users", currentUser.uid);
    await updateDoc(userProfileRef, {
      measurementBlueprint: {
        upperBody: dimensionalBlueprint.upperBody,
        lowerBody: dimensionalBlueprint.lowerBody,
        lastUpdated: serverTimestamp(),
      },
      activeCommissionsCount: increment(1),
    });

    // Step C: Execute Asynchronous External Communication Routines via EmailJS
    const trackingToken = structuralOrderRef.id.substring(0, 8).toUpperCase();
    dispatchAtelierEmailReceipts(currentUser.email, trackingToken, commissionOrderPayload);

    // Step D: Trigger visual feedback and redirect to the premium Order Success Gateway
    showAtelierNotification(
      `Commission ${structuralOrderRef.id.substring(0, 6).toUpperCase()} requested successfully!`,
    );

    pendingBespokeSubmission = null;
    closeBespokeCheckoutModal();

    // NEW ROUTING GATE: Forward smoothly to order-success.html with the new Firestore Document reference
    setTimeout(() => {
      const structuralShortId = structuralOrderRef.id.substring(0, 8);
      window.location.href = `order-success.html?orderRef=${structuralShortId}`;
    }, 2000);

  } catch (error) {
    console.error("Studio Commission processing failure event:", error);
    showAtelierNotification(
      "Production server rejected commission payload.",
      "error",
    );
    // Re-enable interface controls if database writes crash out
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
    }
  }
}

/**
 * Dispatches Customer Confirmation and Internal Cutting Desk Alerts via EmailJS Protocols
 */
async function dispatchAtelierEmailReceipts(clientEmail, orderToken, payload) {
  // Map configuration tokens into human-readable titles
  const silhouetteLabel = formatGarmentSlug(payload.configuration?.silhouette, payload.configuration?.customSilhouetteName);
  const textileLabel = formatTextileSlug(payload.configuration?.textileProfile, payload.configuration?.customTextileName);
  const upperMetrics = payload.tailoringMetrics?.upperBody || {};
  const lowerMetrics = payload.tailoringMetrics?.lowerBody || {};
  const atelierLabel = formatAtelierSlug(payload.atelierSpecification?.selectedAtelier);
  const customAtelierName = payload.atelierSpecification?.customAtelierName;
  const customSilhouetteName = payload.configuration?.customSilhouetteName;
  const customTextileName = payload.configuration?.customTextileName;

  // 1. Compilation Parameter Matrix for the Customer Receipt Template
  const clientTemplateParams = {
    to_email: clientEmail,
    order_id: `SB-${orderToken}`,
    garment_selection: silhouetteLabel,
    fabric_selection: textileLabel,
    atelier_selection: atelierLabel,
    custom_atelier_name: customAtelierName || "",
    custom_silhouette_name: customSilhouetteName || "",
    custom_textile_name: customTextileName || "",
    neck_metric: upperMetrics.neck,
    chest_metric: upperMetrics.chest,
    across_back_shoulder_metric: upperMetrics.acrossBackShoulder,
    sleeve_length_metric: upperMetrics.sleeveLength,
    top_length_metric: upperMetrics.topLength,
    around_arm_metric: upperMetrics.aroundArm,
    wrist_metric: upperMetrics.wrist,
    waist_metric: lowerMetrics.waist,
    length_metric: lowerMetrics.length,
    thigh_metric: lowerMetrics.thigh,
    knee_metric: lowerMetrics.knee,
    bar_ankle_metric: lowerMetrics.barAnkle,
  };

  // 2. Compilation Parameter Matrix for the Internal Tailor Queue Alert Template
  const internalTeamParams = {
    client_identity: clientEmail,
    order_id: `SB-${orderToken}`,
    garment_selection: silhouetteLabel,
    fabric_selection: textileLabel,
    atelier_selection: atelierLabel,
    custom_atelier_name: customAtelierName || "",
    custom_silhouette_name: customSilhouetteName || "",
    custom_textile_name: customTextileName || "",
  };

  try {
    // Run concurrent email dispatches to optimize execution times
    await Promise.all([
      // Execute User Receipt Template Call
      window.emailjs.send("service_v2tmcii", "template_dw9l4ur", clientTemplateParams),
      // Cutting-desk / admin alert template
      window.emailjs.send("service_v2tmcii", "template_y1uwrqi", internalTeamParams)
    ]);
    console.log(`Communication protocols executed. Receipts dispatched for SB-${orderToken}.`);
  } catch (emailError) {
    // Swallow communication exceptions safely so the client's screen redirect flow remains unaffected
    console.error("EmailJS network communication protocol exception intercepted:", emailError);
  }
}

function formatGarmentSlug(slug, customName) {
  if (slug === CUSTOM_STYLE_VALUE && customName) return customName;
  const mappings = {
    "signature-kaftan": "Signature Custom Kaftan",
    "bespoke-two-piece": "Premium Two-Piece Suit",
    "luxury-agbada": "Royal Agbada Masterpiece",
    "printed-apparel": "Printed Contemporary Shirt",
    [CUSTOM_STYLE_VALUE]: "Other / Custom Silhouette",
  };
  return mappings[slug] || slug;
}

function formatTextileSlug(slug, customName) {
  if (slug === CUSTOM_FABRIC_VALUE && customName) return customName;
  const mappings = {
    "premium-wool": "Super 120s Premium Wool",
    "polished-linen": "Polished Tropical Linen",
    "luxury-brocade": "Hand-Woven Luxury Brocade",
    "deluxe-cotton": "High-Thread Deluxe Cotton",
    [CUSTOM_FABRIC_VALUE]: "Other / Custom Fabric",
  };
  return mappings[slug] || slug;
}

function formatAtelierSlug(slug) {
  const mappings = {
    "accra-flagship": "Suit Boss Flagship Atelier — Accra",
    "kumasi-studio": "Suit Boss Kumasi Studio",
    "takoradi-workshop": "Suit Boss Takoradi Workshop",
    [CUSTOM_ATELIER_VALUE]: "Other / Custom Atelier",
  };
  return mappings[slug] || slug;
}