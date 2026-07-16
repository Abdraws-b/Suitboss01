import { 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword,
    GoogleAuthProvider,
    signInWithPopup,
    getAdditionalUserInfo
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js";

import { 
    doc, 
    setDoc,
    getDoc,
    serverTimestamp 
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

import { auth, db } from "./app.js"; 
import { showAtelierNotification } from "./ui-feedback.js"; 

// ---------------------------------------------------------------------------
// ROUTING CONSTANTS
// All post-auth redirects are declared here — change in one place only.
// ---------------------------------------------------------------------------
const ROUTE_HOME          = "index.html";        // Validated returning user landing
const ROUTE_NEW_CLIENT    = "custom-order.html"; // First-time user → capture measurements

let isRegistrationState = false;

export function initAuthEngine() {
    const authForm   = document.getElementById("auth-credential-form");
    const toggleLink = document.getElementById("toggle-to-register");
    const submitBtn  = document.getElementById("auth-submit-btn");
    const paneTitle  = document.querySelector(".auth-pane-title");
    const paneSwitch = document.querySelector(".auth-pane-switch");
    const googleBtn  = document.getElementById("oauth-google");

    if (!authForm) return;

    // -----------------------------------------------------------------------
    // UI STATE TOGGLE  ·  Login ⇆ Register
    // -----------------------------------------------------------------------
    if (toggleLink && !toggleLink.dataset.listenerAttached) {
        toggleLink.dataset.listenerAttached = "true";

        toggleLink.addEventListener("click", (e) => {
            e.preventDefault();
            isRegistrationState = !isRegistrationState;

            if (isRegistrationState) {
                if (paneTitle)  paneTitle.textContent = "Create Atelier Profile";
                if (submitBtn)  submitBtn.textContent = "Register & Create Blueprint";
                if (paneSwitch) paneSwitch.innerHTML  =
                    `Already registered? <a href="#login" id="toggle-to-register">Authorize Entry</a>`;
            } else {
                if (paneTitle)  paneTitle.textContent = "Atelier Access";
                if (submitBtn)  submitBtn.textContent = "Authorize Entry";
                if (paneSwitch) paneSwitch.innerHTML  =
                    `New to the studio? <a href="#register" id="toggle-to-register">Create an account</a>`;
            }
        });
    }

    // -----------------------------------------------------------------------
    // EMAIL / PASSWORD  ·  Submit Pipeline
    // -----------------------------------------------------------------------
    authForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        clearAuthErrors();
        setLoadingState(submitBtn, true);

        const emailInput    = document.getElementById("auth-email");
        const passwordInput = document.getElementById("auth-password");

        if (!emailInput || !passwordInput) return;

        const email    = emailInput.value.trim();
        const password = passwordInput.value;

        if (!email || !password) {
            setLoadingState(submitBtn, false);
            return;
        }

        try {
            if (isRegistrationState) {
                // --- NEW ACCOUNT ---
                // 1. Create Firebase Auth identity
                const userCredential = await createUserWithEmailAndPassword(auth, email, password);
                const user = userCredential.user;

                // 2. Provision Firestore profile document
                await provisionUserFirestoreRecord(user.uid, user.email, "Email/Password Provider");

                // 3. New clients go straight to the measurement blueprint
                showAtelierNotification("Account created. Let's capture your measurements.", "success");
                window.location.href = ROUTE_NEW_CLIENT;

            } else {
                // --- RETURNING USER LOGIN ---
                await signInWithEmailAndPassword(auth, email, password);

                // Validated user → home page; they can navigate to bespoke order from there
                showAtelierNotification("Welcome back. Redirecting to your studio.", "success");
                window.location.href = ROUTE_HOME;
            }

        } catch (error) {
            console.error("Authentication System Failure Event:", error);
            displayAuthSystemError(error.message);
        } finally {
            setLoadingState(submitBtn, false);
        }
    });

    // -----------------------------------------------------------------------
    // GOOGLE OAUTH  ·  Federated Access
    // New user  → provision record → ROUTE_NEW_CLIENT (capture measurements)
    // Returning → ROUTE_HOME (validated, no re-onboarding needed)
    // -----------------------------------------------------------------------
    if (googleBtn) {
        googleBtn.addEventListener("click", async () => {
            const provider = new GoogleAuthProvider();
            setLoadingState(googleBtn, true);

            try {
                const result            = await signInWithPopup(auth, provider);
                const additionalInfo    = getAdditionalUserInfo(result);

                // Primary signal: Firebase tells us directly if this is a new user
                const isNewUser = additionalInfo?.isNewUser ?? false;

                // Secondary guard: check Firestore in case the Auth record exists
                // but the profile document was never written (e.g. prior interrupted signup)
                let profileExists = false;
                if (!isNewUser) {
                    const userDocSnap = await getDoc(doc(db, "users", result.user.uid));
                    profileExists = userDocSnap.exists();
                }

                if (isNewUser || !profileExists) {
                    // First time through — write profile and capture measurements
                    await provisionUserFirestoreRecord(
                        result.user.uid,
                        result.user.email,
                        "Google OAuth Network"
                    );
                    showAtelierNotification("Account created. Let's capture your measurements.", "success");
                    window.location.href = ROUTE_NEW_CLIENT;
                } else {
                    // Validated returning user — send to home
                    showAtelierNotification("Identity verified. Welcome back.", "success");
                    window.location.href = ROUTE_HOME;
                }

            } catch (error) {
                console.error("OAuth Network Failure Event:", error);
                displayAuthSystemError(error.message);
            } finally {
                setLoadingState(googleBtn, false);
            }
        });
    }
}

// ---------------------------------------------------------------------------
// FIRESTORE  ·  Provision new client profile document
// Uses merge:true so a repeat call never overwrites existing measurement data
// ---------------------------------------------------------------------------
async function provisionUserFirestoreRecord(uid, email, method) {
    const userDocRef = doc(db, "users", uid);

    const initialAtelierPayload = {
        uid,
        email,
        authenticationMethod: method,
        accountCreatedTimestamp: serverTimestamp(),
        systemAccessLevel: "client",
        measurementBlueprint: {
            neck:        null,
            chest:       null,
            shoulder:    null,
            sleeve:      null,
            waist:       null,
            hips:        null,
            outseam:     null,
            inseam:      null,
            lastUpdated: null
        },
        activeCommissionsCount: 0
    };

    // merge:true protects any pre-existing field data (e.g. partially saved measurements)
    await setDoc(userDocRef, initialAtelierPayload, { merge: true });
}

// ---------------------------------------------------------------------------
// UI HELPERS
// ---------------------------------------------------------------------------

/** Display a Firebase error stripped of its verbose prefix */
function displayAuthSystemError(message) {
    const errorNode = document.querySelector(".error-indicator");
    if (errorNode) {
        errorNode.textContent = message.replace("Firebase: ", "");
        errorNode.style.color = "#ff4d4d";
    }
}

/** Wipe stale error messages before a fresh submission attempt */
function clearAuthErrors() {
    document.querySelectorAll(".error-indicator").forEach(el => {
        el.textContent = "";
    });
}

/** Toggle button disabled + label so the user knows a request is in-flight */
function setLoadingState(btn, isLoading) {
    if (!btn) return;
    btn.disabled = isLoading;
    btn.style.opacity = isLoading ? "0.65" : "1";
    btn.style.cursor  = isLoading ? "not-allowed" : "";
}