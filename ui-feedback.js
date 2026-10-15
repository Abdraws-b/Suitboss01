/**
 * Triggers a premium, in-app notification banner
 * @param {string} message - The text statement to display
 * @param {string} type - 'success' or 'error'
 */
export function showAtelierNotification(message, type = 'success') {
    const container = document.getElementById("atelier-toast-container");
    if (!container) return;

    // Create the toast node element
    const toast = document.createElement("div");
    toast.className = `atelier-toast ${type === 'error' ? 'error-alert' : ''}`;
    toast.innerHTML = `<span>${message}</span>`;

    // Append into active display screen layout
    container.appendChild(toast);

    // Auto-dismiss execution routine after 4 seconds
    setTimeout(() => {
        toast.style.animation = "toastFadeOut 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards";
        toast.addEventListener("animationend", () => {
            toast.remove();
        });
    }, 4000);
}

function escapeConfirmText(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * In-app replacement for window.confirm(). Renders a branded dialog and
 * resolves to true (confirmed) or false (cancelled / Esc / backdrop click).
 *
 *   const ok = await showAtelierConfirm({
 *       title: "Delete order SB-1A2B3C4D?",
 *       message: "This cannot be undone.",
 *       confirmLabel: "Delete order",
 *       tone: "danger",
 *   });
 *
 * Focus starts on Cancel (the safe choice), Tab is kept inside the dialog,
 * and focus returns to whatever opened it. All text is escaped.
 *
 * @param {Object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.message]
 * @param {string} [opts.confirmLabel]
 * @param {string} [opts.cancelLabel]
 * @param {'danger'|'default'} [opts.tone]
 * @returns {Promise<boolean>}
 */
export function showAtelierConfirm({
    title = "Are you sure?",
    message = "",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    tone = "default",
} = {}) {
    return new Promise((resolve) => {
        const opener = document.activeElement;
        const uid = `atelier-confirm-${Date.now()}`;

        const overlay = document.createElement("div");
        overlay.className = "atelier-confirm-overlay";
        overlay.innerHTML = `
            <div class="atelier-confirm-card ${tone === "danger" ? "is-danger" : ""}"
                 role="alertdialog" aria-modal="true"
                 aria-labelledby="${uid}-title" aria-describedby="${uid}-msg">
                <h3 class="atelier-confirm-title" id="${uid}-title">${escapeConfirmText(title)}</h3>
                ${message ? `<p class="atelier-confirm-message" id="${uid}-msg">${escapeConfirmText(message)}</p>` : ""}
                <div class="atelier-confirm-actions">
                    <button type="button" class="atelier-confirm-btn atelier-confirm-cancel">${escapeConfirmText(cancelLabel)}</button>
                    <button type="button" class="atelier-confirm-btn atelier-confirm-ok">${escapeConfirmText(confirmLabel)}</button>
                </div>
            </div>`;

        const cancelBtn = overlay.querySelector(".atelier-confirm-cancel");
        const okBtn = overlay.querySelector(".atelier-confirm-ok");
        const previousOverflow = document.body.style.overflow;
        let settled = false;

        function finish(result) {
            if (settled) return;
            settled = true;
            document.removeEventListener("keydown", onKeydown, true);
            overlay.classList.add("is-closing");
            document.body.style.overflow = previousOverflow;
            setTimeout(() => overlay.remove(), 180);
            if (opener && typeof opener.focus === "function" && document.contains(opener)) {
                opener.focus();
            }
            resolve(result);
        }

        function onKeydown(e) {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                finish(false);
            } else if (e.key === "Tab") {
                // Keep focus inside the dialog
                e.preventDefault();
                (document.activeElement === cancelBtn ? okBtn : cancelBtn).focus();
            }
        }

        cancelBtn.addEventListener("click", () => finish(false));
        okBtn.addEventListener("click", () => finish(true));
        overlay.addEventListener("mousedown", (e) => {
            if (e.target === overlay) finish(false);
        });
        document.addEventListener("keydown", onKeydown, true);

        document.body.style.overflow = "hidden";
        document.body.appendChild(overlay);
        cancelBtn.focus();
    });
}