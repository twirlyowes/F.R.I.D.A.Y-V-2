"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createResilientFirestore } = require("../lib/firestoreResilience");

function quotaError() {
  const error = new Error("Quota exceeded for this Firestore database");
  error.code = 8;
  return error;
}

function firestoreError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

class FakeSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.exists = data !== undefined;
    this._data = data === undefined ? undefined : clone(data);
    this.id = ref.id;
  }

  data() {
    return this.exists ? clone(this._data) : undefined;
  }

  get(field) {
    return this.exists ? this._data[field] : undefined;
  }
}

class FakeDocumentReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split("/").pop();
  }

  async get() {
    this.db.maybeFailRead();
    return new FakeSnapshot(this, this.db.docs.get(this.path));
  }

  async set(data, options) {
    this.db.maybeFailWrite();
    const current = this.db.docs.get(this.path);
    this.db.docs.set(
      this.path,
      options && options.merge ? { ...(current || {}), ...clone(data) } : clone(data)
    );
    return { writeTime: new Date() };
  }

  async update(data) {
    this.db.maybeFailWrite();
    const current = this.db.docs.get(this.path);
    if (!current) throw firestoreError(5, "No document to update: " + this.path);
    this.db.docs.set(this.path, { ...current, ...clone(data) });
    return { writeTime: new Date() };
  }

  async delete() {
    this.db.maybeFailWrite();
    this.db.docs.delete(this.path);
    return { writeTime: new Date() };
  }

  collection(name) {
    return new FakeCollectionReference(this.db, this.path + "/" + name);
  }
}

class FakeQuery {
  constructor(db, path, options = {}) {
    this.db = db;
    this.path = path;
    this.filters = options.filters || [];
    this.orders = options.orders || [];
    this.maxResults = options.maxResults == null ? null : options.maxResults;
    this.skip = options.skip || 0;
  }

  where(field, operator, value) {
    return new FakeQuery(this.db, this.path, {
      filters: [...this.filters, { field, operator, value }],
      orders: this.orders,
      maxResults: this.maxResults,
      skip: this.skip
    });
  }

  orderBy(field, direction = "asc") {
    return new FakeQuery(this.db, this.path, {
      filters: this.filters,
      orders: [...this.orders, { field, direction }],
      maxResults: this.maxResults,
      skip: this.skip
    });
  }

  limit(count) {
    return new FakeQuery(this.db, this.path, {
      filters: this.filters,
      orders: this.orders,
      maxResults: count,
      skip: this.skip
    });
  }

  offset(count) {
    return new FakeQuery(this.db, this.path, {
      filters: this.filters,
      orders: this.orders,
      maxResults: this.maxResults,
      skip: count
    });
  }

  async get() {
    this.db.maybeFailRead();
    const prefix = this.path + "/";
    let rows = [...this.db.docs.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
      .map(([path, data]) => ({ path, data }))
      .filter(({ data }) => this.filters.every(filter => {
        const actual = data[filter.field];
        if (filter.operator === "==") return actual === filter.value;
        if (filter.operator === "!=") return actual !== undefined && actual !== filter.value;
        if (filter.operator === ">") return actual > filter.value;
        if (filter.operator === ">=") return actual >= filter.value;
        if (filter.operator === "<") return actual < filter.value;
        if (filter.operator === "<=") return actual <= filter.value;
        throw new Error("Unsupported fake operator: " + filter.operator);
      }));

    for (const order of this.orders) {
      rows.sort((left, right) => {
        if (left.data[order.field] === right.data[order.field]) return 0;
        const comparison = left.data[order.field] < right.data[order.field] ? -1 : 1;
        return order.direction === "desc" ? -comparison : comparison;
      });
    }

    rows = rows.slice(this.skip);
    if (this.maxResults != null) rows = rows.slice(0, this.maxResults);
    const docs = rows.map(({ path, data }) => new FakeSnapshot(this.db.doc(path), data));
    return {
      docs,
      size: docs.length,
      empty: docs.length === 0,
      forEach: callback => docs.forEach(callback)
    };
  }
}

class FakeCollectionReference extends FakeQuery {
  doc(id) {
    const actualId = id == null ? "auto-" + (++this.db.autoId) : String(id);
    return this.db.doc(this.path + "/" + actualId);
  }

  async add(data) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

class FakeBatch {
  constructor(db) {
    this.db = db;
    this.operations = [];
  }

  set(ref, data, options) {
    this.operations.push({ type: "set", ref, data: clone(data), options });
    return this;
  }

  update(ref, data) {
    this.operations.push({ type: "update", ref, data: clone(data) });
    return this;
  }

  delete(ref) {
    this.operations.push({ type: "delete", ref });
    return this;
  }

  async commit() {
    this.db.maybeFailWrite();
    const next = new Map([...this.db.docs.entries()].map(([path, data]) => [path, clone(data)]));
    for (const operation of this.operations) {
      const path = operation.ref.path;
      if (operation.type === "update" && !next.has(path)) {
        throw firestoreError(5, "No document to update: " + path);
      }
      if (operation.type === "delete") {
        next.delete(path);
      } else if (operation.type === "set") {
        const current = next.get(path);
        next.set(path, operation.options && operation.options.merge
          ? { ...(current || {}), ...clone(operation.data) }
          : clone(operation.data));
      } else if (operation.type === "update") {
        next.set(path, { ...next.get(path), ...clone(operation.data) });
      }
    }
    this.db.docs = next;
    return this.operations.map(() => ({ writeTime: new Date() }));
  }
}

class FakeFirestore {
  constructor() {
    this.docs = new Map();
    this.failReads = false;
    this.failWrites = false;
    this.autoId = 0;
  }

  maybeFailRead() {
    if (this.failReads) throw quotaError();
  }

  maybeFailWrite() {
    if (this.failWrites) throw quotaError();
  }

  collection(path) {
    return new FakeCollectionReference(this, path);
  }

  doc(path) {
    return new FakeDocumentReference(this, path);
  }

  batch() {
    return new FakeBatch(this);
  }
}

function resilient(nativeDb) {
  const admin = { firestore: { Timestamp: { now: () => new Date() } } };
  return createResilientFirestore(nativeDb, admin);
}

test("cached collection queries keep working after quota fallback activates", async () => {
  const nativeDb = new FakeFirestore();
  nativeDb.docs.set("profiles/one", { team: "orange", score: 7 });
  nativeDb.docs.set("profiles/two", { team: "blue", score: 3 });
  const db = resilient(nativeDb);

  await db.collection("profiles").get(); // warm a complete collection snapshot
  nativeDb.failWrites = true;
  await db.collection("settings").doc("guild-1").set({ enabled: true });

  const result = await db.collection("profiles").where("team", "==", "orange").get();
  assert.equal(db.getResilienceStatus().mode, "fallback");
  assert.equal(result.size, 1);
  assert.equal(result.docs[0].id, "one");
  assert.equal(result.docs[0].data().score, 7);
});

test("uncached reads still use Firestore after a write quota triggers fallback", async () => {
  const nativeDb = new FakeFirestore();
  nativeDb.docs.set("profiles/untouched", { team: "purple" });
  const db = resilient(nativeDb);

  nativeDb.failWrites = true;
  await db.collection("settings").doc("trigger").set({ enabled: true });

  const result = await db.collection("profiles").doc("untouched").get();
  assert.equal(db.getResilienceStatus().mode, "fallback");
  assert.equal(db.getResilienceStatus().readQuotaExhausted, false);
  assert.equal(result.data().team, "purple");
});

test("cached reads keep working after read quota is exhausted", async () => {
  const nativeDb = new FakeFirestore();
  nativeDb.docs.set("profiles/cached", { team: "orange" });
  const db = resilient(nativeDb);
  await db.collection("profiles").doc("cached").get();

  nativeDb.failWrites = true;
  await db.collection("settings").doc("trigger").set({ enabled: true });
  nativeDb.failReads = true;

  const result = await db.collection("profiles").doc("cached").get();
  assert.equal(result.data().team, "orange");
  assert.equal(db.getResilienceStatus().readQuotaExhausted, true);

  await assert.rejects(
    db.collection("profiles").doc("never-cached").get(),
    /no cached document/
  );
});

test("an update to an uncached existing document queues for recovery without fabricating a complete read", async () => {
  const nativeDb = new FakeFirestore();
  nativeDb.docs.set("preferences/user-1", { theme: "dark", count: 1 });
  const db = resilient(nativeDb);

  nativeDb.failWrites = true;
  await db.collection("preferences").doc("user-1").update({ count: 2 });

  assert.equal(db.getResilienceStatus().pendingOperations, 1);

  // Reads still work after a write quota failure. The fallback overlays the
  // queued mutation on the server snapshot instead of returning stale fields.
  const optimistic = await db.collection("preferences").doc("user-1").get();
  assert.equal(optimistic.data().count, 2);
  assert.equal(db.getResilienceStatus().readQuotaExhausted, false);

  nativeDb.failWrites = false;
  await db.runRecoveryCheck();

  assert.equal(db.getResilienceStatus().mode, "normal");
  assert.equal(db.getResilienceStatus().pendingOperations, 0);
  const recovered = await db.collection("preferences").doc("user-1").get();
  assert.equal(recovered.data().count, 2);
});

test("an uncached partial document is not fabricated when reads are also quota-blocked", async () => {
  const nativeDb = new FakeFirestore();
  nativeDb.docs.set("preferences/user-2", { theme: "light", count: 4 });
  const db = resilient(nativeDb);

  nativeDb.failWrites = true;
  await db.collection("preferences").doc("user-2").update({ count: 5 });
  nativeDb.failReads = true;

  await assert.rejects(
    db.collection("preferences").doc("user-2").get(),
    /partial cached data/
  );
  assert.equal(db.getResilienceStatus().readQuotaExhausted, true);

  nativeDb.failReads = false;
  nativeDb.failWrites = false;
  await db.runRecoveryCheck();
  const recovered = await db.collection("preferences").doc("user-2").get();
  assert.equal(recovered.data().count, 5);
});

test("an uncached partial document is not fabricated when reads are also quota-blocked", async () => {
  const nativeDb = new FakeFirestore();
  nativeDb.docs.set("preferences/user-2", { theme: "light", count: 4 });
  const db = resilient(nativeDb);

  nativeDb.failWrites = true;
  await db.collection("preferences").doc("user-2").update({ count: 5 });
  nativeDb.failReads = true;

  await assert.rejects(
    db.collection("preferences").doc("user-2").get(),
    /partial cached data/
  );
  assert.equal(db.getResilienceStatus().readQuotaExhausted, true);

  nativeDb.failReads = false;
  nativeDb.failWrites = false;
  await db.runRecoveryCheck();
  const recovered = await db.collection("preferences").doc("user-2").get();
  assert.equal(recovered.data().count, 5);
});

test("a permanently invalid queued update does not block later valid writes from recovering", async () => {
  const nativeDb = new FakeFirestore();
  const db = resilient(nativeDb);

  nativeDb.failWrites = true;
  await db.collection("preferences").doc("missing-user").update({ count: 2 });
  await db.collection("preferences").doc("valid-user").set({ count: 3 });

  nativeDb.failWrites = false;
  await db.runRecoveryCheck();

  assert.equal(db.getResilienceStatus().mode, "normal");
  assert.equal(db.getResilienceStatus().pendingOperations, 0);
  assert.equal(db.getResilienceStatus().failedRecoveryGroups, 1);
  const recovered = await db.collection("preferences").doc("valid-user").get();
  assert.equal(recovered.data().count, 3);
});

test("a fallback transaction above Firestore's 500-write limit is rejected atomically", async () => {
  const nativeDb = new FakeFirestore();
  const db = resilient(nativeDb);

  nativeDb.failWrites = true;
  await db.collection("settings").doc("trigger").set({ fallback: true });
  assert.equal(db.getResilienceStatus().mode, "fallback");
  assert.equal(db.getResilienceStatus().pendingOperations, 1);

  await assert.rejects(
    db.runTransaction(async transaction => {
      for (let index = 0; index < 501; index += 1) {
        transaction.set(db.collection("items").doc("item-" + index), { index });
      }
    }),
    /cannot queue more than 500 writes/
  );

  assert.equal(db.getResilienceStatus().pendingOperations, 1);
});
