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

  // 특정 연/월의 달성률 통계. 목표 생성일이 해당 월 중간이면 goalAppliesOnDate가
  // startDate 이전 날짜를 자연스럽게 제외하므로 별도 보정 없이 생성일 기준으로 계산됩니다.
  // 아직 오지 않은 미래 날짜는 집계에서 제외합니다.
  function monthStats(userId, year, month) {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayS = todayStr();
    let applicableDays = 0;
    let fullyDoneDays = 0;
    let slotsTotal = 0;
    let slotsDone = 0;

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${pad2(month + 1)}-${pad2(day)}`;
      if (dateStr > todayS) break; // 미래 날짜는 집계하지 않음
      const goals = goalsForUserOnDate(userId, dateStr);
      if (goals.length === 0) continue; // 목표가 없던 날(계정/목표 생성 이전 포함)은 분모에서 제외
      applicableDays++;
      const doneCount = goals.filter((g) => isDone(userId, g.id, dateStr)).length;
      slotsTotal += goals.length;
      slotsDone += doneCount;
      if (doneCount === goals.length) fullyDoneDays++;
    }

    const rate = slotsTotal > 0 ? Math.round((slotsDone / slotsTotal) * 100) : null;
    return { applicableDays, fullyDoneDays, slotsTotal, slotsDone, rate };
  }

  // 오늘(또는 목표가 있던 가장 최근 날짜)부터 거슬러 올라가며 모든 목표를 완료한 날의 연속 일수.
  // 아직 진행 중인 오늘/가장 최근 날짜가 미완료여도 스트릭을 끊지 않고 건너뜁니다.
  function currentStreak(userId) {
    let streak = 0;
    const cursor = new Date();
    let seenFirstApplicable = false;

    for (let i = 0; i < 3650; i++) {
      const dateStr = todayStr(cursor);
      const goals = goalsForUserOnDate(userId, dateStr);
      if (goals.length > 0) {
        const doneCount = goals.filter((g) => isDone(userId, g.id, dateStr)).length;
        const fullyDone = doneCount === goals.length;
        if (fullyDone) {
          streak++;
        } else if (seenFirstApplicable) {
          break;
        }
        seenFirstApplicable = true;
      }
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
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
  const dashState = {
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
  };

  /* ---------------- DOM refs ---------------- */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const appShell = $("#app-shell");
  const loginScreen = $("#screen-login");
  const innerScreens = {
    calendar: $("#screen-calendar"),
    dashboard: $("#screen-dashboard"),
    settings: $("#screen-settings"),
  };
  const SCREEN_TITLES = { calendar: "캘린더", dashboard: "현황판", settings: "설정" };

  function showScreen(name) {
    if (name === "login") {
      appShell.classList.add("hidden");
      loginScreen.classList.remove("hidden");
      return;
    }
    loginScreen.classList.add("hidden");
    appShell.classList.remove("hidden");
    Object.keys(innerScreens).forEach((key) => {
      innerScreens[key].classList.toggle("hidden", key !== name);
    });
    $("#screen-title-label").textContent = SCREEN_TITLES[name] || "";
    $$(".side-nav-btn[data-screen]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.screen === name);
    });
  }

  $$(".side-nav-btn[data-screen]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.screen;
      if (name === "calendar") { renderCalendar(); renderMyStat(); }
      if (name === "dashboard") renderDashboard();
      if (name === "settings") renderSettings();
      showScreen(name);
    });
  });

  $("#btn-logout-side").addEventListener("click", () => {
    clearSession();
    showScreen("login");
  });

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

  function enterApp() {
    const user = getCurrentUser();
    if (!user) { showScreen("login"); return; }
    $("#current-user-name").textContent = user.name + (user.isAdmin ? " (관리자)" : "");
    renderCalendar();
    renderMyStat();
    showScreen("calendar");
  }

  /* ---------------- 화면 전환 ---------------- */
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

  /* ---------------- 개인 달성률 카드 (이번 달 기준, 캘린더 탐색과 무관) ---------------- */
  function renderMyStat() {
    const user = getCurrentUser();
    if (!user) return;
    const now = new Date();
    const stats = monthStats(user.id, now.getFullYear(), now.getMonth());
    const streak = currentStreak(user.id);

    if (stats.rate == null) {
      $("#my-stat-value").textContent = "—";
      $("#my-stat-bar").style.width = "0%";
      $("#my-stat-sub").textContent = "이번 달 아직 진행할 목표가 없어요.";
    } else {
      $("#my-stat-value").textContent = stats.rate + "%";
      $("#my-stat-bar").style.width = stats.rate + "%";
      $("#my-stat-sub").textContent = `${stats.slotsDone}/${stats.slotsTotal} 목표 완료 · 완전 달성 ${stats.fullyDoneDays}/${stats.applicableDays}일`;
    }
    $("#my-stat-streak").textContent = `🔥 연속 ${streak}일`;
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
      const isRequired = g.required !== false;
      li.innerHTML = `
        <input type="checkbox" data-goal-id="${g.id}" ${checked} />
        <div class="modal-goal-item-text">
          <span class="modal-goal-item-title">${escapeHtml(g.title)}${isRequired ? '<span class="required-tag">필수</span>' : '<span class="optional-tag">선택</span>'}</span>
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
    renderMyStat();
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
      const isRequired = g.required !== false;
      li.innerHTML = `
        <div class="goal-item-main">
          <span class="goal-item-title">${escapeHtml(g.title)}${isRequired ? '<span class="required-tag">필수</span>' : '<span class="optional-tag">선택</span>'}</span>
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

  /* ---------------- 현황판 화면 (전체 참여자) ---------------- */
  $("#btn-dash-prev-month").addEventListener("click", () => {
    dashState.month--;
    if (dashState.month < 0) { dashState.month = 11; dashState.year--; }
    renderDashboard();
  });
  $("#btn-dash-next-month").addEventListener("click", () => {
    dashState.month++;
    if (dashState.month > 11) { dashState.month = 0; dashState.year++; }
    renderDashboard();
  });

  function renderDashboard() {
    $("#dashboard-month-title").textContent = `${dashState.year}년 ${dashState.month + 1}월`;

    const users = loadUsers();
    const list = $("#dashboard-user-list");
    list.innerHTML = "";

    users.forEach((u) => {
      const stats = monthStats(u.id, dashState.year, dashState.month);
      const streak = currentStreak(u.id);
      const rateText = stats.rate == null ? "—" : stats.rate + "%";
      const barWidth = stats.rate == null ? 0 : stats.rate;

      const li = document.createElement("li");
      li.className = "dashboard-item";
      li.innerHTML = `
        <div class="dashboard-item-top">
          <span class="dashboard-item-name">${escapeHtml(u.name)}${u.isAdmin ? '<span class="admin-tag">관리자</span>' : ""}</span>
          <span class="dashboard-item-rate">${rateText}</span>
        </div>
        <div class="dashboard-bar-wrap"><div class="dashboard-bar" style="width:${barWidth}%"></div></div>
        <div class="dashboard-item-sub">
          <span>${stats.slotsTotal ? `${stats.slotsDone}/${stats.slotsTotal} 목표 완료` : "이 달에 진행할 목표 없음"}</span>
          <span class="streak-badge">🔥 연속 ${streak}일</span>
        </div>
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
      $("#goal-required").checked = g.required !== false;
      deleteBtn.classList.remove("hidden");
    } else {
      $("#add-goal-title-text").textContent = "목표 추가";
      $("#goal-title").value = "";
      $("#goal-desc").value = "";
      setFreqTab("daily");
      $$("#dow-select input").forEach((cb) => (cb.checked = false));
      $("#interval-days").value = 3;
      $("#goal-required").checked = true;
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
    const required = $("#goal-required").checked;

    if (state.editingGoalId) {
      const idx = goals.findIndex((g) => g.id === state.editingGoalId);
      if (idx >= 0) {
        goals[idx].title = title;
        goals[idx].description = $("#goal-desc").value.trim();
        goals[idx].freqType = state.currentFreq;
        goals[idx].daysOfWeek = daysOfWeek;
        goals[idx].intervalDays = intervalDays;
        goals[idx].required = required;
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
        required,
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

  /* ---------------- 데이터 백업 및 복구 (내 계정 전용) ---------------- */
  const BACKUP_SIGNATURE = "daily-study-stamp-backup";
  const BACKUP_VERSION = 1;

  $("#btn-backup").addEventListener("click", () => {
    const user = getCurrentUser();
    if (!user) return;
    const goals = loadGoals().filter((g) => g.userId === user.id);
    const completions = loadCompletions().filter((c) => c.userId === user.id);
    const payload = {
      app: BACKUP_SIGNATURE,
      version: BACKUP_VERSION,
      exportedAt: todayStr(),
      userName: user.name,
      goals,
      completions,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `study-stamp-backup-${user.name}-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    $("#backup-msg").textContent = `백업 파일이 다운로드되었습니다. (목표 ${goals.length}개, 완료기록 ${completions.length}건)`;
  });

  $("#btn-restore").addEventListener("click", () => {
    $("#backup-msg").textContent = "";
    $("#restore-file-input").click();
  });

  $("#restore-file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch (err) {
        alert("파일을 읽을 수 없습니다. 올바른 백업(JSON) 파일인지 확인해주세요.");
        e.target.value = "";
        return;
      }

      if (data.app !== BACKUP_SIGNATURE || !Array.isArray(data.goals) || !Array.isArray(data.completions)) {
        alert("이 앱의 백업 파일이 아닙니다.");
        e.target.value = "";
        return;
      }

      const confirmMsg =
        `백업 파일 정보\n- 백업 계정: ${data.userName || "알 수 없음"}\n- 백업 일자: ${data.exportedAt || "알 수 없음"}\n` +
        `- 목표 ${data.goals.length}개, 완료기록 ${data.completions.length}건\n\n` +
        `현재 로그인된 계정의 기존 목표와 완료 기록을 이 백업 내용으로 모두 대체합니다. 계속할까요?`;
      if (!confirm(confirmMsg)) {
        e.target.value = "";
        return;
      }

      const user = getCurrentUser();
      const otherGoals = loadGoals().filter((g) => g.userId !== user.id);
      const otherCompletions = loadCompletions().filter((c) => c.userId !== user.id);
      const restoredGoals = data.goals.map((g) => ({ ...g, userId: user.id }));
      const restoredCompletions = data.completions.map((c) => ({ ...c, userId: user.id }));

      saveGoals(otherGoals.concat(restoredGoals));
      saveCompletions(otherCompletions.concat(restoredCompletions));

      $("#backup-msg").textContent = "복구가 완료되었습니다.";
      e.target.value = "";
      renderSettings();
      renderCalendar();
      renderMyStat();
    };
    reader.readAsText(file);
  });

  /* ---------------- 초기화 ---------------- */
  document.addEventListener("DOMContentLoaded", () => {
    initDB();
    const user = getCurrentUser();
    if (user) enterApp();
    else showScreen("login");
  });
})();
