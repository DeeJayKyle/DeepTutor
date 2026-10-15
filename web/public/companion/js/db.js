// Offline-first local database (IndexedDB). One database per signed-in tutor,
// so workspaces stay separate on shared devices. Every record carries
// createdAt/updatedAt and a revision counter used by backup conflict checks.

import { nowIso, uid } from "./util.js";

export const SCHEMA_VERSION = 1;

/** Record stores included in backups (files are optional, see backup.js). */
export const DATA_STORES = [
  "classes",
  "units",
  "resources",
  "materials",
  "students",
  "assessments",
  "marks",
  "research",
  "settings",
  "audit",
];
export const FILE_STORE = "files";

const INDEXES = {
  units: ["classId"],
  resources: ["classId", "unitId"],
  materials: ["classId", "unitId", "kind"],
  students: ["classId"],
  assessments: ["classId", "unitId"],
  marks: ["assessmentId", "studentId"],
  research: ["classId", "unitId"],
  audit: ["at"],
};

// Migrations are applied in order when the stored version is older.
const MIGRATIONS = [
  (db) => {
    for (const name of [...DATA_STORES, FILE_STORE, "meta"]) {
      if (db.objectStoreNames.contains(name)) continue;
      const store = db.createObjectStore(name, { keyPath: "id" });
      for (const index of INDEXES[name] ?? []) store.createIndex(index, index, { unique: false });
    }
  },
];

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class LocalDB {
  constructor(name) {
    this.name = name;
    this.db = null;
    this.listeners = new Set();
  }

  static nameFor(user) {
    return `tutor-companion--${String(user || "local").toLowerCase().replace(/[^a-z0-9_.@-]/g, "_")}`;
  }

  async open() {
    if (!("indexedDB" in globalThis)) {
      throw new Error("This browser does not support offline storage (IndexedDB).");
    }
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, MIGRATIONS.length);
      request.onupgradeneeded = (event) => {
        const db = request.result;
        for (let v = event.oldVersion; v < MIGRATIONS.length; v += 1) MIGRATIONS[v](db, request.transaction);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Close other Tutor Companion tabs and reload."));
    });
    return this;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(store) {
    for (const fn of this.listeners) fn(store);
  }

  tx(stores, mode = "readonly") {
    return this.db.transaction(stores, mode);
  }

  async all(store) {
    return promisify(this.tx([store]).objectStore(store).getAll());
  }

  async get(store, id) {
    if (!id) return undefined;
    return promisify(this.tx([store]).objectStore(store).get(id));
  }

  async byIndex(store, index, value) {
    return promisify(this.tx([store]).objectStore(store).index(index).getAll(value));
  }

  async count(store) {
    return promisify(this.tx([store]).objectStore(store).count());
  }

  /** Insert or update a record, maintaining timestamps and revision. */
  async put(store, record) {
    const existing = record.id ? await this.get(store, record.id) : undefined;
    const now = nowIso();
    const value = {
      ...record,
      id: record.id || uid(store.slice(0, 2) + "_"),
      createdAt: existing?.createdAt || record.createdAt || now,
      updatedAt: now,
      rev: (existing?.rev || 0) + 1,
    };
    await promisify(this.tx([store], "readwrite").objectStore(store).put(value));
    this.emit(store);
    return value;
  }

  /** Write records exactly as given (used by restore). */
  async putRaw(store, records) {
    const tx = this.tx([store], "readwrite");
    const os = tx.objectStore(store);
    for (const r of records) os.put(r);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Write aborted"));
    });
    this.emit(store);
  }

  async delete(store, id) {
    await promisify(this.tx([store], "readwrite").objectStore(store).delete(id));
    this.emit(store);
  }

  async clear(store) {
    await promisify(this.tx([store], "readwrite").objectStore(store).clear());
    this.emit(store);
  }

  async log(action, detail = "") {
    const entry = { id: uid("au_"), at: nowIso(), action, detail: String(detail).slice(0, 300) };
    await promisify(this.tx(["audit"], "readwrite").objectStore("audit").put(entry));
    return entry;
  }

  async getSetting(key, fallback = undefined) {
    const row = await this.get("settings", key);
    return row ? row.value : fallback;
  }

  async setSetting(key, value) {
    return this.put("settings", { id: key, value });
  }

  // ---- Cascading deletes keep course units, marks etc. linked correctly ----

  async deleteUnit(unitId) {
    for (const store of ["materials", "resources", "research"]) {
      for (const r of await this.byIndex(store, "unitId", unitId)) {
        if (store === "resources") await this.put(store, { ...r, unitId: "" });
        else await this.delete(store, r.id);
      }
    }
    for (const a of await this.byIndex("assessments", "unitId", unitId)) await this.deleteAssessment(a.id);
    await this.delete("units", unitId);
  }

  async deleteAssessment(assessmentId) {
    for (const m of await this.byIndex("marks", "assessmentId", assessmentId)) await this.delete("marks", m.id);
    await this.delete("assessments", assessmentId);
  }

  async deleteStudent(studentId) {
    for (const m of await this.byIndex("marks", "studentId", studentId)) await this.delete("marks", m.id);
    await this.delete("students", studentId);
  }

  async deleteClass(classId) {
    for (const u of await this.byIndex("units", "classId", classId)) await this.deleteUnit(u.id);
    for (const s of await this.byIndex("students", "classId", classId)) await this.deleteStudent(s.id);
    for (const a of await this.byIndex("assessments", "classId", classId)) await this.deleteAssessment(a.id);
    for (const store of ["materials", "research"]) {
      for (const r of await this.byIndex(store, "classId", classId)) await this.delete(store, r.id);
    }
    for (const r of await this.byIndex("resources", "classId", classId)) {
      await this.put("resources", { ...r, classId: "", unitId: "" });
    }
    await this.delete("classes", classId);
  }

  async deleteResource(resourceId) {
    const r = await this.get("resources", resourceId);
    if (r?.fileId) await this.delete(FILE_STORE, r.fileId);
    await this.delete("resources", resourceId);
  }
}
