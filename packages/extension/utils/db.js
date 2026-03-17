// IndexedDB wrapper for storing captures temporarily (24h TTL)

const DB_NAME = 'Captures';
const STORE_NAME = 'captures';
const DB_VERSION = 1;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
  
  return dbPromise;
}

export async function saveCapture(id, blob, filename, mimeType, consoleLogs = null, networkLogs = null, sourceUrl = null, deviceMeta = null) {
  const db = await openDB();
  const transaction = db.transaction([STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  
  const capture = {
    id,
    blob,
    filename,
    mimeType,
    timestamp: Date.now(),
    consoleLogs,    // Array of console log entries
    networkLogs,    // Array of network request entries
    sourceUrl,      // Original page URL
    deviceMeta,     // Device metadata (browser, OS, network, etc.)
  };
  
  return new Promise((resolve, reject) => {
    const request = store.put(capture);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getCapture(id) {
  const db = await openDB();
  const transaction = db.transaction([STORE_NAME], 'readonly');
  const store = transaction.objectStore(STORE_NAME);
  
  return new Promise((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteCapture(id) {
  const db = await openDB();
  const transaction = db.transaction([STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  
  return new Promise((resolve, reject) => {
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// Clean up captures older than 24 hours
export async function cleanupExpiredCaptures() {
  const db = await openDB();
  const transaction = db.transaction([STORE_NAME], 'readwrite');
  const store = transaction.objectStore(STORE_NAME);
  const index = store.index('timestamp');
  
  const cutoff = Date.now() - TTL_MS;
  const range = IDBKeyRange.upperBound(cutoff);
  
  return new Promise((resolve, reject) => {
    const request = index.openCursor(range);
    const deleted = [];
    
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        deleted.push(cursor.value.id);
        cursor.delete();
        cursor.continue();
      } else {
        resolve(deleted);
      }
    };
    
    request.onerror = () => reject(request.error);
  });
}

// Initialize cleanup on module load
cleanupExpiredCaptures().catch(console.error);
