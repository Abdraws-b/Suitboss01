import {
  collection,
  addDoc,
  doc,
  updateDoc,
  increment,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";
import { auth, db } from "./app.js";
import { showAtelierNotification } from "./ui-feedback.js";

export function initOrderCommissionEngine() {
  const form = document.getElementById("bespoke-proportion-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    // Prevent default submission behavior entirely to manage network calls manually
    e.preventDefault();

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

    // 3. Assemble the comprehensive Commission Document Payload Matrix
    const commissionOrderPayload = {
      clientId: currentUser.uid,
      clientEmail: currentUser.email,
      configuration: {
        silhouette: styleInput.value,
        textileProfile: fabricInput.value,
      },
      tailoringMetrics: dimensionalBlueprint,
      commissionStatus: "Pending Studio Review",
      financialStatus: "Awaiting Invoice",
      orderCreatedTimestamp: serverTimestamp(),
    };

    // Change UI state to prevent multi-click replication anomalies
    const submitBtn = document.getElementById("order-submit-btn") || form.querySelector("button[type='submit']");
    const originalBtnText = submitBtn ? submitBtn.textContent : "Submit Commission";
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
  }); // Closes addEventListener
} // Closes initOrderCommissionEngine

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
      window.emailjs.send("service_d1bqr4r", "template_sstz80b", clientTemplateParams),
      // FIXED: Replaced YOUR_TAILOR_TEMPLATE_ID placeholder with the production cutting desk template string (Bug 8)
      window.emailjs.send("service_d1bqr4r", "template_bvd9gsl", internalTeamParams)
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