// Page-level interceptors for console and network capture
// Injected into the MAIN world to intercept page's actual console/fetch/XHR calls
(function () {
  if (window.__screenshotInterceptorsInstalled) return;
  window.__screenshotInterceptorsInstalled = true;

  const MAX_CONSOLE_PREVIEW_SIZE = 10240; // Keep console serialization bounded
  const MAX_LOG_ARGS = 20;
  const MAX_ENTRIES = 500;

  // ── Console capture ──────────────────────────────────────────────────
  const consoleLogs = [];
  const originalConsole = {};
  const LEVELS = ['log', 'warn', 'error', 'info', 'debug'];

  function serializeArg(arg) {
    if (arg === undefined) return 'undefined';
    if (arg === null) return 'null';
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack || ''}`;
    try {
      const str = JSON.stringify(arg, null, 2);
      return str && str.length > MAX_CONSOLE_PREVIEW_SIZE ? str.slice(0, MAX_CONSOLE_PREVIEW_SIZE) + '…' : str;
    } catch {
      try { return String(arg); } catch { return '[unserializable]'; }
    }
  }

  LEVELS.forEach((level) => {
    originalConsole[level] = console[level];
    console[level] = function (...args) {
      if (consoleLogs.length < MAX_ENTRIES) {
        consoleLogs.push({
          ts: Date.now(),
          level,
          args: args.slice(0, MAX_LOG_ARGS).map(serializeArg),
        });
      }
      return originalConsole[level].apply(console, args);
    };
  });

  // ── Network (fetch + XHR) capture ────────────────────────────────────
  const networkLogs = [];

  function headersToObj(headers) {
    const obj = {};
    try {
      if (headers instanceof Headers) {
        headers.forEach((v, k) => { obj[k] = v; });
      } else if (headers && typeof headers === 'object') {
        Object.entries(headers).forEach(([k, v]) => { obj[k] = String(v); });
      }
    } catch { /* ignore */ }
    return obj;
  }

  function looksTextLike(contentType = '') {
    const normalized = String(contentType).toLowerCase();
    return (
      normalized.includes('json') ||
      normalized.includes('text/') ||
      normalized.includes('xml') ||
      normalized.includes('javascript') ||
      normalized.includes('x-www-form-urlencoded') ||
      normalized.includes('svg')
    );
  }

  async function readBodyContent(body, contentType = '') {
    if (!body) return null;
    if (typeof body === 'string') return body;
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) {
      const parts = [];
      body.forEach((v, k) => parts.push(`${k}=${v instanceof File ? `[File: ${v.name}]` : v}`));
      return parts.join('&');
    }
    if (body instanceof Blob) {
      try {
        if (contentType && !looksTextLike(contentType)) {
          return `[Blob ${contentType || body.type || 'binary'} ${body.size} bytes]`;
        }
        return await body.text();
      } catch { return '[Blob]'; }
    }
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      try {
        if (contentType && !looksTextLike(contentType)) return '[ArrayBuffer]';
        const decoder = new TextDecoder('utf-8', { fatal: false });
        const bytes = body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        return decoder.decode(bytes);
      } catch { return '[ArrayBuffer]'; }
    }
    return null;
  }

  // ── Fetch interception ───────────────────────────────────────────────
  const originalFetch = window.fetch;

  window.fetch = async function (input, init) {
    const entry = {
      ts: Date.now(),
      type: 'fetch',
      method: 'GET',
      url: '',
      requestHeaders: {},
      requestBody: null,
      status: 0,
      statusText: '',
      responseHeaders: {},
      responseBody: null,
      duration: 0,
      size: 0,
      error: null,
    };

    try {
      if (input instanceof Request) {
        entry.url = input.url;
        entry.method = input.method;
        entry.requestHeaders = headersToObj(input.headers);
        if (input.body) {
          try {
            entry.requestBody = await readBodyContent(
              input.clone().body,
              input.headers.get('content-type') || ''
            );
          } catch { /* ignore */ }
        }
      } else {
        entry.url = String(input);
      }

      if (init) {
        if (init.method) entry.method = init.method.toUpperCase();
        if (init.headers) entry.requestHeaders = { ...entry.requestHeaders, ...headersToObj(new Headers(init.headers)) };
        if (init.body != null) {
          entry.requestBody = await readBodyContent(
            init.body,
            entry.requestHeaders['content-type'] || entry.requestHeaders['Content-Type'] || ''
          );
        }
      }
    } catch { /* safe defaults */ }

    const startTime = performance.now();

    try {
      const response = await originalFetch.apply(this, arguments);
      entry.duration = Math.round(performance.now() - startTime);
      entry.status = response.status;
      entry.statusText = response.statusText;
      entry.responseHeaders = headersToObj(response.headers);

      // Read the full response body for text-like payloads without consuming the original
      try {
        const clone = response.clone();
        const contentType = response.headers.get('content-type') || '';
        if (looksTextLike(contentType)) {
          const text = await clone.text();
          entry.responseBody = text;
          entry.size = text.length;
        } else {
          const blob = await clone.blob();
          entry.responseBody = `[${contentType || 'binary response'} ${blob.size} bytes]`;
          entry.size = blob.size;
        }
      } catch { /* response may not be cloneable */ }

      if (networkLogs.length < MAX_ENTRIES) networkLogs.push(entry);
      return response;
    } catch (err) {
      entry.duration = Math.round(performance.now() - startTime);
      entry.error = err ? err.message || String(err) : 'Unknown error';
      if (networkLogs.length < MAX_ENTRIES) networkLogs.push(entry);
      throw err;
    }
  };

  // ── XMLHttpRequest interception ──────────────────────────────────────
  const XHRProto = XMLHttpRequest.prototype;
  const originalOpen = XHRProto.open;
  const originalSend = XHRProto.send;
  const originalSetRequestHeader = XHRProto.setRequestHeader;

  XHRProto.open = function (method, url) {
    this.__screenshot = {
      method: (method || 'GET').toUpperCase(),
      url: String(url),
      requestHeaders: {},
      requestBody: null,
      startTime: 0,
    };
    return originalOpen.apply(this, arguments);
  };

  XHRProto.setRequestHeader = function (name, value) {
    if (this.__screenshot) {
      this.__screenshot.requestHeaders[name] = value;
    }
    return originalSetRequestHeader.apply(this, arguments);
  };

  XHRProto.send = function (body) {
    const meta = this.__screenshot;
    if (meta) {
      meta.startTime = performance.now();
      if (body != null) {
        meta.requestBody = typeof body === 'string' ? body : '[binary]';
      }

      this.addEventListener('loadend', function () {
        const entry = {
          ts: Date.now(),
          type: 'xhr',
          method: meta.method,
          url: meta.url,
          requestHeaders: meta.requestHeaders,
          requestBody: meta.requestBody,
          status: this.status,
          statusText: this.statusText,
          responseHeaders: {},
          responseBody: null,
          duration: Math.round(performance.now() - meta.startTime),
          size: 0,
          error: null,
        };

        // Parse response headers
        try {
          const rawHeaders = this.getAllResponseHeaders();
          if (rawHeaders) {
            rawHeaders.trim().split(/[\r\n]+/).forEach((line) => {
              const idx = line.indexOf(': ');
              if (idx > 0) entry.responseHeaders[line.slice(0, idx)] = line.slice(idx + 2);
            });
          }
        } catch { /* ignore */ }

        // Capture the full response body for text-like payloads
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            entry.responseBody = this.responseText;
            entry.size = this.responseText.length;
          } else if (this.responseType === 'json') {
            const json = JSON.stringify(this.response);
            entry.responseBody = json;
            entry.size = json.length;
          }
        } catch { /* ignore */ }

        if (this.status === 0 && !entry.responseBody) {
          entry.error = 'Network error or aborted';
        }

        if (networkLogs.length < MAX_ENTRIES) networkLogs.push(entry);
      });
    }
    return originalSend.apply(this, arguments);
  };

  // ── Device metadata capture ──────────────────────────────────────────
  async function collectDeviceMetadata() {
    const metadata = {
      timestamp: new Date().toISOString(),
      url: window.location.href,
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      browser: 'Unknown',
      browserVersion: 'Unknown',
      os: 'Unknown',
      networkSpeed: null,
      charging: null,
      browserMode: 'Normal',
    };

    // Parse browser and version from userAgent
    try {
      const ua = navigator.userAgent;
      if (ua.includes('Chrome') && !ua.includes('Edg')) {
        metadata.browser = 'Chrome';
        const match = ua.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
        if (match) metadata.browserVersion = match[1];
      } else if (ua.includes('Edg')) {
        metadata.browser = 'Edge';
        const match = ua.match(/Edg\/(\d+\.\d+\.\d+\.\d+)/);
        if (match) metadata.browserVersion = match[1];
      } else if (ua.includes('Firefox')) {
        metadata.browser = 'Firefox';
        const match = ua.match(/Firefox\/(\d+\.\d+)/);
        if (match) metadata.browserVersion = match[1];
      } else if (ua.includes('Safari') && !ua.includes('Chrome')) {
        metadata.browser = 'Safari';
        const match = ua.match(/Version\/(\d+\.\d+)/);
        if (match) metadata.browserVersion = match[1];
      }
    } catch { /* ignore */ }

    // Parse OS from userAgent and platform
    try {
      const ua = navigator.userAgent;
      const platform = navigator.platform;
      if (ua.includes('Mac') || platform.includes('Mac')) {
        metadata.os = 'Mac OS';
      } else if (ua.includes('Win') || platform.includes('Win')) {
        metadata.os = 'Windows';
      } else if (ua.includes('Linux') || platform.includes('Linux')) {
        metadata.os = 'Linux';
      } else if (ua.includes('Android')) {
        metadata.os = 'Android';
      } else if (ua.includes('iPhone') || ua.includes('iPad')) {
        metadata.os = 'iOS';
      }
    } catch { /* ignore */ }

    // Network speed (if available)
    try {
      if (navigator.connection || navigator.mozConnection || navigator.webkitConnection) {
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (connection.downlink) {
          metadata.networkSpeed = `${connection.downlink} Mbps`;
        }
      }
    } catch { /* ignore */ }

    // Battery / Charging status (if available)
    try {
      if (navigator.getBattery) {
        const battery = await navigator.getBattery();
        metadata.charging = battery.charging ? 'Charging' : 'Not Charging';
      }
    } catch { /* ignore */ }

    // Browser mode detection (incognito/private heuristic)
    try {
      // This is a heuristic and may not work in all browsers
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        // In incognito, quota is typically much smaller
        if (estimate.quota && estimate.quota < 120000000) { // < 120MB suggests incognito
          metadata.browserMode = 'Incognito';
        }
      }
    } catch { /* ignore */ }

    return metadata;
  }

  // ── Communication with content script via postMessage ────────────────
  console.log('[page-interceptors.js] Interceptors installed, buffers ready');
  
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === '__SCREENSHOT_GET_LOGS__') {
      console.log('[page-interceptors.js] Received log request, collecting metadata...');
      
      const deviceMeta = await collectDeviceMetadata();
      
      console.log('[page-interceptors.js] Sending response:', {
        consoleCount: consoleLogs.length,
        networkCount: networkLogs.length,
        hasMeta: !!deviceMeta
      });
      
      window.postMessage({
        type: '__SCREENSHOT_LOGS_RESPONSE__',
        consoleLogs: consoleLogs.slice(),
        networkLogs: networkLogs.slice(),
        deviceMeta,
      }, '*');
    }
  });
})();
