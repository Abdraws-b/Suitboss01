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