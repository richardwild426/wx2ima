const $ = (id) => document.getElementById(id);
const state = {
  authenticated: false,
  profiles: [],
  jobs: [],
  selected: localStorage.getItem("wx2ima.profile") || "",
  filter: "all",
  settings: "",
  bases: [],
  mappings: [],
  importing: false,
  settingsVersion: 0,
  connectVersion: 0,
  deleteVersion: 0,
  profilesVersion: 0,
  historyVersion: 0,
  sessionVersion: 0,
  editing: "",
  deleting: "",
  profileBusy: new Set(),
};
const finished = new Set(["complete", "duplicate", "failed"]);
// Native validation follows the browser language unless an explicit message is supplied.
for (const field of document.querySelectorAll("input, select, textarea")) {
  field.addEventListener("invalid", () => {
    if (field.validity.customError) return;
    field.setCustomValidity(
      field.validity.valueMissing
        ? field.tagName === "SELECT"
          ? "请选择一项。"
          : "请填写此项。"
        : "请检查输入内容是否符合要求。",
    );
  });
  for (const event of ["input", "change"])
    field.addEventListener(event, () => field.setCustomValidity(""));
}
let toastTimer;
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 4500);
}
function node(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function option(value, text) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  return o;
}
function button(text, handler, className = "text-button", operationKey) {
  const b = node("button", className, text);
  b.type = "button";
  if (operationKey) b.dataset.operationKey = operationKey;
  b.addEventListener("click", handler);
  syncButtonLoading(b);
  return b;
}
const pendingActions = new Map();
const loadingButtons = new WeakMap();
function operationKey(button) {
  if (!button) return Symbol("background");
  if (button.dataset.operationKey) return button.dataset.operationKey;
  if (button.id === "connect-submit")
    return state.editing ? `edit:${state.editing}` : "connect";
  if (button.id === "delete-confirm") return `delete:${state.deleting}`;
  if (button.closest("#inbox-form")) return `inbox:${state.settings}`;
  if (button.closest("#mapping-form")) return `mapping:${state.settings}`;
  return button.id || button;
}
function loadingLabel(button) {
  if (button.id === "connect-submit")
    return state.editing ? "保存中…" : "验证中…";
  const labels = {
    "login-submit": "登录中…",
    "save-articles": "提交中…",
    "delete-confirm": "删除中…",
    refresh: "刷新中…",
    logout: "退出中…",
    paste: "粘贴中…",
  };
  if (labels[button.id]) return labels[button.id];
  if (button.textContent.includes("删除")) return "删除中…";
  if (button.textContent.includes("重试")) return "重试中…";
  if (button.closest("form")) return "保存中…";
  return "加载中…";
}
/** Keep an operation locked across list redraws; each DOM instance retains its own original content. */
function syncButtonLoading(button, key = operationKey(button)) {
  const task = pendingActions.get(key);
  if (!task || loadingButtons.has(button)) return;
  const snapshot = {
    task,
    children: [...button.childNodes],
    label: button.getAttribute("aria-label"),
    busy: button.getAttribute("aria-busy"),
    disabled: button.disabled,
  };
  loadingButtons.set(button, snapshot);
  task.buttons.add(button);
  const content = node("span", "button-loading-content");
  content.setAttribute("aria-hidden", "true");
  content.append(...snapshot.children);
  const progress = node("span", "button-loading-progress");
  progress.setAttribute("aria-hidden", "true");
  progress.append(
    node("span", "button-spinner"),
    node("span", "button-loading-label", task.label),
  );
  button.replaceChildren(content, progress);
  button.classList.add("is-loading");
  button.setAttribute("aria-busy", "true");
  button.setAttribute("aria-label", task.label);
  button.disabled = true;
}
function resetButtonLoading(button) {
  const snapshot = loadingButtons.get(button);
  if (!snapshot) return;
  button.replaceChildren(...snapshot.children);
  button.classList.remove("is-loading");
  for (const [name, value] of [
    ["aria-label", snapshot.label],
    ["aria-busy", snapshot.busy],
  ]) {
    if (value === null) button.removeAttribute(name);
    else button.setAttribute(name, value);
  }
  button.disabled = snapshot.disabled;
  snapshot.task.buttons.delete(button);
  loadingButtons.delete(button);
}
function syncDialogLoading(dialog) {
  for (const button of dialog.querySelectorAll("button"))
    syncButtonLoading(button);
}
function showLogin() {
  state.authenticated = false;
  state.sessionVersion++;
  state.profilesVersion++;
  state.historyVersion++;
  state.jobs = [];
  state.profiles = [];
  $("history-list").replaceChildren();
  $("account-list").replaceChildren();
  $("deleted-account-list").replaceChildren();
  $("active-profile").replaceChildren();
  $("workspace").hidden = true;
  $("logout").hidden = true;
  $("login-view").hidden = false;
  closeDialogs();
}
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new Error("网络连接失败，请检查网络后重试。");
  }
  const data = await response
    .json()
    .catch(() => ({ error: "服务器返回异常，请稍后重试。" }));
  if (!response.ok) {
    if (response.status === 401 && path !== "/login") showLogin();
    throw new Error(data.error || "操作未完成，请稍后重试。");
  }
  return data;
}
async function busy(button, action, errorId) {
  const key = operationKey(button);
  if (pendingActions.has(key) || button?.disabled) return;
  const task = {
    buttons: new Set(),
    label: button ? loadingLabel(button) : "",
  };
  pendingActions.set(key, task);
  const dialog = button?.closest("dialog");
  const version = dialogVersion(dialog);
  const sessionVersion = state.sessionVersion;
  const current = () =>
    sessionVersion === state.sessionVersion &&
    (!dialog || (dialog.open && dialogVersion(dialog) === version));
  if (button) syncButtonLoading(button, key);
  if (errorId) $(errorId).textContent = "";
  try {
    return await action();
  } catch (error) {
    if (current()) {
      if (errorId) $(errorId).textContent = error.message;
      else toast(error.message);
    }
  } finally {
    pendingActions.delete(key);
    for (const target of [...task.buttons]) resetButtonLoading(target);
    updateDestination();
  }
}
function dialogVersion(dialog) {
  return dialog?.id === "settings-dialog"
    ? state.settingsVersion
    : dialog?.id === "connect-dialog"
      ? state.connectVersion
      : dialog?.id === "delete-dialog"
        ? state.deleteVersion
        : 0;
}
function clearValidation(container) {
  for (const field of container.querySelectorAll("input, select, textarea"))
    field.setCustomValidity("");
}
function clearCredentials() {
  for (const id of ["client-id", "api-key"]) {
    $(id).value = "";
    $(id).setCustomValidity("");
  }
}
/** Invalidate synchronously: the native close event can arrive after a dialog reopens. */
function resetDialog(dialog) {
  for (const button of dialog.querySelectorAll("button"))
    resetButtonLoading(button);
  if (dialog.id === "connect-dialog") {
    state.connectVersion++;
    state.editing = "";
    $("connect-form").reset();
    clearCredentials();
  } else if (dialog.id === "settings-dialog") {
    state.settingsVersion++;
    state.settings = "";
    state.bases = [];
    state.mappings = [];
  } else if (dialog.id === "delete-dialog") {
    state.deleteVersion++;
    state.deleting = "";
  }
  clearValidation(dialog);
  for (const button of dialog.querySelectorAll("button"))
    button.disabled = false;
}
function closeDialog(dialog) {
  resetDialog(dialog);
  dialog.close();
}
function closeDialogs() {
  for (const dialog of document.querySelectorAll("dialog"))
    if (dialog.open) closeDialog(dialog);
}
function activeProfile(id) {
  return state.profiles.find((p) => p.id === id && !p.deleted_at);
}
function writableProfile(id) {
  return state.profileBusy.has(id) ? null : activeProfile(id) || null;
}
function selectProfile(id) {
  state.selected = id;
  state.jobs = [];
  $("import-error").textContent = "";
  renderProfiles();
  busy(null, loadHistory);
}
function selectedProfile() {
  return state.profiles.find((p) => p.id === state.selected);
}
function updateDestination() {
  const profile = selectedProfile();
  $("save-articles").disabled =
    loadingButtons.has($("save-articles")) ||
    state.importing ||
    !writableProfile(state.selected) ||
    !profile?.inbox_id;
  $("route-summary").textContent = profile
    ? profile.deleted_at
      ? "账号已删除，仅可查看记录和下载 PDF"
      : state.profileBusy.has(profile.id)
        ? "账号正在更新，请稍候"
        : profile.inbox_name
          ? `按公众号分配 · 待分类：${profile.inbox_name}`
          : "请先设置待分类知识库"
    : "请选择一个 IMA 账号";
  $("routing-settings").disabled =
    loadingButtons.has($("routing-settings")) ||
    !writableProfile(state.selected);
  $("onboarding").hidden = state.profiles.some((p) => !p.deleted_at);
}
function renderProfiles() {
  const active = state.profiles.filter((p) => !p.deleted_at);
  const deleted = state.profiles.filter((p) => p.deleted_at);
  $("account-count").textContent = String(active.length);
  if (!state.profiles.some((p) => p.id === state.selected))
    state.selected = active[0]?.id || deleted[0]?.id || "";
  const select = $("active-profile");
  select.replaceChildren();
  if (!state.profiles.length) select.append(option("", "连接 IMA 账号"));
  for (const profile of [...active, ...deleted])
    select.append(
      option(
        profile.id,
        `${profile.name} · ${profile.owner_name}${profile.deleted_at ? "（已删除，仅查看记录）" : ""}`,
      ),
    );
  select.value = state.selected;
  if (state.selected) localStorage.setItem("wx2ima.profile", state.selected);
  else localStorage.removeItem("wx2ima.profile");
  const container = $("account-list");
  container.replaceChildren();
  if (!active.length)
    container.append(
      node("p", "mapping-empty", "暂无可用的 IMA 账号，添加后即可保存文章。"),
    );
  for (const p of active) {
    const item = node("article", "account-item");
    item.append(
      node("div", "avatar", [...p.owner_name][0]?.toUpperCase() || "I"),
    );
    const details = node("div", "account-details");
    details.append(
      node("h3", "", p.name),
      node("p", "", `${p.owner_name} · 用户自行填写`),
      node(
        "p",
        "",
        `${p.kb_count} 个可写入知识库 · ${p.inbox_name ? `待分类：${p.inbox_name}` : "未设置待分类知识库"}`,
      ),
      node(
        "span",
        "fingerprint",
        `凭据标识 ${p.fingerprint} · 验证日期 ${new Date(`${p.verified_at.replace(" ", "T")}Z`).toLocaleDateString("zh-CN")}`,
      ),
    );
    item.append(details);
    const actions = node("div", "account-actions");
    actions.append(
      button(p.id === state.selected ? "当前账号" : "使用此账号", () => {
        selectProfile(p.id);
        closeDialog($("accounts-dialog"));
      }),
      button("分配与待分类", () => openSettings(p.id)),
      button("编辑", () => openConnect(p.id)),
      button("删除", () => openDelete(p.id), "text-button danger-text"),
    );
    for (const action of actions.querySelectorAll("button"))
      action.disabled = state.profileBusy.has(p.id);
    item.append(actions);
    container.append(item);
  }
  $("deleted-accounts").hidden = !deleted.length;
  $("deleted-account-count").textContent = String(deleted.length);
  const archive = $("deleted-account-list");
  archive.replaceChildren();
  for (const p of deleted) {
    const item = node("article", "account-item deleted-account");
    const details = node("div", "account-details");
    details.append(
      node("h3", "", p.name),
      node("p", "", `${p.owner_name} · 已删除，仅保留历史记录`),
    );
    item.append(
      details,
      button("查看记录", () => {
        state.filter = "all";
        for (const filter of document.querySelectorAll("[data-filter]")) {
          filter.classList.toggle("selected", filter.dataset.filter === "all");
          filter.setAttribute(
            "aria-pressed",
            String(filter.dataset.filter === "all"),
          );
        }
        selectProfile(p.id);
        closeDialog($("accounts-dialog"));
        $("history-list").scrollIntoView({ block: "center" });
      }),
    );
    archive.append(item);
  }
  updateDestination();
  renderHistory();
}
async function loadProfiles() {
  const version = ++state.profilesVersion;
  const data = await api("/profiles");
  if (!state.authenticated || state.profilesVersion !== version) return;
  state.profiles = data.profiles;
  if (state.settings && !activeProfile(state.settings))
    closeDialog($("settings-dialog"));
  if (state.editing && !activeProfile(state.editing))
    closeDialog($("connect-dialog"));
  if (state.deleting && !activeProfile(state.deleting))
    closeDialog($("delete-dialog"));
  if (!state.profiles.some((p) => p.id === state.selected)) state.jobs = [];
  renderProfiles();
}
async function loadHistory() {
  const version = ++state.historyVersion;
  const requested = state.selected;
  if (!requested) {
    state.jobs = [];
    renderHistory();
    $("last-updated").textContent = "导入记录保存在此工作区。";
    return;
  }
  const data = await api(`/jobs?profile=${encodeURIComponent(requested)}`);
  if (
    !state.authenticated ||
    state.selected !== requested ||
    state.historyVersion !== version
  )
    return;
  state.jobs = data.jobs;
  renderHistory();
  $("last-updated").textContent =
    `更新于 ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })} · 最近 100 条记录`;
}
function statusLabel(stage) {
  return (
    {
      queued: "等待处理",
      downloading: "正在获取文章",
      validating: "正在检查 PDF",
      saved: "PDF 已保存",
      uploading: "正在上传",
      uploaded: "PDF 已上传",
      adding: "正在存入 IMA",
      verifying: "正在核验入库",
      complete: "已存入 IMA",
      duplicate: "已保存，无需重复",
      failed: "需要处理",
    }[stage] || "处理中"
  );
}
function renderHistory() {
  const deleted = selectedProfile()?.deleted_at;
  $("history-readonly").hidden = !deleted;
  $("empty-history").querySelector(".empty-hint").hidden = Boolean(deleted);
  $("history-count").textContent = String(state.jobs.length);
  const jobs = state.jobs.filter(
    (j) =>
      state.filter === "all" ||
      (state.filter === "failed"
        ? j.stage === "failed"
        : !finished.has(j.stage)),
  );
  const container = $("history-list");
  container.replaceChildren();
  $("empty-history").hidden = jobs.length > 0;
  $("empty-history").querySelector("h3").textContent =
    state.filter === "all"
      ? "把值得读的文章留在这里"
      : state.filter === "failed"
        ? "暂无需要处理的任务"
        : "暂无正在处理的任务";
  $("empty-history").querySelector("p").textContent =
    state.filter === "all"
      ? "保存的文章、PDF 和处理状态都会显示在这里。"
      : "新任务及处理状态会自动更新。";
  for (const j of jobs) {
    const row = node("article", "history-row");
    const article = node("div", "article-cell");
    article.append(node("span", "pdf-icon", "PDF"));
    const titleWrap = node("div");
    const link = node("a", "article-title", j.title || "微信公众号文章");
    link.href = j.source_url;
    link.target = "_blank";
    link.rel = "noreferrer";
    titleWrap.append(link);
    const date = new Date(`${j.created_at.replace(" ", "T")}Z`).toLocaleString(
      "zh-CN",
      {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      },
    );
    titleWrap.append(
      node(
        "div",
        "article-meta",
        [
          j.account_name,
          date,
          j.page_count ? `${j.page_count} 页` : null,
          j.file_size ? `${(j.file_size / 1024 / 1024).toFixed(1)} MB` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    article.append(titleWrap);
    row.append(article);
    const kb = node("div", "kb-cell", j.kb_name || "正在确定目标知识库");
    if (j.used_inbox) kb.append(node("span", "fallback-badge", "存入待分类"));
    row.append(kb);
    const status = node("div", "status-cell");
    const pill = node(
      "span",
      `status-pill ${finished.has(j.stage) ? j.stage : ""}`,
    );
    pill.append(
      node("span", "status-dot"),
      document.createTextNode(statusLabel(j.stage)),
    );
    status.append(pill);
    if (j.error) status.append(node("p", "status-error", j.error));
    row.append(status);
    const actions = node("div", "row-actions");
    if (j.has_pdf) {
      const pdf = node("a", "", "PDF ↓");
      pdf.href = `/api/jobs/${j.id}/pdf`;
      pdf.setAttribute("download", "");
      actions.append(pdf);
    }
    if (j.stage === "failed" && writableProfile(j.profile_id))
      actions.append(
        button(
          "重试",
          (event) =>
            busy(event.currentTarget, async () => {
              if (!writableProfile(j.profile_id)) return;
              await api(`/jobs/${j.id}/retry`, { method: "POST", body: "{}" });
              await loadHistory();
              toast("已开始重试，将复用已保存的 PDF。");
            }),
          "text-button",
          `retry:${j.id}`,
        ),
      );
    if (j.account_name && writableProfile(j.profile_id))
      actions.append(
        button("设置分配", () =>
          openSettings(j.profile_id, {
            name: j.account_name,
            key: j.account_key,
          }),
        ),
      );
    row.append(actions);
    container.append(row);
  }
}
async function openWorkspace() {
  state.authenticated = true;
  $("login-view").hidden = true;
  $("workspace").hidden = false;
  $("logout").hidden = false;
  await loadProfiles();
  await loadHistory();
}
function openConnect(id = "") {
  const profile = id ? writableProfile(id) : null;
  if (id && !profile) return;
  closeDialogs();
  resetDialog($("connect-dialog"));
  state.editing = id;
  $("connect-error").textContent = "";
  $("account-name").value = profile?.name || "";
  $("owner-name").value = profile?.owner_name || "";
  $("connect-title").textContent = id ? "编辑 IMA 账号" : "连接 IMA";
  $("connect-submit").textContent = id ? "保存修改" : "验证并连接 →";
  $("connect-intro").hidden = Boolean(id);
  $("edit-intro").hidden = !id;
  $("credentials-help").textContent = id
    ? "两项均留空将保留原凭据。更新时请同时填写客户端标识和接口密钥，且必须属于当前同一账号。"
    : "凭据在服务器端加密保存。再次连接相同客户端标识会更新凭据。";
  updateCredentialValidity();
  syncDialogLoading($("connect-dialog"));
  $("connect-dialog").showModal();
}
/** Recompute both fields before native validation, including when a previously invalid form is reused. */
function updateCredentialValidity() {
  const client = $("client-id");
  const key = $("api-key");
  const hasClient = Boolean(client.value.trim());
  const hasKey = Boolean(key.value.trim());
  client.setCustomValidity("");
  key.setCustomValidity("");
  client.required = !state.editing || hasKey;
  key.required = !state.editing || hasClient;
  if (hasClient && !hasKey)
    key.setCustomValidity("请同时填写接口密钥，或清空两项以保留原凭据。");
  if (hasKey && !hasClient)
    client.setCustomValidity("请同时填写客户端标识，或清空两项以保留原凭据。");
}
function openDelete(id) {
  const profile = writableProfile(id);
  if (!profile) return;
  closeDialogs();
  resetDialog($("delete-dialog"));
  state.deleting = id;
  $("delete-account-name").textContent =
    `${profile.name} · ${profile.owner_name}`;
  $("delete-error").textContent = "";
  syncDialogLoading($("delete-dialog"));
  $("delete-dialog").showModal();
}
async function openSettings(id, publisher) {
  if (!writableProfile(id)) return;
  closeDialogs();
  resetDialog($("settings-dialog"));
  state.settings = id;
  const version = ++state.settingsVersion;
  $("settings-error").textContent = "";
  $("settings-body").hidden = true;
  $("mapping-form").reset();
  $("settings-loading").hidden = false;
  $("settings-dialog").showModal();
  $("settings-title").textContent =
    state.profiles.find((p) => p.id === id)?.name || "公众号分配";
  syncDialogLoading($("settings-dialog"));
  try {
    const [bases, rules] = await Promise.all([
      api(`/profiles/${id}/knowledge-bases`),
      api(`/profiles/${id}/mappings`),
    ]);
    if (state.settingsVersion !== version || !writableProfile(id)) return;
    state.bases = bases.knowledgeBases;
    state.mappings = rules.mappings;
    for (const field of ["inbox-select", "mapping-kb"]) {
      const select = $(field);
      select.replaceChildren(
        option("", state.bases.length ? "请选择知识库" : "暂无可写入的知识库"),
      );
      for (const kb of state.bases) select.append(option(kb.id, kb.name));
    }
    $("inbox-select").value =
      state.profiles.find((p) => p.id === id)?.inbox_id || "";
    $("publisher-name").value = publisher?.name || "";
    $("publisher-key").value = publisher?.key || "";
    renderMappings();
    $("settings-body").hidden = false;
  } catch (error) {
    if (state.settingsVersion === version)
      $("settings-error").textContent = error.message;
  } finally {
    if (state.settingsVersion === version) $("settings-loading").hidden = true;
  }
}
function renderMappings() {
  const list = $("mapping-list");
  list.replaceChildren();
  if (!state.mappings.length)
    list.append(
      node("p", "mapping-empty", "尚未设置分配规则，文章将存入待分类知识库。"),
    );
  for (const rule of state.mappings) {
    const item = node("div", "mapping-item");
    item.append(
      node("span", "", rule.account_name),
      node("span", "mapping-destination", `→ ${rule.kb_name}`),
      button(
        "删除",
        (event) =>
          busy(
            event.currentTarget,
            async () => {
              const id = state.settings,
                version = state.settingsVersion;
              if (!writableProfile(id) || !$("settings-dialog").open) return;
              await api(`/profiles/${id}/mappings`, {
                method: "DELETE",
                body: JSON.stringify({ accountKey: rule.account_key }),
              });
              if (state.settingsVersion !== version) return;
              state.mappings = state.mappings.filter(
                (x) => x.account_key !== rule.account_key,
              );
              renderMappings();
            },
            "settings-error",
          ),
        "text-button",
        `remove-rule:${state.settings}:${rule.account_key}`,
      ),
    );
    list.append(item);
  }
}
$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(
    $("login-submit"),
    async () => {
      await api("/login", {
        method: "POST",
        body: JSON.stringify({ password: $("password").value }),
      });
      $("password").value = "";
      await openWorkspace();
    },
    "login-error",
  );
});
$("reveal-password").addEventListener("click", () => {
  const hidden = $("password").type === "password";
  $("password").type = hidden ? "text" : "password";
  $("reveal-password").textContent = hidden ? "隐藏" : "显示";
  $("reveal-password").setAttribute(
    "aria-label",
    hidden ? "隐藏访问口令" : "显示访问口令",
  );
});
$("logout").addEventListener("click", (event) =>
  busy(event.currentTarget, async () => {
    await api("/logout", { method: "POST", body: "{}" });
    showLogin();
  }),
);
$("manage-accounts").addEventListener("click", () => {
  renderProfiles();
  $("accounts-dialog").showModal();
});
$("first-account").addEventListener("click", () => openConnect());
$("add-account").addEventListener("click", () => openConnect());
for (const b of document.querySelectorAll(".close-dialog"))
  b.addEventListener("click", () => {
    closeDialog(b.closest("dialog"));
  });
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog(dialog);
  });
  dialog.addEventListener("close", () => {
    if (!dialog.open) resetDialog(dialog);
  });
}
for (const id of ["client-id", "api-key"])
  for (const event of ["input", "change"])
    $(id).addEventListener(event, updateCredentialValidity);
$("active-profile").addEventListener("change", () => {
  selectProfile($("active-profile").value);
});
$("routing-settings").addEventListener("click", () => {
  if (state.selected) openSettings(state.selected);
});
$("connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!$("connect-dialog").open) return;
  const id = state.editing;
  if (id && !writableProfile(id)) return;
  updateCredentialValidity();
  if (!$("connect-form").reportValidity()) return;
  const version = state.connectVersion;
  const sessionVersion = state.sessionVersion;
  const current = () =>
    state.connectVersion === version && $("connect-dialog").open;
  busy(
    $("connect-submit"),
    async () => {
      const payload = {
        name: $("account-name").value.trim(),
        ownerName: $("owner-name").value.trim(),
      };
      if (!payload.name || !payload.ownerName)
        throw new Error("请填写账号备注和所有者。");
      if ($("client-id").value.trim() && $("api-key").value.trim()) {
        payload.clientId = $("client-id").value.trim();
        payload.apiKey = $("api-key").value.trim();
      }
      if (id) state.profileBusy.add(id);
      renderProfiles();
      try {
        const data = await api(id ? `/profiles/${id}` : "/profiles", {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(payload),
        });
        if (sessionVersion !== state.sessionVersion) return;
        if (current()) {
          clearCredentials();
          updateCredentialValidity();
          if (!id) {
            state.selected = data.profile.id;
            state.jobs = [];
          }
        }
        applyProfile(data.profile);
        const refreshed = await refreshAfterProfileChange();
        if (!current()) return;
        closeDialog($("connect-dialog"));
        if (id) {
          if (refreshed) toast("账号信息已更新。");
          $("accounts-dialog").showModal();
        } else {
          if (refreshed) toast("IMA 连接已验证，请选择待分类知识库。");
          await openSettings(data.profile.id);
        }
      } finally {
        if (id) state.profileBusy.delete(id);
        renderProfiles();
      }
    },
    "connect-error",
  );
});
/** Apply committed mutations immediately, so a failed refresh cannot leave deleted accounts writable. */
function applyProfile(profile) {
  state.profilesVersion++;
  const index = state.profiles.findIndex((p) => p.id === profile.id);
  if (index < 0) state.profiles.push(profile);
  else state.profiles[index] = profile;
  renderProfiles();
}
/** A committed write must not look retryable just because a subsequent read failed. */
async function refreshAfterProfileChange() {
  const sessionVersion = state.sessionVersion;
  let refreshed = true;
  for (const load of [loadProfiles, loadHistory]) {
    try {
      await load();
    } catch {
      refreshed = false;
    }
    if (sessionVersion !== state.sessionVersion) return false;
  }
  if (!refreshed)
    toast("账号操作已完成，但列表或记录刷新失败，请点击刷新导入记录按钮重试。");
  return refreshed;
}
$("delete-confirm").addEventListener("click", () => {
  const id = state.deleting;
  if (!$("delete-dialog").open || !writableProfile(id)) return;
  const version = state.deleteVersion;
  const sessionVersion = state.sessionVersion;
  busy(
    $("delete-confirm"),
    async () => {
      state.profileBusy.add(id);
      renderProfiles();
      try {
        const data = await api(`/profiles/${id}`, {
          method: "DELETE",
          body: "{}",
        });
        if (sessionVersion !== state.sessionVersion) return;
        if (state.settings === id) closeDialog($("settings-dialog"));
        if (state.editing === id) closeDialog($("connect-dialog"));
        // A new dialog may hold another account's credentials; never clear that newer form.
        if (!$("connect-dialog").open) clearCredentials();
        if (state.selected === id) {
          state.selected =
            state.profiles.find((p) => p.id !== id && !p.deleted_at)?.id || id;
          state.jobs = [];
          $("import-error").textContent = "";
        }
        applyProfile(data.profile);
        const current =
          state.deleteVersion === version && $("delete-dialog").open;
        if (current) {
          closeDialog($("delete-dialog"));
          $("accounts-dialog").showModal();
        }
        toast("账号已删除，历史记录、PDF 和 IMA 中的内容均已保留。");
        await refreshAfterProfileChange();
      } finally {
        state.profileBusy.delete(id);
        renderProfiles();
      }
    },
    "delete-error",
  );
});
$("inbox-form").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(
    event.submitter || $("inbox-form").querySelector('button[type="submit"]'),
    async () => {
      const id = state.settings,
        version = state.settingsVersion;
      if (!writableProfile(id) || !$("settings-dialog").open) return;
      await api(`/profiles/${id}/settings`, {
        method: "PUT",
        body: JSON.stringify({ inboxId: $("inbox-select").value }),
      });
      if (state.settingsVersion !== version) return;
      await loadProfiles();
      toast("待分类知识库已保存。");
    },
    "settings-error",
  );
});
$("publisher-name").addEventListener("input", () => {
  $("publisher-key").value = "";
});
$("mapping-form").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(
    event.submitter || $("mapping-form").querySelector('button[type="submit"]'),
    async () => {
      const id = state.settings,
        version = state.settingsVersion;
      if (!writableProfile(id) || !$("settings-dialog").open) return;
      await api(`/profiles/${id}/mappings`, {
        method: "POST",
        body: JSON.stringify({
          accountName: $("publisher-name").value,
          accountKey: $("publisher-key").value || undefined,
          kbId: $("mapping-kb").value,
        }),
      });
      if (state.settingsVersion !== version) return;
      const data = await api(`/profiles/${id}/mappings`);
      if (state.settingsVersion !== version) return;
      state.mappings = data.mappings;
      renderMappings();
      $("mapping-form").reset();
      toast("公众号分配规则已保存。");
    },
    "settings-error",
  );
});
$("article-urls").addEventListener("input", () => {
  const count = $("article-urls")
    .value.trim()
    .split(/\s+/)
    .filter(Boolean).length;
  $("link-count").textContent = count
    ? `${count} 条链接 · 最多 10 条`
    : "每行一条文章链接";
});
$("paste").addEventListener("click", (event) =>
  busy(event.currentTarget, async () => {
    try {
      $("article-urls").value = await navigator.clipboard.readText();
      $("article-urls").dispatchEvent(new Event("input"));
    } catch {
      throw new Error("无法读取剪贴板，请直接粘贴到输入框。");
    }
  }),
);
$("import-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (state.importing) return;
  if (!writableProfile(state.selected) || !selectedProfile()?.inbox_id) {
    $("import-error").textContent =
      "请选择可用账号并设置待分类知识库，已删除账号仅可查看记录。";
    return;
  }
  state.importing = true;
  busy(
    $("save-articles"),
    async () => {
      const submitted = $("article-urls").value;
      const urls = submitted.trim().split(/\s+/).filter(Boolean);
      if (!urls.length || urls.length > 10)
        throw new Error("请输入 1 至 10 条文章链接。");
      await api("/jobs", {
        method: "POST",
        body: JSON.stringify({ profileId: state.selected, urls }),
      });
      if ($("article-urls").value === submitted) $("article-urls").value = "";
      $("article-urls").dispatchEvent(new Event("input"));
      await loadHistory();
      toast("已开始导入，关闭页面后也会继续处理。");
    },
    "import-error",
  ).finally(() => {
    state.importing = false;
    updateDestination();
  });
});
for (const b of document.querySelectorAll("[data-filter]"))
  b.addEventListener("click", () => {
    state.filter = b.dataset.filter;
    for (const other of document.querySelectorAll("[data-filter]")) {
      other.classList.toggle("selected", other === b);
      other.setAttribute("aria-pressed", String(other === b));
    }
    renderHistory();
  });
$("refresh").addEventListener("click", (event) =>
  busy(event.currentTarget, async () => {
    await loadProfiles();
    await loadHistory();
  }),
);
setInterval(() => {
  if (
    state.authenticated &&
    state.selected &&
    document.visibilityState === "visible" &&
    state.jobs.some((j) => !finished.has(j.stage))
  )
    loadHistory().catch((error) => toast(error.message));
}, 4000);
document.addEventListener("visibilitychange", () => {
  if (state.authenticated && document.visibilityState === "visible")
    loadHistory().catch((error) => toast(error.message));
});
try {
  const data = await api("/session");
  if (data.authenticated) await openWorkspace();
  else {
    showLogin();
    if (!data.configured)
      $("login-error").textContent =
        "网站尚未设置访问口令，请联系管理员完成配置。";
  }
} catch (error) {
  showLogin();
  $("login-error").textContent = error.message;
} finally {
  $("loading").hidden = true;
}
