/* Office Darts League — front-end logic */
(() => {
  "use strict";

  // ---------- State ----------
  let data = { players: [], scores: [] };
  let weekStart = startOfWeek(new Date());
  let view = "week"; // "week" | "season" | "game"
  let league = null; // set in init() to the current league
  let lastSync = 0;
  let deployId = null; // reload long-open pages when a new deploy ships
  let nameMode = "pick"; // "pick" (dropdown of registered players) | "new"
  let mergeOpenId = null; // player id with the merge picker open
  let mergeTargetId = ""; // chosen merge target (survives re-renders)

  // ---------- Match (x01 game) state ----------
  // Purely a live scorer — nothing here is saved to the leaderboard.
  const GAME_STARTS = [101, 201, 301, 401, 501, 601, 701, 801, 901, 1001];
  let gameSetup = { start: 201, selected: [] }; // selected: player ids in throw order
  let game = null; // null = setup screen; else { start, players, currentIdx, turn, winnerIdx }

  // ---------- Elements ----------
  const el = {
    boardBody: document.getElementById("boardBody"),
    weekNav: document.getElementById("weekNav"),
    weekRange: document.getElementById("weekRange"),
    prevWeek: document.getElementById("prevWeek"),
    nextWeek: document.getElementById("nextWeek"),
    thisWeek: document.getElementById("thisWeek"),
    leagueNav: document.getElementById("leagueNav"),
    leagueLabel: document.getElementById("leagueLabel"),
    prevLeague: document.getElementById("prevLeague"),
    nextLeague: document.getElementById("nextLeague"),
    thisLeague: document.getElementById("thisLeague"),
    tabs: Array.from(document.querySelectorAll(".tab")),
    form: document.getElementById("scoreForm"),
    nameInput: document.getElementById("nameInput"),
    nameSelect: document.getElementById("nameSelect"),
    nameModeToggle: document.getElementById("nameModeToggle"),
    dateInput: document.getElementById("dateInput"),
    scoreInput: document.getElementById("scoreInput"),
    manageList: document.getElementById("manageList"),
    existingHint: document.getElementById("existingHint"),
    saveBtn: document.getElementById("saveBtn"),
    deleteBtn: document.getElementById("deleteBtn"),
    formMsg: document.getElementById("formMsg"),
    toast: document.getElementById("toast"),
    syncDot: document.getElementById("syncDot"),
    syncText: document.getElementById("syncText"),
  };

  // The league runs Monday–Friday (5 playing days per week).
  const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
  const DAYS_PER_WEEK = WEEKDAYS.length;

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
  function isWeekday(d) {
    const day = d.getDay();
    return day >= 1 && day <= 5;
  }
  // A competition week is "complete" once its Friday is in the past.
  function weekIsComplete(start) {
    const friday = addDays(start, DAYS_PER_WEEK - 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return friday < today;
  }
  // Sensible default for the entry form: today, or the most recent weekday.
  function defaultEntryDate() {
    let d = new Date();
    while (!isWeekday(d)) d = addDays(d, -1);
    return d;
  }

  // ---------- League helpers ----------
  // Two leagues per year for the running statistics:
  //   Spring: 1 Jan – 30 Jun   ·   Autumn: 1 Aug – 31 Dec   (July is off-season)
  function leagueForDate(d) {
    const m = d.getMonth();
    const y = d.getFullYear();
    if (m <= 5) return { type: "spring", year: y }; // Jan–Jun
    if (m >= 7) return { type: "autumn", year: y }; // Aug–Dec
    return null; // July
  }
  function leagueWindow(l) {
    return l.type === "spring"
      ? { start: new Date(l.year, 0, 1), end: new Date(l.year, 5, 30) }
      : { start: new Date(l.year, 7, 1), end: new Date(l.year, 11, 31) };
  }
  function leagueName(l) {
    return `${l.type === "spring" ? "Spring" : "Autumn"} ${l.year}`;
  }
  function nextLeague(l) {
    return l.type === "spring"
      ? { type: "autumn", year: l.year }
      : { type: "spring", year: l.year + 1 };
  }
  function prevLeague(l) {
    return l.type === "autumn"
      ? { type: "spring", year: l.year }
      : { type: "autumn", year: l.year - 1 };
  }
  function sameLeague(a, b) {
    return a.type === b.type && a.year === b.year;
  }
  // Current league, or — during the July break — the Spring that just ended.
  function currentLeague() {
    const today = new Date();
    return leagueForDate(today) || { type: "spring", year: today.getFullYear() };
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
      // A new deploy shipped while this page was open (e.g. the office TV):
      // reload to pick up the new code — but never in the middle of a match.
      if (data.deployId) {
        if (deployId && deployId !== data.deployId && (view !== "game" || game === null)) {
          location.reload();
          return;
        }
        deployId = data.deployId;
      }
      lastSync = Date.now();
      markFresh(true);
      // Don't redraw mid-match — a background poll must never disturb a game
      // in progress. The setup screen does refresh (roster may have changed).
      if (view !== "game" || game === null) render();
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
    el.weekNav.hidden = view !== "week";
    el.leagueNav.hidden = view !== "season";
    renderWeekLabel();
    renderLeagueLabel();
    renderNamePicker();
    renderManage();
    if (view === "season") renderSeason();
    else if (view === "game") renderGame();
    else renderWeek();
  }

  function renderLeagueLabel() {
    if (!league) return;
    const { start, end } = leagueWindow(league);
    el.leagueLabel.textContent = `${leagueName(league)} · ${fmtShort(start)} – ${fmtShort(end)}`;
    el.thisLeague.style.visibility = sameLeague(league, currentLeague())
      ? "hidden"
      : "visible";
  }

  function renderWeekLabel() {
    const end = addDays(weekStart, DAYS_PER_WEEK - 1); // Friday
    const isThisWeek = sameDay(weekStart, startOfWeek(new Date()));
    const suffix = isThisWeek ? " · This week" : "";
    el.weekRange.textContent = `${fmtShort(weekStart)} – ${fmtShort(end)}, ${end.getFullYear()}${suffix}`;
    el.thisWeek.style.visibility = isThisWeek ? "hidden" : "visible";
  }

  // ---------- Name picker (dropdown by default, free text to add) ----------
  function sortedPlayers() {
    return [...data.players].sort((a, b) => a.name.localeCompare(b.name));
  }

  function currentName() {
    return nameMode === "pick"
      ? el.nameSelect.value
      : el.nameInput.value.trim();
  }

  function renderNamePicker() {
    const sorted = sortedPlayers();
    // Nobody registered yet → free-text is the only way in.
    if (sorted.length === 0 && nameMode === "pick") nameMode = "new";

    const prev = el.nameSelect.value;
    el.nameSelect.innerHTML =
      `<option value="">Select your name…</option>` +
      sorted
        .map((p) => `<option value="${escapeAttr(p.name)}">${escapeHtml(p.name)}</option>`)
        .join("");
    if (prev && sorted.some((p) => p.name === prev)) el.nameSelect.value = prev;

    const picking = nameMode === "pick";
    el.nameSelect.hidden = !picking;
    el.nameInput.hidden = picking;
    el.nameModeToggle.hidden = sorted.length === 0;
    el.nameModeToggle.textContent = picking
      ? "+ Add a new player"
      : "← Choose an existing player instead";
  }

  // ---------- Manage players (merge misspelled duplicates / delete) ----------
  function renderManage() {
    const sorted = sortedPlayers();
    if (sorted.length === 0) {
      el.manageList.innerHTML = `<p class="manage__hint">No players yet.</p>`;
      return;
    }
    const counts = new Map();
    for (const s of data.scores) {
      counts.set(s.playerId, (counts.get(s.playerId) || 0) + 1);
    }
    el.manageList.innerHTML = sorted
      .map((p) => {
        const n = counts.get(p.id) || 0;
        const scoreTxt = `${n} score${n === 1 ? "" : "s"}`;
        const others = sorted.filter((o) => o.id !== p.id);
        const mergeUi =
          mergeOpenId === p.id
            ? `
          <div class="manage__merge">
            <select class="manage__target" data-id="${escapeAttr(p.id)}">
              <option value="">Merge scores into…</option>
              ${others
                .map(
                  (o) =>
                    `<option value="${escapeAttr(o.id)}"${o.id === mergeTargetId ? " selected" : ""}>${escapeHtml(o.name)}</option>`
                )
                .join("")}
            </select>
            <button type="button" class="btn btn--mini" data-act="merge-go" data-id="${escapeAttr(p.id)}">Merge</button>
            <button type="button" class="btn btn--mini btn--plain" data-act="merge-cancel">Cancel</button>
          </div>`
            : "";
        return `
        <div class="manage__row">
          <div class="manage__who">
            <span class="manage__name">${escapeHtml(p.name)}</span>
            <span class="manage__meta">${scoreTxt}</span>
          </div>
          <div class="manage__acts">
            <button type="button" class="btn btn--mini" data-act="merge-open" data-id="${escapeAttr(p.id)}" ${others.length === 0 ? "disabled" : ""}>Merge…</button>
            <button type="button" class="btn btn--mini btn--danger" data-act="delete" data-id="${escapeAttr(p.id)}">Delete</button>
          </div>
          ${mergeUi}
        </div>`;
      })
      .join("");
  }

  async function apiCall(path, method, body) {
    const res = await fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || "Something went wrong.");
    return payload;
  }

  // Winner(s) of a given competition week (highest weekly total, >0). Ties shared.
  function winnerOfWeek(start) {
    const dayset = new Set(WEEKDAYS.map((_, i) => toKey(addDays(start, i))));
    const totals = new Map();
    for (const s of data.scores) {
      if (!dayset.has(s.date)) continue;
      totals.set(s.playerId, (totals.get(s.playerId) || 0) + s.value);
    }
    let max = 0;
    for (const v of totals.values()) if (v > max) max = v;
    if (max <= 0) return null;
    const names = [];
    for (const [pid, v] of totals) {
      if (v === max) {
        const p = playerById(pid);
        if (p) names.push(p.name);
      }
    }
    names.sort((a, b) => a.localeCompare(b));
    return { names, total: max };
  }

  // Best single-day three-dart score within one league (Spring/Autumn) —
  // the record resets when a new league starts.
  function leagueForWeek(start) {
    return (
      leagueForDate(start) ||
      leagueForDate(addDays(start, DAYS_PER_WEEK - 1)) ||
      currentLeague()
    );
  }

  function recordDay(lg) {
    const win = leagueWindow(lg);
    const startKey = toKey(win.start);
    const endKey = toKey(win.end);
    let best = null;
    for (const s of data.scores) {
      if (s.date < startKey || s.date > endKey) continue;
      if (!best || s.value > best.value) best = s;
    }
    if (!best) return null;
    const p = playerById(best.playerId);
    return { name: p ? p.name : "—", value: best.value, date: best.date };
  }

  function weekHighlightsHtml() {
    const last = winnerOfWeek(addDays(weekStart, -7));
    const weekLeague = leagueForWeek(weekStart);
    const rec = recordDay(weekLeague);
    const lastName = last
      ? last.names.length > 1
        ? `${last.names.slice(0, -1).join(", ")} & ${last.names[last.names.length - 1]}`
        : last.names[0]
      : null;
    const lastVal = last
      ? `${escapeHtml(lastName)} <span class="muted">· ${fmtNum(last.total)} pts</span>`
      : "No scores last week";
    const recVal = rec
      ? `${escapeHtml(rec.name)} <span class="muted">· ${fmtNum(rec.value)} (${fmtShort(parseKey(rec.date))})</span>`
      : "Not set yet";
    return `
      <div class="highlights">
        <div class="hl">
          <span class="hl__icon">🏆</span>
          <div class="hl__body">
            <div class="hl__label">Last week's winner</div>
            <div class="hl__value">${lastVal}</div>
          </div>
        </div>
        <div class="hl">
          <span class="hl__icon">🎯</span>
          <div class="hl__body">
            <div class="hl__label">Record single day · ${escapeHtml(leagueName(weekLeague))}</div>
            <div class="hl__value">${recVal}</div>
          </div>
        </div>
      </div>`;
  }

  function renderWeek() {
    const banner = weekHighlightsHtml();
    const todayKey = toKey(new Date());
    const rows = data.players
      .map((p) => ({ player: p, ...weekDataFor(p.id, weekStart) }))
      .filter((r) => r.total > 0 || Object.values(r.byDay).some((v) => v !== null))
      .sort((a, b) => b.total - a.total || a.player.name.localeCompare(b.player.name));

    if (rows.length === 0) {
      el.boardBody.innerHTML =
        banner +
        emptyState(
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
            const today = key === todayKey ? " is-today" : "";
            const val = v === null ? "–" : fmtNum(v);
            return `<span class="daychip${empty}${today}">${WEEKDAYS[idx]} <b>${val}</b></span>`;
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

    el.boardBody.innerHTML = banner + `<div class="lb">${html}</div>`;
  }

  function weekRangeLabel(weekKey) {
    const start = parseKey(weekKey);
    const end = addDays(start, DAYS_PER_WEEK - 1);
    return `${fmtShort(start)}–${fmtShort(end)}`;
  }

  function renderSeason() {
    // Stats run per league — only count scores inside the league's window.
    const win = leagueWindow(league);
    const startKey = toKey(win.start);
    const endKey = toKey(win.end);
    const inLeague = (s) => s.date >= startKey && s.date <= endKey;

    // Group every score by competition week (Mon) and by player.
    const weeks = new Map(); // weekKey -> Map(playerId -> { sum, days, maxDay })
    const agg = new Map(); // playerId -> aggregate stats

    for (const p of data.players) {
      agg.set(p.id, {
        player: p,
        total: 0,
        days: 0,
        bestDay: null, // { value, date }
        bestWeek: null, // { value, weekKey }
        weeksWon: 0,
        topDayWeeks: 0, // completed weeks holding the top single-day throw
        weeksPlayed: 0, // completed weeks participated in
        dnfs: 0, // completed weeks played but not all 5 days
      });
    }

    for (const s of data.scores) {
      if (!inLeague(s)) continue;
      const a = agg.get(s.playerId);
      if (!a) continue;
      a.total += s.value;
      a.days += 1;
      if (!a.bestDay || s.value > a.bestDay.value) {
        a.bestDay = { value: s.value, date: s.date };
      }
      const wk = toKey(startOfWeek(parseKey(s.date)));
      if (!weeks.has(wk)) weeks.set(wk, new Map());
      const wpMap = weeks.get(wk);
      if (!wpMap.has(s.playerId)) wpMap.set(s.playerId, { sum: 0, days: 0, maxDay: 0 });
      const wp = wpMap.get(s.playerId);
      wp.sum += s.value;
      wp.days += 1;
      if (s.value > wp.maxDay) wp.maxDay = s.value;
    }

    // Per-week accolades.
    for (const [wk, wpMap] of weeks) {
      // Highest-scoring week is a personal record — count any week.
      for (const [pid, wp] of wpMap) {
        const a = agg.get(pid);
        if (a && (!a.bestWeek || wp.sum > a.bestWeek.value)) {
          a.bestWeek = { value: wp.sum, weekKey: wk };
        }
      }
      // Wins / win%, top-day and DNFs only count once a week is finished.
      if (!weekIsComplete(parseKey(wk))) continue;

      const sums = [...wpMap.values()].map((w) => w.sum);
      const maxTotal = sums.length ? Math.max(...sums) : 0;
      const maxDay = Math.max(...[...wpMap.values()].map((w) => w.maxDay), 0);

      for (const [pid, wp] of wpMap) {
        const a = agg.get(pid);
        if (!a || wp.days === 0) continue;
        a.weeksPlayed += 1;
        if (wp.days < DAYS_PER_WEEK) a.dnfs += 1;
        if (maxTotal > 0 && wp.sum === maxTotal) a.weeksWon += 1;
        if (maxDay > 0 && wp.maxDay === maxDay) a.topDayWeeks += 1;
      }
    }

    const winPct = (a) => (a.weeksPlayed > 0 ? a.weeksWon / a.weeksPlayed : 0);

    const rows = [...agg.values()]
      .filter((a) => a.days > 0)
      .sort(
        (a, b) =>
          b.weeksWon - a.weeksWon ||
          winPct(b) - winPct(a) ||
          b.total - a.total ||
          a.player.name.localeCompare(b.player.name)
      );

    if (rows.length === 0) {
      el.boardBody.innerHTML = emptyState(
        `No scores in ${leagueName(league)} yet`,
        "Once scores land in this league's window, the stats show up here."
      );
      return;
    }

    // ----- Record-holder highlight cards -----
    const leaderBy = (valFn) => {
      let best = null;
      for (const a of rows) {
        const v = valFn(a);
        if (v == null) continue;
        if (!best || v > best.v) best = { a, v };
      }
      return best;
    };
    const recBestDay = leaderBy((a) => (a.bestDay ? a.bestDay.value : null));
    const recBestWeek = leaderBy((a) => (a.bestWeek ? a.bestWeek.value : null));
    const recWins = leaderBy((a) => (a.weeksWon > 0 ? a.weeksWon : null));
    const recWinPct = leaderBy((a) =>
      a.weeksPlayed > 0 && a.weeksWon > 0 ? winPct(a) : null
    );

    const card = (icon, label, name, detail) => `
      <div class="rec">
        <div class="rec__icon">${icon}</div>
        <div class="rec__label">${label}</div>
        <div class="rec__name">${name ? escapeHtml(name) : "—"}</div>
        <div class="rec__detail">${name ? detail : "Not yet"}</div>
      </div>`;

    const records = `
      <div class="records">
        ${card(
          "🎯",
          "Highest single day",
          recBestDay && recBestDay.a.player.name,
          recBestDay ? `${fmtNum(recBestDay.v)} on ${fmtShort(parseKey(recBestDay.a.bestDay.date))}` : ""
        )}
        ${card(
          "🔥",
          "Highest-scoring week",
          recBestWeek && recBestWeek.a.player.name,
          recBestWeek ? `${fmtNum(recBestWeek.v)} · ${weekRangeLabel(recBestWeek.a.bestWeek.weekKey)}` : ""
        )}
        ${card(
          "🏆",
          "Most weeks won",
          recWins && recWins.a.player.name,
          recWins ? `${recWins.v} ${recWins.v === 1 ? "week" : "weeks"}` : ""
        )}
        ${card(
          "📈",
          "Best win rate",
          recWinPct && recWinPct.a.player.name,
          recWinPct ? `${Math.round(recWinPct.v * 100)}% of weeks` : ""
        )}
      </div>`;

    // ----- Full stats table -----
    const body = rows
      .map((a, i) => {
        const bestDay = a.bestDay
          ? `${fmtNum(a.bestDay.value)} <span class="muted">(${fmtShort(parseKey(a.bestDay.date))})</span>`
          : "–";
        const bestWeek = a.bestWeek ? fmtNum(a.bestWeek.value) : "–";
        return `
          <tr>
            <td class="s-rank">${i + 1}</td>
            <td class="s-name">${escapeHtml(a.player.name)}</td>
            <td>${a.weeksWon > 0 ? `🏆 ${a.weeksWon}` : "–"}</td>
            <td>${a.weeksPlayed > 0 ? Math.round(winPct(a) * 100) + "%" : "–"}</td>
            <td>${a.topDayWeeks || "–"}</td>
            <td>${bestDay}</td>
            <td>${bestWeek}</td>
            <td>${a.dnfs || "–"}</td>
            <td class="s-total">${fmtNum(a.total)}</td>
          </tr>`;
      })
      .join("");

    el.boardBody.innerHTML = `
      ${records}
      <div class="season">
        <div class="season__cap">${escapeHtml(leagueName(league))} · ranked by weeks won · weekly accolades count finished Mon–Fri weeks only</div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>Weeks won</th>
              <th title="Share of finished weeks won">Win %</th>
              <th title="Weeks where you threw the top single-day score">Top days</th>
              <th>Best day</th>
              <th title="Your highest weekly total">High week</th>
              <th title="Finished weeks where you missed at least one day">DNFs</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
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
    const name = currentName();
    const dateKey = el.dateInput.value;
    if (!name || !dateKey) {
      el.existingHint.hidden = true;
      el.deleteBtn.hidden = true;
      el.saveBtn.textContent = "Save score";
      return;
    }
    if (!isWeekday(parseKey(dateKey))) {
      el.existingHint.hidden = false;
      el.existingHint.textContent = "Heads up: the league runs Monday–Friday, so this day won't count.";
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

  el.prevLeague.addEventListener("click", () => {
    league = prevLeague(league);
    render();
  });
  el.nextLeague.addEventListener("click", () => {
    league = nextLeague(league);
    render();
  });
  el.thisLeague.addEventListener("click", () => {
    league = currentLeague();
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
  el.nameSelect.addEventListener("change", updateExistingHint);
  el.dateInput.addEventListener("change", updateExistingHint);

  el.nameModeToggle.addEventListener("click", () => {
    nameMode = nameMode === "pick" ? "new" : "pick";
    if (nameMode === "new") el.nameInput.value = "";
    renderNamePicker();
    updateExistingHint();
    if (nameMode === "new") el.nameInput.focus();
  });

  el.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = currentName();
    const dateKey = el.dateInput.value;
    const scoreRaw = el.scoreInput.value;

    if (!name) {
      return setFormMsg(
        nameMode === "pick"
          ? "Please select your name from the list."
          : "Please type the new player's name.",
        "error"
      );
    }
    if (!dateKey) return setFormMsg("Please pick a day.", "error");
    if (!isWeekday(parseKey(dateKey))) {
      return setFormMsg("The league runs Monday–Friday — please pick a weekday.", "error");
    }
    const scoreVal = Number(scoreRaw);
    if (scoreRaw === "" || isNaN(scoreVal)) {
      return setFormMsg("Please enter a numeric score.", "error");
    }
    if (scoreVal < 0 || scoreVal > 180) {
      return setFormMsg("A three-dart score must be between 0 and 180.", "error");
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
      // A brand-new player is now registered — flip back to the dropdown
      // with them selected, so picking stays the default.
      if (nameMode === "new") {
        nameMode = "pick";
        renderNamePicker();
        const saved = data.players.find(
          (p) => p.name.toLowerCase() === name.replace(/\s+/g, " ").toLowerCase()
        );
        if (saved) el.nameSelect.value = saved.name;
      }
      // Jump the board to the week the score belongs to so it's visible
      // (season and game views stay put).
      weekStart = startOfWeek(parseKey(dateKey));
      syncTabs();
      if (view !== "game" || game === null) render();
      else renderNamePicker();
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
    const name = currentName();
    const dateKey = el.dateInput.value;
    if (!name || !dateKey) return;
    if (!confirm(`Remove ${name}'s score for ${parseKey(dateKey).toLocaleDateString()}?`)) return;

    el.deleteBtn.disabled = true;
    try {
      data = await sendScore("DELETE", { name, date: dateKey });
      lastSync = Date.now();
      if (view !== "game" || game === null) render();
      el.scoreInput.value = "";
      updateExistingHint();
      toast("Score removed");
    } catch (err) {
      toast(err.message, true);
    } finally {
      el.deleteBtn.disabled = false;
    }
  });

  // ---------- Manage players: merge & delete ----------
  el.manageList.addEventListener("change", (e) => {
    const sel = e.target.closest(".manage__target");
    if (sel) mergeTargetId = sel.value;
  });

  el.manageList.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;

    if (act === "merge-open") {
      mergeOpenId = id;
      mergeTargetId = "";
      renderManage();
      return;
    }
    if (act === "merge-cancel") {
      mergeOpenId = null;
      mergeTargetId = "";
      renderManage();
      return;
    }
    if (act === "merge-go") {
      const from = playerById(id);
      const into = playerById(mergeTargetId);
      if (!into) return toast("Pick who to merge into first.", true);
      if (
        !confirm(
          `Merge "${from.name}" into "${into.name}"?\n\nAll of ${from.name}'s scores move to ${into.name} (if both scored on the same day, the higher score is kept), then "${from.name}" is removed.`
        )
      )
        return;
      btn.disabled = true;
      try {
        data = await apiCall("/api/player/merge", "POST", {
          fromId: id,
          intoId: into.id,
        });
        mergeOpenId = null;
        mergeTargetId = "";
        if (view !== "game" || game === null) render();
        else {
          renderNamePicker();
          renderManage();
        }
        updateExistingHint();
        toast(`Merged into ${into.name} ✔`);
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
      return;
    }
    if (act === "delete") {
      const p = playerById(id);
      if (!p) return;
      const n = data.scores.filter((s) => s.playerId === id).length;
      if (
        !confirm(
          `Delete "${p.name}"${n ? ` and their ${n} score${n === 1 ? "" : "s"}` : ""}? This can't be undone.\n\nTip: if this is a misspelling of someone real, use Merge instead so the scores aren't lost.`
        )
      )
        return;
      btn.disabled = true;
      try {
        data = await apiCall("/api/player", "DELETE", { id });
        if (view !== "game" || game === null) render();
        else {
          renderNamePicker();
          renderManage();
        }
        updateExistingHint();
        toast(`Deleted ${p.name}`);
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    }
  });

  // ---------- Match mode (x01, tap-the-board scorer) ----------
  // Rules: no bust — a dart that would overshoot simply doesn't count.
  // You must finish on a double (inner bull counts) landing exactly on 0,
  // and a dart that would leave 1 doesn't count either (1 is unfinishable).
  // Darts apply strictly in the order they're thrown.

  const BOARD_NUMS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  // Ring radii — standard board proportions scaled so the double ring ends at 200.
  const R = { bull: 7.5, bull25: 18.7, tripIn: 116.5, tripOut: 125.9, dblIn: 190.6, dblOut: 200, edge: 236 };

  function polar(r, deg) {
    const a = ((deg - 90) * Math.PI) / 180;
    return [r * Math.cos(a), r * Math.sin(a)];
  }

  function ringSegPath(r0, r1, a0, a1) {
    const [x0, y0] = polar(r1, a0);
    const [x1, y1] = polar(r1, a1);
    const [x2, y2] = polar(r0, a1);
    const [x3, y3] = polar(r0, a0);
    const f = (n) => n.toFixed(2);
    return `M${f(x0)} ${f(y0)} A${r1} ${r1} 0 0 1 ${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)} A${r0} ${r0} 0 0 0 ${f(x3)} ${f(y3)} Z`;
  }

  function boardSvg() {
    let segs = "";
    for (let i = 0; i < 20; i++) {
      const n = BOARD_NUMS[i];
      const a0 = i * 18 - 9;
      const a1 = i * 18 + 9;
      const dark = i % 2 === 0; // 20 sector is dark
      const singleFill = dark ? "seg--black" : "seg--cream";
      const ringFill = dark ? "seg--red" : "seg--green";
      segs += `<path class="seg ${singleFill}" data-v="${n}" data-m="1" d="${ringSegPath(R.bull25, R.tripIn, a0, a1)}"></path>`;
      segs += `<path class="seg ${ringFill}" data-v="${n}" data-m="3" d="${ringSegPath(R.tripIn, R.tripOut, a0, a1)}"></path>`;
      segs += `<path class="seg ${singleFill}" data-v="${n}" data-m="1" d="${ringSegPath(R.tripOut, R.dblIn, a0, a1)}"></path>`;
      segs += `<path class="seg ${ringFill}" data-v="${n}" data-m="2" d="${ringSegPath(R.dblIn, R.dblOut, a0, a1)}"></path>`;
    }
    const nums = BOARD_NUMS.map((n, i) => {
      const [x, y] = polar(218, i * 18);
      return `<text class="boardnum" x="${x.toFixed(1)}" y="${y.toFixed(1)}">${n}</text>`;
    }).join("");
    return `
      <svg class="board-svg" viewBox="-250 -250 500 500" role="img" aria-label="Dartboard — tap where the dart landed">
        <circle class="seg seg--miss" data-v="0" data-m="1" r="${R.edge}"></circle>
        ${segs}
        <circle class="seg seg--green" data-v="25" data-m="1" r="${R.bull25}"></circle>
        <circle class="seg seg--red" data-v="50" data-m="2" r="${R.bull}"></circle>
        <g pointer-events="none">${nums}</g>
      </svg>`;
  }

  function dartLabel(v, m) {
    if (v === 0) return "Miss";
    if (v === 50) return "Bull";
    if (v === 25) return "25";
    return (m === 3 ? "T" : m === 2 ? "D" : "") + v;
  }

  function startGame() {
    const players = gameSetup.selected
      .map((id) => playerById(id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, name: p.name, remaining: gameSetup.start }));
    if (players.length === 0) return;
    game = {
      start: gameSetup.start,
      players,
      currentIdx: 0,
      turn: [], // this turn's darts: { label, score, voidReason, prevRemaining }
      winnerIdx: null,
    };
    renderGame();
  }

  function applyDart(v, m) {
    if (!game || game.winnerIdx !== null || game.turn.length >= 3) return;
    const p = game.players[game.currentIdx];
    const score = v === 50 ? 50 : v * m;
    const isDouble = m === 2; // includes inner bull (data-m="2")
    const r = p.remaining;
    let voidReason = null;
    if (score > r) voidReason = "Too many — that dart doesn't count";
    else if (r - score === 0 && !isDouble) voidReason = "You must finish on a double";
    else if (r - score === 1) voidReason = "Can't leave 1 — that dart doesn't count";

    if (!voidReason) p.remaining = r - score;
    game.turn.push({
      label: dartLabel(v, m),
      score: voidReason ? 0 : score,
      voidReason,
      prevRemaining: r,
    });
    if (!voidReason && p.remaining === 0) game.winnerIdx = game.currentIdx;
    if (voidReason) toast(voidReason, true);
    renderGame();
  }

  function undoDart() {
    if (!game || game.turn.length === 0) return;
    const last = game.turn.pop();
    game.players[game.currentIdx].remaining = last.prevRemaining;
    game.winnerIdx = null;
    renderGame();
  }

  function nextPlayer() {
    if (!game || game.winnerIdx !== null) return;
    game.currentIdx = (game.currentIdx + 1) % game.players.length;
    game.turn = [];
    renderGame();
  }

  function checkoutHint(remaining) {
    if (remaining > 50 || remaining < 2) return "";
    if (remaining === 50) return "Bull to finish";
    if (remaining % 2 === 0) return `D${remaining / 2} to finish`;
    return "";
  }

  function renderGameSetup() {
    const sorted = sortedPlayers();
    const startChips = GAME_STARTS.map(
      (v) =>
        `<button type="button" class="chip${v === gameSetup.start ? " is-active" : ""}" data-act="set-start" data-v="${v}">${v}</button>`
    ).join("");

    const roster =
      sorted.length === 0
        ? `<p class="game__hint">No registered players yet — add one via the score form first.</p>`
        : sorted
            .map((p) => {
              const idx = gameSetup.selected.indexOf(p.id);
              const on = idx !== -1;
              return `<button type="button" class="chip chip--player${on ? " is-active" : ""}" data-act="toggle-player" data-id="${escapeAttr(p.id)}">
                ${on ? `<span class="chip__order">${idx + 1}</span>` : ""}${escapeHtml(p.name)}
              </button>`;
            })
            .join("");

    const canStart = gameSetup.selected.length >= 1;
    el.boardBody.innerHTML = `
      <div class="game">
        <div class="game__setup">
          <h3 class="game__h">Starting score</h3>
          <div class="chips">${startChips}</div>
          <h3 class="game__h">Who's playing? <span class="muted">tap in throwing order</span></h3>
          <div class="chips">${roster}</div>
          <p class="game__hint">First to exactly 0 wins — the last dart must be a double
            (inner bull counts). No busts: a dart that would overshoot, land on 0 without
            a double, or leave 1 simply doesn't count. Nothing here touches the league stats.</p>
          <button type="button" class="btn btn--primary game__start" data-act="start-game" ${canStart ? "" : "disabled"}>
            Start match · ${gameSetup.start}
          </button>
        </div>
      </div>`;
  }

  function renderGame() {
    if (!game) return renderGameSetup();

    const cur = game.players[game.currentIdx];
    const won = game.winnerIdx !== null;

    const cards = game.players
      .map((p, i) => {
        const cls =
          (i === game.currentIdx && !won ? " is-current" : "") +
          (i === game.winnerIdx ? " is-winner" : "");
        const hint = i === game.currentIdx && !won ? checkoutHint(p.remaining) : "";
        return `
          <div class="gp${cls}">
            <div class="gp__name">${i === game.winnerIdx ? "👑 " : ""}${escapeHtml(p.name)}</div>
            <div class="gp__left">${fmtNum(p.remaining)}</div>
            ${hint ? `<div class="gp__hint">${hint}</div>` : ""}
          </div>`;
      })
      .join("");

    const slots = [0, 1, 2]
      .map((i) => {
        const d = game.turn[i];
        if (!d) return `<span class="dartslot is-empty">·</span>`;
        const voidCls = d.voidReason ? " is-void" : "";
        return `<span class="dartslot${voidCls}" title="${d.voidReason ? escapeAttr(d.voidReason) : ""}">${escapeHtml(d.label)}</span>`;
      })
      .join("");
    const turnTotal = game.turn.reduce((t, d) => t + d.score, 0);

    const banner = won
      ? `<div class="game__win">🏆 <b>${escapeHtml(game.players[game.winnerIdx].name)}</b> wins the ${game.start}!</div>`
      : `<div class="game__now">
           <span class="game__turnwho">${escapeHtml(cur.name)}</span> to throw
           <span class="game__slots">${slots}</span>
           <span class="muted">turn: ${turnTotal}</span>
         </div>`;

    const controls = won
      ? `
        <button type="button" class="btn btn--primary" data-act="rematch">Rematch</button>
        <button type="button" class="btn btn--ghostline" data-act="new-match">New match</button>
        <button type="button" class="btn btn--ghostline" data-act="undo-dart">Undo last dart</button>`
      : `
        <button type="button" class="btn btn--ghostline" data-act="miss">Missed board</button>
        <button type="button" class="btn btn--ghostline" data-act="undo-dart" ${game.turn.length ? "" : "disabled"}>Undo dart</button>
        <button type="button" class="btn btn--primary" data-act="next-player" ${game.turn.length === 3 ? "" : "disabled"}>
          Next: ${escapeHtml(game.players[(game.currentIdx + 1) % game.players.length].name)}
        </button>
        <button type="button" class="btn btn--ghostline btn--quit" data-act="quit-game">Quit</button>`;

    el.boardBody.innerHTML = `
      <div class="game">
        <div class="gplayers">${cards}</div>
        ${banner}
        <div class="game__board${won || game.turn.length === 3 ? " is-locked" : ""}">${boardSvg()}</div>
        <div class="game__controls">${controls}</div>
      </div>`;
  }

  // One delegated handler covers every game control + board tap.
  el.boardBody.addEventListener("click", (e) => {
    const seg = e.target.closest(".seg");
    if (seg && view === "game" && game) {
      applyDart(Number(seg.dataset.v), Number(seg.dataset.m));
      return;
    }
    const btn = e.target.closest("[data-act]");
    if (!btn || view !== "game") return;
    const act = btn.dataset.act;
    if (act === "set-start") {
      gameSetup.start = Number(btn.dataset.v);
      renderGameSetup();
    } else if (act === "toggle-player") {
      const id = btn.dataset.id;
      const i = gameSetup.selected.indexOf(id);
      if (i === -1) gameSetup.selected.push(id);
      else gameSetup.selected.splice(i, 1);
      renderGameSetup();
    } else if (act === "start-game") startGame();
    else if (act === "miss") applyDart(0, 1);
    else if (act === "undo-dart") undoDart();
    else if (act === "next-player") nextPlayer();
    else if (act === "rematch") {
      gameSetup.selected = game.players.map((p) => p.id);
      startGame();
    } else if (act === "new-match") {
      game = null;
      renderGameSetup();
    } else if (act === "quit-game") {
      if (confirm("Quit this match? The game isn't saved anywhere.")) {
        game = null;
        renderGameSetup();
      }
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
    league = currentLeague();
    el.dateInput.value = toKey(defaultEntryDate());
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
