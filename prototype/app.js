// 問題データはprototype/problems.json（scripts/export_to_prototype.pyが生成）から取得する。
// verified=Trueの問題のみが含まれる。取得完了まではstart-buttonを無効化しておく
let PROBLEMS = [];

async function loadProblems() {
  const res = await fetch("problems.json");
  if (!res.ok) throw new Error(`problems.json fetch failed: ${res.status}`);
  PROBLEMS = await res.json();
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

const ACCENT_LANG = { us: "en-US", gb: "en-GB", au: "en-AU" };
const ACCENT_KEYS = ["us", "gb", "au"];
const INTER_PROBLEM_PAUSE_MS = 1400; // 問題間の間。iOSでは次の音声再生がユーザー操作から遅延するため、
                                      // 自動再生がブロックされる可能性がある（実機確認済み、2026-08-02）
const MISTAKE_REASON_PAUSE_MS = 3000; // 誤答理由チップを選ぶ余地を与えるため、通常の間より長くする

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
  sessionMistakeIds: new Set(), // このセッション内で「できた」以外だった問題ID（終了後の再挑戦用）
};

const screens = {
  top: document.getElementById("screen-top"),
  part: document.getElementById("screen-part"),
  select: document.getElementById("screen-select"),
  listen: document.getElementById("screen-listen"),
  answer: document.getElementById("screen-answer"),
  summary: document.getElementById("screen-summary"),
  stats: document.getElementById("screen-stats"),
  mistakes: document.getElementById("screen-mistakes"),
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
function showReaction(emoji, durationMs, onDone, ariaLabel, showReasonChips) {
  const overlay = document.getElementById("reaction-overlay");
  const emojiEl = document.getElementById("reaction-emoji");
  const barFill = document.getElementById("reaction-bar-fill");

  document.getElementById("mistake-reason-group").classList.toggle("hidden", !showReasonChips);

  emojiEl.textContent = emoji;
  if (ariaLabel) emojiEl.setAttribute("aria-label", ariaLabel);
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

// 日をまたぐ間隔反復（簡易SM-2）。historyの各エントリにsrsサブオブジェクトを追加する形で拡張する
// （既存フィールドは変更しないため後方互換。旧エントリはsrs未設定＝SRS対象外として扱われる）
const SRS_QUALITY_BY_TIER = { perfect: 5, half: 3, none: 1 };

function applySrsUpdate(entry, tier) {
  const quality = SRS_QUALITY_BY_TIER[tier];
  const srs = entry.srs || { repetitions: 0, easeFactor: 2.5, intervalDays: 0 };
  let { repetitions, easeFactor, intervalDays } = srs;
  if (quality < 3) {
    repetitions = 0;
    intervalDays = 1;
  } else {
    intervalDays = repetitions === 0 ? 1 : repetitions === 1 ? 6 : Math.round(intervalDays * easeFactor);
    repetitions += 1;
  }
  easeFactor = Math.max(1.3, easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
  entry.srs = { repetitions, easeFactor, intervalDays, nextReviewDate: shiftDayKey(todayKey(), intervalDays) };
}

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
  applySrsUpdate(entry, tier);
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

function weeklyReportWithComparison() {
  const thisWeek = weeklyReport();
  const log = loadDailyLog();
  const today = todayKey();
  let attempts = 0;
  let scoreSum = 0;
  let daysActive = 0;
  for (let i = 7; i < 14; i++) {
    const entry = log[shiftDayKey(today, -i)];
    if (entry) {
      attempts += entry.attempts;
      scoreSum += entry.scoreSum;
      daysActive += 1;
    }
  }
  const lastWeek = { attempts, scoreSum, daysActive };
  const thisPct = thisWeek.attempts ? thisWeek.scoreSum / thisWeek.attempts : null;
  const lastPct = lastWeek.attempts ? lastWeek.scoreSum / lastWeek.attempts : null;
  const trend = thisPct !== null && lastPct !== null ? Math.round((thisPct - lastPct) * 100) : null;
  return { thisWeek, lastWeek, trend };
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
    vibrate(PERFECT_WEEK_VIBRATE);
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
    vibrate(LEVEL_UP_VIBRATE);
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
const LEECH_MIN_ATTEMPTS = 3; // これ未満は「まだ判断できない」として対象外
const LEECH_MAX_ACCURACY = 0.5; // この正答率未満をLeech（何度も間違える問題）扱いにする

// 達成度の色分け（進捗の情報階層をテキストだけでなく色でも伝える）
function pctClass(pct) {
  if (pct >= 80) return "pct-high";
  if (pct < 50) return "pct-low";
  return "";
}

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

// --- アクセント別正答率（現状は米国英語の音声のみ提供中。将来の英/豪音声追加を見越し先行実装） ---
const ACCENT_LOG_KEY = "eigo-shukan-juku:accent-log:v1";
const ACCENT_LABEL = { us: "米", gb: "英", au: "豪" };

function loadAccentLog() {
  try {
    return JSON.parse(localStorage.getItem(ACCENT_LOG_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveAccentLog(log) {
  try {
    localStorage.setItem(ACCENT_LOG_KEY, JSON.stringify(log));
  } catch (e) {
    // 保存できなくても練習は続行できる
  }
}

function recordAccentAttempt(accentKey, tier) {
  const log = loadAccentLog();
  const entry = log[accentKey] || { attempts: 0, scoreSum: 0 };
  entry.attempts += 1;
  entry.scoreSum += SCORE_BY_TIER[tier];
  log[accentKey] = entry;
  saveAccentLog(log);
}

function weakProblems() {
  const history = loadHistory();
  return PROBLEMS.map((p) => ({ ...p, ...(history[p.id] || { attempts: 0, scoreSum: 0 }) }))
    .filter((p) => p.attempts >= WEAK_MIN_ATTEMPTS)
    .sort((a, b) => a.scoreSum / a.attempts - b.scoreSum / b.attempts || a.id.localeCompare(b.id))
    .slice(0, WEAK_LIST_LIMIT);
}

// Leech検出（Ankiに倣い、重み付き抽選でも改善しない「何度も間違える問題」に気づかせる。
// 専用ストレージは持たず、既存historyを都度判定するだけの軽量ロジック）
function isLeech(entry) {
  return entry.attempts >= LEECH_MIN_ATTEMPTS && entry.scoreSum / entry.attempts < LEECH_MAX_ACCURACY;
}

function leechProblems() {
  const history = loadHistory();
  return PROBLEMS.map((p) => ({ ...p, ...(history[p.id] || { attempts: 0, scoreSum: 0 }) }))
    .filter((p) => isLeech(p))
    .sort((a, b) => a.scoreSum / a.attempts - b.scoreSum / b.attempts || a.id.localeCompare(b.id));
}

// SM-2の復習予定日を過ぎた問題（未挑戦の問題はsrs未設定のため対象外。通常セッションで初回消化される想定）
function dueForReviewProblems() {
  const history = loadHistory();
  const today = todayKey();
  return PROBLEMS.filter((p) => {
    const entry = history[p.id];
    return !!(entry && entry.srs && entry.srs.nextReviewDate <= today);
  });
}

// --- 苦手問題マーク（ユーザーが手動で☆マークし、後で絞り込んで復習できる） ---
const MARKED_PROBLEMS_KEY = "eigo-shukan-juku:marked-problems:v1";

function loadMarkedProblems() {
  try {
    return new Set(JSON.parse(localStorage.getItem(MARKED_PROBLEMS_KEY)) || []);
  } catch (e) {
    return new Set();
  }
}

function saveMarkedProblems(marked) {
  try {
    localStorage.setItem(MARKED_PROBLEMS_KEY, JSON.stringify([...marked]));
  } catch (e) {
    // 保存できなくても練習は続行できる
  }
}

function toggleMarkedProblem(problemId) {
  const marked = loadMarkedProblems();
  if (marked.has(problemId)) marked.delete(problemId);
  else marked.add(problemId);
  saveMarkedProblems(marked);
  return marked.has(problemId);
}

function markedProblemsList() {
  const marked = loadMarkedProblems();
  const history = loadHistory();
  return PROBLEMS.filter((p) => marked.has(p.id)).map((p) => ({
    ...p,
    ...(history[p.id] || { attempts: 0, scoreSum: 0 }),
  }));
}

// --- 自己録音の永続化（IndexedDB。バイナリBlobはlocalStorageで扱えないため）。
// 問題ごとに最新1件のみ保持（keyPathがproblemIdなのでput()すると自動的に上書きされる） ---
const RECORDING_DB_NAME = "eigo-shukan-juku-recordings";
const RECORDING_DB_VERSION = 1;
const RECORDING_STORE = "recordings";

let recordingDbPromise = null;

function openRecordingDb() {
  if (recordingDbPromise) return recordingDbPromise;
  recordingDbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB not supported"));
      return;
    }
    const req = indexedDB.open(RECORDING_DB_NAME, RECORDING_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(RECORDING_STORE)) {
        db.createObjectStore(RECORDING_STORE, { keyPath: "problemId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return recordingDbPromise;
}

async function saveRecording(problemId, blob, mimeType) {
  try {
    const db = await openRecordingDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(RECORDING_STORE, "readwrite");
      tx.objectStore(RECORDING_STORE).put({ problemId, blob, mimeType, recordedAt: new Date().toISOString() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    return false; // IndexedDB未対応・失敗時も練習自体は止めない
  }
}

async function loadRecording(problemId) {
  try {
    const db = await openRecordingDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(RECORDING_STORE, "readonly");
      const req = tx.objectStore(RECORDING_STORE).get(problemId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (e) {
    return null;
  }
}

// --- フレーズ単位の個人辞書（回答テキストから選択した部分を保存するだけの簡易版） ---
const PHRASES_KEY = "eigo-shukan-juku:phrases:v1";

function loadPhrases() {
  try {
    return JSON.parse(localStorage.getItem(PHRASES_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function savePhrases(phrases) {
  try {
    localStorage.setItem(PHRASES_KEY, JSON.stringify(phrases));
  } catch (e) {
    // 保存できなくても練習は続行できる
  }
}

function savePhrase(problemId, phrase) {
  const phrases = loadPhrases();
  phrases.push({ problemId, phrase, at: new Date().toISOString() });
  savePhrases(phrases);
}

document.getElementById("save-phrase-button").addEventListener("click", () => {
  const selected = window.getSelection().toString().trim();
  if (!selected) {
    showToast("テキストを選択してから押してください");
    return;
  }
  savePhrase(currentProblem().id, selected);
  showToast(`📎 「${selected}」を登録しました`);
});

// --- 誤答ログ（✕/半分回答時に自動記録、任意で理由メモを追加できる） ---
const MISTAKE_LOG_KEY = "eigo-shukan-juku:mistake-log:v1";
const MISTAKE_LOG_LIMIT = 200; // 肥大化防止。古い順に切り捨てる
const REASON_LABEL = { hearing: "聞き取れず", structure: "文構造", speed: "速度" };

function loadMistakeLog() {
  try {
    return JSON.parse(localStorage.getItem(MISTAKE_LOG_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveMistakeLog(log) {
  try {
    localStorage.setItem(MISTAKE_LOG_KEY, JSON.stringify(log.slice(-MISTAKE_LOG_LIMIT)));
  } catch (e) {
    // 保存できなくても練習は続行できる
  }
}

function recordMistake(problemId, text, reason, tier) {
  const log = loadMistakeLog();
  log.push({ problemId, text, reason, tier, at: new Date().toISOString(), reviewed: false });
  saveMistakeLog(log);
}

function updateLastMistakeReason(problemId, reason) {
  const log = loadMistakeLog();
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].problemId === problemId) {
      log[i].reason = reason;
      break;
    }
  }
  saveMistakeLog(log);
}

function markMistakeReviewedByAt(at) {
  const log = loadMistakeLog();
  const entry = log.find((m) => m.at === at);
  if (entry) entry.reviewed = true;
  saveMistakeLog(log);
}

function unreviewedMistakeCount() {
  return loadMistakeLog().filter((m) => !m.reviewed).length;
}

// --- 直近セッションで間違えた問題（セッション終了後・セッションをまたいでの「もう一周」用） ---
const LAST_SESSION_MISTAKES_KEY = "eigo-shukan-juku:last-session-mistakes:v1";

function loadLastSessionMistakes() {
  try {
    return JSON.parse(localStorage.getItem(LAST_SESSION_MISTAKES_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveLastSessionMistakes(ids) {
  try {
    localStorage.setItem(LAST_SESSION_MISTAKES_KEY, JSON.stringify(ids));
  } catch (e) {
    // 保存できなくても「もう一周」ボタンが出ないだけで練習は続行できる
  }
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
      '<p class="stats-empty">📊 まだデータがありません。練習を始めましょう！</p>';
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

let statsShowMarkedOnly = false;

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

  const { thisWeek: week, trend } = weeklyReportWithComparison();
  document.getElementById("weekly-report").textContent =
    week.attempts === 0
      ? "今週はまだ記録がありません"
      : `今週は${week.daysActive}日練習・計${week.attempts}問・達成度${Math.round((week.scoreSum / week.attempts) * 100)}%`;
  const trendEl = document.getElementById("weekly-trend");
  if (trend === null) {
    trendEl.textContent = "先週のデータがないため比較できません";
    trendEl.className = "weekly-trend";
  } else if (trend > 0) {
    trendEl.textContent = `↑ 先週比 +${trend}pt`;
    trendEl.className = "weekly-trend trend-up";
  } else if (trend < 0) {
    trendEl.textContent = `↓ 先週比 ${trend}pt`;
    trendEl.className = "weekly-trend trend-down";
  } else {
    trendEl.textContent = "先週と同じ達成度です";
    trendEl.className = "weekly-trend";
  }

  renderGrowthChart();
  renderBadgeGrid();

  document.getElementById("stats-level-breakdown").innerHTML = Object.entries(levelBreakdown())
    .map(([level, { attempts: a, scoreSum: s }]) => {
      const pct = a === 0 ? "-" : `${Math.round((s / a) * 100)}%`;
      const cls = a === 0 ? "" : pctClass(Math.round((s / a) * 100));
      return `<p class="summary-row"><span>${LEVEL_LABEL[level]}</span><strong class="${cls}">${pct}</strong></p>`;
    })
    .join("");

  const accentLog = loadAccentLog();
  document.getElementById("stats-accent-breakdown").innerHTML = ACCENT_KEYS.map((key) => {
    const entry = accentLog[key];
    const hasData = entry && entry.attempts > 0;
    const pctNum = hasData ? Math.round((entry.scoreSum / entry.attempts) * 100) : null;
    const pct = hasData ? `${pctNum}%` : "データなし";
    const cls = hasData ? pctClass(pctNum) : "";
    return `<p class="summary-row"><span>${ACCENT_LABEL[key]}</span><strong class="${cls}">${pct}</strong></p>`;
  }).join("");

  const filterBtn = document.getElementById("filter-marked-toggle");
  filterBtn.classList.toggle("active", statsShowMarkedOnly);
  const listSource = statsShowMarkedOnly ? markedProblemsList() : weakProblems();
  const emptyMessage = statsShowMarkedOnly
    ? "☆ まだマークした問題がありません"
    : "📊 まだ記録がありません。練習を始めましょう！";
  document.getElementById("stats-weak-list").innerHTML =
    listSource.length === 0
      ? `<p class="stats-empty">${emptyMessage}</p>`
      : listSource
          .map((p) => {
            const pct = p.attempts === 0 ? "-" : `${Math.round((p.scoreSum / p.attempts) * 100)}%`;
            const meta = p.attempts === 0 ? "まだ挑戦していません" : `達成度${pct}（${p.attempts}回中平均${p.scoreSum.toFixed(1)}点）`;
            const leechBadge = p.attempts > 0 && isLeech(p) ? `<span class="leech-badge">🩹 何度も間違えています</span>` : "";
            return `<div class="weak-item">${leechBadge}<p class="weak-item-text">${escapeHtml(p.text)}</p><p class="weak-item-meta">${meta}</p></div>`;
          })
          .join("");

  const phrases = loadPhrases();
  document.getElementById("stats-phrase-list").innerHTML =
    phrases.length === 0
      ? `<p class="stats-empty">📎 まだ登録したフレーズがありません</p>`
      : phrases
          .slice()
          .reverse()
          .map((ph) => `<div class="weak-item"><p class="weak-item-text">${escapeHtml(ph.phrase)}</p></div>`)
          .join("");
}

document.getElementById("filter-marked-toggle").addEventListener("click", () => {
  statsShowMarkedOnly = !statsShowMarkedOnly;
  renderStatsScreen();
});

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

// --- 画面6: 誤答レビュー ---
function playMistakeAudio(problemId) {
  const p = PROBLEMS.find((pr) => pr.id === problemId);
  if (!p) return;
  if (p.audio) {
    ttsAudio.src = p.audio;
    ttsAudio.playbackRate = 1;
    ttsAudio.currentTime = 0;
    ttsAudio.play().catch(() => speakFallback(p));
  } else {
    speakFallback(p);
  }
}

function renderMistakesScreen() {
  const log = loadMistakeLog().filter((m) => !m.reviewed).slice().reverse();
  const listEl = document.getElementById("mistakes-list");
  if (log.length === 0) {
    listEl.innerHTML = `<p class="stats-empty">🎉 誤答はありません</p>`;
    return;
  }
  listEl.innerHTML = log
    .map((m) => {
      const meta = m.reason ? `理由: ${REASON_LABEL[m.reason]}` : "理由: 未選択";
      return (
        `<div class="weak-item">` +
        `<p class="weak-item-text">${escapeHtml(m.text)}</p>` +
        `<p class="weak-item-meta">${meta}</p>` +
        `<div class="mistake-item-actions">` +
        `<button class="btn-text mistake-play" data-problem-id="${escapeHtml(m.problemId)}">🔊 音声を聞く</button>` +
        `<button class="btn-text mistake-reviewed" data-at="${escapeHtml(m.at)}">✓ レビュー済みにする</button>` +
        `</div></div>`
      );
    })
    .join("");
}

document.getElementById("mistakes-list").addEventListener("click", (e) => {
  const playBtn = e.target.closest(".mistake-play");
  if (playBtn) {
    playMistakeAudio(playBtn.dataset.problemId);
    return;
  }
  const reviewedBtn = e.target.closest(".mistake-reviewed");
  if (reviewedBtn) {
    markMistakeReviewedByAt(reviewedBtn.dataset.at);
    renderMistakesScreen();
    renderTopScreen();
  }
});

document.getElementById("start-review-button").addEventListener("click", () => {
  state.selectedLevel = "review";
  renderLifetimeStats();
  startSession();
});

document.getElementById("top-mistakes-button").addEventListener("click", () => {
  renderMistakesScreen();
  showScreen("mistakes");
});
document.getElementById("back-from-mistakes").addEventListener("click", () => {
  renderTopScreen();
  showScreen("top");
});

// --- 画面-1: TOP（ダッシュボード） ---
function renderTopScreen() {
  document.getElementById("top-streak").textContent = `${currentStreak()} 日`;
  document.getElementById("top-level").textContent = `Lv.${levelForXp(loadXp())}`;
  document.getElementById("top-coins").textContent = `${loadCoins()}枚`;
  document.getElementById("top-freezes").textContent = `${loadFreezeCount()} 個`;

  const badge = document.getElementById("top-mistakes-badge");
  const count = unreviewedMistakeCount();
  if (count === 0) {
    badge.classList.add("hidden");
  } else {
    badge.textContent = String(count);
    badge.classList.remove("hidden");
  }

  const retryCount = loadLastSessionMistakes().length;
  const retryBtn = document.getElementById("top-retry-mistakes-button");
  if (retryCount === 0) {
    retryBtn.classList.add("hidden");
  } else {
    document.getElementById("top-retry-mistakes-badge").textContent = String(retryCount);
    retryBtn.classList.remove("hidden");
  }

  const srsCount = dueForReviewProblems().length;
  const srsBtn = document.getElementById("top-srs-button");
  if (srsCount === 0) {
    srsBtn.classList.add("hidden");
  } else {
    document.getElementById("top-srs-badge").textContent = String(srsCount);
    srsBtn.classList.remove("hidden");
  }
}

document.getElementById("top-srs-button").addEventListener("click", () => {
  state.selectedLevel = "srs";
  startSession();
});

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
    chip.setAttribute("role", "radio");
    chip.setAttribute("aria-checked", chip.classList.contains("active") ? "true" : "false");
    if (chip.classList.contains("locked")) {
      chip.addEventListener("click", () => showToast("🔧 まだ音声を用意していません"));
      return;
    }
    chip.addEventListener("click", () => {
      groupEl.querySelectorAll(".chip").forEach((c) => {
        c.classList.remove("active");
        c.setAttribute("aria-checked", "false");
      });
      chip.classList.add("active");
      chip.setAttribute("aria-checked", "true");
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

// 復習専用セット（マーク済み問題を優先し、不足分は既存の苦手判定・重み付けで補うハイブリッド方式）
function buildReviewSet() {
  const marked = loadMarkedProblems();
  const markedProblems = PROBLEMS.filter((p) => marked.has(p.id));
  if (markedProblems.length >= SESSION_SIZE) {
    return weightedShuffle(markedProblems, () => 1).slice(0, SESSION_SIZE);
  }
  const remaining = SESSION_SIZE - markedProblems.length;
  const history = loadHistory();
  const weakIds = new Set(weakProblems().map((p) => p.id));
  const weakPool = PROBLEMS.filter((p) => !marked.has(p.id) && weakIds.has(p.id));
  const fallbackPool = PROBLEMS.filter((p) => !marked.has(p.id) && !weakIds.has(p.id));
  const extra = weightedShuffle([...weakPool, ...fallbackPool], (p) => problemWeight(p, history)).slice(0, remaining);
  return [...markedProblems, ...extra];
}

let retrySessionPool = []; // 「間違えた問題だけもう一周」用に一時的にセットされる問題プール

function startSession() {
  const isReview = state.selectedLevel === "review";
  const isRetry = state.selectedLevel === "retry";
  const isSrs = state.selectedLevel === "srs";
  const pool = isReview
    ? buildReviewSet()
    : isRetry
      ? retrySessionPool
      : isSrs
        ? dueForReviewProblems()
        : state.selectedLevel === "mix"
          ? PROBLEMS
          : PROBLEMS.filter((p) => p.level === state.selectedLevel && p.set_number === state.selectedSet);
  if (pool.length === 0) return;

  const history = loadHistory();
  const shuffled = isReview ? pool : weightedShuffle(pool, (p) => problemWeight(p, history));
  state.queue = shuffled.slice(0, SESSION_SIZE);
  state.poolSize = state.queue.length;
  state.cleared = new Set();
  state.currentIndex = 0;
  state.scoreSum = 0;
  state.totalCount = 0;
  state.streak = 0;
  state.bestStreak = 0;
  state.hadAnyImperfect = false;
  state.sessionMistakeIds = new Set();
  sessionStartedAt = Date.now();
  enterListen();
}

document.getElementById("retry-mistakes-button").addEventListener("click", () => {
  retrySessionPool = PROBLEMS.filter((p) => loadLastSessionMistakes().includes(p.id));
  state.selectedLevel = "retry";
  startSession();
});
document.getElementById("top-retry-mistakes-button").addEventListener("click", () => {
  retrySessionPool = PROBLEMS.filter((p) => loadLastSessionMistakes().includes(p.id));
  state.selectedLevel = "retry";
  startSession();
});

document.getElementById("start-button").addEventListener("click", startSession);
document.getElementById("restart-button").addEventListener("click", startSession);

// --- セッションの中断・再開（バックグラウンド遷移やリロードをまたいで途中から再開できるようにする） ---
const SESSION_SNAPSHOT_KEY = "eigo-shukan-juku:session-snapshot:v1";
const SESSION_RESUME_TIMEOUT_MS = 30 * 60 * 1000; // 30分以上前のスナップショットは古すぎるため無視する

function saveSessionSnapshot() {
  if (state.queue.length === 0) return;
  try {
    localStorage.setItem(
      SESSION_SNAPSHOT_KEY,
      JSON.stringify({ ...state, cleared: [...state.cleared], savedAt: Date.now() })
    );
  } catch (e) {
    // 保存できなくても練習は続行できる（再開できないだけ）
  }
}

function loadSessionSnapshot() {
  try {
    const raw = JSON.parse(localStorage.getItem(SESSION_SNAPSHOT_KEY));
    if (!raw || !Array.isArray(raw.queue) || raw.queue.length === 0) return null;
    if (Date.now() - raw.savedAt > SESSION_RESUME_TIMEOUT_MS) return null;
    return raw;
  } catch (e) {
    return null;
  }
}

function clearSessionSnapshot() {
  try {
    localStorage.removeItem(SESSION_SNAPSHOT_KEY);
  } catch (e) {
    // 消せなくても実害は次回また再開バナーが出るだけ
  }
}

function maybeShowResumeBanner() {
  if (!loadSessionSnapshot()) return;
  document.getElementById("resume-banner").classList.remove("hidden");
}

function resumeSession() {
  const snapshot = loadSessionSnapshot();
  if (!snapshot) return;
  Object.assign(state, snapshot);
  state.cleared = new Set(snapshot.cleared);
  delete state.savedAt;
  document.getElementById("resume-banner").classList.add("hidden");
  sessionStartedAt = Date.now();
  enterListen();
}

document.getElementById("resume-session-button").addEventListener("click", resumeSession);
document.getElementById("dismiss-resume-button").addEventListener("click", () => {
  clearSessionSnapshot();
  document.getElementById("resume-banner").classList.add("hidden");
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveSessionSnapshot();
});

// --- 画面2: リスニング ---
function currentProblem() {
  return state.queue[state.currentIndex];
}

function pickAccentKey() {
  return state.selectedAccent === "mix"
    ? ACCENT_KEYS[Math.floor(Math.random() * ACCENT_KEYS.length)]
    : state.selectedAccent;
}

function currentAccentLang() {
  return ACCENT_LANG[pickAccentKey()];
}

function updateProgressUI() {
  const clearedCount = state.cleared.size;
  const correctSuffix = clearedCount > 0 ? `（${clearedCount}問正解）` : "";
  const label = `第${state.totalCount + 1}問（全${state.poolSize}問中）${correctSuffix}`;
  document.querySelectorAll(".progress-label").forEach((el) => (el.textContent = label));
  const fill = document.getElementById("progress-bar-fill");
  if (fill) {
    const pct = Math.round((state.cleared.size / state.poolSize) * 100);
    fill.style.width = `${pct}%`;
    fill.closest(".progress-bar-track")?.setAttribute("aria-valuenow", String(pct));
  }

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
    showAudioErrorHint(p.text);
    return;
  }
  hideAudioErrorHint();
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(p.text);
  utter.lang = p._lang || currentAccentLang();
  utter.rate = state.speedRate;
  window.speechSynthesis.speak(utter);
}

function showAudioErrorHint(text) {
  document.getElementById("audio-error-text").textContent = text;
  document.getElementById("audio-error-hint").classList.remove("hidden");
  showToast("🔇 音声を再生できませんでした");
}

function hideAudioErrorHint() {
  document.getElementById("audio-error-hint").classList.add("hidden");
}

function enterListen() {
  const p = currentProblem();
  p._lang_key = pickAccentKey(); // この出題での再生アクセントを固定（リプレイ時に変わらないように）
  p._lang = ACCENT_LANG[p._lang_key];
  hideAudioErrorHint();
  releaseMicStream();
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

// --- 自己録音（お手本と聞き比べるための非採点機能。音声認識による自動採点は却下済み方針） ---
let mediaRecorder = null;
let recordedChunks = [];
let micStream = null; // 権限取得後のstreamを保持し、画面遷移時にreleaseMicStream()で解放する

function recordingSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

// iOS Safariはwebm系codecに対応しない可能性が高いため候補を順に試す（実機での対応状況は未検証）
const RECORDING_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];

function pickRecordingMimeType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
  return RECORDING_MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function onMicPermissionDenied() {
  document.getElementById("record-status").textContent =
    "🎤 マイクの使用が許可されていません（ブラウザの設定から許可できます）";
  document.getElementById("record-button").disabled = true;
}

async function startRecording() {
  if (!recordingSupported()) {
    showToast("この端末では録音機能が使えません");
    return false;
  }
  try {
    micStream = micStream || (await navigator.mediaDevices.getUserMedia({ audio: true }));
  } catch (e) {
    onMicPermissionDenied();
    return false;
  }
  const mimeType = pickRecordingMimeType();
  recordedChunks = [];
  mediaRecorder = mimeType ? new MediaRecorder(micStream, { mimeType }) : new MediaRecorder(micStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.start();
  return true;
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      resolve(null);
      return;
    }
    mediaRecorder.onstop = () => {
      const mimeType = mediaRecorder.mimeType || "audio/webm";
      resolve({ blob: new Blob(recordedChunks, { type: mimeType }), mimeType });
    };
    mediaRecorder.stop();
  });
}

function releaseMicStream() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

async function updateRecordBoxUI(problemId) {
  const box = document.getElementById("record-box");
  if (!recordingSupported()) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  const recordBtn = document.getElementById("record-button");
  recordBtn.dataset.recording = "false";
  recordBtn.textContent = "🎙 録音する";
  recordBtn.disabled = false;
  const rec = await loadRecording(problemId);
  document.getElementById("play-my-recording").disabled = !rec;
  document.getElementById("record-status").textContent = rec ? "録音済みです（再録音で上書きされます）" : "";
}

document.getElementById("record-button").addEventListener("click", async () => {
  const btn = document.getElementById("record-button");
  const p = currentProblem();
  if (btn.dataset.recording === "true") {
    const result = await stopRecording();
    btn.dataset.recording = "false";
    btn.textContent = "🎙 録音する";
    if (result) {
      const ok = await saveRecording(p.id, result.blob, result.mimeType);
      document.getElementById("record-status").textContent = ok ? "録音を保存しました" : "保存に失敗しました";
      document.getElementById("play-my-recording").disabled = !ok;
    }
    return;
  }
  const started = await startRecording();
  if (started) {
    btn.dataset.recording = "true";
    btn.textContent = "⏹ 停止";
    document.getElementById("record-status").textContent = "録音中…";
  }
});

document.getElementById("play-my-recording").addEventListener("click", async () => {
  const p = currentProblem();
  const rec = await loadRecording(p.id);
  if (!rec) return;
  const audioEl = document.getElementById("my-recording-audio");
  audioEl.src = URL.createObjectURL(rec.blob);
  audioEl.play().catch(() => showToast("録音の再生に失敗しました"));
});

// --- 画面3: 回答・解説 ---
function updateMarkButton(problemId) {
  const btn = document.getElementById("mark-button");
  const isMarked = loadMarkedProblems().has(problemId);
  btn.textContent = isMarked ? "★" : "☆";
  btn.classList.toggle("marked", isMarked);
  btn.setAttribute("aria-pressed", String(isMarked));
}

function enterAnswer() {
  const p = currentProblem();
  updateProgressUI();
  document.getElementById("answer-text").textContent = p.text;
  updateAccuracyLabel();
  updateMarkButton(p.id);
  updateRecordBoxUI(p.id); // 非同期だが画面遷移をブロックしない（既存録音の有無は準備でき次第反映）
  setJudgeButtonsDisabled(false);
  showScreen("answer");
}

document.getElementById("mark-button").addEventListener("click", () => {
  const p = currentProblem();
  const nowMarked = toggleMarkedProblem(p.id);
  updateMarkButton(p.id);
  showToast(nowMarked ? "★ マークしました" : "マークを解除しました");
});

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
const TIER_LABEL = { perfect: "できた", half: "半分できた", none: "できなかった" };
const TIER_BEEP = { perfect: [880, 0.12], half: [520, 0.14], none: [220, 0.18] };
const TIER_VIBRATE = { perfect: [15], half: [20], none: [30, 40, 30] };
const LEVEL_UP_VIBRATE = [20, 30, 20, 30, 40];
const PERFECT_WEEK_VIBRATE = [30, 20, 30, 20, 30, 20, 60];

let pendingMistakeProblemId = null;

function setJudgeButtonsDisabled(disabled) {
  ["judge-perfect", "judge-half", "judge-none"].forEach((id) => {
    document.getElementById(id).disabled = disabled;
  });
}

function judge(tier) {
  if (document.getElementById("judge-perfect").disabled) return; // 演出中の二重タップ防止
  setJudgeButtonsDisabled(true);
  const p = currentProblem();
  state.totalCount += 1;
  state.scoreSum += SCORE_BY_TIER[tier];
  recordAttempt(p.id, tier);
  if (p._lang_key) recordAccentAttempt(p._lang_key, tier);

  if (tier === "perfect") {
    state.cleared.add(p.id);
    state.streak += 1;
    state.bestStreak = Math.max(state.bestStreak, state.streak);
    pendingMistakeProblemId = null;
  } else {
    state.hadAnyImperfect = true;
    state.streak = 0;
    // 「できた」以外は数問先に再度差し込み、同セッション内で再出題する
    const offset = 2 + Math.floor(Math.random() * 3);
    const reinsertAt = Math.min(state.queue.length, state.currentIndex + 1 + offset);
    state.queue.splice(reinsertAt, 0, p);
    recordMistake(p.id, p.text, null, tier);
    pendingMistakeProblemId = p.id;
    state.sessionMistakeIds.add(p.id);
  }
  playBeep(...TIER_BEEP[tier]);
  vibrate(TIER_VIBRATE[tier]);

  const sessionDone = state.cleared.size >= state.poolSize;
  if (!sessionDone) state.currentIndex += 1;
  saveSessionSnapshot();

  // 間を空けてから次へ（バーで可視化）。誤答理由チップを出す場合は選ぶ時間を確保するため長めにする。
  // この遅延によりnext再生はユーザー操作と同一コールスタックでなくなるため、
  // iOS Safariで自動再生がブロックされる可能性がある（実機確認済み）
  const pauseMs = tier === "perfect" ? INTER_PROBLEM_PAUSE_MS : MISTAKE_REASON_PAUSE_MS;
  showReaction(
    TIER_EMOJI[tier],
    pauseMs,
    sessionDone ? enterSummary : enterListen,
    TIER_LABEL[tier],
    tier !== "perfect"
  );
}

document.getElementById("judge-perfect").addEventListener("click", () => judge("perfect"));
document.getElementById("judge-half").addEventListener("click", () => judge("half"));
document.getElementById("judge-none").addEventListener("click", () => judge("none"));
document.getElementById("replay-on-answer").addEventListener("click", playCurrent);

document.querySelectorAll("#mistake-reason-group .reason-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (!pendingMistakeProblemId) return;
    updateLastMistakeReason(pendingMistakeProblemId, chip.dataset.reason);
    showToast("メモしました");
  });
});

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
  clearSessionSnapshot();
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

  const mistakeIds = [...state.sessionMistakeIds];
  saveLastSessionMistakes(mistakeIds);
  const retryBtn = document.getElementById("retry-mistakes-button");
  if (mistakeIds.length > 0) {
    retryBtn.textContent = `🔁 間違えた問題だけもう一周（${mistakeIds.length}問）`;
    retryBtn.classList.remove("hidden");
  } else {
    retryBtn.classList.add("hidden");
  }

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
    releaseMicStream();
    clearSessionSnapshot();
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

// --- オンボーディングの簡易パーソナライズ設問（レベル感・目的） ---
const ONBOARDING_PROFILE_KEY = "eigo-shukan-juku:onboarding-profile:v1";
let onboardingLevel = "beginner";
let onboardingGoal = "general";

function saveOnboardingProfile(profile) {
  try {
    localStorage.setItem(ONBOARDING_PROFILE_KEY, JSON.stringify(profile));
  } catch (e) {
    // 保存できなくても選択内容がstate.selectedLevelに反映されていればこの回だけは有効
  }
}

setupSingleSelectGroup(document.getElementById("onboarding-level-group"), "level", (v) => {
  onboardingLevel = v;
});
setupSingleSelectGroup(document.getElementById("onboarding-goal-group"), "goal", (v) => {
  onboardingGoal = v;
});

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
  maybeShowResumeBanner();
}

if (hasPassedGate()) {
  document.getElementById("screen-gate").classList.add("hidden");
  showScreen("top");
  maybeShowOnboarding();
  maybeShowResumeBanner();
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
  saveOnboardingProfile({ goal: onboardingGoal, initialLevel: onboardingLevel });
  state.selectedLevel = onboardingLevel;
  document.querySelectorAll("#level-group .chip").forEach((c) => {
    const isSelected = c.dataset.level === onboardingLevel;
    c.classList.toggle("active", isSelected);
    c.setAttribute("aria-checked", String(isSelected));
  });
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
const loadingIndicatorEl = document.getElementById("loading-indicator");
startButtonEl.disabled = true;

loadProblems()
  .then(() => {
    startButtonEl.disabled = false;
    loadingIndicatorEl.classList.add("hidden");
    renderSetChips(state.selectedLevel);
    renderTopScreen(); // 初回renderTopScreen()はPROBLEMS未取得時点で走るため、SRSバッジ等を読み込み完了後に再計算する
  })
  .catch((err) => {
    console.error(err);
    loadingIndicatorEl.classList.add("hidden");
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
