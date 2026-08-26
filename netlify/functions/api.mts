import type { Config } from "@netlify/functions";
import { getStore, getDeployStore } from "@netlify/blobs";

interface Player {
  id: string;
  name: string;
  createdAt: string;
}

interface ScoreEntry {
  playerId: string;
  date: string; // YYYY-MM-DD
  value: number;
  updatedAt: string;
}

interface Data {
  players: Player[];
  scores: ScoreEntry[];
}

const KEY = "leaderboard";

// The shape of the deploy info Netlify hands to functions at runtime.
type NetlifyCtx = { deploy?: { context?: string; id?: string } };

type Store = ReturnType<typeof getStore>;

// IMPORTANT: process.env.CONTEXT is a BUILD-time variable — it is not set
// when the function runs, so the old `CONTEXT === "production"` check was
// always false and production data silently lived in a deploy-scoped store
// that got wiped by every deploy. The deploy context must come from the
// runtime context object instead, and we default to the durable site-wide
// store unless this is positively a preview, so real data can never again
// end up somewhere ephemeral.
function deployInfo(ctx?: NetlifyCtx): { context: string; id: string } {
  const fallback = (globalThis as any).Netlify?.context?.deploy;
  return {
    context: ctx?.deploy?.context ?? fallback?.context ?? "",
    id: ctx?.deploy?.id ?? fallback?.id ?? "",
  };
}

function store(deployContext: string): Store {
  const options = { name: "darts", consistency: "strong" as const };
  return deployContext === "deploy-preview" || deployContext === "branch-deploy"
    ? getDeployStore(options)
    : getStore(options);
}

async function readData(db: Store): Promise<Data> {
  const raw = (await db.get(KEY, { type: "json" })) as Partial<Data> | null;
  return {
    players: Array.isArray(raw?.players) ? raw!.players : [],
    scores: Array.isArray(raw?.scores) ? raw!.scores : [],
  };
}

async function writeData(db: Store, data: Data): Promise<void> {
  await db.setJSON(KEY, data);
}

const cleanName = (s: unknown) =>
  typeof s === "string" ? s.trim().replace(/\s+/g, " ") : "";

const normName = (s: string) => cleanName(s).toLowerCase();

const isValidDate = (s: unknown): s is string =>
  typeof s === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !Number.isNaN(Date.parse(s));

// The league runs Monday–Friday only.
const isWeekday = (s: string): boolean => {
  const dow = new Date(`${s}T00:00:00Z`).getUTCDay();
  return dow >= 1 && dow <= 5;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export default async (req: Request, context: NetlifyCtx) => {
  const url = new URL(req.url);
  const deploy = deployInfo(context);
  const db = store(deploy.context);

  // ---- Read the whole leaderboard ----
  if (url.pathname === "/api/data") {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    // deployId lets long-open pages (the office TV) notice a new deploy
    // and reload themselves so they never run stale code.
    return json({ ...(await readData(db)), deployId: deploy.id });
  }

  // ---- One-time recovery: import data from an old deploy-scoped store ----
  // Before the storage fix above, the leaderboard lived in per-deploy
  // storage, so each deploy appeared to wipe it. The old blobs still exist
  // on the old deploys, though. Open
  //   /api/admin/import-deploy?deployId=<old deploy id>
  // (the id is in the Netlify UI under Deploys) to merge that deploy's
  // leaderboard into the durable store. Safe to run more than once.
  if (url.pathname === "/api/admin/import-deploy") {
    if (req.method !== "GET" && req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }
    const deployId = url.searchParams.get("deployId")?.trim() ?? "";
    if (!/^[0-9a-f]{24}$/i.test(deployId)) {
      return json(
        { error: "Pass ?deployId=<24-character deploy id> (find it under Deploys in the Netlify UI)." },
        400
      );
    }

    const old = getDeployStore({
      name: "darts",
      deployID: deployId,
      consistency: "strong",
    });
    const raw = (await old.get(KEY, { type: "json" })) as Partial<Data> | null;
    const oldPlayers = Array.isArray(raw?.players) ? raw!.players! : [];
    const oldScores = Array.isArray(raw?.scores) ? raw!.scores! : [];
    if (oldPlayers.length === 0 && oldScores.length === 0) {
      return json({ error: "No leaderboard data found on that deploy." }, 404);
    }

    const data = await readData(db);
    const byNorm = new Map(data.players.map((p) => [normName(p.name), p]));
    const idMap = new Map<string, string>();
    let addedPlayers = 0;
    for (const op of oldPlayers) {
      const existing = byNorm.get(normName(op.name));
      if (existing) {
        idMap.set(op.id, existing.id);
      } else {
        data.players.push(op);
        byNorm.set(normName(op.name), op);
        idMap.set(op.id, op.id);
        addedPlayers++;
      }
    }

    const scoreKey = (pid: string, date: string) => `${pid}|${date}`;
    const current = new Map(data.scores.map((s) => [scoreKey(s.playerId, s.date), s]));
    let addedScores = 0;
    let raisedScores = 0;
    for (const os of oldScores) {
      const pid = idMap.get(os.playerId);
      if (!pid) continue;
      const clash = current.get(scoreKey(pid, os.date));
      if (!clash) {
        const moved = { ...os, playerId: pid };
        data.scores.push(moved);
        current.set(scoreKey(pid, os.date), moved);
        addedScores++;
      } else if (os.value > clash.value) {
        clash.value = os.value;
        clash.updatedAt = new Date().toISOString();
        raisedScores++;
      }
    }

    await writeData(db, data);
    return json({
      ok: true,
      importedFromDeploy: deployId,
      addedPlayers,
      addedScores,
      raisedScores,
      totals: { players: data.players.length, scores: data.scores.length },
    });
  }

  // ---- Remove a player (and all of their scores) ----
  if (url.pathname === "/api/player") {
    if (req.method !== "DELETE") {
      return json({ error: "Method not allowed" }, 405);
    }

    let payload: any;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "Invalid request body." }, 400);
    }

    const id = typeof payload?.id === "string" ? payload.id : "";
    if (!id) return json({ error: "Missing player id." }, 400);

    const data = await readData(db);
    const player = data.players.find((p) => p.id === id);
    if (!player) return json({ error: "That player no longer exists." }, 404);

    data.players = data.players.filter((p) => p.id !== id);
    data.scores = data.scores.filter((s) => s.playerId !== id);
    await writeData(db, data);
    return json(data);
  }

  // ---- Merge one player into another (fixes misspelled duplicates) ----
  // Moves every score from `fromId` onto `intoId`; when both have a score on
  // the same day the higher one wins. The `from` player is then removed.
  if (url.pathname === "/api/player/merge") {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    let payload: any;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "Invalid request body." }, 400);
    }

    const fromId = typeof payload?.fromId === "string" ? payload.fromId : "";
    const intoId = typeof payload?.intoId === "string" ? payload.intoId : "";
    if (!fromId || !intoId) return json({ error: "Missing player ids." }, 400);
    if (fromId === intoId) {
      return json({ error: "Pick two different players to merge." }, 400);
    }

    const data = await readData(db);
    const from = data.players.find((p) => p.id === fromId);
    const into = data.players.find((p) => p.id === intoId);
    if (!from || !into) {
      return json({ error: "One of those players no longer exists." }, 404);
    }

    const intoByDate = new Map(
      data.scores.filter((s) => s.playerId === intoId).map((s) => [s.date, s])
    );
    const remaining: ScoreEntry[] = [];
    for (const s of data.scores) {
      if (s.playerId !== fromId) {
        remaining.push(s);
        continue;
      }
      const clash = intoByDate.get(s.date);
      if (!clash) {
        const moved = { ...s, playerId: intoId, updatedAt: new Date().toISOString() };
        intoByDate.set(s.date, moved);
        remaining.push(moved);
      } else if (s.value > clash.value) {
        clash.value = s.value;
        clash.updatedAt = new Date().toISOString();
      }
    }
    data.scores = remaining;
    data.players = data.players.filter((p) => p.id !== fromId);
    await writeData(db, data);
    return json(data);
  }

  // ---- Add/update or delete a single day's score ----
  if (url.pathname === "/api/score") {
    if (req.method !== "POST" && req.method !== "DELETE") {
      return json({ error: "Method not allowed" }, 405);
    }

    let payload: any;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "Invalid request body." }, 400);
    }

    const name = cleanName(payload?.name);
    const date = payload?.date;

    if (!name) return json({ error: "Please choose or type your name." }, 400);
    if (name.length > 40) return json({ error: "That name is too long." }, 400);
    if (!isValidDate(date)) {
      return json({ error: "Please pick a valid day." }, 400);
    }
    if (!isWeekday(date)) {
      return json(
        { error: "The league runs Monday–Friday — please pick a weekday." },
        400
      );
    }

    const data = await readData(db);
    let player = data.players.find((p) => normName(p.name) === normName(name));

    if (req.method === "DELETE") {
      if (player) {
        data.scores = data.scores.filter(
          (s) => !(s.playerId === player!.id && s.date === date)
        );
        await writeData(db, data);
      }
      return json(data);
    }

    // POST: validate the score value.
    const value = Number(payload?.value);
    if (!Number.isFinite(value) || value < 0 || value > 180) {
      return json(
        { error: "A three-dart score must be a whole number between 0 and 180." },
        400
      );
    }
    const rounded = Math.round(value);

    // Create the player on first appearance (de-duplicated by normalized name).
    if (!player) {
      player = {
        id: crypto.randomUUID(),
        name,
        createdAt: new Date().toISOString(),
      };
      data.players.push(player);
    }

    const existing = data.scores.find(
      (s) => s.playerId === player!.id && s.date === date
    );
    if (existing) {
      existing.value = rounded;
      existing.updatedAt = new Date().toISOString();
    } else {
      data.scores.push({
        playerId: player.id,
        date,
        value: rounded,
        updatedAt: new Date().toISOString(),
      });
    }

    await writeData(db, data);
    return json(data);
  }

  return json({ error: "Not found" }, 404);
};

export const config: Config = {
  path: [
    "/api/data",
    "/api/score",
    "/api/player",
    "/api/player/merge",
    "/api/admin/import-deploy",
  ],
};
