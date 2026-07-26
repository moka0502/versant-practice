// ダミー問題データ（実データ・実音声はStage 1/2以降で差し替え）
// 本番のVersant Part B（Repeats）は1回16問のため、件数をそれに合わせている
const PROBLEMS = [
  { id: "rep-0001", level: "beginner", text: "If you need any help, just let me know." },
  { id: "rep-0002", level: "beginner", text: "Can you close the door, please?" },
  { id: "rep-0003", level: "beginner", text: "I'll call you back in five minutes." },
  { id: "rep-0004", level: "beginner", text: "The train leaves at nine o'clock sharp." },
  { id: "rep-0005", level: "beginner", text: "Please turn off the lights before you leave." },
  { id: "rep-0006", level: "intermediate", text: "Could you please send me the report before the end of the day?" },
  { id: "rep-0007", level: "intermediate", text: "I was wondering if you could help me with this file." },
  { id: "rep-0008", level: "intermediate", text: "We need to finalize the budget before the meeting tomorrow." },
  { id: "rep-0009", level: "intermediate", text: "She usually takes the bus to work unless it's raining heavily." },
  { id: "rep-0010", level: "intermediate", text: "Let me know if you have any questions about the new policy." },
  { id: "rep-0011", level: "advanced", text: "The meeting has been rescheduled to next Tuesday because several key members are traveling." },
  { id: "rep-0012", level: "advanced", text: "Although the proposal looked promising, the committee decided to postpone their decision." },
  { id: "rep-0013", level: "advanced", text: "Despite the heavy rain, the construction team managed to finish the project ahead of schedule." },
  { id: "rep-0014", level: "advanced", text: "The new marketing strategy focuses on expanding into international markets over the next few years." },
  { id: "rep-0015", level: "advanced", text: "Even though the flight was delayed by several hours, most passengers remained remarkably calm." },
  { id: "rep-0016", level: "advanced", text: "Researchers discovered that the unexpected results were caused by a flaw in the original experiment." },
];

const ACCENT_LANG = { us: "en-US", gb: "en-GB", au: "en-AU" };
const ACCENT_KEYS = ["us", "gb", "au"];

const state = {
  selectedLevel: "mix",
  selectedAccent: "mix",
  speedRate: 1,
  queue: [],
  poolSize: 0,
  cleared: new Set(),
  currentIndex: 0,
  correctCount: 0,
  totalCount: 0,
  streak: 0,
  bestStreak: 0,
};

const screens = {
  part: document.getElementById("screen-part"),
  select: document.getElementById("screen-select"),
  listen: document.getElementById("screen-listen"),
  answer: document.getElementById("screen-answer"),
  summary: document.getElementById("screen-summary"),
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

function showReaction(emoji) {
  const overlay = document.getElementById("reaction-overlay");
  const emojiEl = document.getElementById("reaction-emoji");
  emojiEl.textContent = emoji;
  emojiEl.style.animation = "none";
  void emojiEl.offsetWidth; // アニメーション再発火のためのreflow
  emojiEl.style.animation = "";
  overlay.classList.remove("hidden");
  setTimeout(() => overlay.classList.add("hidden"), 500);
}

// --- 画面0: Part選択 ---
document.getElementById("part-b-button").addEventListener("click", () => showScreen("select"));
document.getElementById("back-to-part").addEventListener("click", () => showScreen("part"));

// --- 画面1: レベル・アクセント選択（単一選択） ---
function setupSingleSelectGroup(groupEl, dataAttr, onSelect) {
  groupEl.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      groupEl.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      onSelect(chip.dataset[dataAttr]);
    });
  });
}

setupSingleSelectGroup(document.getElementById("level-group"), "level", (v) => {
  state.selectedLevel = v;
});
setupSingleSelectGroup(document.getElementById("accent-group"), "accent", (v) => {
  state.selectedAccent = v;
});

function startSession() {
  const pool =
    state.selectedLevel === "mix"
      ? PROBLEMS
      : PROBLEMS.filter((p) => p.level === state.selectedLevel);
  if (pool.length === 0) return;

  state.queue = [...pool].sort(() => Math.random() - 0.5);
  state.poolSize = pool.length;
  state.cleared = new Set();
  state.currentIndex = 0;
  state.correctCount = 0;
  state.totalCount = 0;
  state.streak = 0;
  state.bestStreak = 0;
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
  const label = `${state.cleared.size} / ${state.poolSize} 問クリア`;
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

function playCurrent() {
  const p = currentProblem();
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
    el.textContent = "正答率: -";
    return;
  }
  const pct = Math.round((state.correctCount / state.totalCount) * 100);
  el.textContent = `正答率: ${state.correctCount} / ${state.totalCount}（${pct}%）`;
}

function judge(isCorrect) {
  const p = currentProblem();
  state.totalCount += 1;

  if (isCorrect) {
    state.cleared.add(p.id);
    state.correctCount += 1;
    state.streak += 1;
    state.bestStreak = Math.max(state.bestStreak, state.streak);
    playBeep(880, 0.12);
    vibrate([15]);
    showReaction("🎉"); // 演出は非同期で流すだけ。次の音声再生をブロックしない（iOSの自動再生制限対策）
  } else {
    state.streak = 0;
    // 間違えた問題は数問先に再度差し込み、同セッション内で再出題する
    const offset = 2 + Math.floor(Math.random() * 3);
    const reinsertAt = Math.min(state.queue.length, state.currentIndex + 1 + offset);
    state.queue.splice(reinsertAt, 0, p);
    playBeep(220, 0.18);
    vibrate([30, 40, 30]);
    showReaction("😅");
  }

  if (state.cleared.size >= state.poolSize) {
    enterSummary();
    return;
  }
  state.currentIndex += 1;
  // ○/✕タップ（ユーザー操作）の同一コールスタック内で次の音声再生まで行う
  enterListen();
}

document.getElementById("judge-correct").addEventListener("click", () => judge(true));
document.getElementById("judge-wrong").addEventListener("click", () => judge(false));
document.getElementById("replay-on-answer").addEventListener("click", playCurrent);

// --- 画面4: セッションリザルト ---
function enterSummary() {
  const pct = state.totalCount === 0 ? 0 : Math.round((state.correctCount / state.totalCount) * 100);
  document.getElementById("summary-accuracy").textContent = `${state.correctCount} / ${state.totalCount}（${pct}%）`;
  document.getElementById("summary-streak").textContent = `🔥 ${state.bestStreak}`;
  document.getElementById("summary-total").textContent = `${state.poolSize} 問`;
  showScreen("summary");
}

// --- 共通: 戻るボタン ---
document.querySelectorAll(".back-button").forEach((btn) => {
  btn.addEventListener("click", () => {
    window.speechSynthesis && window.speechSynthesis.cancel();
    showScreen("select");
  });
});
