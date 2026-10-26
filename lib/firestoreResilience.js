"use strict";

/*
 * Firestore quota resilience for FRIDAY.
 *
 * Successfully read/written documents are cached. During quota exhaustion,
 * supported cached reads use the local cache and writes are queued in memory.
 * Unknown/partial reads fail safely instead of inventing empty data.
 *
 * IMPORTANT: cache and write queue are process-memory only. Restarting or
 * redeploying Render during fallback can lose unsynchronized changes.
 */

const WRAPPED = new WeakMap();
const DELETE_FIELD = Symbol("friday.deleteField");
const MAX_PENDING_OPERATIONS = 10000;
const MAX_CACHED_DOCUMENTS = 20000;
const MAX_CACHED_QUERIES = 1000;
const MAX_RECOVERY_OPERATIONS = 2000;

function createResilientFirestore(nativeDb, admin) {
  const documents = new Map();
  const completeCollections = new Set();
  const queryCache = new Map();
  const changedPaths = new Set();
  const wrappers = new Map();
  const pendingWrites = [];

  let pendingOperations = 0;
  let mode = "normal";
  let fallbackStartedAt = null;
  let discordClient = null;
  let recoveryTimer = null;
  let recoveryRunning = false;
  let lastOwnerNoticeAt = 0;
  const pendingOwnerMessages = [];

  const timestampNow = () => {
    try { return admin.firestore.Timestamp.now(); } catch { return new Date(); }
  };

  function describeError(error) {
    return [error && error.code, error && error.message, error && error.details,
      error && error.toString && error.toString()].filter(Boolean).join(" ");
  }

  function isQuotaError(error) {
    const text = describeError(error).toLowerCase();
    const code = String(error && error.code != null ? error.code : "").toLowerCase();
    const exhausted = code === "8" || code === "resource-exhausted" ||
      code === "resource_exhausted" || text.includes("resource_exhausted") ||
      text.includes("resource-exhausted");
    const explicitQuota = /quota.{0,80}(exceed|limit|exhaust|reached)|(?:exceed|exhaust|reached).{0,80}quota|daily.{0,40}(limit|quota)|free[- ]tier.{0,40}(limit|exceed)/.test(text);
    // Do not switch modes for generic RESOURCE_EXHAUSTED / transient
    // throttling unless the error also indicates a quota or limit.
    return explicitQuota || (exhausted && /quota|limit|exceed/.test(text));
  }

  function ownerIds() {
    return [...new Set(String(process.env.OWNER_ID || "").split(",")
      .map(id => id.trim()).filter(id => /^\d{17,20}$/.test(id)))];
  }

  async function sendToOwners(message) {
    const ids = ownerIds();
    if (!ids.length) {
      console.warn("[FirestoreResilience] OWNER_ID is missing or has no valid Discord user IDs; owner DM skipped.");
      return;
    }
    if (!discordClient || !discordClient.isReady || !discordClient.isReady()) {
      pendingOwnerMessages.push(message);
      return;
    }
    for (const id of ids) {
      try {
        const user = await discordClient.users.fetch(id);
        await user.send(message);
      } catch (error) {
        console.warn("[FirestoreResilience] Could not DM owner " + id + ":", error && error.message || error);
      }
    }
  }

  function flushPendingOwnerMessages() {
    if (!discordClient || !discordClient.isReady || !discordClient.isReady() || !pendingOwnerMessages.length) return;
    const messages = pendingOwnerMessages.splice(0, pendingOwnerMessages.length);
    for (const message of messages) void sendToOwners(message);
  }

  function attachClient(client) {
    discordClient = client || null;
    if (!discordClient) return;
    if (discordClient.isReady && discordClient.isReady()) {
      flushPendingOwnerMessages();
    } else {
      if (discordClient.on) {
        discordClient.on("ready", flushPendingOwnerMessages);
        discordClient.on("clientReady", flushPendingOwnerMessages);
      }
    }
  }

  function formatFallbackNotice() {
    return [
      "⚠️ **Firestore quota exhausted — FRIDAY is switching to temporary in-memory storage.**",
      "",
      "Firestore rejected a database operation because a quota/usage limit was reached.",
      "FRIDAY is now using cached/in-memory data for operations it can safely serve.",
      "Queued changes will be synchronized when Firestore becomes available again.",
      "",
      "**Pending write operations:** " + pendingOperations,
      "**Detected:** <t:" + Math.floor(Date.now() / 1000) + ":F>",
      "",
      "⚠️ This fallback cache and queue currently live in process memory. Do not restart or redeploy FRIDAY before recovery; a restart can lose unsynchronized changes."
    ].join("\n");
  }

  function formatRecoveryNotice() {
    return [
      "✅ **Firestore is available again.**",
      "FRIDAY synchronized its pending in-memory writes and returned to normal Firestore mode.",
      "**Recovered at:** <t:" + Math.floor(Date.now() / 1000) + ":F>"
    ].join("\n");
  }

  function enterFallback(error) {
    if (mode !== "normal") return;
    mode = "fallback";
    fallbackStartedAt = Date.now();
    console.error("[FirestoreResilience] Quota exhaustion detected; switching to in-memory fallback.", describeError(error));
    if (Date.now() - lastOwnerNoticeAt > 60 * 60 * 1000) {
      lastOwnerNoticeAt = Date.now();
      // Queue the DM after the failing operation can enter the fallback queue.
      queueMicrotask(() => void sendToOwners(formatFallbackNotice()));
    }
    scheduleRecoveryAtNextPacificReset();
  }

  function getNextPacificResetDelay(nowMs = Date.now()) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    });
    const partsFor = date => Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    const currentParts = partsFor(new Date(nowMs));
    const currentKey = currentParts.year + "-" + currentParts.month + "-" + currentParts.day;
    const end = nowMs + 28 * 60 * 60 * 1000;
    for (let tick = Math.floor(nowMs / 60000) * 60000 + 60000; tick <= end; tick += 60000) {
      const parts = partsFor(new Date(tick));
      const key = parts.year + "-" + parts.month + "-" + parts.day;
      if (key !== currentKey && parts.hour === "00" && parts.minute === "05") {
        return Math.max(1000, tick - nowMs);
      }
    }
    return 24 * 60 * 60 * 1000;
  }

  function scheduleRecoveryAtNextPacificReset() {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    const delay = getNextPacificResetDelay();
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      void attemptRecovery();
    }, delay);
    if (recoveryTimer.unref) recoveryTimer.unref();
    console.log("[FirestoreResilience] Recovery check scheduled in about " + Math.round(delay / 60000) + " minute(s), after the next Pacific-time quota reset.");
  }

  function scheduleRecoveryRetry(delayMs = 5 * 60 * 1000) {
    if (recoveryTimer) clearTimeout(recoveryTimer);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      void attemptRecovery();
    }, delayMs);
    if (recoveryTimer.unref) recoveryTimer.unref();
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof Date) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function cloneValue(value) {
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return Buffer.from(value);
    if (typeof value.toDate === "function" && typeof value.toMillis === "function") return value;
    if (Array.isArray(value)) return value.map(cloneValue);
    if (!isPlainObject(value)) return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = cloneValue(child);
    return output;
  }

  function transformName(value) {
    return String((value && (value._methodName || value._method)) ||
      (value && value.constructor && value.constructor.name) || "").toLowerCase();
  }

  function normalizeForMemory(value) {
    if (value === null || value === undefined || typeof value !== "object") return value;
    const name = transformName(value);
    if (name.includes("servertimestamp") || name.includes("server_timestamp")) return timestampNow();
    if (name.includes("deletefield") || name === "delete") return DELETE_FIELD;
    if (value instanceof Date) return new Date(value.getTime());
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return Buffer.from(value);
    if (typeof value.toDate === "function" && typeof value.toMillis === "function") return value;
    if (Array.isArray(value)) return value.map(normalizeForMemory);
    if (!isPlainObject(value)) return value;
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = normalizeForMemory(child);
    return output;
  }

  function isDeepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a && typeof a.isEqual === "function") {
      try { return a.isEqual(b); } catch {}
    }
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }

  function deepMerge(base, patch) {
    const output = isPlainObject(base) ? cloneValue(base) : {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (value === DELETE_FIELD) delete output[key];
      else if (isPlainObject(value) && isPlainObject(output[key])) output[key] = deepMerge(output[key], value);
      else output[key] = cloneValue(value);
    }
    return output;
  }

  function getField(data, field) {
    if (!data) return undefined;
    return String(field).split(".").reduce((value, key) => value == null ? undefined : value[key], data);
  }

  function setField(data, field, value) {
    const parts = String(field).split(".");
    let cursor = data;
    for (const part of parts.slice(0, -1)) {
      if (!isPlainObject(cursor[part])) cursor[part] = {};
      cursor = cursor[part];
    }
    const key = parts[parts.length - 1];
    if (value === DELETE_FIELD) delete cursor[key];
    else cursor[key] = cloneValue(value);
  }

  function resolveTransform(value, current) {
    const name = transformName(value);
    if (name.includes("servertimestamp") || name.includes("server_timestamp")) return timestampNow();
    if (name.includes("deletefield") || name === "delete") return DELETE_FIELD;
    if (name.includes("increment")) {
      const operand = Number(value._operand != null ? value._operand : (value._elements && value._elements[0]) || 0);
      return Number(current || 0) + operand;
    }
    if (name.includes("arrayunion")) {
      const elements = value._elements || [];
      const output = Array.isArray(current) ? current.slice() : [];
      for (const item of elements) if (!output.some(existing => isDeepEqual(existing, item))) output.push(cloneValue(item));
      return output;
    }
    if (name.includes("arrayremove")) {
      const elements = value._elements || [];
      return (Array.isArray(current) ? current : []).filter(existing => !elements.some(item => isDeepEqual(existing, item)));
    }
    return normalizeForMemory(value);
  }

  function stageOperations(operations, strict = false) {
    const staged = new Map();
    const changed = new Set();

    for (const operation of operations) {
      const path = operation.path;
      if (!path) throw new Error("Firestore fallback cannot identify a document path.");
      const before = staged.has(path) ? staged.get(path) : documents.get(path);
      let entry = before ? {
        exists: before.exists,
        full: before.full,
        data: before.exists ? cloneValue(before.data) : undefined
      } : undefined;

      if (operation.type === "delete") {
        entry = { exists: false, full: true, data: undefined };
      } else if (operation.type === "set") {
        const incoming = normalizeForMemory(operation.data || {});
        const merge = Boolean(operation.options && (operation.options.merge || operation.options.mergeFields));
        if (!merge) {
          entry = { exists: true, full: true, data: cloneValue(incoming) };
        } else {
          const base = entry && entry.exists ? entry.data : {};
          const knownMissing = Boolean(entry && !entry.exists);
          entry = { exists: true, full: Boolean((entry && entry.full) || knownMissing), data: deepMerge(base, incoming) };
        }
      } else if (operation.type === "update") {
        if (strict && (!entry || !entry.exists || !entry.full)) {
          throw new Error("FRIDAY in-memory fallback has no complete cached document for update: " + path + ". The write was not accepted.");
        }
        const data = entry && entry.exists ? cloneValue(entry.data || {}) : {};
        for (const [field, rawValue] of Object.entries(operation.data || {})) {
          setField(data, field, resolveTransform(rawValue, getField(data, field)));
        }
        entry = { exists: true, full: Boolean(entry && entry.full), data };
      } else {
        throw new Error("Unsupported Firestore fallback operation: " + operation.type);
      }

      staged.set(path, entry);
      changed.add(path);
    }
    return { staged, changed };
  }

  function rememberDocument(path, entry) {
    documents.delete(path);
    documents.set(path, entry);
    if (documents.size > MAX_CACHED_DOCUMENTS) {
      documents.delete(documents.keys().next().value);
      queryCache.clear();
      completeCollections.clear();
      changedPaths.clear();
    }
  }

  function applyStaged(staged, changed) {
    for (const [path, entry] of staged) rememberDocument(path, entry);
    for (const path of changed) changedPaths.add(path);
  }

  function enqueueAndApply(operations) {
    if (!operations.length) return;
    if (pendingOperations + operations.length > MAX_PENDING_OPERATIONS) {
      throw new Error("FRIDAY fallback write queue is full (" + MAX_PENDING_OPERATIONS + " operations). The write was rejected to avoid silently losing data.");
    }
    const staged = stageOperations(operations, true);
    pendingWrites.push({ operations: operations.map(operation => ({ ...operation })), queuedAt: Date.now() });
    pendingOperations += operations.length;
    applyStaged(staged.staged, staged.changed);
  }

  function updateCacheAfterSuccess(operations) {
    if (!operations.length) return;
    const staged = stageOperations(operations, false);
    applyStaged(staged.staged, staged.changed);
  }

  function cacheDocumentSnapshot(snapshot) {
    const path = snapshot && snapshot.ref && snapshot.ref.path;
    if (!path) return;
    if (!snapshot.exists) {
      rememberDocument(path, { exists: false, full: true, data: undefined });
      return;
    }
    rememberDocument(path, { exists: true, full: true, data: cloneValue(snapshot.data() || {}) });
  }

  function isDirectChild(documentPath, collectionPath) {
    const prefix = collectionPath + "/";
    if (!documentPath.startsWith(prefix)) return false;
    return !documentPath.slice(prefix.length).includes("/");
  }

  function queryKey(descriptor) {
    const encode = value => {
      if (value instanceof Date) return { __date: value.getTime() };
      if (value && typeof value.toMillis === "function") return { __timestamp: value.toMillis() };
      if (Array.isArray(value)) return value.map(encode);
      if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, encode(value[key])]));
      return value;
    };
    return JSON.stringify(encode({
      path: descriptor.path, filters: descriptor.filters, orders: descriptor.orders,
      limit: descriptor.limit, offset: descriptor.offset
    }));
  }

  function cacheQuerySnapshot(descriptor, snapshot) {
    const docs = snapshot.docs || [];
    const key = queryKey(descriptor);

    // Do not copy large query snapshots wholesale into memory.
    if (docs.length > MAX_CACHED_DOCUMENTS) {
      queryCache.delete(key);
      completeCollections.delete(descriptor.path);
      return;
    }

    for (const doc of docs) cacheDocumentSnapshot(doc);
    const paths = docs.map(doc => doc.ref.path);
    const allStillCached = paths.every(path => {
      const entry = documents.get(path);
      return entry && entry.exists && entry.full;
    });
    if (!allStillCached) {
      queryCache.delete(key);
      completeCollections.delete(descriptor.path);
      return;
    }

    queryCache.delete(key);
    queryCache.set(key, paths);
    while (queryCache.size > MAX_CACHED_QUERIES) {
      queryCache.delete(queryCache.keys().next().value);
    }

    if (!descriptor.filters.length && !descriptor.orders.length &&
        descriptor.limit == null && !descriptor.offset) {
      completeCollections.add(descriptor.path);
    }
  }

  function comparable(value) {
    if (value instanceof Date) return value.getTime();
    if (value && typeof value.toMillis === "function") return value.toMillis();
    if (value && typeof value.toDate === "function") return value.toDate().getTime();
    return value;
  }

  function matchesFilter(data, filter) {
    const actual = comparable(getField(data, filter.field));
    const expected = comparable(filter.value);
    switch (filter.operator) {
      case "==": return isDeepEqual(actual, expected);
      case "!=": return actual !== undefined && !isDeepEqual(actual, expected);
      case "<": return actual < expected;
      case "<=": return actual <= expected;
      case ">": return actual > expected;
      case ">=": return actual >= expected;
      case "in": return Array.isArray(expected) && expected.some(value => isDeepEqual(actual, comparable(value)));
      case "not-in": return Array.isArray(expected) && actual !== undefined && !expected.some(value => isDeepEqual(actual, comparable(value)));
      case "array-contains": return Array.isArray(actual) && actual.some(value => isDeepEqual(value, expected));
      case "array-contains-any": return Array.isArray(actual) && Array.isArray(expected) && actual.some(value => expected.some(item => isDeepEqual(value, comparable(item))));
      default: throw new Error("FRIDAY fallback does not support Firestore query operator " + JSON.stringify(filter.operator) + ".");
    }
  }

  function makeLocalDocumentSnapshot(path, entry) {
    const rawRef = nativeDb.doc(path);
    const ref = wrapDocumentReference(rawRef);
    const exists = Boolean(entry && entry.exists);
    const data = exists ? cloneValue(entry.data || {}) : undefined;
    return {
      id: rawRef.id,
      ref,
      exists,
      createTime: undefined,
      updateTime: undefined,
      readTime: undefined,
      data: () => exists ? cloneValue(data) : undefined,
      get: field => exists ? cloneValue(getField(data, field)) : undefined,
      isEqual: other => Boolean(other && other.ref && other.ref.path === path)
    };
  }

  function makeLocalQuerySnapshot(descriptor) {
    const key = queryKey(descriptor);
    let candidates;
    if (completeCollections.has(descriptor.path)) {
      candidates = new Set([...documents.keys()].filter(path => isDirectChild(path, descriptor.path)));
    } else if (queryCache.has(key)) {
      candidates = new Set(queryCache.get(key));
      for (const path of changedPaths) if (isDirectChild(path, descriptor.path)) candidates.add(path);
    } else {
      throw new Error("FRIDAY in-memory fallback has no cached result for query on " + JSON.stringify(descriptor.path) + ". Unknown query results are not fabricated.");
    }

    let rows = [];
    for (const path of candidates) {
      const entry = documents.get(path);
      if (!entry || !entry.exists) continue;
      if (!entry.full) {
        throw new Error("FRIDAY in-memory fallback has only partial cached data for " + path + "; refusing to return an incomplete query result.");
      }
      const data = entry.data || {};
      if (descriptor.filters.every(filter => matchesFilter(data, filter))) rows.push({ path, data, entry });
    }

    for (const order of descriptor.orders) {
      rows.sort((a, b) => {
        const left = comparable(getField(a.data, order.field));
        const right = comparable(getField(b.data, order.field));
        if (left === undefined && right !== undefined) return 1;
        if (right === undefined && left !== undefined) return -1;
        if (left === right) return 0;
        const result = left < right ? -1 : 1;
        return order.direction === "desc" ? -result : result;
      });
    }
    if (descriptor.offset) rows = rows.slice(descriptor.offset);
    if (descriptor.limit != null) rows = rows.slice(0, descriptor.limit);

    const docs = rows.map(row => makeLocalDocumentSnapshot(row.path, row.entry));
    return {
      docs, size: docs.length, empty: docs.length === 0,
      readTime: undefined, docChanges: () => [], forEach: callback => docs.forEach(callback)
    };
  }

  function getLocalDocument(path) {
    const entry = documents.get(path);
    if (!entry) throw new Error("FRIDAY in-memory fallback has no cached document for " + path + ". Unknown data is not treated as missing.");
    if (entry.exists && !entry.full) throw new Error("FRIDAY in-memory fallback has only partial cached data for " + path + "; refusing to return incomplete data.");
    return makeLocalDocumentSnapshot(path, entry);
  }

  function unwrap(reference) {
    return WRAPPED.get(reference)?.native || reference;
  }

  function pathOf(reference) {
    return (WRAPPED.get(reference) && WRAPPED.get(reference).path) || unwrap(reference)?.path;
  }

  async function readOrFallback(nativeRead, localRead) {
    if (mode !== "normal") return localRead();
    try { return await nativeRead(); }
    catch (error) {
      if (!isQuotaError(error)) throw error;
      enterFallback(error);
      return localRead();
    }
  }

  function fakeWriteResult() {
    return { writeTime: timestampNow(), fallback: true };
  }

  async function writeOrFallback(nativeWrite, operations) {
    if (mode !== "normal") {
      enqueueAndApply(operations);
      return fakeWriteResult();
    }
    try {
      const result = await nativeWrite();
      updateCacheAfterSuccess(operations);
      return result;
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      enterFallback(error);
      enqueueAndApply(operations);
      return fakeWriteResult();
    }
  }

  function wrapDocumentReference(reference) {
    const path = reference.path;
    const cacheKey = "doc:" + path;
    if (wrappers.has(cacheKey)) return wrappers.get(cacheKey);

    const wrapped = new Proxy(reference, {
      get(target, property) {
        if (property === "get") {
          return () => readOrFallback(async () => {
            const snapshot = await target.get();
            cacheDocumentSnapshot(snapshot);
            return snapshot;
          }, () => getLocalDocument(path));
        }
        if (property === "set") {
          return (data, options) => writeOrFallback(() => target.set(data, options), [
            { type: "set", path, data: cloneValue(data), options: options ? { ...options } : undefined }
          ]);
        }
        if (property === "update") {
          return data => writeOrFallback(() => target.update(data), [
            { type: "update", path, data: cloneValue(data) }
          ]);
        }
        if (property === "delete") {
          return () => writeOrFallback(() => target.delete(), [{ type: "delete", path }]);
        }
        if (property === "collection") return name => wrapCollectionReference(target.collection(name));
        if (property === "parent") return wrapCollectionReference(target.parent);
        if (property === "firestore") return dbProxy;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    WRAPPED.set(wrapped, { kind: "document", native: reference, path });
    wrappers.set(cacheKey, wrapped);
    return wrapped;
  }

  function wrapCollectionReference(collection) {
    return wrapQuery(collection, {
      path: collection.path, filters: [], orders: [], limit: null, offset: 0
    }, true);
  }

  function wrapQuery(query, descriptor, isCollectionReference = false) {
    const desc = {
      path: descriptor.path,
      filters: descriptor.filters.slice(),
      orders: descriptor.orders.slice(),
      limit: descriptor.limit,
      offset: descriptor.offset
    };

    const wrapped = new Proxy(query, {
      get(target, property) {
        if (property === "get") {
          return () => readOrFallback(async () => {
            const snapshot = await target.get();
            cacheQuerySnapshot(desc, snapshot);
            return snapshot;
          }, () => makeLocalQuerySnapshot(desc));
        }
        if (property === "where") {
          return (field, operator, value) => wrapQuery(target.where(field, operator, value), {
            ...desc,
            filters: [...desc.filters, {
              field: typeof field === "string" ? field : String(field),
              operator, value: cloneValue(value)
            }]
          }, false);
        }
        if (property === "orderBy") {
          return (field, direction = "asc") => wrapQuery(target.orderBy(field, direction), {
            ...desc,
            orders: [...desc.orders, {
              field: typeof field === "string" ? field : String(field), direction
            }]
          }, false);
        }
        if (property === "limit") {
          return count => wrapQuery(target.limit(count), { ...desc, limit: Number(count) }, false);
        }
        if (property === "offset") {
          return count => wrapQuery(target.offset(count), { ...desc, offset: Number(count) }, false);
        }
        if (isCollectionReference && property === "doc") {
          return id => wrapDocumentReference(id == null ? target.doc() : target.doc(id));
        }
        if (isCollectionReference && property === "add") {
          return async data => {
            if (mode !== "normal") {
              const reference = target.doc();
              enqueueAndApply([{ type: "set", path: reference.path, data: cloneValue(data) }]);
              return wrapDocumentReference(reference);
            }
            try {
              const reference = await target.add(data);
              updateCacheAfterSuccess([{ type: "set", path: reference.path, data: cloneValue(data) }]);
              return wrapDocumentReference(reference);
            } catch (error) {
              if (!isQuotaError(error)) throw error;
              enterFallback(error);
              const reference = target.doc();
              enqueueAndApply([{ type: "set", path: reference.path, data: cloneValue(data) }]);
              return wrapDocumentReference(reference);
            }
          };
        }
        if (property === "parent") return target.parent ? wrapCollectionReference(target.parent) : target.parent;
        if (property === "firestore") return dbProxy;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    WRAPPED.set(wrapped, { kind: isCollectionReference ? "collection" : "query", native: query, descriptor: desc, path: desc.path });
    return wrapped;
  }

  function wrapBatch(nativeBatch) {
    const operations = [];
    const wrapper = {
      set(reference, data, options) {
        operations.push({ type: "set", path: pathOf(reference), data: cloneValue(data), options: options ? { ...options } : undefined });
        nativeBatch.set(unwrap(reference), data, options);
        return wrapper;
      },
      update(reference, data) {
        operations.push({ type: "update", path: pathOf(reference), data: cloneValue(data) });
        nativeBatch.update(unwrap(reference), data);
        return wrapper;
      },
      delete(reference) {
        operations.push({ type: "delete", path: pathOf(reference) });
        nativeBatch.delete(unwrap(reference));
        return wrapper;
      },
      async commit() {
        if (mode !== "normal") {
          enqueueAndApply(operations);
          return operations.map(fakeWriteResult);
        }
        try {
          const result = await nativeBatch.commit();
          updateCacheAfterSuccess(operations);
          return result;
        } catch (error) {
          if (!isQuotaError(error)) throw error;
          enterFallback(error);
          enqueueAndApply(operations);
          return operations.map(fakeWriteResult);
        }
      }
    };
    return wrapper;
  }

  function makeLocalTransaction() {
    const operations = [];
    const transaction = {
      async get(reference) { return getLocalDocument(pathOf(reference)); },
      set(reference, data, options) {
        operations.push({ type: "set", path: pathOf(reference), data: cloneValue(data), options: options ? { ...options } : undefined });
        return transaction;
      },
      update(reference, data) {
        operations.push({ type: "update", path: pathOf(reference), data: cloneValue(data) });
        return transaction;
      },
      delete(reference) {
        operations.push({ type: "delete", path: pathOf(reference) });
        return transaction;
      }
    };
    return { transaction, operations };
  }

  async function runTransaction(updateFunction, options) {
    if (mode !== "normal") {
      const local = makeLocalTransaction();
      const result = await updateFunction(local.transaction);
      enqueueAndApply(local.operations);
      return result;
    }

    let lastOperations = [];
    try {
      const result = await nativeDb.runTransaction(async nativeTransaction => {
        const operations = [];
        const facade = {
          async get(reference) {
            const snapshot = await nativeTransaction.get(unwrap(reference));
            cacheDocumentSnapshot(snapshot);
            return snapshot;
          },
          set(reference, data, setOptions) {
            operations.push({ type: "set", path: pathOf(reference), data: cloneValue(data), options: setOptions ? { ...setOptions } : undefined });
            nativeTransaction.set(unwrap(reference), data, setOptions);
            return facade;
          },
          update(reference, data) {
            operations.push({ type: "update", path: pathOf(reference), data: cloneValue(data) });
            nativeTransaction.update(unwrap(reference), data);
            return facade;
          },
          delete(reference) {
            operations.push({ type: "delete", path: pathOf(reference) });
            nativeTransaction.delete(unwrap(reference));
            return facade;
          }
        };
        const callbackResult = await updateFunction(facade);
        lastOperations = operations;
        return callbackResult;
      }, options);

      updateCacheAfterSuccess(lastOperations);
      return result;
    } catch (error) {
      if (!isQuotaError(error)) throw error;
      enterFallback(error);
      const local = makeLocalTransaction();
      const result = await updateFunction(local.transaction);
      enqueueAndApply(local.operations);
      return result;
    }
  }

  async function applyQueuedOperation(operation) {
    const reference = nativeDb.doc(operation.path);
    if (operation.type === "set") await reference.set(operation.data, operation.options);
    else if (operation.type === "update") await reference.update(operation.data);
    else if (operation.type === "delete") await reference.delete();
    else throw new Error("Unknown queued Firestore operation: " + operation.type);
  }

  async function applyQueuedGroup(group) {
    const operations = group.operations;
    if (operations.length === 1) return applyQueuedOperation(operations[0]);

    // Keep original batches atomic when they fit Firestore's 500-write limit.
    // Oversized batches are split because they cannot be committed as one batch.
    const chunkSize = operations.length <= 500 ? operations.length : 400;
    for (let start = 0; start < operations.length; start += chunkSize) {
      const batch = nativeDb.batch();
      for (const operation of operations.slice(start, start + chunkSize)) {
        const reference = nativeDb.doc(operation.path);
        if (operation.type === "set") batch.set(reference, operation.data, operation.options);
        else if (operation.type === "update") batch.update(reference, operation.data);
        else if (operation.type === "delete") batch.delete(reference);
      }
      await batch.commit();
    }
  }

  async function attemptRecovery() {
    if (recoveryRunning || mode !== "fallback") return;
    recoveryRunning = true;
    mode = "recovering";
    let attempted = 0;

    try {
      while (pendingWrites.length && attempted < MAX_RECOVERY_OPERATIONS) {
        const group = pendingWrites[0];
        await applyQueuedGroup(group);
        pendingWrites.shift();
        pendingOperations -= group.operations.length;
        attempted += group.operations.length;
        if (attempted >= MAX_RECOVERY_OPERATIONS) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }

      if (pendingWrites.length) {
        mode = "fallback";
        scheduleRecoveryRetry(60 * 1000);
        console.log("[FirestoreResilience] Recovery paused after " + attempted + " write(s); " + pendingOperations + " operation(s) remain queued.");
        return;
      }

      // A write queue can drain while the read quota remains exhausted.
      await nativeDb.collection("_friday_health").doc("quota-probe").get();

      mode = "normal";
      fallbackStartedAt = null;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = null;
      void sendToOwners(formatRecoveryNotice());
      console.log("[FirestoreResilience] Firestore recovery verified; returned to normal mode.");
    } catch (error) {
      mode = "fallback";
      console.error("[FirestoreResilience] Recovery/synchronization failed; queued writes were retained:", describeError(error));
      if (isQuotaError(error)) scheduleRecoveryAtNextPacificReset();
      else scheduleRecoveryRetry(5 * 60 * 1000);
    } finally {
      recoveryRunning = false;
    }
  }

  function getResilienceStatus() {
    return {
      mode,
      fallbackStartedAt,
      pendingOperations,
      cachedDocuments: documents.size,
      cachedCompleteCollections: completeCollections.size,
      lastOwnerNoticeAt
    };
  }

  let dbProxy;
  dbProxy = new Proxy(nativeDb, {
    get(target, property) {
      if (property === "db") return dbProxy;
      if (property === "attachClient") return attachClient;
      if (property === "getResilienceStatus") return getResilienceStatus;
      if (property === "collection") return path => wrapCollectionReference(target.collection(path));
      if (property === "batch") return () => wrapBatch(target.batch());
      if (property === "runTransaction") return runTransaction;
      if (property === "collectionGroup") {
        return name => wrapQuery(target.collectionGroup(name), {
          path: "__collectionGroup__/" + name, filters: [], orders: [], limit: null, offset: 0
        }, false);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  return dbProxy;
}

module.exports = { createResilientFirestore };
