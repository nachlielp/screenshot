// Promise-based wrappers around chrome messaging.
// Every send resolves with the response or rejects with a real Error —
// no more fire-and-forget calls that silently drop failures.

const DEFAULT_TIMEOUT_MS = 15000;

function wrapSend(send, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Message timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      send((response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(response);
      });
    } catch (error) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    }
  });
}

export function sendRuntimeMessage(message, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return wrapSend((cb) => chrome.runtime.sendMessage(message, cb), timeoutMs);
}

export function sendTabMessage(tabId, message, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return wrapSend((cb) => chrome.tabs.sendMessage(tabId, message, cb), timeoutMs);
}

/**
 * Like sendRuntimeMessage, but treats a `{ success: false }` response as an error.
 * Use for request/response commands where the handler reports failures in-band.
 */
export async function requestRuntime(message, options) {
  const response = await sendRuntimeMessage(message, options);
  if (response && response.success === false) {
    throw new Error(response.error || response.message || `"${message.type}" failed`);
  }
  return response;
}

export async function requestTab(tabId, message, options) {
  const response = await sendTabMessage(tabId, message, options);
  if (response && response.success === false) {
    throw new Error(response.error || response.message || `"${message.type}" failed`);
  }
  return response;
}
