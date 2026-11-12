// 訳文と照合用のハッシュだけを拡張の IndexedDB に置く。
const MAX_ENTRIES = 1000;
const STORE = "translations";

async function withStore(work) {
  /** @type {IDBDatabase} */
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open("lingo-translations", 1);
    open.onupgradeneeded = () => {
      const store = open.result.createObjectStore(STORE, { keyPath: "key" });
      store.createIndex("lastUsed", "lastUsed");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve(undefined);
      tx.onabort = () => reject(tx.error);
      work(tx.objectStore(STORE));
    });
  } finally {
    db.close();
  }
}

export async function lookupTranslations(scope, batch) {
  const keys = new Map();
  const found = new Map();
  if (scope) {
    try {
      await Promise.all(
        batch.map(async (item) => {
          const input = JSON.stringify([1, ...scope, item.format ?? "text", item.text]);
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
          keys.set(item.id, btoa(String.fromCharCode(...new Uint8Array(digest))));
        }),
      );
      await withStore((store) => {
        for (const key of new Set(keys.values())) {
          const request = store.get(key);
          request.onsuccess = () => {
            if (!request.result) return;
            found.set(key, request.result.text);
            store.put({ ...request.result, lastUsed: performance.timeOrigin + performance.now() });
          };
        }
      });
    } catch {
      // 保存領域を利用できない場合も通常どおり翻訳する。
      found.clear();
      keys.clear();
    }
  }
  const hits = [],
    missing = [];
  for (const item of batch) {
    const text = found.get(keys.get(item.id));
    if (text === undefined) missing.push(item);
    else hits.push({ id: item.id, text });
  }
  return { keys, hits, missing };
}

export async function saveTranslations(keys, translations) {
  if (!keys.size) return;
  try {
    await withStore((store) => {
      for (const { id, text } of translations)
        store.put({ key: keys.get(id), text, lastUsed: performance.timeOrigin + performance.now() });
      const count = store.count();
      count.onsuccess = () => {
        let excess = count.result - MAX_ENTRIES;
        if (excess <= 0) return;
        const oldest = store.index("lastUsed").openKeyCursor();
        oldest.onsuccess = () => {
          const cursor = oldest.result;
          if (!cursor) return;
          store.delete(cursor.primaryKey);
          if (--excess > 0) cursor.continue();
        };
      };
    });
  } catch {
    // 容量不足などで保存できなくても、取得した訳文は使える。
  }
}
