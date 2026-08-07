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

export function initOrderCommissionEngine() {
  const form = document.getElementById("bespoke-proportion-form");
  if (!form) return;

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

    // 2. Capture measurement dimensions from the active form state
    const dimensionalBlueprint = {
      neck: parseFloat(document.getElementById("measure-neck").value) || null,
      chest: parseFloat(document.getElementById("measure-chest").value) || null,
      shoulder: parseFloat(document.getElementById("measure-shoulder").value) || null,
      sleeve: parseFloat(document.getElementById("measure-sleeve").value) || null,
      waist: parseFloat(document.getElementById("measure-waist").value) || null,
      hips: parseFloat(document.getElementById("measure-hips").value) || null,
      outseam: parseFloat(document.getElementById("measure-outseam").value) || null,
      inseam: parseFloat(document.getElementById("measure-inseam").value) || null,
    };

    // --- ANATOMICAL DEFENSIVE VALIDATION ENGINE ---
    const ValidationBounds = { min: 30, max: 200 };
    let descriptiveValidationError = null;

    for (const [metricKey, metricValue] of Object.entries(dimensionalBlueprint)) {
      if (metricValue !== null) {
        if (metricValue < ValidationBounds.min || metricValue > ValidationBounds.max) {
          descriptiveValidationError = `Please enter a realistic measurement for your ${metricKey} (${ValidationBounds.min}cm - ${ValidationBounds.max}cm).`;
          break;
        }
      } else {
        descriptiveValidationError = `Please fill out all structural parameters to guarantee a perfect bespoke silhouette cut.`;
        break;
      }
    }

    if (descriptiveValidationError) {
      showAtelierNotification(descriptiveValidationError, "error");
      return;
    }
    // ----------------------------------------------------

    // Measurements and garment selection are validated — stash them and
    // move to checkout instead of writing to Firestore immediately. The
    // actual order isn't created until the checkout modal is confirmed.
    pendingBespokeSubmission = {
      dimensionalBlueprint,
      silhouette: styleInput.value,
      textileProfile: fabricInput.value,
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

  const { silhouette, textileProfile } = pendingBespokeSubmission;

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
          <h2 class="rtw-modal-title">${formatGarmentSlug(silhouette)}</h2>
          <button class="rtw-modal-close" id="bespoke-modal-close" aria-label="Close checkout">&times;</button>
        </div>

        <div class="rtw-modal-confirmation-row">
          <div class="rtw-confirmation-chip">
            <span class="rtw-chip-label">Fabric</span>
            <span class="rtw-chip-value">${formatTextileSlug(textileProfile)}</span>
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

  const { dimensionalBlueprint, silhouette, textileProfile } = pendingBespokeSubmission;

  const commissionOrderPayload = {
    clientId: currentUser.uid,
    clientEmail: currentUser.email,
    clientName: checkoutDetails.fullName,
    contactPhone: checkoutDetails.contactPhone,
    shippingAddress: checkoutDetails.shippingAddress,
    preferredDeliveryDate: checkoutDetails.preferredDeliveryDate,
    configuration: {
      silhouette,
      textileProfile,
    },
    tailoringMetrics: dimensionalBlueprint,
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
        ...dimensionalBlueprint,
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
  const silhouetteLabel = formatGarmentSlug(payload.configuration?.silhouette);
  const textileLabel = formatTextileSlug(payload.configuration?.textileProfile);
  const metrics = payload.tailoringMetrics;

  // 1. Compilation Parameter Matrix for the Customer Receipt Template
  const clientTemplateParams = {
    to_email: clientEmail,
    order_id: `SB-${orderToken}`,
    garment_selection: silhouetteLabel,
    fabric_selection: textileLabel,
    neck_metric: metrics.neck,
    chest_metric: metrics.chest,
    shoulder_metric: metrics.shoulder,
    sleeve_metric: metrics.sleeve,
    waist_metric: metrics.waist,
    hips_metric: metrics.hips,
    outseam_metric: metrics.outseam,
    inseam_metric: metrics.inseam,
  };

  // 2. Compilation Parameter Matrix for the Internal Tailor Queue Alert Template
  const internalTeamParams = {
    client_identity: clientEmail,
    order_id: `SB-${orderToken}`,
    garment_selection: silhouetteLabel,
    fabric_selection: textileLabel,
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

function formatGarmentSlug(slug) {
  const mappings = {
    "signature-kaftan": "Signature Custom Kaftan",
    "bespoke-two-piece": "Premium Two-Piece Suit",
    "luxury-agbada": "Royal Agbada Masterpiece",
    "printed-apparel": "Printed Contemporary Shirt",
  };
  return mappings[slug] || slug;
}

function formatTextileSlug(slug) {
  const mappings = {
    "premium-wool": "Super 120s Premium Wool",
    "polished-linen": "Polished Tropical Linen",
    "luxury-brocade": "Hand-Woven Luxury Brocade",
    "deluxe-cotton": "High-Thread Deluxe Cotton",
  };
  return mappings[slug] || slug;
}