/**
 * PRODUCT IMAGE UPLOAD CLIENT
 *
 * Browser-side client for the Suitboss PHP image endpoints:
 *   POST /api/cloudinary-upload.php            (admin: product photos; multipart, field "image")
 *   POST /api/cloudinary-delete.php            (admin: JSON { publicId })
 *   POST /api/cloudinary-reference-upload.php  (any signed-in customer: bespoke reference photo)
 *   POST /api/cloudinary-reference-delete.php  (customer: delete their OWN unsaved reference photo)
 *
 * Deliberately has NO Firebase or DOM imports. The caller injects
 * `getIdToken(forceRefresh)`, which keeps this file testable in Node and
 * guarantees no secret or role information is ever handled here — the server
 * derives the UID and admin status from the verified Firebase ID token.
 */

export const PRODUCT_IMAGE_MAX_BYTES = 8 * 1024 * 1024; // must match the server limit
export const PRODUCT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export class ProductImageError extends Error {
  constructor(message, { code = "unknown", status = 0, retryable = false } = {}) {
    super(message);
    this.name = "ProductImageError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** Returns a user-facing problem string, or null when the file is acceptable. */
export function validateProductImageFile(file) {
  if (!file) return "Please choose an image to upload.";
  if (!PRODUCT_IMAGE_TYPES.includes(file.type)) {
    return "Only JPG, PNG, or WEBP images are accepted.";
  }
  if (file.size < 1) return "That file is empty — please choose another image.";
  if (file.size > PRODUCT_IMAGE_MAX_BYTES) {
    return "That image is over 8MB — please choose a smaller file.";
  }
  return null;
}

/** Rejects with ProductImageError({code:"timeout"}) if `promise` takes too long. */
export function withTimeout(promise, ms, message = "The request timed out.") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new ProductImageError(message, { code: "timeout", retryable: true })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── PUBLIC ID HELPERS ────────────────────────────────────────────────────────
// Must stay in sync with the pattern enforced by api/cloudinary-delete.php.
export const PRODUCT_IMAGE_FOLDER = "suitboss/products";
const PUBLIC_ID_PATTERN = /^suitboss\/products\/[A-Za-z0-9_-]{1,120}$/;

/** True only for ids inside suitboss/products/ that the delete endpoint will accept. */
export function isValidProductImagePublicId(value) {
  return typeof value === "string" && PUBLIC_ID_PATTERN.test(value);
}

/**
 * Derives a public id from a Cloudinary delivery URL such as
 * https://res.cloudinary.com/<cloud>/image/upload/[transforms/][v123/]suitboss/products/<id>.jpg
 * Returns null for any other URL (Firebase Storage, pasted third-party links, ...).
 */
export function publicIdFromCloudinaryUrl(url) {
  if (typeof url !== "string" || url === "") return null;
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (parsed.protocol !== "https:" || parsed.hostname !== "res.cloudinary.com") return null;
  const match = decodeURIComponent(parsed.pathname).match(
    /\/image\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(suitboss\/products\/[A-Za-z0-9_-]+)(?:\.[A-Za-z0-9]+)?$/
  );
  return match && isValidProductImagePublicId(match[1]) ? match[1] : null;
}

/**
 * Decides which Cloudinary asset (if any) belongs to a product document.
 *   { publicId, source: "stored" | "url" }   -> delete this asset
 *   { publicId: null, reason: "no-cloudinary-image" } -> nothing of ours to delete
 *   { publicId: null, reason: "invalid-public-id" }   -> a stored id exists but is
 *        unusable and cannot be recovered from the URL; caller must NOT drop the record.
 */
export function resolveProductImagePublicId({ imagePublicId, imageUrl } = {}) {
  const stored = typeof imagePublicId === "string" ? imagePublicId.trim() : "";
  if (stored && isValidProductImagePublicId(stored)) {
    const fromUrl = publicIdFromCloudinaryUrl(imageUrl);
    if (fromUrl && fromUrl !== stored) {
      console.warn("Product imagePublicId differs from its imageUrl; using the stored id.", { stored, fromUrl });
    }
    return { publicId: stored, source: "stored" };
  }
  const derived = publicIdFromCloudinaryUrl(imageUrl);
  if (derived) return { publicId: derived, source: "url" };
  if (stored) return { publicId: null, reason: "invalid-public-id" };
  return { publicId: null, reason: "no-cloudinary-image" };
}

/** Raised by removeProductAndImage. `stage` says which half failed. */
export class ProductRemovalError extends Error {
  constructor(message, { stage, code = "unknown", status = 0, publicId = null, cause = null } = {}) {
    super(message);
    this.name = "ProductRemovalError";
    this.stage = stage;       // "image" | "record"
    this.code = code;
    this.status = status;
    this.publicId = publicId;
    this.cause = cause;
  }
}

/**
 * Safe product removal: the Cloudinary image is deleted FIRST and awaited; the
 * Firestore record is only deleted once the image is confirmed gone
 * ("ok" or "not found"). If the image step fails the record is left untouched,
 * so the admin can simply press Remove again. If the record step fails after
 * the image is gone, the record still holds imagePublicId and a retry succeeds
 * (Cloudinary answers "not found", which counts as success).
 *
 * @returns {Promise<{ imageResult: "ok"|"not found"|"skipped", publicId: string|null, source: string|null }>}
 */
export async function removeProductAndImage({ client, imagePublicId, imageUrl, deleteRecord }) {
  if (!client || typeof client.removeImage !== "function") {
    throw new TypeError("removeProductAndImage requires a client with removeImage().");
  }
  if (typeof deleteRecord !== "function") {
    throw new TypeError("removeProductAndImage requires a deleteRecord() function.");
  }

  const resolved = resolveProductImagePublicId({ imagePublicId, imageUrl });

  if (!resolved.publicId && resolved.reason === "invalid-public-id") {
    throw new ProductRemovalError(
      "This product has an unreadable image reference, so its image can't be removed safely. The product was kept.",
      { stage: "image", code: "invalid-public-id" }
    );
  }

  let imageResult = "skipped";
  if (resolved.publicId) {
    try {
      imageResult = await client.removeImage(resolved.publicId);
    } catch (err) {
      throw new ProductRemovalError(
        err?.message || "The product image could not be removed from Cloudinary.",
        { stage: "image", code: err?.code || "unknown", status: err?.status || 0, publicId: resolved.publicId, cause: err }
      );
    }
  }

  try {
    await deleteRecord();
  } catch (err) {
    throw new ProductRemovalError(
      "The registry entry could not be deleted.",
      { stage: "record", code: err?.code || "unknown", publicId: resolved.publicId, cause: err }
    );
  }

  return { imageResult, publicId: resolved.publicId, source: resolved.publicId ? resolved.source : null };
}

function messageForDeleteStatus(status, code) {
  if (status === 401) return "Your session has expired. Please sign in again and retry.";
  if (status === 403) return "Administrator access is required to remove product images.";
  if (status === 400) return "The product's image reference was rejected as invalid.";
  if (status === 404 || status === 405) return "The image service is unavailable. Contact the site administrator.";
  return "The image service could not remove the image right now. Please try again.";
}

function messageForStatus(status, serverMessage) {
  if (status === 429) return "Too many uploads in a short time. Please wait a few minutes and try again.";
  if (status === 401) return "Your session has expired. Please sign in again and retry.";
  if (status === 403) return "Administrator access is required to upload product images.";
  if (status === 413) return "That image is over 8MB — please choose a smaller file.";
  if (status === 415) return "Only JPG, PNG, or WEBP images are accepted.";
  if (status >= 400 && status < 500 && serverMessage) return serverMessage;
  if (status === 404 || status === 405) return "The image upload service is unavailable. Contact the site administrator.";
  return "The image could not be uploaded right now. Please try again.";
}

/**
 * @param {object}   opts
 * @param {(forceRefresh: boolean) => Promise<string>} opts.getIdToken
 * @param {string}   [opts.endpointBase="/api"]
 * @param {Function} [opts.fetchImpl]
 * @param {number}   [opts.uploadTimeoutMs=90000]
 * @param {number}   [opts.deleteTimeoutMs=20000]
 * @param {number}   [opts.tokenTimeoutMs=15000]
 * @param {string}   [opts.uploadEndpoint="cloudinary-upload.php"]
 * @param {string}   [opts.deleteEndpoint="cloudinary-delete.php"]
 * @param {(id: string) => boolean} [opts.isValidPublicId]  which public ids removeImage() will accept
 */
export function createProductImageClient({
  getIdToken,
  endpointBase = "/api",
  fetchImpl = (...args) => fetch(...args),
  uploadTimeoutMs = 90000,
  deleteTimeoutMs = 20000,
  tokenTimeoutMs = 15000,
  uploadEndpoint = "cloudinary-upload.php",
  deleteEndpoint = "cloudinary-delete.php",
  isValidPublicId = isValidProductImagePublicId,
} = {}) {
  if (typeof getIdToken !== "function") {
    throw new TypeError("createProductImageClient requires a getIdToken function.");
  }

  /**
   * One bounded HTTP round trip: connecting, sending, receiving headers AND
   * reading the JSON body all sit under a single deadline. Nothing here can
   * wait forever — when the deadline hits, the request is aborted and the
   * promise rejects with code "timeout" even if the transport ignores abort.
   */
  async function timedRequest(url, init, timeoutMs) {
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProductImageError("The request timed out. Check your connection and try again.", {
          code: "timeout",
          retryable: true,
        }));
      }, timeoutMs);
    });

    const work = (async () => {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      let body = null;
      try {
        body = await res.json();
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        body = null; // HTML error page, empty body, etc.
      }
      return { res, body };
    })();
    work.catch(() => {}); // a late rejection after the deadline must not surface as "unhandled"

    try {
      return await Promise.race([work, deadline]);
    } catch (err) {
      if (err instanceof ProductImageError) throw err;
      if (err?.name === "AbortError") {
        throw new ProductImageError("The request timed out. Check your connection and try again.", {
          code: "timeout",
          retryable: true,
        });
      }
      throw new ProductImageError("Network error. Check your connection and try again.", {
        code: "network",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** getIdToken() with a deadline, so a stalled auth bootstrap or token refresh can't hang the UI. */
  async function boundedToken(forceRefresh) {
    try {
      return await withTimeout(
        Promise.resolve(getIdToken(forceRefresh)),
        tokenTimeoutMs,
        "Couldn't confirm your sign-in in time. Check your connection and try again."
      );
    } catch (err) {
      if (err instanceof ProductImageError) throw err; // timeout
      return null; // not signed in / token error
    }
  }

  /** Sends an authenticated request; on a 401 refreshes the token and retries ONCE. */
  async function authedRequest(url, buildInit, timeoutMs) {
    const token = await boundedToken(false);
    if (!token) throw new ProductImageError("You must be signed in to upload images.", { code: "no-session" });

    let result = await timedRequest(url, buildInit(token), timeoutMs);

    if (result.res.status === 401) {
      const fresh = await boundedToken(true);
      if (!fresh) {
        throw new ProductImageError(messageForStatus(401), { code: "unauthorized", status: 401 });
      }
      result = await timedRequest(url, buildInit(fresh), timeoutMs);
    }

    return result;
  }

  /**
   * Uploads one image. Resolves { imageUrl, publicId } — values returned by
   * Cloudinary via the server. Throws ProductImageError otherwise.
   */
  async function upload(file) {
    const problem = validateProductImageFile(file);
    if (problem) throw new ProductImageError(problem, { code: "invalid-file" });

    const { res, body } = await authedRequest(
      `${endpointBase}/${uploadEndpoint}`,
      (token) => {
        const form = new FormData();
        form.append("image", file, file.name || "upload");
        // No Content-Type header: the browser must set the multipart boundary.
        return { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form };
      },
      uploadTimeoutMs
    );

    if (!res.ok || !body || body.success !== true) {
      const serverMessage = typeof body?.error === "string" ? body.error : "";
      throw new ProductImageError(messageForStatus(res.status, serverMessage), {
        code: "server-rejected",
        status: res.status,
        retryable: res.status >= 500 || res.status === 0,
      });
    }

    const { imageUrl, publicId } = body;
    if (
      typeof imageUrl !== "string" || !imageUrl.startsWith("https://") ||
      typeof publicId !== "string" || publicId === ""
    ) {
      throw new ProductImageError("The upload service returned an unexpected response.", {
        code: "bad-response",
        status: res.status,
        retryable: true,
      });
    }
    return { imageUrl, publicId };
  }

  /**
   * Strict removal. Resolves "ok" | "not found" (both mean the asset is gone),
   * otherwise throws ProductImageError with a specific code:
   *   invalid-public-id, no-session, unauthorized (401), forbidden (403),
   *   network, timeout, server-error, bad-response.
   * The response body is validated; HTTP 200 alone is not treated as success.
   */
  async function removeImage(publicId) {
    if (!isValidPublicId(publicId)) {
      throw new ProductImageError("The product image reference is invalid.", { code: "invalid-public-id" });
    }

    const { res, body } = await authedRequest(
      `${endpointBase}/${deleteEndpoint}`,
      (token) => ({
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ publicId }),
      }),
      deleteTimeoutMs
    );

    if (!res.ok || !body || body.success !== true) {
      const code =
        res.status === 401 ? "unauthorized" :
        res.status === 403 ? "forbidden" :
        res.status === 400 ? "invalid-public-id" : "server-error";
      throw new ProductImageError(messageForDeleteStatus(res.status, code), {
        code,
        status: res.status,
        retryable: code === "server-error",
      });
    }

    if (body.result !== "ok" && body.result !== "not found") {
      throw new ProductImageError("The image service returned an unexpected response.", {
        code: "bad-response",
        status: res.status,
        retryable: true,
      });
    }
    return body.result;
  }

  /** Best-effort removal of an uploaded-but-unsaved image. Never throws; failures are logged. */
  async function deleteImage(publicId) {
    try {
      await removeImage(publicId);
      return true;
    } catch (err) {
      console.warn("Cloudinary cleanup failed; the image may need manual removal.", {
        publicId, code: err?.code, status: err?.status,
      });
      return false;
    }
  }

  return { upload, removeImage, deleteImage };
}

// ── BESPOKE REFERENCE IMAGES (customer-facing) ───────────────────────────────
export const REFERENCE_IMAGE_FOLDER = "suitboss/bespoke-references";
const REFERENCE_PUBLIC_ID_PATTERN = /^suitboss\/bespoke-references\/[a-f0-9]{16}-[a-f0-9]{16}$/;

/** True only for ids the reference-delete endpoint can ever accept. */
export function isValidReferenceImagePublicId(value) {
  return typeof value === "string" && REFERENCE_PUBLIC_ID_PATTERN.test(value);
}

/**
 * Client for the Apparel Silhouette reference photo. Same hardening as the
 * product client (token, timeouts, validation) but pointed at the endpoints
 * any SIGNED-IN customer may use — the server derives ownership from the
 * verified token, never from anything sent here.
 */
export function createReferenceImageClient(opts = {}) {
  return createProductImageClient({
    ...opts,
    uploadEndpoint: "cloudinary-reference-upload.php",
    deleteEndpoint: "cloudinary-reference-delete.php",
    isValidPublicId: isValidReferenceImagePublicId,
  });
}

/**
 * Holds ONE uploaded-but-not-yet-saved image so that:
 *   - a retried save re-uses the same Cloudinary upload (no duplicate files),
 *   - choosing a different file / removing the image deletes the unused upload,
 *   - a successful save calls commit() so the image is never cleaned up.
 */
export function createImageUploadSlot(client) {
  let current = null; // { file, imageUrl, publicId }
  return {
    get current() { return current; },

    /** Uploads `file` unless this exact file is already uploaded. Throws ProductImageError on failure. */
    async ensure(file) {
      if (current && current.file === file) {
        return { imageUrl: current.imageUrl, publicId: current.publicId };
      }
      if (current) this.discard();
      const uploaded = await client.upload(file);
      current = { file, imageUrl: uploaded.imageUrl, publicId: uploaded.publicId };
      return uploaded;
    },

    /** Best-effort delete of the unsaved upload (never throws; not awaited by callers). */
    discard() {
      const orphan = current;
      current = null;
      return orphan ? client.deleteImage(orphan.publicId) : Promise.resolve(false);
    },

    /** The image now belongs to a saved record — forget it WITHOUT deleting. */
    commit() { current = null; },
  };
}