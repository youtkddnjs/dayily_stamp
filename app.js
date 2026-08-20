/* =========================================================
   매일 공부 스탬프 — app.js
   Firebase Firestore를 데이터 저장소로 사용하는 정적 웹앱입니다.
   (기기별 localStorage가 아니라, 모든 기기가 같은 Firestore 프로젝트를 공유합니다.)
   GitHub Pages 등 정적 호스팅에서 그대로 동작합니다.
   ========================================================= */

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updatePassword,
  deleteUser,
  signOut,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  writeBatch,
  enableIndexedDbPersistence,
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCPB4ifkXy0-SO88G94PBKAit1kHCm5x1c",
  authDomain: "dailystamp-b8c37.firebaseapp.com",
  projectId: "dailystamp-b8c37",
  storageBucket: "dailystamp-b8c37.firebasestorage.app",
  messagingSenderId: "24149820298",
  appId: "1:24149820298:web:271b2cd2a3a14f7b75be73",
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

try {
  // 오프라인에서도 최근 데이터를 볼 수 있고, 재접속 시 자동 동기화됩니다.
  // 같은 브라우저에서 탭을 여러 개 열면 실패할 수 있는데, 그 경우엔 그냥 무시합니다.
  await enableIndexedDbPersistence(db).catch(() => {});
} catch (err) {
  /* no-op */
}

(function () {
  "use strict";

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

  function completionDocId(userId, goalId, dateStr) {
    return `${userId}__${goalId}__${dateStr}`;
  }

  // 4자리 코드를 Firebase Auth 비밀번호(6자 이상 필요)로 변환합니다. 코드만 알면 항상
  // 같은 값이 나오므로 별도로 비밀번호를 저장/관리할 필요가 없습니다.
  const AUTH_EMAIL_DOMAIN = "dailystamp.local";
  function emailForUserId(userId) { return `${userId}@${AUTH_EMAIL_DOMAIN}`; }
  function derivePassword(code) { return "stamp-" + code.toLowerCase(); }

  /* ---------------- Firestore 캐시 (실시간 동기화) ---------------- */
  let usersCache = [];
  let goalsCache = [];
  let completionsCache = [];

  function loadUsers() { return usersCache; }
  function loadGoals() { return goalsCache; }
  function loadCompletions() { return completionsCache; }

  // 로그인 세션은 로컬(브라우저)에 저장하지 않습니다. 지금 로그인되어 있는 사람이
  // 누구인지는 오직 Firebase Authentication의 로그인 상태(onAuthStateChanged)로만 판단합니다.
  let currentAppUser = null;
  function getCurrentUser() { return currentAppUser; }

  /* ---------------- Firestore 쓰기 함수 ---------------- */

  // 관리자 계정을 만들면서 동시에 로그인 중인 사람(관리자 본인)의 세션이 끊기지 않도록,
  // 보조(secondary) Firebase 앱 인스턴스를 잠깐 띄워 그 안에서만 계정을 생성합니다.
  let secondaryAppSeq = 0;
  async function createAuthAccountFor(userId, code) {
    const secondaryApp = initializeApp(firebaseConfig, "secondary-" + Date.now() + "-" + (secondaryAppSeq++));
    const secondaryAuth = getAuth(secondaryApp);
    try {
      const cred = await createUserWithEmailAndPassword(secondaryAuth, emailForUserId(userId), derivePassword(code));
      return cred.user.uid;
    } finally {
      try { await signOut(secondaryAuth); } catch (e) { /* no-op */ }
      try { await deleteApp(secondaryApp); } catch (e) { /* no-op */ }
    }
  }

  // 최초 관리자 계정은 앱이 자동으로 만들지 않습니다. 이 앱을 배포한 사람이 Firebase 콘솔에서
  // 직접 Authentication 계정과 Firestore users/admin 문서를 만들어야 합니다(README 참고).
  // 그래서 관리자 로그인 정보는 소스 코드는 물론이고 이 앱의 실행 흐름에도 전혀 남지 않습니다.

  async function createUser(userData) {
    const id = genId("u");
    const authUid = await createAuthAccountFor(id, userData.code);
    await setDoc(doc(db, "users", id), {
      ...userData,
      authUid,
      authEmail: emailForUserId(id),
    });
    return id;
  }

  // 관리자 전용: 사용자와 그 사람의 목표·완료기록을 전부 지웁니다.
  async function deleteUserAndData(targetUser) {
    // 1) 가능하면 Firebase Authentication 계정도 함께 지웁니다. 클라이언트 SDK는 "지금 로그인한
    //    사람 스스로"만 자신의 계정을 지울 수 있으므로, 관리자가 이미 알고 있는 이 사용자의 코드로
    //    보조 앱 인스턴스에 잠깐 로그인한 뒤 그 세션에서 자기 자신을 삭제하는 방식을 씁니다
    //    (사용자 추가 때 보조 앱으로 계정을 만드는 것과 같은 방식의 역순이며, 관리자 본인의
    //    로그인 세션은 끊기지 않습니다). 이미 계정이 없거나 실패해도 아래 데이터 삭제는 계속 진행합니다.
    try {
      const secondaryApp = initializeApp(firebaseConfig, "secondary-del-" + Date.now() + "-" + (secondaryAppSeq++));
      const secondaryAuth = getAuth(secondaryApp);
      try {
        await signInWithEmailAndPassword(secondaryAuth, targetUser.authEmail, derivePassword(targetUser.code));
        await deleteUser(secondaryAuth.currentUser);
      } finally {
        try { await signOut(secondaryAuth); } catch (e) { /* no-op */ }
        try { await deleteApp(secondaryApp); } catch (e) { /* no-op */ }
      }
    } catch (err) {
      /* Auth 계정 삭제는 최선을 다해 시도할 뿐, 실패해도 아래 Firestore 데이터 삭제로 이어갑니다. */
    }

    // 2) Firestore의 사용자 문서 + 그 사람의 목표·완료기록을 모두 지웁니다(500건 단위 분할).
    const relatedGoals = goalsCache.filter((g) => g.userId === targetUser.id);
    const relatedCompletions = completionsCache.filter((c) => c.userId === targetUser.id);
    const ops = [{ ref: doc(db, "users", targetUser.id) }];
    relatedGoals.forEach((g) => ops.push({ ref: doc(db, "goals", g.id) }));
    relatedCompletions.forEach((c) => ops.push({ ref: doc(db, "completions", completionDocId(c.userId, c.goalId, c.date)) }));

    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      ops.slice(i, i + 400).forEach((op) => batch.delete(op.ref));
      await batch.commit();
    }

    // 리스너가 반영하기 전에 관리자가 곧바로 목록을 다시 볼 수도 있으므로 로컬 캐시도 즉시 갱신합니다.
    usersCache = usersCache.filter((u) => u.id !== targetUser.id);
    goalsCache = goalsCache.filter((g) => g.userId !== targetUser.id);
    completionsCache = completionsCache.filter((c) => c.userId !== targetUser.id);
  }

  // 본인 로그인 상태에서만 호출됩니다: Firestore의 code 필드와 Firebase Auth 비밀번호를 함께 갱신합니다.
  async function updateUserCode(userId, newCode) {
    await updatePassword(auth.currentUser, derivePassword(newCode));
    await updateDoc(doc(db, "users", userId), { code: newCode });
    // 호출부에서 곧바로 signOut()을 이어서 부르는데, Firestore의 실시간 리스너가 이 변경사항을
    // usersCache에 반영하기 "전에" 로그아웃이 먼저 일어나면 곧바로 새 코드로 재로그인했을 때
    // "일치하는 사용자를 찾을 수 없습니다" 오류가 날 수 있습니다(리스너 갱신은 비동기라 타이밍을
    // 보장할 수 없음). 이를 방지하기 위해 로컬 캐시도 즉시 함께 갱신해 이 경쟁 상태를 없앱니다.
    // (나중에 리스너가 같은 값을 다시 전달해도 동일한 값이라 문제 없습니다.)
    const cached = usersCache.find((u) => u.id === userId);
    if (cached) cached.code = newCode;
  }

  async function createGoal(goalData) {
    const id = genId("g");
    await setDoc(doc(db, "goals", id), goalData);
    return id;
  }

  async function updateGoal(goalId, patch) {
    await updateDoc(doc(db, "goals", goalId), patch);
  }

  async function deleteGoalAndCompletions(goalId) {
    const relatedCompletions = completionsCache.filter((c) => c.goalId === goalId);
    const batch = writeBatch(db);
    batch.delete(doc(db, "goals", goalId));
    relatedCompletions.forEach((c) => {
      batch.delete(doc(db, "completions", completionDocId(c.userId, c.goalId, c.date)));
    });
    await batch.commit();
  }

  async function setDone(userId, goalId, dateStr, done) {
    const ref = doc(db, "completions", completionDocId(userId, goalId, dateStr));
    if (done) {
      await setDoc(ref, { userId, goalId, date: dateStr, done: true });
    } else {
      await deleteDoc(ref);
    }
  }

  // 백업 파일로 특정 사용자의 목표+완료기록을 통째로 대체합니다. (일괄 batch, 500건 단위 분할)
  async function restoreUserData(userId, backupGoals, backupCompletions) {
    const existingGoals = goalsCache.filter((g) => g.userId === userId);
    const existingCompletions = completionsCache.filter((c) => c.userId === userId);

    const ops = [];
    existingGoals.forEach((g) => ops.push({ type: "delete", ref: doc(db, "goals", g.id) }));
    existingCompletions.forEach((c) =>
      ops.push({ type: "delete", ref: doc(db, "completions", completionDocId(c.userId, c.goalId, c.date)) })
    );
    backupGoals.forEach((g) => {
      const { id, ...rest } = g;
      const goalId = id || genId("g");
      ops.push({ type: "set", ref: doc(db, "goals", goalId), data: { ...rest, userId } });
    });
    backupCompletions.forEach((c) => {
      const newC = { userId, goalId: c.goalId, date: c.date, done: true };
      ops.push({ type: "set", ref: doc(db, "completions", completionDocId(userId, newC.goalId, newC.date)), data: newC });
    });

    for (let i = 0; i < ops.length; i += 400) {
      const batch = writeBatch(db);
      ops.slice(i, i + 400).forEach((op) => {
        if (op.type === "delete") batch.delete(op.ref);
        else batch.set(op.ref, op.data);
      });
      await batch.commit();
    }
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

  function dayStatus(userId, dateStr) {
    const goals = goalsForUserOnDate(userId, dateStr);
    if (goals.length === 0) return "none";
    const doneCount = goals.filter((g) => isDone(userId, g.id, dateStr)).length;
    if (doneCount === 0) return "has-goals";
    if (doneCount === goals.length) return "done";
    return "partial";
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

  const bootOverlay = $("#boot-overlay");
  const bootStatusText = $("#boot-status-text");
  const bootErrorEl = $("#boot-error");
  const appShell = $("#app-shell");
  const loginScreen = $("#screen-login");
  const innerScreens = {
    calendar: $("#screen-calendar"),
    dashboard: $("#screen-dashboard"),
    settings: $("#screen-settings"),
  };
  const SCREEN_TITLES = { calendar: "캘린더", dashboard: "현황판", settings: "설정" };

  function showBootError(msg) {
    bootStatusText.textContent = "연결에 문제가 발생했어요.";
    bootErrorEl.textContent = msg;
    bootErrorEl.classList.remove("hidden");
  }

  function hideBootOverlay() {
    bootOverlay.classList.add("hidden");
  }

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

  function activeScreenName() {
    return Object.keys(innerScreens).find((key) => !innerScreens[key].classList.contains("hidden"));
  }

  // Firestore 실시간 업데이트가 들어올 때마다(다른 기기에서의 변경 포함) 현재 보이는 화면을 새로고침합니다.
  function refreshCurrentScreen() {
    if (appShell.classList.contains("hidden")) return; // 로그인 전에는 갱신할 화면 없음
    const active = activeScreenName();
    if (active === "calendar") { renderCalendar(); renderMyStat(); }
    else if (active === "dashboard") renderDashboard();
    else if (active === "settings") renderSettings();
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

  $("#btn-logout-side").addEventListener("click", async () => {
    await signOut(auth); // onAuthStateChanged가 감지해서 로그인 화면으로 전환합니다.
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

  async function doLogin() {
    const code = loginCodeInput.value.trim();
    loginError.textContent = "";
    if (!isValidCode(code)) {
      loginError.textContent = "4자리 코드를 입력해주세요.";
      return;
    }
    const user = loadUsers().find((u) => u.code.toLowerCase() === code.toLowerCase());
    if (!user || !user.authEmail) {
      loginError.textContent = "일치하는 사용자를 찾을 수 없습니다.";
      return;
    }

    const btn = $("#btn-login");
    btn.disabled = true;
    try {
      // 실제 로그인은 Firebase Authentication으로 처리합니다. 성공하면 onAuthStateChanged가
      // 감지해서 화면 전환까지 이어서 처리합니다(로컬에는 아무것도 저장하지 않습니다).
      await signInWithEmailAndPassword(auth, user.authEmail, derivePassword(code));
      loginCodeInput.value = "";
    } catch (err) {
      loginError.textContent = "로그인에 실패했습니다. 코드를 다시 확인해주세요.";
    } finally {
      btn.disabled = false;
    }
  }

  $("#btn-login").addEventListener("click", doLogin);
  loginCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

  function enterApp(user) {
    currentAppUser = user;
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

  $("#btn-save-day").addEventListener("click", async () => {
    const user = getCurrentUser();
    const dateStr = state.modalDate;
    const btn = $("#btn-save-day");
    const checkboxes = $$("#modal-goal-list input[type=checkbox]");
    btn.disabled = true;
    btn.textContent = "저장 중...";
    try {
      await Promise.all(checkboxes.map((cb) => setDone(user.id, cb.dataset.goalId, dateStr, cb.checked)));
      closeModal();
      renderCalendar();
      renderMyStat();
    } catch (err) {
      alert("저장에 실패했습니다. 네트워크 상태를 확인해주세요.");
    } finally {
      btn.disabled = false;
      btn.textContent = "완료 저장";
    }
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
    const me = getCurrentUser();
    const list = $("#user-list");
    list.innerHTML = "";
    users.forEach((u) => {
      const li = document.createElement("li");
      li.className = "user-item";
      const isSelf = me && u.id === me.id;
      li.innerHTML = `
        <div class="user-item-main">
          <span class="user-item-name">${escapeHtml(u.name)}</span>
          <span class="user-item-code">코드: ${escapeHtml(u.code)}</span>
        </div>
        <div class="user-item-right">
          ${u.isAdmin ? '<span class="user-item-admin-badge">관리자</span>' : ""}
          ${isSelf ? "" : `<button type="button" class="icon-btn btn-delete-user" data-user-id="${u.id}" aria-label="사용자 삭제">삭제</button>`}
        </div>
      `;
      list.appendChild(li);
    });

    $$(".btn-delete-user").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const targetId = btn.dataset.userId;
        const target = users.find((u) => u.id === targetId);
        if (!target) return;
        const ok = confirm(
          `"${target.name}" 사용자를 삭제할까요?\n이 사용자의 목표와 완료 기록이 모두 함께 삭제되며, 되돌릴 수 없습니다.`
        );
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = "삭제 중...";
        try {
          await deleteUserAndData(target);
          renderSettings();
        } catch (err) {
          alert("삭제에 실패했습니다. 네트워크 상태를 확인하고 다시 시도해주세요.");
          btn.disabled = false;
          btn.textContent = "삭제";
        }
      });
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

  $("#btn-save-goal").addEventListener("click", async () => {
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

    const required = $("#goal-required").checked;
    const saveBtn = $("#btn-save-goal");
    saveBtn.disabled = true;

    try {
      if (state.editingGoalId) {
        await updateGoal(state.editingGoalId, {
          title,
          description: $("#goal-desc").value.trim(),
          freqType: state.currentFreq,
          daysOfWeek,
          intervalDays,
          required,
        });
      } else {
        await createGoal({
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
      closeModal();
      renderSettings();
      renderCalendar();
    } catch (err) {
      errEl.textContent = "저장에 실패했습니다. 네트워크 상태를 확인해주세요.";
    } finally {
      saveBtn.disabled = false;
    }
  });

  $("#btn-delete-goal").addEventListener("click", async () => {
    if (!state.editingGoalId) return;
    if (!confirm("이 목표를 삭제하시겠습니까? 관련된 완료 기록도 함께 삭제됩니다.")) return;
    try {
      await deleteGoalAndCompletions(state.editingGoalId);
      closeModal();
      renderSettings();
      renderCalendar();
    } catch (err) {
      alert("삭제에 실패했습니다. 네트워크 상태를 확인해주세요.");
    }
  });

  /* ---------------- 접속 코드 변경 ---------------- */
  $("#btn-change-code").addEventListener("click", () => {
    $("#new-code-input").value = "";
    $("#change-code-error").textContent = "";
    openModal("changeCode");
  });

  $("#btn-confirm-change-code").addEventListener("click", async () => {
    const user = getCurrentUser();
    const newCode = $("#new-code-input").value.trim();
    const errEl = $("#change-code-error");

    if (!isValidCode(newCode)) {
      errEl.textContent = "영문/숫자 4자리로 입력해주세요.";
      return;
    }
    const dup = loadUsers().find((u) => u.id !== user.id && u.code.toLowerCase() === newCode.toLowerCase());
    if (dup) {
      errEl.textContent = "이미 사용 중인 코드입니다. 다른 코드를 입력해주세요.";
      return;
    }
    try {
      await updateUserCode(user.id, newCode);
      closeModal();
      alert("접속 코드가 변경되었습니다. 새 코드로 다시 로그인해주세요.");
      await signOut(auth); // onAuthStateChanged가 로그인 화면 전환까지 처리합니다.
    } catch (err) {
      if (err && err.code === "auth/requires-recent-login") {
        errEl.textContent = "보안을 위해 다시 로그인한 후 코드를 변경해주세요.";
      } else {
        errEl.textContent = "변경에 실패했습니다. 네트워크 상태를 확인해주세요.";
      }
    }
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

  $("#btn-confirm-add-user").addEventListener("click", async () => {
    const name = $("#new-user-name").value.trim();
    const code = $("#new-user-code").value.trim();
    const errEl = $("#add-user-error");
    errEl.textContent = "";

    if (!name) { errEl.textContent = "이름을 입력해주세요."; return; }
    if (!isValidCode(code)) { errEl.textContent = "영문/숫자 4자리 코드를 입력해주세요."; return; }

    const dup = loadUsers().find((u) => u.code.toLowerCase() === code.toLowerCase());
    if (dup) { errEl.textContent = "이미 사용 중인 코드입니다."; return; }

    try {
      await createUser({ name, code, isAdmin: false, createdAt: todayStr() });
      closeModal();
      renderUserList();
    } catch (err) {
      errEl.textContent = "추가에 실패했습니다. 네트워크 상태를 확인해주세요.";
    }
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
    reader.onload = async () => {
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
      $("#backup-msg").textContent = "복구 중...";
      try {
        await restoreUserData(user.id, data.goals, data.completions);
        $("#backup-msg").textContent = "복구가 완료되었습니다.";
        renderSettings();
        renderCalendar();
        renderMyStat();
      } catch (err) {
        $("#backup-msg").textContent = "복구에 실패했습니다. 네트워크 상태를 확인해주세요.";
      } finally {
        e.target.value = "";
      }
    };
    reader.readAsText(file);
  });

  /* ---------------- 초기화 (Firebase 인증 상태가 모든 화면 전환의 유일한 기준) ---------------- */
  let firstUsersSnapshotResolve;
  const firstUsersSnapshotPromise = new Promise((resolve) => { firstUsersSnapshotResolve = resolve; });
  let listenersAttached = false;
  let bootedOnce = false;

  function attachRealtimeListeners() {
    if (listenersAttached) return;
    listenersAttached = true;
    onSnapshot(
      collection(db, "users"),
      (snap) => {
        usersCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (firstUsersSnapshotResolve) { firstUsersSnapshotResolve(); firstUsersSnapshotResolve = null; }
        if (currentAppUser) {
          const updated = usersCache.find((u) => u.id === currentAppUser.id);
          if (updated) {
            currentAppUser = updated;
          } else {
            // 다른 기기(관리자)에서 지금 로그인 중인 이 계정을 삭제한 경우: 강제 로그아웃합니다.
            currentAppUser = null;
            signOut(auth).catch(() => {});
          }
        }
        refreshCurrentScreen();
      },
      () => { if (firstUsersSnapshotResolve) { firstUsersSnapshotResolve(); firstUsersSnapshotResolve = null; } }
    );
    onSnapshot(collection(db, "goals"), (snap) => {
      goalsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      refreshCurrentScreen();
    });
    onSnapshot(collection(db, "completions"), (snap) => {
      completionsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      refreshCurrentScreen();
    });
  }

  // Firebase Authentication의 로그인 상태가 바뀔 때마다(최초 진입, 로그인, 로그아웃, 새로고침
  // 후 세션 복원 등) 호출됩니다. 로컬에 별도로 저장하는 세션이 없으므로 이 콜백이 유일한 기준입니다.
  // retryCount: 로그인된 Auth 계정과 짝을 이루는 Firestore 사용자 문서를 아직 못 찾았을 때
  // 재시도한 횟수입니다. 데이터 캐시가 늦게 도착하는 극히 드문 경우를 위한 재시도이지만, 관리자가
  // 이 계정을 삭제해 문서가 영영 없는 경우에는 무한 재시도로 빠지지 않도록 상한을 둡니다.
  async function handleAuthState(firebaseUser, retryCount = 0) {
    if (!firebaseUser) {
      // 완전히 로그아웃된 상태 → 로그인 화면에서 코드 검증을 하려면 최소한의 Firestore 접근
      // 권한이 필요하므로 다시 익명으로 연결합니다.
      currentAppUser = null;
      try {
        await signInAnonymously(auth);
      } catch (err) {
        showBootError(
          "인증에 실패했습니다. Firebase 콘솔 → Authentication → Sign-in method에서 '익명' 로그인이 사용 설정되어 있는지 확인해주세요."
        );
      }
      return;
    }

    if (firebaseUser.isAnonymous) {
      if (!bootedOnce) {
        bootedOnce = true;
        attachRealtimeListeners();
        await firstUsersSnapshotPromise;
        hideBootOverlay();
      }
      currentAppUser = null;
      showScreen("login");
      return;
    }

    // 익명이 아닌 실제 로그인 상태 (방금 로그인했거나, 이전 방문의 세션이 복원된 경우)
    attachRealtimeListeners(); // 안전망
    if (!bootedOnce) {
      bootedOnce = true;
      await firstUsersSnapshotPromise;
      hideBootOverlay();
    }
    const matched = usersCache.find((u) => u.authUid === firebaseUser.uid);
    if (matched) {
      enterApp(matched);
    } else if (retryCount < 15) {
      // 데이터 캐시가 아직 도착하지 않은 극히 드문 경우: 잠시 후 재시도 (최대 약 3초)
      setTimeout(() => handleAuthState(firebaseUser, retryCount + 1), 200);
    } else {
      // 그래도 못 찾으면 관리자가 이 계정을 삭제한 것으로 보고 로그아웃 처리합니다.
      currentAppUser = null;
      try { await signOut(auth); } catch (e) { /* no-op */ }
      loginError.textContent = "계정을 찾을 수 없습니다. 관리자에게 문의해주세요.";
    }
  }

  onAuthStateChanged(auth, (firebaseUser) => {
    handleAuthState(firebaseUser).catch((err) => {
      showBootError("예상치 못한 오류가 발생했습니다: " + (err && err.message ? err.message : err));
    });
  });
})();
