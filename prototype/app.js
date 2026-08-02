// 問題データはprototype/problems.json（scripts/export_to_prototype.pyが生成）から取得する。
// verified=Trueの問題のみが含まれる。取得完了まではstart-buttonを無効化しておく
let PROBLEMS = [];

async function loadProblems() {
  const res = await fetch("problems.json");
  if (!res.ok) throw new Error(`problems.json fetch failed: ${res.status}`);
  PROBLEMS = await res.json();
}

const ACCENT_LANG = { us: "en-US", gb: "en-GB", au: "en-AU" };
const ACCENT_KEYS = ["us", "gb", "au"];
const INTER_PROBLEM_PAUSE_MS = 2000; // 問題間の間。iOSでは次の音声再生がユーザー操作から遅延するため、
                                      // 自動再生がブロックされる可能性がある（実機要確認）

const state = {
  selectedLevel: "beginner",
  selectedSet: 1, // レベル内のセット番号（バックログNo.3.5）。"mix"選択時は使わない
  selectedAccent: "us", // 現状は米国英語の音声しか用意していないため（他はUIでロック済み）
  speedRate: 1,
  queue: [],
  poolSize: 0,
  cleared: new Set(),
  currentIndex: 0,
  scoreSum: 0,
  totalCount: 0,
  streak: 0,
  bestStreak: 0,
};

const screens = {
  top: document.getElementById("screen-top"),
  part: document.getElementById("screen-part"),
  select: document.getElementById("screen-select"),
  listen: document.getElementById("screen-listen"),
  answer: document.getElementById("screen-answer"),
  summary: document.getElementById("screen-summary"),
  stats: document.getElementById("screen-stats"),
};

function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    if (key === name) {
      el.classList.remove("hidden");
      el.classList.add("screen-enter");
      // 次フレームでenterクラスを外し、遷移アニメーションを発火させる
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("screen-enter")));
    } else {
      el.classList.add("hidden");
    }
  });
}

// --- 効果音・バイブ ---
let audioCtx = null;
function playBeep(freq, duration) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (e) {
    // AudioContext未対応環境では無音でよい
  }
}

function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

// 複数の単音を時間差で鳴らして簡単なチャイムにする（音声ファイル不要、Web Audio APIのみ）
function playChime(notes) {
  let t = 0;
  notes.forEach(([freq, duration]) => {
    setTimeout(() => playBeep(freq, duration), t * 1000);
    t += duration * 0.85; // 次の音を少し重ねて繋がりよく聞こえるようにする
  });
}

const LEVEL_UP_CHIME = [
  [523.25, 0.12],
  [659.25, 0.12],
  [783.99, 0.2],
]; // ド・ミ・ソの上昇アルペジオ
const PERFECT_WEEK_CHIME = [
  [523.25, 0.1],
  [659.25, 0.1],
  [783.99, 0.1],
  [1046.5, 0.28],
]; // ド・ミ・ソ・高いドの華やかなファンファーレ
const SESSION_COMPLETE_CHIME = [
  [659.25, 0.12],
  [783.99, 0.12],
  [1046.5, 0.24],
]; // ミ・ソ・高いドの締めくくりの和音

// emoji表示 + 下部タイムバーを durationMs かけて満たし、終わったら onDone を呼ぶ
// （問題間の「間」を可視化する役割も兼ねる）
function showReaction(emoji, durationMs, onDone) {
  const overlay = document.getElementById("reaction-overlay");
  const emojiEl = document.getElementById("reaction-emoji");
  const barFill = document.getElementById("reaction-bar-fill");

  emojiEl.textContent = emoji;
  emojiEl.style.animation = "none";
  void emojiEl.offsetWidth; // アニメーション再発火のためのreflow
  emojiEl.style.animation = "";

  barFill.style.transition = "none";
  barFill.style.width = "0%";
  void barFill.offsetWidth;
  barFill.style.transition = `width ${durationMs}ms linear`;
  barFill.style.width = "100%";

  overlay.classList.remove("hidden");
  setTimeout(() => {
    overlay.classList.add("hidden");
    onDone && onDone();
  }, durationMs);
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.remove("show"), 1500);
}

// --- 練習履歴の永続化（localStorage、端末内のみ。サーバー同期はしない） ---
const HISTORY_KEY = "eigo-shukan-juku:history:v1";

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || {};
  } catch (e) {
    return {}; // 壊れた値が入っていた場合は空として扱う（練習自体は止めない）
  }
}

function saveHistory(history) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (e) {
    // ストレージ容量超過等。記録できないだけで練習は続行できるようにする
  }
}

// 自己評価の3段階。「できた」だけを正解扱いにする（半分は部分点として記録には残すが、
// クリア・ストリークの継続条件にはしない）
const SCORE_BY_TIER = { perfect: 1, half: 0.5, none: 0 };

function recordAttempt(problemId, tier) {
  recordPracticeDay();
  recordDailyAttempt(tier);
  awardXp(tier);
  awardCoins(tier);
  checkAndAwardBadges();
  maybeCelebratePerfectWeek();

  const history = loadHistory();
  const entry = history[problemId] || { attempts: 0, scoreSum: 0 };
  entry.attempts += 1;
  entry.scoreSum += SCORE_BY_TIER[tier];
  entry.lastResult = tier;
  entry.lastAt = new Date().toISOString();
  history[problemId] = entry;
  saveHistory(history);
}

function lifetimeStats() {
  const history = loadHistory();
  return Object.values(history).reduce(
    (acc, entry) => ({
      attempts: acc.attempts + entry.attempts,
      scoreSum: acc.scoreSum + entry.scoreSum,
    }),
    { attempts: 0, scoreSum: 0 }
  );
}

function renderLifetimeStats() {
  const el = document.getElementById("lifetime-stats");
  if (!el) return;
  const { attempts, scoreSum } = lifetimeStats();
  if (attempts === 0) {
    el.textContent = "これまでの記録: まだありません";
    return;
  }
  const pct = Math.round((scoreSum / attempts) * 100);
  el.textContent = `これまでの記録: 累計${attempts}問・達成度${pct}%`;
}

// --- 練習日トラッキング（ストリーク計算用。日付境界はUTC基準の簡略化） ---
const PRACTICE_DAYS_KEY = "eigo-shukan-juku:practice-days:v1";

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function loadPracticeDays() {
  try {
    return JSON.parse(localStorage.getItem(PRACTICE_DAYS_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function savePracticeDays(days) {
  try {
    localStorage.setItem(PRACTICE_DAYS_KEY, JSON.stringify(days));
  } catch (e) {
    // 保存できなくてもストリーク表示が0になるだけで練習は続行できる
  }
}

function shiftDayKey(key, deltaDays) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

// --- ストリークフリーズ（1日休んでもストリークが途切れないための救済アイテム） ---
const STREAK_FREEZE_KEY = "eigo-shukan-juku:streak-freezes:v1";
const FROZEN_DAYS_KEY = "eigo-shukan-juku:frozen-days:v1";
const FREEZE_MILESTONE_KEY = "eigo-shukan-juku:freeze-milestone:v1";
const MAX_STREAK_FREEZES = 2;
const FREEZE_EARN_INTERVAL_DAYS = 7; // 7日連続ごとに1個獲得

function loadFreezeCount() {
  try {
    return JSON.parse(localStorage.getItem(STREAK_FREEZE_KEY)) ?? 0;
  } catch (e) {
    return 0;
  }
}

function saveFreezeCount(n) {
  try {
    localStorage.setItem(STREAK_FREEZE_KEY, JSON.stringify(n));
  } catch (e) {
    // 保存できなくても練習は続行できる
  }
}

function loadFrozenDays() {
  try {
    return JSON.parse(localStorage.getItem(FROZEN_DAYS_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveFrozenDays(days) {
  try {
    localStorage.setItem(FROZEN_DAYS_KEY, JSON.stringify(days));
  } catch (e) {
    // 保存できなくても練習は続行できる
  }
}

// 「昨日だけ」練習を忘れていた場合、フリーズが1個以上あれば自動で昨日を穴埋めする
function maybeUseStreakFreeze() {
  const days = new Set(loadPracticeDays());
  const today = todayKey();
  const yesterday = shiftDayKey(today, -1);
  const twoDaysAgo = shiftDayKey(today, -2);
  if (days.has(today) || days.has(yesterday) || !days.has(twoDaysAgo)) return;

  const freezes = loadFreezeCount();
  if (freezes <= 0) return;

  saveFreezeCount(freezes - 1);
  const frozen = loadFrozenDays();
  if (!frozen.includes(yesterday)) {
    frozen.push(yesterday);
    saveFrozenDays(frozen);
  }
}

// ストリークが新たに7の倍数に到達するたびにフリーズを1個獲得する（上限あり）
function maybeAwardStreakFreeze(streak) {
  const lastMilestone = parseInt(localStorage.getItem(FREEZE_MILESTONE_KEY) || "0", 10);
  const milestone = Math.floor(streak / FREEZE_EARN_INTERVAL_DAYS);
  if (milestone > lastMilestone) {
    localStorage.setItem(FREEZE_MILESTONE_KEY, String(milestone));
    saveFreezeCount(Math.min(loadFreezeCount() + 1, MAX_STREAK_FREEZES));
  }
}

function recordPracticeDay() {
  maybeUseStreakFreeze();
  const days = loadPracticeDays();
  const key = todayKey();
  if (!days.includes(key)) {
    days.push(key);
    savePracticeDays(days);
  }
  maybeAwardStreakFreeze(currentStreak());
}

function currentStreak() {
  const days = new Set([...loadPracticeDays(), ...loadFrozenDays()]);
  let streak = 0;
  const cursor = new Date();
  if (!days.has(todayKey(cursor))) cursor.setDate(cursor.getDate() - 1); // 今日未記録でも昨日までの連続は維持
  while (days.has(todayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// あと何日で次のキリのいいストリーク日数（7/14/30/50/100...）に届くか
const STREAK_MILESTONES = [7, 14, 30, 50, 100, 200, 365];

function nextStreakMilestoneMessage(streak) {
  const next = STREAK_MILESTONES.find((m) => m > streak);
  if (!next) return "";
  return `あと${next - streak}日で${next}日連続達成！`;
}

// --- 日次ログ（デイリー目標・週次レポート・成長グラフの共通データ源） ---
const DAILY_LOG_KEY = "eigo-shukan-juku:daily-log:v1";
const DAILY_GOAL = 10; // 1日の目標問題数（固定値。将来的にユーザー設定にしてもよい）

function loadDailyLog() {
  try {
    return JSON.parse(localStorage.getItem(DAILY_LOG_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveDailyLog(log) {
  try {
    localStorage.setItem(DAILY_LOG_KEY, JSON.stringify(log));
  } catch (e) {
    // 保存できなくても練習は続行できる
  }
}

function recordDailyAttempt(tier) {
  const log = loadDailyLog();
  const key = todayKey();
  const entry = log[key] || { attempts: 0, scoreSum: 0 };
  entry.attempts += 1;
  entry.scoreSum += SCORE_BY_TIER[tier];
  log[key] = entry;
  saveDailyLog(log);
}

function todayProgress() {
  const log = loadDailyLog();
  return log[todayKey()] || { attempts: 0, scoreSum: 0 };
}

function weeklyReport() {
  const log = loadDailyLog();
  const today = todayKey();
  let attempts = 0;
  let scoreSum = 0;
  let daysActive = 0;
  for (let i = 0; i < 7; i++) {
    const entry = log[shiftDayKey(today, -i)];
    if (entry) {
      attempts += entry.attempts;
      scoreSum += entry.scoreSum;
      daysActive += 1;
    }
  }
  return { attempts, scoreSum, daysActive };
}

// --- パーフェクトウィーク演出（7日連続、全問「できた」だった場合の特別演出） ---
const PERFECT_WEEK_LAST_KEY = "eigo-shukan-juku:perfect-week-last:v1";

function isPerfectWeek() {
  const log = loadDailyLog();
  const today = todayKey();
  for (let i = 0; i < 7; i++) {
    const entry = log[shiftDayKey(today, -i)];
    if (!entry || entry.attempts === 0 || entry.scoreSum !== entry.attempts) return false;
  }
  return true;
}

function maybeCelebratePerfectWeek() {
  const today = todayKey();
  if (localStorage.getItem(PERFECT_WEEK_LAST_KEY) === today) return; // 同じ日に何度も演出しない
  if (isPerfectWeek()) {
    localStorage.setItem(PERFECT_WEEK_LAST_KEY, today);
    showToast("🎊 パーフェクトウィーク達成！7日連続で全問「できた」！");
    playChime(PERFECT_WEEK_CHIME);
  }
}

// --- XP・レベル ---
const XP_KEY = "eigo-shukan-juku:xp:v1";
const XP_BY_TIER = { perfect: 10, half: 5, none: 2 }; // 挑戦したこと自体にも少し加点する
const XP_PER_LEVEL = 100;

function loadXp() {
  try {
    return JSON.parse(localStorage.getItem(XP_KEY)) || 0;
  } catch (e) {
    return 0;
  }
}

function saveXp(xp) {
  try {
    localStorage.setItem(XP_KEY, JSON.stringify(xp));
  } catch (e) {
    // 保存できなくても練習は続行できる
  }
}

function levelForXp(xp) {
  return Math.floor(xp / XP_PER_LEVEL) + 1;
}

function awardXp(tier) {
  const before = loadXp();
  const after = before + XP_BY_TIER[tier];
  saveXp(after);
  if (levelForXp(after) > levelForXp(before)) {
    showToast(`⭐ レベルアップ！ Lv.${levelForXp(after)}`);
    playChime(LEVEL_UP_CHIME);
  }
}

// --- コイン・アイテム交換（ストリークフリーズをコインで購入できる） ---
const COINS_KEY = "eigo-shukan-juku:coins:v1";
const COINS_BY_TIER = { perfect: 3, half: 2, none: 1 }; // 挑戦そのものにも少し加点する
const FREEZE_COST_COINS = 30;

function loadCoins() {
  try {
    return JSON.parse(localStorage.getItem(COINS_KEY)) || 0;
  } catch (e) {
    return 0;
  }
}

function saveCoins(coins) {
  try {
    localStorage.setItem(COINS_KEY, JSON.stringify(coins));
  } catch (e) {
    // 保存できなくても練習は続行できる
  }
}

function awardCoins(tier) {
  saveCoins(loadCoins() + COINS_BY_TIER[tier]);
}

function buyStreakFreeze() {
  if (loadFreezeCount() >= MAX_STREAK_FREEZES) {
    showToast("ストリークフリーズはすでに上限です");
    return;
  }
  const coins = loadCoins();
  if (coins < FREEZE_COST_COINS) {
    showToast(`🪙 コインが足りません（あと${FREEZE_COST_COINS - coins}枚）`);
    return;
  }
  saveCoins(coins - FREEZE_COST_COINS);
  saveFreezeCount(loadFreezeCount() + 1);
  showToast("❄️ ストリークフリーズを購入しました！");
  renderStatsScreen();
}

// --- 総練習時間（セッション単位で計測。個々の問題の思考時間までは測らない簡易版） ---
const PRACTICE_TIME_MS_KEY = "eigo-shukan-juku:practice-time-ms:v1";
let sessionStartedAt = null;

function loadTotalPracticeMs() {
  try {
    return JSON.parse(localStorage.getItem(PRACTICE_TIME_MS_KEY)) || 0;
  } catch (e) {
    return 0;
  }
}

function addPracticeMs(ms) {
  try {
    localStorage.setItem(PRACTICE_TIME_MS_KEY, JSON.stringify(loadTotalPracticeMs() + ms));
  } catch (e) {
    // 保存できなくても練習は続行できる
  }
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  return `${hours}時間${minutes % 60}分`;
}

// --- 実績バッジ ---
const BADGES_KEY = "eigo-shukan-juku:badges:v1";
const BADGE_DEFS = [
  { id: "first-step", emoji: "🐣", label: "はじめの一歩", check: (s) => s.lifetimeAttempts >= 1 },
  { id: "steady-50", emoji: "📘", label: "コツコツ50問", check: (s) => s.lifetimeAttempts >= 50 },
  { id: "veteran-100", emoji: "🏆", label: "百戦錬磨", check: (s) => s.lifetimeAttempts >= 100 },
  { id: "streak-3", emoji: "🔥", label: "3日坊主卒業", check: (s) => s.streak >= 3 },
  { id: "streak-7", emoji: "⚡", label: "1週間戦士", check: (s) => s.streak >= 7 },
  { id: "perfect-session", emoji: "🌟", label: "パーフェクトセッション", check: (s) => s.hadPerfectSession },
];

function loadBadges() {
  try {
    return JSON.parse(localStorage.getItem(BADGES_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveBadges(badges) {
  try {
    localStorage.setItem(BADGES_KEY, JSON.stringify(badges));
  } catch (e) {
    // 保存できなくても練習は続行できる
  }
}

function checkAndAwardBadges(extra = {}) {
  const earned = new Set(loadBadges());
  const { attempts } = lifetimeStats();
  const snapshot = { lifetimeAttempts: attempts, streak: currentStreak(), hadPerfectSession: false, ...extra };
  const newlyEarned = BADGE_DEFS.filter((b) => !earned.has(b.id) && b.check(snapshot));
  if (newlyEarned.length === 0) return;
  newlyEarned.forEach((b) => earned.add(b.id));
  saveBadges([...earned]);
  newlyEarned.forEach((b) => showToast(`${b.emoji} 実績解除: ${b.label}`));
}

function renderBadgeGrid() {
  const earned = new Set(loadBadges());
  document.getElementById("badge-grid").innerHTML = BADGE_DEFS.map((b) => {
    const locked = !earned.has(b.id);
    return (
      `<div class="badge-item ${locked ? "locked" : ""}">` +
      `<span class="badge-emoji">${locked ? "🔒" : b.emoji}</span>` +
      `<span class="badge-label">${b.label}</span></div>`
    );
  }).join("");
}

// --- 統計画面 ---
const LEVEL_LABEL = { beginner: "初級", intermediate: "中級", advanced: "上級" };
const WEAK_MIN_ATTEMPTS = 2; // 1回のミスだけで「苦手」扱いにしないための下限
const WEAK_LIST_LIMIT = 5;

function levelBreakdown() {
  const history = loadHistory();
  const byLevel = {
    beginner: { attempts: 0, scoreSum: 0 },
    intermediate: { attempts: 0, scoreSum: 0 },
    advanced: { attempts: 0, scoreSum: 0 },
  };
  for (const p of PROBLEMS) {
    const entry = history[p.id];
    if (!entry) continue;
    byLevel[p.level].attempts += entry.attempts;
    byLevel[p.level].scoreSum += entry.scoreSum;
  }
  return byLevel;
}

function weakProblems() {
  const history = loadHistory();
  return PROBLEMS.map((p) => ({ ...p, ...(history[p.id] || { attempts: 0, scoreSum: 0 }) }))
    .filter((p) => p.attempts >= WEAK_MIN_ATTEMPTS)
    .sort((a, b) => a.scoreSum / a.attempts - b.scoreSum / b.attempts || a.id.localeCompare(b.id))
    .slice(0, WEAK_LIST_LIMIT);
}

const WEEK_DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function renderWeekCalendar() {
  const practiceDays = new Set(loadPracticeDays());
  const frozenDays = new Set(loadFrozenDays());
  const today = todayKey();
  const cells = [];
  for (let i = 6; i >= 0; i--) {
    const key = shiftDayKey(today, -i);
    const date = new Date(`${key}T00:00:00Z`);
    const dotClass = practiceDays.has(key) ? "done" : frozenDays.has(key) ? "frozen" : "";
    const todayClass = key === today ? "today" : "";
    cells.push(
      `<div class="week-day"><span class="week-day-label">${WEEK_DAY_LABELS[date.getUTCDay()]}</span>` +
        `<span class="week-day-dot ${dotClass} ${todayClass}"></span></div>`
    );
  }
  document.getElementById("week-calendar").innerHTML = cells.join("");
}

function renderGrowthChart() {
  const log = loadDailyLog();
  const today = todayKey();
  const entries = [];
  for (let i = 6; i >= 0; i--) {
    entries.push(log[shiftDayKey(today, -i)]);
  }
  const hasAnyData = entries.some((entry) => entry && entry.attempts > 0);
  if (!hasAnyData) {
    document.getElementById("growth-chart").innerHTML =
      '<p class="stats-empty">まだデータがありません。練習を始めましょう！</p>';
    return;
  }
  const bars = entries.map((entry) => {
    const pct = entry && entry.attempts > 0 ? Math.round((entry.scoreSum / entry.attempts) * 100) : 0;
    return (
      `<div class="growth-bar-col"><div class="growth-bar" style="height:${Math.max(pct, 4)}%"></div>` +
      `<span class="growth-bar-label">${pct}</span></div>`
    );
  });
  document.getElementById("growth-chart").innerHTML = bars.join("");
}

function renderStatsScreen() {
  const { attempts, scoreSum } = lifetimeStats();
  document.getElementById("stats-total").textContent = attempts === 0 ? "-" : `${attempts}問`;
  document.getElementById("stats-accuracy").textContent =
    attempts === 0 ? "-" : `${Math.round((scoreSum / attempts) * 100)}%`;
  const streak = currentStreak();
  document.getElementById("stats-streak").textContent = `🔥 ${streak} 日`;
  document.getElementById("stats-freezes").textContent = `❄️ ${loadFreezeCount()} 個`;
  document.getElementById("stats-level").textContent = `Lv.${levelForXp(loadXp())}`;
  document.getElementById("stats-practice-time").textContent = formatDuration(loadTotalPracticeMs());
  document.getElementById("stats-coins").textContent = `${loadCoins()}枚`;
  document.getElementById("streak-countdown").textContent = nextStreakMilestoneMessage(streak);
  renderWeekCalendar();

  const today = todayProgress();
  document.getElementById("daily-goal-label").textContent = `${today.attempts} / ${DAILY_GOAL} 問`;
  document.getElementById("daily-goal-fill").style.width =
    `${Math.min(100, Math.round((today.attempts / DAILY_GOAL) * 100))}%`;

  const week = weeklyReport();
  document.getElementById("weekly-report").textContent =
    week.attempts === 0
      ? "今週はまだ記録がありません"
      : `今週は${week.daysActive}日練習・計${week.attempts}問・達成度${Math.round((week.scoreSum / week.attempts) * 100)}%`;

  renderGrowthChart();
  renderBadgeGrid();

  document.getElementById("stats-level-breakdown").innerHTML = Object.entries(levelBreakdown())
    .map(([level, { attempts: a, scoreSum: s }]) => {
      const pct = a === 0 ? "-" : `${Math.round((s / a) * 100)}%`;
      return `<p class="summary-row"><span>${LEVEL_LABEL[level]}</span><strong>${pct}</strong></p>`;
    })
    .join("");

  const weak = weakProblems();
  document.getElementById("stats-weak-list").innerHTML =
    weak.length === 0
      ? `<p class="stats-empty">まだ記録がありません。練習を始めましょう！</p>`
      : weak
          .map((p) => {
            const pct = Math.round((p.scoreSum / p.attempts) * 100);
            return `<div class="weak-item"><p class="weak-item-text">${p.text}</p><p class="weak-item-meta">達成度${pct}%（${p.attempts}回中平均${p.scoreSum.toFixed(1)}点）</p></div>`;
          })
          .join("");
}

function exportHistoryAsJson() {
  const payload = { history: loadHistory(), practiceDays: loadPracticeDays(), exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `eigo-shukan-juku-history-${todayKey()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

document.getElementById("lifetime-stats").addEventListener("click", () => {
  renderStatsScreen();
  showScreen("stats");
});
document.getElementById("export-history-button").addEventListener("click", exportHistoryAsJson);
document.getElementById("buy-freeze-button").addEventListener("click", buyStreakFreeze);
document.getElementById("back-from-stats").addEventListener("click", () => {
  renderTopScreen();
  showScreen("top");
});

// --- 画面-1: TOP（ダッシュボード） ---
function renderTopScreen() {
  document.getElementById("top-streak").textContent = `${currentStreak()} 日`;
  document.getElementById("top-level").textContent = `Lv.${levelForXp(loadXp())}`;
  document.getElementById("top-coins").textContent = `${loadCoins()}枚`;
  document.getElementById("top-freezes").textContent = `${loadFreezeCount()} 個`;
}

const STAT_EXPLANATIONS = {
  streak: "🔥 毎日1問以上練習した連続日数。フリーズがあれば1日休んでも途切れません",
  level: "⭐ 練習で貯まるXPに応じて上がります（100XPごとにLv.+1）。正解ほど多く貯まります",
  coins: "🪙 練習するたびに貯まる通貨。30枚でストリークフリーズと交換できます",
  freeze: "❄️ 1日休んでもストリークを維持できる救済アイテム。7日連続達成ごとに1個もらえます（最大2個）",
};

document.querySelectorAll(".info-dot").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    showToast(STAT_EXPLANATIONS[btn.dataset.info]);
  });
});

document.getElementById("top-practice-button").addEventListener("click", () => showScreen("part"));
document.getElementById("top-stats-button").addEventListener("click", () => {
  renderStatsScreen();
  showScreen("stats");
});

renderTopScreen();

// --- 画面0: Part選択 ---
document.getElementById("part-b-button").addEventListener("click", () => {
  renderLifetimeStats();
  showScreen("select");
});
document.getElementById("back-to-part").addEventListener("click", () => showScreen("part"));
document.getElementById("back-to-top").addEventListener("click", () => {
  renderTopScreen();
  showScreen("top");
});
document.querySelectorAll(".part-item.locked").forEach((btn) => {
  btn.addEventListener("click", () => showToast("🔧 このPartは準備中です"));
});

// --- 画面1: レベル・アクセント選択（単一選択） ---
function setupSingleSelectGroup(groupEl, dataAttr, onSelect) {
  groupEl.querySelectorAll(".chip").forEach((chip) => {
    if (chip.classList.contains("locked")) {
      chip.addEventListener("click", () => showToast("🔧 まだ音声を用意していません"));
      return;
    }
    chip.addEventListener("click", () => {
      groupEl.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      onSelect(chip.dataset[dataAttr]);
    });
  });
}

// レベル内の「セット」選択（バックログNo.3.5）。ミックス選択時はセット概念が無いため非表示にする
function renderSetChips(level) {
  const groupEl = document.getElementById("set-group");
  const wrapperEl = document.getElementById("set-option-group");
  const sets =
    level === "mix"
      ? []
      : [...new Set(PROBLEMS.filter((p) => p.level === level).map((p) => p.set_number))].sort((a, b) => a - b);

  if (sets.length === 0) {
    groupEl.innerHTML = "";
    wrapperEl.hidden = true;
    return;
  }

  wrapperEl.hidden = false;
  groupEl.innerHTML = sets
    .map((n, i) => `<button class="chip${i === 0 ? " active" : ""}" data-set="${n}">${LEVEL_LABEL[level]}${n}</button>`)
    .join("");
  state.selectedSet = sets[0];
  setupSingleSelectGroup(groupEl, "set", (v) => {
    state.selectedSet = Number(v);
  });
}

setupSingleSelectGroup(document.getElementById("level-group"), "level", (v) => {
  state.selectedLevel = v;
  renderSetChips(v);
});
setupSingleSelectGroup(document.getElementById("accent-group"), "accent", (v) => {
  state.selectedAccent = v;
});

const SESSION_SIZE = 16; // 本番Versant Part B(Repeats)の1回あたり問題数に合わせた上限

// 苦手な問題ほど選ばれやすくする重み（未挑戦は標準、達成度が低いほど重みが大きくなる）
function problemWeight(p, history) {
  const entry = history[p.id];
  if (!entry || entry.attempts === 0) return 1;
  const accuracy = entry.scoreSum / entry.attempts;
  return 1 + (1 - accuracy) * 2; // 得意(1.0)→重み1、苦手(0.0)→重み3
}

// 重み付き非復元抽出（指数キー法）。重みが大きいほど先頭に来やすくなるが、毎回同じ順にはならない
function weightedShuffle(items, weightFn) {
  return items
    .map((item) => ({ item, key: Math.random() ** (1 / weightFn(item)) }))
    .sort((a, b) => b.key - a.key)
    .map((entry) => entry.item);
}

function startSession() {
  const pool =
    state.selectedLevel === "mix"
      ? PROBLEMS
      : PROBLEMS.filter((p) => p.level === state.selectedLevel && p.set_number === state.selectedSet);
  if (pool.length === 0) return;

  const history = loadHistory();
  const shuffled = weightedShuffle(pool, (p) => problemWeight(p, history));
  state.queue = shuffled.slice(0, SESSION_SIZE);
  state.poolSize = state.queue.length;
  state.cleared = new Set();
  state.currentIndex = 0;
  state.scoreSum = 0;
  state.totalCount = 0;
  state.streak = 0;
  state.bestStreak = 0;
  state.hadAnyImperfect = false;
  sessionStartedAt = Date.now();
  enterListen();
}

document.getElementById("start-button").addEventListener("click", startSession);
document.getElementById("restart-button").addEventListener("click", startSession);

// --- 画面2: リスニング ---
function currentProblem() {
  return state.queue[state.currentIndex];
}

function currentAccentLang() {
  const key =
    state.selectedAccent === "mix"
      ? ACCENT_KEYS[Math.floor(Math.random() * ACCENT_KEYS.length)]
      : state.selectedAccent;
  return ACCENT_LANG[key];
}

function updateProgressUI() {
  const clearedCount = state.cleared.size;
  const correctSuffix = clearedCount > 0 ? `（${clearedCount}問正解）` : "";
  const label = `第${state.totalCount + 1}問（全${state.poolSize}問中）${correctSuffix}`;
  document.querySelectorAll(".progress-label").forEach((el) => (el.textContent = label));
  const fill = document.getElementById("progress-bar-fill");
  if (fill) fill.style.width = `${Math.round((state.cleared.size / state.poolSize) * 100)}%`;

  document.querySelectorAll(".streak-badge").forEach((el) => {
    if (state.streak >= 2) {
      el.textContent = `🔥 ${state.streak}`;
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  });
}

const ttsAudio = document.getElementById("tts-audio");

function playCurrent() {
  const p = currentProblem();
  if (p.audio) {
    ttsAudio.src = p.audio;
    ttsAudio.playbackRate = state.speedRate;
    ttsAudio.currentTime = 0;
    ttsAudio.play().catch((err) => {
      console.error("audio playback failed, falling back to speechSynthesis", err);
      speakFallback(p);
    });
    return;
  }
  speakFallback(p);
}

// 実音声ファイルが無い場合、または再生に失敗した場合の保険（本来ほぼ発生しない想定。
// verified=Trueの問題だけがproblems.jsonに含まれ、それには音声が必ず紐付いているため）
function speakFallback(p) {
  if (!window.speechSynthesis) {
    alert(p.text);
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(p.text);
  utter.lang = p._lang || currentAccentLang();
  utter.rate = state.speedRate;
  window.speechSynthesis.speak(utter);
}

function enterListen() {
  const p = currentProblem();
  p._lang = currentAccentLang(); // この出題での再生アクセントを固定（リプレイ時に変わらないように）
  updateProgressUI();
  showScreen("listen");
  playCurrent();
}

document.getElementById("play-button").addEventListener("click", playCurrent);

document.querySelectorAll("#speed-group .speed-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll("#speed-group .speed-chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    state.speedRate = parseFloat(chip.dataset.rate);
  });
});

document.getElementById("reveal-button").addEventListener("click", () => {
  ttsAudio.pause();
  window.speechSynthesis && window.speechSynthesis.cancel();
  enterAnswer();
});

// --- 画面3: 回答・解説 ---
function enterAnswer() {
  const p = currentProblem();
  updateProgressUI();
  document.getElementById("answer-text").textContent = p.text;
  updateAccuracyLabel();
  showScreen("answer");
}

function updateAccuracyLabel() {
  const el = document.getElementById("accuracy-label");
  if (state.totalCount === 0) {
    el.textContent = "達成度: -";
    return;
  }
  const pct = Math.round((state.scoreSum / state.totalCount) * 100);
  el.textContent = `達成度: ${pct}%（${state.totalCount}問中）`;
}

const TIER_EMOJI = { perfect: "🎉", half: "🙂", none: "😅" };
const TIER_BEEP = { perfect: [880, 0.12], half: [520, 0.14], none: [220, 0.18] };
const TIER_VIBRATE = { perfect: [15], half: [20], none: [30, 40, 30] };

function judge(tier) {
  const p = currentProblem();
  state.totalCount += 1;
  state.scoreSum += SCORE_BY_TIER[tier];
  recordAttempt(p.id, tier);

  if (tier === "perfect") {
    state.cleared.add(p.id);
    state.streak += 1;
    state.bestStreak = Math.max(state.bestStreak, state.streak);
  } else {
    state.hadAnyImperfect = true;
    state.streak = 0;
    // 「できた」以外は数問先に再度差し込み、同セッション内で再出題する
    const offset = 2 + Math.floor(Math.random() * 3);
    const reinsertAt = Math.min(state.queue.length, state.currentIndex + 1 + offset);
    state.queue.splice(reinsertAt, 0, p);
  }
  playBeep(...TIER_BEEP[tier]);
  vibrate(TIER_VIBRATE[tier]);

  const sessionDone = state.cleared.size >= state.poolSize;
  if (!sessionDone) state.currentIndex += 1;

  // 2秒の間を空けてから次へ（バーで可視化）。この遅延によりnext再生はユーザー操作と
  // 同一コールスタックでなくなるため、iOS Safariで自動再生がブロックされる可能性がある（要実機確認）
  showReaction(TIER_EMOJI[tier], INTER_PROBLEM_PAUSE_MS, sessionDone ? enterSummary : enterListen);
}

document.getElementById("judge-perfect").addEventListener("click", () => judge("perfect"));
document.getElementById("judge-half").addEventListener("click", () => judge("half"));
document.getElementById("judge-none").addEventListener("click", () => judge("none"));
document.getElementById("replay-on-answer").addEventListener("click", playCurrent);

// --- 画面4: セッションリザルト ---
// 達成度に応じてマスコット・メッセージを変える（キャラクターのリアクション拡充）
const SUMMARY_REACTIONS = [
  { min: 90, mascot: "🤩", messages: ["完璧！すごい集中力！", "パーフェクトに近い出来栄え！", "この調子で続けよう！"] },
  { min: 70, mascot: "😊", messages: ["お疲れさま！いい感じ！", "着実に力がついてきてます", "ナイス practice！"] },
  { min: 40, mascot: "🙂", messages: ["お疲れさま！", "また挑戦してみよう", "続けることに意味があります"] },
  { min: 0, mascot: "💪", messages: ["よく頑張りました！", "難しい問題もあったね、また挑戦しよう", "少しずつでOK、続けよう"] },
];

function pickSummaryReaction(pct) {
  const tier = SUMMARY_REACTIONS.find((t) => pct >= t.min) || SUMMARY_REACTIONS[SUMMARY_REACTIONS.length - 1];
  const message = tier.messages[Math.floor(Math.random() * tier.messages.length)];
  return { mascot: tier.mascot, message };
}

function enterSummary() {
  if (sessionStartedAt) {
    addPracticeMs(Date.now() - sessionStartedAt);
    sessionStartedAt = null;
  }
  if (state.totalCount > 0 && !state.hadAnyImperfect) {
    checkAndAwardBadges({ hadPerfectSession: true });
  }
  if (state.totalCount > 0) playChime(SESSION_COMPLETE_CHIME);

  const pct = state.totalCount === 0 ? 0 : Math.round((state.scoreSum / state.totalCount) * 100);
  const reaction = pickSummaryReaction(pct);
  document.getElementById("summary-mascot").textContent = reaction.mascot;
  document.querySelector("#screen-summary h1").textContent = reaction.message;
  document.getElementById("summary-accuracy").textContent = `${pct}%（${state.totalCount}問中）`;
  document.getElementById("summary-streak").textContent = `🔥 ${state.bestStreak}`;
  document.getElementById("summary-total").textContent = `${state.poolSize} 問`;
  showScreen("summary");
}

// --- SNSシェアカード（端末内で画像生成、外部サービスには依存しない） ---
function generateShareImage() {
  const canvas = document.createElement("canvas");
  canvas.width = 600;
  canvas.height = 400;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#5b5bd6";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.font = "bold 40px sans-serif";
  ctx.fillText("英語習慣塾", canvas.width / 2, 70);
  ctx.font = "72px sans-serif";
  ctx.fillText(document.getElementById("summary-mascot").textContent, canvas.width / 2, 180);
  ctx.font = "bold 32px sans-serif";
  ctx.fillText(`達成度 ${document.getElementById("summary-accuracy").textContent}`, canvas.width / 2, 250);
  ctx.font = "22px sans-serif";
  ctx.fillText(`ベストストリーク ${document.getElementById("summary-streak").textContent}`, canvas.width / 2, 300);
  ctx.fillText(`連続練習日数 🔥 ${currentStreak()}日`, canvas.width / 2, 335);
  return canvas;
}

function shareResult() {
  const canvas = generateShareImage();
  canvas.toBlob(async (blob) => {
    const file = new File([blob], "eigo-shukan-juku-result.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "英語習慣塾", text: "今日の練習結果！" });
        return;
      } catch (e) {
        if (e.name === "AbortError") return; // ユーザーがシェアをキャンセルしただけ
      }
    }
    // Web Share API未対応（主にPC）の場合はダウンロードにフォールバック
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "eigo-shukan-juku-result.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, "image/png");
}

document.getElementById("share-button").addEventListener("click", shareResult);

// --- 共通: 戻るボタン ---
document.querySelectorAll(".back-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    ttsAudio.pause();
    window.speechSynthesis && window.speechSynthesis.cancel();
    renderLifetimeStats();
    showScreen("select");
  });
});

// --- オンボーディング（初回起動時のみ表示） ---
const ONBOARDED_KEY = "eigo-shukan-juku:onboarded:v1";

function hasOnboarded() {
  try {
    return !!localStorage.getItem(ONBOARDED_KEY);
  } catch (e) {
    return false; // 判定できない場合は毎回出すだけ（実害はない）
  }
}

function maybeShowOnboarding() {
  if (!hasOnboarded()) {
    document.getElementById("onboarding-overlay").classList.remove("hidden");
  }
}

// --- アクセスゲート(No.2)。本物のセキュリティではない簡易な入場確認 ---
// GitHub Pagesにはサーバー側の認証機能が無いため、ソースを見れば誰でも突破できる。
// 「知らない人がうっかり見ない」程度の抑止に過ぎない。合言葉を変えたい場合はGATE_PASSWORDを書き換える
const GATE_PASSWORD = "eigo2026";
const GATE_PASSED_KEY = "eigo-shukan-juku:gate-passed:v1";

function hasPassedGate() {
  try {
    return localStorage.getItem(GATE_PASSED_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function passGate() {
  try {
    localStorage.setItem(GATE_PASSED_KEY, "1");
  } catch (e) {
    // 保存できなくても今回の表示はそのまま続けられる
  }
  document.getElementById("screen-gate").classList.add("hidden");
  showScreen("top");
  maybeShowOnboarding();
}

if (hasPassedGate()) {
  document.getElementById("screen-gate").classList.add("hidden");
  showScreen("top");
  maybeShowOnboarding();
} else {
  document.getElementById("gate-submit").addEventListener("click", () => {
    const input = document.getElementById("gate-password");
    if (input.value === GATE_PASSWORD) {
      passGate();
    } else {
      document.getElementById("gate-error").classList.remove("hidden");
    }
  });
  document.getElementById("gate-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("gate-submit").click();
  });
}

document.getElementById("onboarding-dismiss").addEventListener("click", () => {
  document.getElementById("onboarding-overlay").classList.add("hidden");
  try {
    localStorage.setItem(ONBOARDED_KEY, "true");
  } catch (e) {
    // 保存できなくても今回閉じることはできている（次回また出るだけ）
  }
});

// --- ダークモード ---
const THEME_KEY = "eigo-shukan-juku:theme:v1";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.getElementById("theme-toggle").textContent = theme === "dark" ? "☀️" : "🌙";
}

function loadTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } catch (e) {
    return "light";
  }
}

applyTheme(loadTheme());

document.getElementById("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (e) {
    // 保存できなくても今回の表示切り替え自体はできている
  }
});

// --- 問題データの読み込み ---
const startButtonEl = document.getElementById("start-button");
startButtonEl.disabled = true;

loadProblems()
  .then(() => {
    startButtonEl.disabled = false;
    renderSetChips(state.selectedLevel);
  })
  .catch((err) => {
    console.error(err);
    alert("問題データの読み込みに失敗しました。ページを再読み込みしてください。");
  });

// --- PWA: Service Worker登録（対応ブラウザのみ、失敗しても練習機能自体は動く） ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // オフライン対応が効かないだけなので、ここで失敗しても練習は続行できる
    });
  });
}
