// Shared (school) classes: build/apply class bundles and synchronise them
// with the school server. A shared class keeps the same ids locally and on the
// server; its class record carries `shared: {schoolId, schoolName, rev, role,
// baseHash}`. Nothing is overwritten silently: when both sides changed, the
// tutor resolves each differing record before anything is written.

import { api } from "./api.js";
import { planRestore } from "./backup.js";
import { sha256Hex } from "./util.js";

export const BUNDLE_SECTIONS = ["units", "materials", "resources", "research", "students", "assessments", "marks"];

/** What each class role may change (mirrors the server's SECTION_WRITERS). */
export const ROLE_CAN = {
  lead: new Set(["class", ...BUNDLE_SECTIONS]),
  teacher: new Set(BUNDLE_SECTIONS),
  assistant: new Set(["marks"]),
  viewer: new Set(),
};

export const ROLE_LABELS = {
  lead: "Class lead — full control",
  teacher: "Teacher — content, students and marks",
  assistant: "Assistant — records marks",
  viewer: "Viewer — read only",
};

/** null = own class (full control); otherwise the class role. */
export function roleOf(cls) {
  return cls?.shared ? cls.shared.role || "viewer" : null;
}

export function can(cls, section) {
  const role = roleOf(cls);
  return role === null || ROLE_CAN[role]?.has(section);
}

function strip(record) {
  // Local-only fields never leave the device.
  const { shared, fileId, offline, openedAt, previousContent, ...rest } = record;
  return rest;
}

const sortById = (list) => [...list].sort((a, b) => String(a.id).localeCompare(String(b.id)));

/** Collect a class and everything linked to it into a server bundle. */
export async function buildBundle(db, classId) {
  const cls = await db.get("classes", classId);
  if (!cls) throw new Error("Class not found");
  const units = await db.byIndex("units", "classId", classId);
  const unitIds = new Set(units.map((u) => u.id));
  const linked = (r) => r.classId === classId || unitIds.has(r.unitId);
  const assessments = await db.byIndex("assessments", "classId", classId);
  const aIds = new Set(assessments.map((a) => a.id));
  const bundle = {
    class: strip(cls),
    units: units.map(strip),
    materials: (await db.all("materials")).filter(linked).map(strip),
    resources: (await db.all("resources")).filter(linked).map(strip),
    research: (await db.all("research")).filter(linked).map(strip),
    students: (await db.byIndex("students", "classId", classId)).map(strip),
    assessments: assessments.map(strip),
    marks: (await db.all("marks")).filter((m) => aIds.has(m.assessmentId)).map(strip),
  };
  for (const s of BUNDLE_SECTIONS) bundle[s] = sortById(bundle[s]);
  return bundle;
}

export async function bundleHash(bundle) {
  return sha256Hex(JSON.stringify(bundle));
}

/** Replace the local copy of a shared class with a bundle from the server. */
export async function applyBundle(db, bundle, shared) {
  const classId = bundle.class.id;
  const existing = await db.get("classes", classId);
  if (existing) await db.deleteClass(classId);
  await db.putRaw("classes", [{ ...bundle.class, shared: { ...shared, baseHash: await bundleHash(bundle) } }]);
  for (const s of BUNDLE_SECTIONS) {
    const records = (bundle[s] || []).map((r) => (s === "resources" ? { ...r, offline: false } : r));
    if (records.length) await db.putRaw(s, records);
  }
}

async function markShared(db, classId, shared, bundle) {
  const cls = await db.get("classes", classId);
  await db.putRaw("classes", [{ ...cls, shared: { ...shared, baseHash: await bundleHash(bundle) } }]);
}

/** Publish one of the tutor's own classes to a school (tutor becomes lead). */
export async function publishClass(db, classId, school) {
  const bundle = await buildBundle(db, classId);
  const res = await api.publishClass(school.id, classId, bundle);
  await markShared(db, classId, { schoolId: school.id, schoolName: school.name, rev: res.rev, role: res.my_role }, bundle);
  await db.log("share-publish", `${bundle.class.name} → ${school.name}`);
  return res;
}

/** Download a shared class the tutor has a role in. */
export async function openSharedClass(db, school, classId) {
  const record = await api.sharedClass(school.id, classId);
  await applyBundle(db, record.bundle, { schoolId: school.id, schoolName: school.name, rev: record.rev, role: record.my_role });
  await db.log("share-download", `${record.bundle.class.name} (${record.my_role})`);
  return record;
}

/**
 * Two-way sync. `resolve(plan, label)` shows the conflict dialog and returns
 * resolutions (or null to cancel). Returns a short summary string.
 */
export async function syncClass(db, classId, resolve) {
  const cls = await db.get("classes", classId);
  if (!cls?.shared) throw new Error("This class is not shared with a school.");
  const { schoolId } = cls.shared;
  const local = await buildBundle(db, classId);
  const localChanged = (await bundleHash(local)) !== cls.shared.baseHash;
  const remote = await api.sharedClass(schoolId, classId);
  const shared = { ...cls.shared, role: remote.my_role };

  if (!localChanged) {
    if (remote.rev === cls.shared.rev) return "Already up to date.";
    await applyBundle(db, remote.bundle, { ...shared, rev: remote.rev });
    return `Downloaded changes from ${remote.updated_by}.`;
  }
  if (!can({ shared }, "marks") && !can({ shared }, "units")) {
    // Viewer with local edits: the server would refuse them.
    const keep = await resolve(null, "You can only view this class. Discard your local changes and download the school copy?");
    if (!keep) return "Sync cancelled.";
    await applyBundle(db, remote.bundle, { ...shared, rev: remote.rev });
    return "Local changes discarded; school copy downloaded.";
  }

  let toSend = local;
  if (remote.rev !== cls.shared.rev) {
    // Both sides changed: merge record by record with the tutor's choices.
    const sections = (b) => ({ classes: [b.class], ...Object.fromEntries(BUNDLE_SECTIONS.map((s) => [s, b[s] || []])) });
    const plan = planRestore(sections(local), sections(remote.bundle));
    const resolutions = await resolve(plan, `Changes from ${remote.updated_by} and from this device`);
    if (!resolutions) return "Sync cancelled.";
    const merged = sections(local);
    for (const { store, record } of plan.added) merged[store].push(record);
    for (const c of plan.conflicts) {
      const choice = resolutions[`${c.store}|${c.id}`] || "local";
      if (choice === "incoming") merged[c.store] = merged[c.store].map((r) => (r.id === c.id ? c.incoming : r));
    }
    toSend = { class: merged.classes[0], ...Object.fromEntries(BUNDLE_SECTIONS.map((s) => [s, sortById(merged[s])])) };
  }
  try {
    const res = await api.updateSharedClass(schoolId, classId, remote.rev, toSend);
    await applyBundle(db, toSend, { ...shared, rev: res.rev });
    await db.log("share-sync", `${toSend.class.name}: ${res.changed.join(", ") || "no changes"}`);
    return res.changed.length ? `Uploaded changes (${res.changed.join(", ")}).` : "Already up to date.";
  } catch (err) {
    if (err.status === 409) return syncClass(db, classId, resolve); // someone saved meanwhile — retry with their copy
    throw err;
  }
}
