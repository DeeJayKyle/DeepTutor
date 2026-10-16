// UI helpers: toasts, modal forms, confirmations, option lists.

import { esc } from "./util.js";

export function toast(message, kind = "info", ms = 4200) {
  const host = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.textContent = message;
  host.appendChild(el);
  while (host.children.length > 3) host.firstElementChild.remove();
  setTimeout(() => el.classList.add("out"), ms);
  setTimeout(() => el.remove(), ms + 400);
}

/**
 * Open a modal. `body` is HTML; returns a promise resolving with the submitted
 * FormData-as-object (or null when cancelled). `validate(values)` may return an
 * error string to keep the dialog open.
 */
export function modal({ title, body, submit = "Save", cancel = "Cancel", wide = false, danger = false, validate, onMount }) {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.innerHTML = `
      <form class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}" novalidate>
        <header class="modal-head"><h2>${esc(title)}</h2>
          <button type="button" class="icon-btn" data-close aria-label="Close">✕</button></header>
        <div class="modal-body">${body}</div>
        <p class="form-error" hidden></p>
        <footer class="modal-foot">
          ${cancel ? `<button type="button" class="btn" data-close>${esc(cancel)}</button>` : ""}
          ${submit ? `<button type="submit" class="btn ${danger ? "btn-danger" : "btn-primary"}">${esc(submit)}</button>` : ""}
        </footer>
      </form>`;
    root.appendChild(wrap);
    const form = wrap.querySelector("form");
    const errorEl = wrap.querySelector(".form-error");
    const close = (value) => {
      wrap.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(null);
    };
    document.addEventListener("keydown", onKey);
    wrap.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => close(null)));
    wrap.addEventListener("mousedown", (e) => {
      if (e.target === wrap) close(null);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const values = formValues(form);
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      const error = validate ? await validate(values, form) : null;
      if (error) {
        errorEl.textContent = error;
        errorEl.hidden = false;
        return;
      }
      close(values);
    });
    onMount?.(form, close);
    const first = form.querySelector("input:not([type=hidden]),select,textarea");
    (first || form.querySelector("button[type=submit]"))?.focus();
  });
}

export function formValues(form) {
  const values = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") {
      if (el.dataset.multi !== undefined) {
        values[el.name] = values[el.name] || [];
        if (el.checked) values[el.name].push(el.value);
      } else values[el.name] = el.checked;
    } else if (el.type === "radio") {
      if (el.checked) values[el.name] = el.value;
    } else if (el.type === "file") values[el.name] = el.files;
    else if (el.multiple && el.tagName === "SELECT") values[el.name] = [...el.selectedOptions].map((o) => o.value);
    else values[el.name] = el.value;
  }
  return values;
}

export async function confirmDialog(message, { title = "Please confirm", confirm = "Confirm", danger = true, typed } = {}) {
  const body = `<p>${esc(message)}</p>${
    typed ? `<label class="field"><span>Type <strong>${esc(typed)}</strong> to confirm</span><input name="typed" autocomplete="off" required></label>` : ""
  }`;
  const result = await modal({
    title,
    body,
    submit: confirm,
    danger,
    validate: (v) => (typed && v.typed.trim() !== typed ? `Type “${typed}” exactly to continue.` : null),
  });
  return result !== null;
}

export function options(items, selected, { blank } = {}) {
  const head = blank !== undefined ? `<option value="">${esc(blank)}</option>` : "";
  return (
    head +
    items
      .map(([value, label]) => `<option value="${esc(value)}" ${String(value) === String(selected ?? "") ? "selected" : ""}>${esc(label)}</option>`)
      .join("")
  );
}

export function field(label, control, hint = "") {
  return `<label class="field"><span>${esc(label)}</span>${control}${hint ? `<small>${esc(hint)}</small>` : ""}</label>`;
}

export function empty(title, text, action = "") {
  return `<div class="empty"><div class="empty-icon" aria-hidden="true">◎</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
}

export function pageHead(title, subtitle = "", actions = "") {
  return `<div class="page-head"><div><h1>${esc(title)}</h1>${subtitle ? `<p class="muted">${esc(subtitle)}</p>` : ""}</div><div class="page-actions">${actions}</div></div>`;
}

export function busy(button, on, label) {
  if (!button) return;
  if (on) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${esc(label || "Working…")}`;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

export function errorBox(err) {
  return `<div class="alert alert-error" role="alert"><strong>Something went wrong.</strong> ${esc(err?.message || err)}</div>`;
}

export function badge(text, kind = "") {
  return `<span class="badge ${kind ? `badge-${kind}` : ""}">${esc(text)}</span>`;
}
