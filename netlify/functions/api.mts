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

// Production keeps a single global store so the office always sees the same
// numbers across deploys. Previews / branch deploys use a deploy-scoped store
// so test data never pollutes the real leaderboard.
function store() {
  const options = { name: "darts", consistency: "strong" as const };
  return process.env.CONTEXT === "production"
    ? getStore(options)
    : getDeployStore(options);
}

async function readData(): Promise<Data> {
  const raw = (await store().get(KEY, { type: "json" })) as Partial<Data> | null;
  return {
    players: Array.isArray(raw?.players) ? raw!.players : [],
    scores: Array.isArray(raw?.scores) ? raw!.scores : [],
  };
}

async function writeData(data: Data): Promise<void> {
  await store().setJSON(KEY, data);
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

export default async (req: Request) => {
  const url = new URL(req.url);

  // ---- Read the whole leaderboard ----
  if (url.pathname === "/api/data") {
    if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
    return json(await readData());
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

    const data = await readData();
    let player = data.players.find((p) => normName(p.name) === normName(name));

    if (req.method === "DELETE") {
      if (player) {
        data.scores = data.scores.filter(
          (s) => !(s.playerId === player!.id && s.date === date)
        );
        await writeData(data);
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

    await writeData(data);
    return json(data);
  }

  return json({ error: "Not found" }, 404);
};

export const config: Config = {
  path: ["/api/data", "/api/score"],
};
