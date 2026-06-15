/* Office Darts League — front-end logic */
(() => {
  "use strict";

  // ---------- State ----------
  let data = { players: [], scores: [] };
  let weekStart = startOfWeek(new Date());
  let view = "week"; // "week" | "season"
  let lastSync = 0;

  // ---------- Elements ----------
  const el = {
    boardBody: document.getElementById("boardBody"),
    weekRange: document.getElementById("weekRange"),
    prevWeek: document.getElementById("prevWeek"),
    nextWeek: document.getElementById("nextWeek"),
    thisWeek: document.getElementById("thisWeek"),
    tabs: Array.from(document.querySelectorAll(".tab")),
    form: document.getElementById("scoreForm"),
    nameInput: document.getElementById("nameInput"),
    dateInput: document.getElementById("dateInput"),
    scoreInput: document.getElementById("scoreInput"),
    playerList: document.getElementById("playerList"),
    existingHint: document.getElementById("existingHint"),
    saveBtn: document.getElementById("saveBtn"),
    deleteBtn: document.getElementById("deleteBtn"),
    formMsg: document.getElementById("formMsg"),
    toast: document.getElementById("toast"),
    syncDot: document.getElementById("syncDot"),
    syncText: document.getElementById("syncText"),
  };

  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // ---------- Date helpers (all local time) ----------
  function pad(n) {
    return String(n).padStart(2, "0");
  }
  function toKey(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function parseKey(k) {
    const [y, m, d] = k.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function startOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const offset = (x.getDay() + 6) % 7; // Monday = 0
    x.setDate(x.getDate() - offset);
    return x;
  }
  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }
  function sameDay(a, b) {
    return toKey(a) === toKey(b);
  }
  function fmtShort(d) {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  function fmtNum(n) {
    return n.toLocaleString("en-US");
  }

  // ---------- Data access ----------
  function playerById(id) {
    return data.players.find((p) => p.id === id);
  }

  // Map of "YYYY-MM-DD" -> total for a player within the week.
  function weekDataFor(playerId, start) {
    const days = WEEKDAYS.map((_, i) => toKey(addDays(start, i)));
    const byDay = {};
    let total = 0;
    for (const key of days) byDay[key] = null;
    for (const s of data.scores) {
      if (s.playerId !== playerId) continue;
      if (s.date in byDay) {
        byDay[s.date] = s.value;
        total += s.value;
      }
    }
    return { byDay, total, days };
  }

  // ---------- API ----------
  async function fetchData() {
    const res = await fetch("/api/data", { headers: { "cache-control": "no-store" } });
    if (!res.ok) throw new Error("Failed to load");
    return res.json();
  }

  async function refresh() {
    try {
      data = await fetchData();
      lastSync = Date.now();
      markFresh(true);
      render();
      updateExistingHint();
    } catch (err) {
      markFresh(false);
    }
  }

  async function sendScore(method, body) {
    const res = await fetch("/api/score", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Something went wrong.");
    return payload;
  }

  function markFresh(ok) {
    el.syncDot.classList.toggle("is-stale", !ok);
    el.syncText.textContent = ok
      ? "Live · shared across the office"
      : "Reconnecting…";
  }

  // ---------- Rendering ----------
  function render() {
    renderWeekLabel();
    renderPlayerList();
    if (view === "week") renderWeek();
    else renderSeason();
  }

  function renderWeekLabel() {
    const end = addDays(weekStart, 6);
    el.weekRange.textContent = `${fmtShort(weekStart)} – ${fmtShort(end)}, ${end.getFullYear()}`;
    const isThisWeek = sameDay(weekStart, startOfWeek(new Date()));
    el.thisWeek.style.visibility = isThisWeek ? "hidden" : "visible";
  }

  function renderPlayerList() {
    const sorted = [...data.players].sort((a, b) => a.name.localeCompare(b.name));
    el.playerList.innerHTML = sorted
      .map((p) => `<option value="${escapeAttr(p.name)}"></option>`)
      .join("");
  }

  function renderWeek() {
    const rows = data.players
      .map((p) => ({ player: p, ...weekDataFor(p.id, weekStart) }))
      .filter((r) => r.total > 0 || Object.values(r.byDay).some((v) => v !== null))
      .sort((a, b) => b.total - a.total || a.player.name.localeCompare(b.player.name));

    if (rows.length === 0) {
      el.boardBody.innerHTML = emptyState(
        "No scores for this week yet",
        "Be the first to throw — add a score on the right."
      );
      return;
    }

    const max = Math.max(...rows.map((r) => r.total), 1);
    const medals = ["🥇", "🥈", "🥉"];

    const html = rows
      .map((r, i) => {
        const rank = i + 1;
        const rankClass = rank <= 3 ? ` row--${rank}` : "";
        const rankCell = rank <= 3 ? `<span class="medal">${medals[rank - 1]}</span>` : rank;
        const chips = r.days
          .map((key, idx) => {
            const v = r.byDay[key];
            const empty = v === null ? " is-empty" : "";
            const val = v === null ? "–" : fmtNum(v);
            return `<span class="daychip${empty}">${WEEKDAYS[idx]} <b>${val}</b></span>`;
          })
          .join("");
        const barW = ((r.total / max) * 100).toFixed(1);
        return `
          <div class="row${rankClass}">
            <div class="row__bar" style="width:${barW}%"></div>
            <div class="rank">${rankCell}</div>
            <div class="who">
              <div class="who__name">${escapeHtml(r.player.name)}</div>
              <div class="who__days">${chips}</div>
            </div>
            <div class="total">
              <div class="total__num">${fmtNum(r.total)}</div>
              <div class="total__label">points</div>
            </div>
          </div>`;
      })
      .join("");

    el.boardBody.innerHTML = `<div class="lb">${html}</div>`;
  }

  function renderSeason() {
    // Aggregate everything across all weeks.
    const stats = new Map(); // playerId -> agg
    for (const p of data.players) {
      stats.set(p.id, {
        player: p,
        total: 0,
        days: 0,
        best: null, // { value, date }
        weeks: new Map(), // weekKey -> sum
      });
    }
    for (const s of data.scores) {
      const agg = stats.get(s.playerId);
      if (!agg) continue;
      agg.total += s.value;
      agg.days += 1;
      if (!agg.best || s.value > agg.best.value) {
        agg.best = { value: s.value, date: s.date };
      }
      const wk = toKey(startOfWeek(parseKey(s.date)));
      agg.weeks.set(wk, (agg.weeks.get(wk) || 0) + s.value);
    }

    // Determine the winner(s) of each completed week.
    const weekWinners = computeWeekWins(stats);

    const rows = [...stats.values()]
      .filter((a) => a.days > 0)
      .sort((a, b) => b.total - a.total || a.player.name.localeCompare(b.player.name));

    if (rows.length === 0) {
      el.boardBody.innerHTML = emptyState(
        "The season hasn't started",
        "Once scores are entered, season totals show up here."
      );
      return;
    }

    const body = rows
      .map((a, i) => {
        const avg = a.days ? (a.total / a.days) : 0;
        const best = a.best
          ? `${fmtNum(a.best.value)} <span style="color:var(--muted)">(${fmtShort(parseKey(a.best.date))})</span>`
          : "–";
        const wins = weekWinners.get(a.player.id) || 0;
        const winCell = wins > 0 ? `<span class="wins">🏆 ${wins}</span>` : "–";
        return `
          <tr>
            <td class="s-rank">${i + 1}</td>
            <td class="s-name">${escapeHtml(a.player.name)}</td>
            <td class="s-total">${fmtNum(a.total)}</td>
            <td>${a.days}</td>
            <td>${avg.toFixed(1)}</td>
            <td>${best}</td>
            <td>${winCell}</td>
          </tr>`;
      })
      .join("");

    el.boardBody.innerHTML = `
      <div class="season">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Total</th>
              <th>Days</th>
              <th>Avg/day</th>
              <th>Best day</th>
              <th>Weeks won</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  // For each week that has any scores, the player(s) with the highest weekly
  // total earn a win. Ties award a win to everyone tied.
  function computeWeekWins(stats) {
    const perWeek = new Map(); // weekKey -> Map(playerId -> sum)
    for (const agg of stats.values()) {
      for (const [wk, sum] of agg.weeks) {
        if (!perWeek.has(wk)) perWeek.set(wk, new Map());
        perWeek.get(wk).set(agg.player.id, sum);
      }
    }
    const wins = new Map();
    for (const playerSums of perWeek.values()) {
      const max = Math.max(...playerSums.values());
      if (max <= 0) continue;
      for (const [pid, sum] of playerSums) {
        if (sum === max) wins.set(pid, (wins.get(pid) || 0) + 1);
      }
    }
    return wins;
  }

  function emptyState(title, sub) {
    return `
      <div class="empty">
        <div class="empty__big">🎯</div>
        <div style="font-weight:700;color:var(--text)">${escapeHtml(title)}</div>
        <div>${escapeHtml(sub)}</div>
      </div>`;
  }

  // ---------- Existing-score hint / edit awareness ----------
  function findScore(name, dateKey) {
    const norm = name.trim().replace(/\s+/g, " ").toLowerCase();
    const player = data.players.find((p) => p.name.toLowerCase() === norm);
    if (!player) return null;
    return data.scores.find((s) => s.playerId === player.id && s.date === dateKey) || null;
  }

  function updateExistingHint() {
    const name = el.nameInput.value.trim();
    const dateKey = el.dateInput.value;
    if (!name || !dateKey) {
      el.existingHint.hidden = true;
      el.deleteBtn.hidden = true;
      el.saveBtn.textContent = "Save score";
      return;
    }
    const existing = findScore(name, dateKey);
    if (existing) {
      const dayName = parseKey(dateKey).toLocaleDateString("en-US", { weekday: "long" });
      el.existingHint.hidden = false;
      el.existingHint.textContent = `${dayName}'s score is currently ${fmtNum(existing.value)} — saving will update it.`;
      el.deleteBtn.hidden = false;
      el.saveBtn.textContent = "Update score";
    } else {
      el.existingHint.hidden = true;
      el.deleteBtn.hidden = true;
      el.saveBtn.textContent = "Save score";
    }
  }

  // ---------- Toast / messages ----------
  let toastTimer;
  function toast(msg, isError = false) {
    el.toast.textContent = msg;
    el.toast.classList.toggle("is-error", isError);
    el.toast.classList.add("is-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("is-show"), 2600);
  }

  function setFormMsg(msg, kind) {
    el.formMsg.textContent = msg || "";
    el.formMsg.className = "formmsg" + (kind ? ` is-${kind}` : "");
  }

  // ---------- Events ----------
  el.prevWeek.addEventListener("click", () => {
    weekStart = addDays(weekStart, -7);
    view = "week";
    syncTabs();
    render();
  });
  el.nextWeek.addEventListener("click", () => {
    weekStart = addDays(weekStart, 7);
    view = "week";
    syncTabs();
    render();
  });
  el.thisWeek.addEventListener("click", () => {
    weekStart = startOfWeek(new Date());
    render();
  });

  el.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      view = tab.dataset.view;
      syncTabs();
      render();
    });
  });

  function syncTabs() {
    el.tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.view === view));
  }

  el.nameInput.addEventListener("input", updateExistingHint);
  el.dateInput.addEventListener("change", updateExistingHint);

  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = el.nameInput.value.trim();
    const dateKey = el.dateInput.value;
    const scoreRaw = el.scoreInput.value;

    if (!name) return setFormMsg("Please choose or type your name.", "error");
    if (!dateKey) return setFormMsg("Please pick a day.", "error");
    if (scoreRaw === "" || isNaN(Number(scoreRaw))) {
      return setFormMsg("Please enter a numeric score.", "error");
    }

    el.saveBtn.disabled = true;
    setFormMsg("Saving…");
    try {
      data = await sendScore("POST", {
        name,
        date: dateKey,
        value: Number(scoreRaw),
      });
      lastSync = Date.now();
      markFresh(true);
      // Jump the board to the week the score belongs to so it's visible.
      weekStart = startOfWeek(parseKey(dateKey));
      if (view === "season") { /* keep season view */ } else { view = "week"; }
      syncTabs();
      render();
      el.scoreInput.value = "";
      updateExistingHint();
      setFormMsg("");
      toast(`Saved ${name}'s score 🎯`);
    } catch (err) {
      setFormMsg(err.message, "error");
      toast(err.message, true);
    } finally {
      el.saveBtn.disabled = false;
    }
  });

  el.deleteBtn.addEventListener("click", async () => {
    const name = el.nameInput.value.trim();
    const dateKey = el.dateInput.value;
    if (!name || !dateKey) return;
    if (!confirm(`Remove ${name}'s score for ${parseKey(dateKey).toLocaleDateString()}?`)) return;

    el.deleteBtn.disabled = true;
    try {
      data = await sendScore("DELETE", { name, date: dateKey });
      lastSync = Date.now();
      render();
      el.scoreInput.value = "";
      updateExistingHint();
      toast("Score removed");
    } catch (err) {
      toast(err.message, true);
    } finally {
      el.deleteBtn.disabled = false;
    }
  });

  // ---------- Escaping ----------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s);
  }

  // ---------- Init ----------
  function init() {
    el.dateInput.value = toKey(new Date());
    syncTabs();
    refresh();
    // Poll so every office screen stays in sync.
    setInterval(refresh, 15000);
    // Refresh when a tab regains focus.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) refresh();
    });
  }

  init();
})();
