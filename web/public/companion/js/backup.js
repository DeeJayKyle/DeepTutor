// Backup, share packages and conflict-safe restore. Restores never overwrite
// silently: planRestore() classifies every record and the tutor chooses how to
// resolve each conflict before applyRestore() writes anything.

import { DATA_STORES, FILE_STORE, SCHEMA_VERSION } from "./db.js";
import { nowIso, sha256Hex, uid } from "./util.js";

export const BACKUP_FORMAT = "tutor-companion-backup";
export const SHARE_FORMAT = "tutor-companion-share";

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || "application/octet-stream" });
}

/** Build a backup snapshot: {format, schema, createdAt, user, stores{}}. */
export async function createSnapshot(db, { stores = DATA_STORES, includeFiles = false, user = "" } = {}) {
  const out = {};
  for (const store of stores) out[store] = await db.all(store);
  if (includeFiles) {
    const files = await db.all(FILE_STORE);
    out[FILE_STORE] = await Promise.all(
      files.map(async (f) => ({ ...f, blob: undefined, data: await blobToBase64(f.blob), type: f.blob?.type })),
    );
  }
  return { format: BACKUP_FORMAT, schema: SCHEMA_VERSION, createdAt: nowIso(), user, stores: out };
}

export async function serializeSnapshot(snapshot) {
  const payload = JSON.stringify(snapshot);
  return { payload, sha256: await sha256Hex(payload) };
}

export async function parseSnapshot(payload, expectedSha) {
  if (expectedSha) {
    const actual = await sha256Hex(payload);
    if (actual !== expectedSha) throw new Error("Integrity check failed: this backup is corrupted.");
  }
  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    throw new Error("This file is not a valid Tutor Companion backup.");
  }
  if (![BACKUP_FORMAT, SHARE_FORMAT].includes(data?.format) || typeof data.stores !== "object") {
    throw new Error("This file is not a Tutor Companion backup or share package.");
  }
  if ((data.schema || 0) > SCHEMA_VERSION) {
    throw new Error("This backup was made by a newer version of Tutor Companion. Update the app first.");
  }
  return data;
}

function comparable(record) {
  if (!record) return "";
  const { updatedAt, rev, createdAt, data, blob, ...rest } = record;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * Compare local stores with incoming ones.
 * Returns {added[], identical, localOnly, conflicts[]}; each conflict has
 * {store, id, local, incoming, newer: "local"|"incoming"|"same"}.
 */
export function planRestore(localStores, incomingStores) {
  const plan = { added: [], identical: 0, localOnly: 0, conflicts: [] };
  for (const [store, records] of Object.entries(incomingStores)) {
    if (!Array.isArray(records) || store === "audit") continue;
    const local = new Map((localStores[store] || []).map((r) => [r.id, r]));
    const seen = new Set();
    for (const incoming of records) {
      if (!incoming || !incoming.id) continue;
      seen.add(incoming.id);
      const mine = local.get(incoming.id);
      if (!mine) plan.added.push({ store, record: incoming });
      else if (comparable(mine) === comparable(incoming)) plan.identical += 1;
      else {
        const a = String(mine.updatedAt || "");
        const b = String(incoming.updatedAt || "");
        plan.conflicts.push({ store, id: incoming.id, local: mine, incoming, newer: a === b ? "same" : a > b ? "local" : "incoming" });
      }
    }
    for (const id of local.keys()) if (!seen.has(id)) plan.localOnly += 1;
  }
  return plan;
}

/**
 * Apply a restore plan. resolutions maps `${store}|${id}` to
 * "local" (keep mine), "incoming" (take backup) or "both" (keep both copies).
 */
export async function applyRestore(db, plan, resolutions = {}) {
  const byStore = new Map();
  const push = (store, record) => {
    if (!byStore.has(store)) byStore.set(store, []);
    byStore.get(store).push(record);
  };
  for (const { store, record } of plan.added) push(store, record);
  let kept = 0;
  let replaced = 0;
  let duplicated = 0;
  for (const c of plan.conflicts) {
    const choice = resolutions[`${c.store}|${c.id}`] || "local";
    if (choice === "incoming") {
      push(c.store, c.incoming);
      replaced += 1;
    } else if (choice === "both" && !["marks", "settings"].includes(c.store)) {
      const label = c.incoming.title !== undefined ? "title" : c.incoming.name !== undefined ? "name" : null;
      const copy = { ...c.incoming, id: uid(c.store.slice(0, 2) + "_") };
      if (label) copy[label] = `${c.incoming[label]} (restored copy)`;
      push(c.store, copy);
      duplicated += 1;
    } else kept += 1;
  }
  for (const [store, records] of byStore) {
    if (store === FILE_STORE) {
      await db.putRaw(
        store,
        records.map((f) => ({ id: f.id, name: f.name, blob: base64ToBlob(f.data, f.type), createdAt: f.createdAt })),
      );
    } else if (DATA_STORES.includes(store)) {
      await db.putRaw(store, records);
    }
  }
  await db.log("restore", `added ${plan.added.length}, replaced ${replaced}, duplicated ${duplicated}, kept ${kept}`);
  return { added: plan.added.length, replaced, duplicated, kept, identical: plan.identical };
}

/** Build a share package for one class (optionally with students and marks). */
export async function createSharePackage(db, classId, { includeStudents = false, includeFiles = false, author = "" } = {}) {
  const cls = await db.get("classes", classId);
  if (!cls) throw new Error("Class not found");
  const units = await db.byIndex("units", "classId", classId);
  const unitIds = new Set(units.map((u) => u.id));
  const stores = {
    classes: [cls],
    units,
    materials: (await db.all("materials")).filter((m) => m.classId === classId || unitIds.has(m.unitId)),
    resources: (await db.all("resources")).filter((r) => r.classId === classId || unitIds.has(r.unitId)),
    research: (await db.all("research")).filter((r) => r.classId === classId || unitIds.has(r.unitId)),
  };
  if (includeStudents) {
    stores.students = await db.byIndex("students", "classId", classId);
    stores.assessments = await db.byIndex("assessments", "classId", classId);
    const aIds = new Set(stores.assessments.map((a) => a.id));
    stores.marks = (await db.all("marks")).filter((m) => aIds.has(m.assessmentId));
  }
  if (includeFiles) {
    const fileIds = new Set(stores.resources.map((r) => r.fileId).filter(Boolean));
    const files = (await db.all(FILE_STORE)).filter((f) => fileIds.has(f.id));
    stores[FILE_STORE] = await Promise.all(
      files.map(async (f) => ({ ...f, blob: undefined, data: await blobToBase64(f.blob), type: f.blob?.type })),
    );
  }
  await db.log("share-export", `${cls.name}${includeStudents ? " (with student records)" : ""}`);
  return { format: SHARE_FORMAT, schema: SCHEMA_VERSION, createdAt: nowIso(), author, title: cls.name, stores };
}
