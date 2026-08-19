/* =========================================================
   매일 공부 스탬프 — app.js
   순수 클라이언트(정적) 웹앱: 모든 데이터는 브라우저 localStorage에 저장됩니다.
   GitHub Pages 등 정적 호스팅에서 그대로 동작합니다.
   ========================================================= */

(function () {
  "use strict";

  /* ---------------- Storage Keys ---------------- */
  const DB = {
    USERS: "dss_users",
    GOALS: "dss_goals",
    COMPLETIONS: "dss_completions",
    SESSION: "dss_session",
  };

  /* ---------------- Utils ---------------- */
  function genId(prefix) {
    return (prefix || "id") + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function todayStr(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function daysBetween(startStr, endStr) {
    const start = new Date(startStr + "T00:00:00");
    const end = new Date(endStr + "T00:00:00");
    return Math.round((end - start) / 86400000);
  }

  const DOW_LABELS = ["일", "월", "화", "수", "목", "금", "토"];
  const ALPHANUM = "abcdefghijkmnpqrstuvwxyz23456789"; // 혼동되는 글자(0,o,1,l,i) 제외

  function randomCode() {
    let s = "";
    for (let i = 0; i < 4; i++) s += ALPHANUM[Math.floor(Math.random() * ALPHANUM.length)];
    return s;
  }

  function isValidCode(code) {
    return /^[a-z0-9]{4}$/i.test(code);
  }

  /* ---------------- Storage Access ---------------- */
  function loadUsers() { return JSON.parse(localStorage.getItem(DB.USERS) || "[]"); }
  function saveUsers(v) { localStorage.setItem(DB.USERS, JSON.stringify(v)); }
  function loadGoals() { return JSON.parse(localStorage.getItem(DB.GOALS) || "[]"); }
  function saveGoals(v) { localStorage.setItem(DB.GOALS, JSON.stringify(v)); }
  function loadCompletions() { return JSON.parse(localStorage.getItem(DB.COMPLETIONS) || "[]"); }
  function saveCompletions(v) { localStorage.setItem(DB.COMPLETIONS, JSON.stringify(v)); }

  function getSession() { return JSON.parse(localStorage.getItem(DB.SESSION) || "null"); }
  function setSession(userId) { localStorage.setItem(DB.SESSION, JSON.stringify({ userId })); }
  function clearSession() { localStorage.removeItem(DB.SESSION); }

  function initDB() {
    const users = loadUsers();
    if (users.length === 0) {
      users.push({
        id: genId("u"),
        name: "관리자",
        code: "a111",
        isAdmin: true,
        createdAt: todayStr(),
      });
      saveUsers(users);
    }
  }

  function getCurrentUser() {
    const s = getSession();
    if (!s) return null;
    return loadUsers().find((u) => u.id === s.userId) || null;
  }

  /* ---------------- Domain Logic ---------------- */
  function goalAppliesOnDate(goal, dateStr) {
    if (dateStr < goal.startDate) return false;
    if (goal.freqType === "daily") return true;
    if (goal.freqType === "weekly") {
      const dow = new Date(dateStr + "T00:00:00").getDay();
      return Array.isArray(goal.daysOfWeek) && goal.daysOfWeek.includes(dow);
    }
    if (goal.freqType === "interval") {
      const diff = daysBetween(goal.startDate, dateStr);
      const step = Math.max(2, parseInt(goal.intervalDays, 10) || 2);
      return diff >= 0 && diff % step === 0;
    }
    return false;
  }

  function goalsForUserOnDate(userId, dateStr) {
    return loadGoals()
      .filter((g) => g.userId === userId)
      .filter((g) => goalAppliesOnDate(g, dateStr));
  }

  function isDone(userId, goalId, dateStr) {
    return loadCompletions().some(
      (c) => c.userId === userId && c.goalId === goalId && c.date === dateStr && c.done
    );
  }

  function setDone(userId, goalId, dateStr, done) {
    let comps = loadCompletions();
    const idx = comps.findIndex((c) => c.userId === userId && c.goalId === goalId && c.date === dateStr);
    if (done) {
      if (idx >= 0) comps[idx].done = true;
      else comps.push({ userId, goalId, date: dateStr, done: true });
    } else if (idx >= 0) {
      comps.splice(idx, 1);
    }
    saveCompletions(comps);
  }

  function dayStatus(userId, dateStr) {
    const goals = goalsForUserOnDate(userId, dateStr);
    if (goals.length === 0) return "none";
    const doneCount = goals.filter((g) => isDone(userId, g.id, dateStr)).length;
    if (doneCount === 0) return "has-goals";
    if (doneCount === goals.length) return "done";
    return "partial";
  }

  /* ---------------- App State ---------------- */
  const state = {
    viewYear: new Date().getFullYear(),
    viewMonth: new Date().getMonth(), // 0-indexed
    modalDate: null,
    editingGoalId: null, // null = 새 목표, 값 있으면 수정
    currentFreq: "daily",
  };

  /* ---------------- DOM refs ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const screens = {
    login: $("#screen-login"),
    calendar: $("#screen-calendar"),
    settings: $("#screen-settings"),
  };

  function showScreen(name) {
    Object.values(screens).forEach((el) => el.classList.add("hidden"));
    screens[name].classList.remove("hidden");
  }

  /* ---------------- Modal helpers ---------------- */
  const modalOverlay = $("#modal-overlay");
  const modals = {
    day: $("#modal-day"),
    addGoal: $("#modal-add-goal"),
    changeCode: $("#modal-change-code"),
    addUser: $("#modal-add-user"),
  };

  function openModal(name) {
    modalOverlay.classList.remove("hidden");
    Object.values(modals).forEach((m) => m.classList.add("hidden"));
    modals[name].classList.remove("hidden");
  }
  function closeModal() {
    modalOverlay.classList.add("hidden");
    Object.values(modals).forEach((m) => m.classList.add("hidden"));
  }
  modalOverlay.addEventListener("click", (e) => {
    if (e.target === modalOverlay) closeModal();
  });
  $$("[data-close]").forEach((btn) => btn.addEventListener("click", closeModal));

  /* ---------------- 로그인 ---------------- */
  const loginCodeInput = $("#login-code");
  const loginError = $("#login-error");

  function doLogin() {
    const code = loginCodeInput.value.trim();
    loginError.textContent = "";
    if (!isValidCode(code)) {
      loginError.textContent = "4자리 코드를 입력해주세요.";
      return;
    }
    const user = loadUsers().find((u) => u.code.toLowerCase() === code.toLowerCase());
    if (!user) {
      loginError.textContent = "일치하는 사용자를 찾을 수 없습니다.";
      return;
    }
    setSession(user.id);
    loginCodeInput.value = "";
    enterApp();
  }

  $("#btn-login").addEventListener("click", doLogin);
  loginCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

  $("#btn-logout").addEventListener("click", () => {
    clearSession();
    showScreen("login");
  });

  function enterApp() {
    const user = getCurrentUser();
    if (!user) { showScreen("login"); return; }
    $("#current-user-name").textContent = user.name + (user.isAdmin ? " (관리자)" : "");
    showScreen("calendar");
    renderCalendar();
  }

  /* ---------------- 화면 전환 ---------------- */
  $("#btn-goto-settings").addEventListener("click", () => {
    renderSettings();
    showScreen("settings");
  });
  $("#btn-back-calendar").addEventListener("click", () => {
    renderCalendar();
    showScreen("calendar");
  });
  $("#link-add-first-goal").addEventListener("click", (e) => {
    e.preventDefault();
    renderSettings();
    showScreen("settings");
  });

  /* ---------------- 캘린더 렌더 ---------------- */
  $("#btn-prev-month").addEventListener("click", () => {
    state.viewMonth--;
    if (state.viewMonth < 0) { state.viewMonth = 11; state.viewYear--; }
    renderCalendar();
  });
  $("#btn-next-month").addEventListener("click", () => {
    state.viewMonth++;
    if (state.viewMonth > 11) { state.viewMonth = 0; state.viewYear++; }
    renderCalendar();
  });

  function renderCalendar() {
    const user = getCurrentUser();
    if (!user) return;
    const { viewYear, viewMonth } = state;
    $("#calendar-title").textContent = `${viewYear}년 ${viewMonth + 1}월`;

    const grid = $("#calendar-grid");
    grid.innerHTML = "";

    const firstDay = new Date(viewYear, viewMonth, 1);
    const startOffset = firstDay.getDay(); // 0=일
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const todayS = todayStr();

    const allGoals = loadGoals().filter((g) => g.userId === user.id);

    for (let i = 0; i < startOffset; i++) {
      const empty = document.createElement("div");
      empty.className = "day-cell empty";
      grid.appendChild(empty);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${viewYear}-${pad2(viewMonth + 1)}-${pad2(day)}`;
      const dow = new Date(viewYear, viewMonth, day).getDay();
      const cell = document.createElement("div");
      const status = dayStatus(user.id, dateStr);
      const hasGoals = allGoals.some((g) => goalAppliesOnDate(g, dateStr));

      cell.className = "day-cell status-" + status;
      if (hasGoals) cell.classList.add("has-goals");
      if (dateStr === todayS) cell.classList.add("today");
      if (dow === 0) cell.classList.add("other-sun");
      if (dow === 6) cell.classList.add("other-sat");

      cell.innerHTML = `<span class="day-num">${day}</span><span class="status-dot"></span>`;
      cell.addEventListener("click", () => openDayModal(dateStr));
      grid.appendChild(cell);
    }

    $("#no-goal-warning").classList.toggle("hidden", allGoals.length > 0);
  }

  /* ---------------- 날짜별 목표 체크 모달 ---------------- */
  function openDayModal(dateStr) {
    const user = getCurrentUser();
    state.modalDate = dateStr;
    const d = new Date(dateStr + "T00:00:00");
    $("#modal-day-title").textContent = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW_LABELS[d.getDay()]})`;

    const goals = goalsForUserOnDate(user.id, dateStr);
    const list = $("#modal-goal-list");
    list.innerHTML = "";

    $("#modal-no-goals").classList.toggle("hidden", goals.length > 0);

    goals.forEach((g) => {
      const li = document.createElement("li");
      li.className = "modal-goal-item";
      const checked = isDone(user.id, g.id, dateStr) ? "checked" : "";
      li.innerHTML = `
        <input type="checkbox" data-goal-id="${g.id}" ${checked} />
        <div class="modal-goal-item-text">
          <span class="modal-goal-item-title">${escapeHtml(g.title)}</span>
          ${g.description ? `<span class="modal-goal-item-desc">${escapeHtml(g.description)}</span>` : ""}
        </div>
      `;
      list.appendChild(li);
    });

    openModal("day");
  }

  $("#btn-save-day").addEventListener("click", () => {
    const user = getCurrentUser();
    const dateStr = state.modalDate;
    $$("#modal-goal-list input[type=checkbox]").forEach((cb) => {
      setDone(user.id, cb.dataset.goalId, dateStr, cb.checked);
    });
    closeModal();
    renderCalendar();
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : str;
    return div.innerHTML;
  }

  /* ---------------- 설정 화면: 목표 목록 ---------------- */
  function freqLabel(g) {
    if (g.freqType === "daily") return "매일";
    if (g.freqType === "weekly") {
      const days = (g.daysOfWeek || []).slice().sort().map((n) => DOW_LABELS[n]).join(", ");
      return `주간 (${days || "-"})`;
    }
    if (g.freqType === "interval") return `${g.intervalDays}일마다`;
    return "";
  }

  function renderSettings() {
    const user = getCurrentUser();
    if (!user) return;

    const goals = loadGoals().filter((g) => g.userId === user.id);
    const list = $("#goal-list");
    list.innerHTML = "";
    $("#goal-list-empty").classList.toggle("hidden", goals.length > 0);

    goals.forEach((g) => {
      const li = document.createElement("li");
      li.className = "goal-item";
      li.innerHTML = `
        <div class="goal-item-main">
          <span class="goal-item-title">${escapeHtml(g.title)}</span>
          <span class="goal-item-freq">${freqLabel(g)}</span>
        </div>
        <span>›</span>
      `;
      li.addEventListener("click", () => openGoalModal(g.id));
      list.appendChild(li);
    });

    $("#admin-block").classList.toggle("hidden", !user.isAdmin);
    if (user.isAdmin) renderUserList();
  }

  function renderUserList() {
    const users = loadUsers();
    const list = $("#user-list");
    list.innerHTML = "";
    users.forEach((u) => {
      const li = document.createElement("li");
      li.className = "user-item";
      li.innerHTML = `
        <div class="user-item-main">
          <span class="user-item-name">${escapeHtml(u.name)}</span>
          <span class="user-item-code">코드: ${escapeHtml(u.code)}</span>
        </div>
        ${u.isAdmin ? '<span class="user-item-admin-badge">관리자</span>' : ""}
      `;
      list.appendChild(li);
    });
  }

  /* ---------------- 목표 추가/수정 모달 ---------------- */
  const freqTabsEl = $("#freq-tabs");
  const weeklyOptionsEl = $("#freq-weekly-options");
  const intervalOptionsEl = $("#freq-interval-options");

  function setFreqTab(freq) {
    state.currentFreq = freq;
    $$(".freq-tab").forEach((btn) => btn.classList.toggle("active", btn.dataset.freq === freq));
    weeklyOptionsEl.classList.toggle("hidden", freq !== "weekly");
    intervalOptionsEl.classList.toggle("hidden", freq !== "interval");
  }

  freqTabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".freq-tab");
    if (!btn) return;
    setFreqTab(btn.dataset.freq);
  });

  function openGoalModal(goalId) {
    state.editingGoalId = goalId || null;
    $("#add-goal-error").textContent = "";
    const deleteBtn = $("#btn-delete-goal");

    if (goalId) {
      const g = loadGoals().find((x) => x.id === goalId);
      $("#add-goal-title-text").textContent = "목표 수정";
      $("#goal-title").value = g.title;
      $("#goal-desc").value = g.description || "";
      setFreqTab(g.freqType);
      $$("#dow-select input").forEach((cb) => {
        cb.checked = (g.daysOfWeek || []).includes(parseInt(cb.value, 10));
      });
      $("#interval-days").value = g.intervalDays || 3;
      deleteBtn.classList.remove("hidden");
    } else {
      $("#add-goal-title-text").textContent = "목표 추가";
      $("#goal-title").value = "";
      $("#goal-desc").value = "";
      setFreqTab("daily");
      $$("#dow-select input").forEach((cb) => (cb.checked = false));
      $("#interval-days").value = 3;
      deleteBtn.classList.add("hidden");
    }
    openModal("addGoal");
  }

  $("#btn-add-goal").addEventListener("click", () => openGoalModal(null));

  $("#btn-save-goal").addEventListener("click", () => {
    const user = getCurrentUser();
    const title = $("#goal-title").value.trim();
    const errEl = $("#add-goal-error");
    errEl.textContent = "";

    if (!title) { errEl.textContent = "제목을 입력해주세요."; return; }

    let daysOfWeek = [];
    let intervalDays = null;
    if (state.currentFreq === "weekly") {
      daysOfWeek = $$("#dow-select input:checked").map((cb) => parseInt(cb.value, 10));
      if (daysOfWeek.length === 0) { errEl.textContent = "요일을 하나 이상 선택해주세요."; return; }
    } else if (state.currentFreq === "interval") {
      intervalDays = Math.max(2, parseInt($("#interval-days").value, 10) || 2);
    }

    const goals = loadGoals();

    if (state.editingGoalId) {
      const idx = goals.findIndex((g) => g.id === state.editingGoalId);
      if (idx >= 0) {
        goals[idx].title = title;
        goals[idx].description = $("#goal-desc").value.trim();
        goals[idx].freqType = state.currentFreq;
        goals[idx].daysOfWeek = daysOfWeek;
        goals[idx].intervalDays = intervalDays;
      }
    } else {
      goals.push({
        id: genId("g"),
        userId: user.id,
        title,
        description: $("#goal-desc").value.trim(),
        freqType: state.currentFreq,
        daysOfWeek,
        intervalDays,
        startDate: todayStr(),
        createdAt: todayStr(),
      });
    }

    saveGoals(goals);
    closeModal();
    renderSettings();
    renderCalendar();
  });

  $("#btn-delete-goal").addEventListener("click", () => {
    if (!state.editingGoalId) return;
    if (!confirm("이 목표를 삭제하시겠습니까? 관련된 완료 기록도 함께 삭제됩니다.")) return;
    const goals = loadGoals().filter((g) => g.id !== state.editingGoalId);
    saveGoals(goals);
    const comps = loadCompletions().filter((c) => c.goalId !== state.editingGoalId);
    saveCompletions(comps);
    closeModal();
    renderSettings();
    renderCalendar();
  });

  /* ---------------- 접속 코드 변경 ---------------- */
  $("#btn-change-code").addEventListener("click", () => {
    $("#new-code-input").value = "";
    $("#change-code-error").textContent = "";
    openModal("changeCode");
  });

  $("#btn-confirm-change-code").addEventListener("click", () => {
    const user = getCurrentUser();
    const newCode = $("#new-code-input").value.trim();
    const errEl = $("#change-code-error");

    if (!isValidCode(newCode)) {
      errEl.textContent = "영문/숫자 4자리로 입력해주세요.";
      return;
    }
    const users = loadUsers();
    const dup = users.find((u) => u.id !== user.id && u.code.toLowerCase() === newCode.toLowerCase());
    if (dup) {
      errEl.textContent = "이미 사용 중인 코드입니다. 다른 코드를 입력해주세요.";
      return;
    }
    const idx = users.findIndex((u) => u.id === user.id);
    users[idx].code = newCode;
    saveUsers(users);
    clearSession();
    closeModal();
    alert("접속 코드가 변경되었습니다. 새 코드로 다시 로그인해주세요.");
    showScreen("login");
  });

  /* ---------------- 관리자: 사용자 추가 ---------------- */
  $("#btn-add-user").addEventListener("click", () => {
    $("#new-user-name").value = "";
    $("#new-user-code").value = randomCode();
    $("#add-user-error").textContent = "";
    openModal("addUser");
  });

  $("#btn-gen-code").addEventListener("click", () => {
    $("#new-user-code").value = randomCode();
  });

  $("#btn-confirm-add-user").addEventListener("click", () => {
    const name = $("#new-user-name").value.trim();
    const code = $("#new-user-code").value.trim();
    const errEl = $("#add-user-error");
    errEl.textContent = "";

    if (!name) { errEl.textContent = "이름을 입력해주세요."; return; }
    if (!isValidCode(code)) { errEl.textContent = "영문/숫자 4자리 코드를 입력해주세요."; return; }

    const users = loadUsers();
    const dup = users.find((u) => u.code.toLowerCase() === code.toLowerCase());
    if (dup) { errEl.textContent = "이미 사용 중인 코드입니다."; return; }

    users.push({
      id: genId("u"),
      name,
      code,
      isAdmin: false,
      createdAt: todayStr(),
    });
    saveUsers(users);
    closeModal();
    renderUserList();
  });

  /* ---------------- 초기화 ---------------- */
  document.addEventListener("DOMContentLoaded", () => {
    initDB();
    const user = getCurrentUser();
    if (user) enterApp();
    else showScreen("login");
  });
})();
