import express from "express";
import cors from "cors";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// ── Paths ─────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "data");
const AUTH_DB_PATH = resolve(DATA_DIR, "auth-db.json");
const PROJECTS_DB_PATH = resolve(DATA_DIR, "projects-db.json");

// ── Types ──────────────────────────────────────────────────────────────────────
/* Account roles mirroring frontend */
const ROLES = ["Редактор", "Администратор", "Владелец", "Создатель"];

const COLORS = [
  "#1271e0", "#34a853", "#9c27b0", "#e91e63", "#ff6f00",
  "#f59e0b", "#0f766e", "#7c3aed", "#2563eb", "#d946ef",
];

function makeInitials(name) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("")
    .slice(0, 2) || "U";
}

// ── Helpers ────────────────────────────────────────────────────────────────────
let presenceRecords = new Map(); // accountId -> { lastSeen, name, initials, ... }
let presenceEvents = [];
let nextPresenceEventId = 1;
const PRESENCE_TTL_MS = 25000;
const PRESENCE_MAX_EVENTS = 40;

async function ensureAuthDb() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(AUTH_DB_PATH)) {
    await writeFile(AUTH_DB_PATH, JSON.stringify([], null, 2), "utf8");
    return [];
  }
  try {
    const text = await readFile(AUTH_DB_PATH, "utf8");
    return JSON.parse(text);
  } catch {
    return [];
  }
}

async function saveAuthDb(accounts) {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(AUTH_DB_PATH, JSON.stringify(accounts, null, 2), "utf8");
}

async function loadProjectsDb() {
  if (!existsSync(PROJECTS_DB_PATH)) return [];
  try {
    const text = await readFile(PROJECTS_DB_PATH, "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveProjectsDb(projects) {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(PROJECTS_DB_PATH, JSON.stringify(projects, null, 2), "utf8");
}

async function getProjectsForAccount(accountId) {
  const entries = await loadProjectsDb();
  const entry = entries.find((item) => item.accountId === accountId);
  return entry?.projects || [];
}

async function saveProjectsForAccount(accountId, projects) {
  const entries = await loadProjectsDb();
  const index = entries.findIndex((item) => item.accountId === accountId);
  const nextEntry = { accountId, projects };
  if (index === -1) entries.push(nextEntry);
  else entries[index] = nextEntry;
  await saveProjectsDb(entries);
  return nextEntry;
}

function toPublicAccount(account) {
  const { password, ...publicAccount } = account;
  return publicAccount;
}

function prunePresence(now = Date.now()) {
  for (const [accountId, record] of presenceRecords) {
    if (now - record.lastSeen > PRESENCE_TTL_MS) {
      presenceRecords.delete(accountId);
    }
  }
}

// ── Express app ────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

// CORS: разрешаем запросы с вашего домена
app.use(cors({
  origin: [
    "https://vipgant.ru",
    "http://localhost:5173",
    "http://localhost:4173",
  ],
  credentials: true,
}));

app.use(express.json({ limit: "10mb" }));

// ──────────────────────────────────────────────────────────────────────────────
// AUTH ENDPOINTS
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/auth/accounts — список пользователей
app.get("/api/auth/accounts", async (_req, res) => {
  try {
    const accounts = await ensureAuthDb();
    res.json({ accounts: accounts.map(toPublicAccount) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/register — регистрация
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, clientId, themeColor, photoUrl } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Укажите имя, email и пароль." });
    }

    const accounts = await ensureAuthDb();
    const normalizedEmail = email.trim().toLowerCase();

    if (accounts.some((a) => a.email.toLowerCase() === normalizedEmail)) {
      return res.status(409).json({ error: "Пользователь с таким email уже существует." });
    }

    const newAccount = {
      id: randomUUID(),
      name: name.trim(),
      email: normalizedEmail,
      password: password, // В реальном проекте используйте bcrypt!
      initials: makeInitials(name),
      color: COLORS[accounts.length % COLORS.length],
      themeColor: themeColor || COLORS[accounts.length % COLORS.length],
      photoUrl: photoUrl || "",
      role: "Редактор",
      createdAt: Date.now(),
    };

    accounts.push(newAccount);
    await saveAuthDb(accounts);

    // При регистрации отмечаем присутствие
    presenceRecords.set(newAccount.id, {
      ...newAccount,
      lastSeen: Date.now(),
    });

    res.status(201).json({ account: toPublicAccount(newAccount) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login — вход
app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password, clientId } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Укажите email и пароль." });
    }

    const accounts = await ensureAuthDb();
    const normalizedEmail = email.trim().toLowerCase();
    const account = accounts.find(
      (a) => a.email.toLowerCase() === normalizedEmail && a.password === password
    );

    if (!account) {
      return res.status(401).json({ error: "Неверный email или пароль." });
    }

    // Обновляем lastLogin
    account.lastLoginClientId = clientId || "";
    await saveAuthDb(accounts);

    // Отмечаем присутствие
    presenceRecords.set(account.id, {
      ...account,
      lastSeen: Date.now(),
    });

    res.json({ account: toPublicAccount(account) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/profile — обновление профиля
app.post("/api/auth/profile", async (req, res) => {
  try {
    const { id, name, themeColor, photoUrl, birthYear, birthDate, phone, city, about } = req.body;
    if (!id || !name) {
      return res.status(400).json({ error: "Передайте id и имя." });
    }

    const accounts = await ensureAuthDb();
    const index = accounts.findIndex((a) => a.id === id);
    if (index === -1) {
      return res.status(404).json({ error: "Пользователь не найден." });
    }

    accounts[index] = {
      ...accounts[index],
      name: name.trim(),
      initials: makeInitials(name),
      color: themeColor || accounts[index].color,
      themeColor: themeColor || accounts[index].themeColor || accounts[index].color,
      photoUrl: photoUrl || accounts[index].photoUrl || "",
      birthYear: birthYear != null ? birthYear : accounts[index].birthYear,
      birthDate: birthDate || accounts[index].birthDate || "",
      phone: phone || accounts[index].phone || "",
      city: city || accounts[index].city || "",
      about: about || accounts[index].about || "",
    };

    await saveAuthDb(accounts);
    res.json({ account: toPublicAccount(accounts[index]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/role — изменение роли
app.post("/api/auth/role", async (req, res) => {
  try {
    const { actorId, targetId, role } = req.body;
    if (!actorId || !targetId || !role) {
      return res.status(400).json({ error: "Передайте actorId, targetId и role." });
    }

    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: "Недопустимая роль." });
    }

    const accounts = await ensureAuthDb();
    const actor = accounts.find((a) => a.id === actorId);
    const targetIndex = accounts.findIndex((a) => a.id === targetId);

    if (!actor || targetIndex === -1) {
      return res.status(404).json({ error: "Пользователь не найден." });
    }

    if (!["Владелец", "Создатель"].includes(actor.role)) {
      return res.status(403).json({ error: "Только владелец или создатель может назначать роли." });
    }

    accounts[targetIndex].role = role;
    await saveAuthDb(accounts);

    res.json({ account: toPublicAccount(accounts[targetIndex]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PRESENCE ENDPOINTS
// ──────────────────────────────────────────────────────────────────────────────

// POST /api/auth/presence — обновление присутствия
app.post("/api/auth/presence", (req, res) => {
  try {
    const { accountId, clientId, action } = req.body;
    if (!accountId || !clientId) {
      return res.status(400).json({ error: "Передайте accountId и clientId." });
    }

    if (action === "offline") {
      presenceRecords.delete(accountId);
      return res.json({ ok: true });
    }

    const accountsPromise = ensureAuthDb();
    accountsPromise.then((accounts) => {
      const account = accounts.find((a) => a.id === accountId);
      if (!account) {
        return res.status(404).json({ error: "Пользователь не найден." });
      }

      const wasOnline = presenceRecords.has(accountId);
      
      presenceRecords.set(accountId, {
        ...toPublicAccount(account),
        lastSeen: Date.now(),
      });

      prunePresence();

      // Если это новое подключение — создаём событие
      if (!wasOnline) {
        presenceEvents.push({
          id: nextPresenceEventId++,
          type: "join",
          accountId: account.id,
          name: account.name,
          initials: account.initials,
          color: account.themeColor || account.color,
          role: account.role,
          message: `${account.name} присоединился к сервису`,
          createdAt: Date.now(),
        });
        if (presenceEvents.length > PRESENCE_MAX_EVENTS) {
          presenceEvents.splice(0, presenceEvents.length - PRESENCE_MAX_EVENTS);
        }
      }

      const record = presenceRecords.get(accountId);
      res.json({
        ok: true,
        online: true,
        account: {
          ...toPublicAccount(account),
          onlineAt: record.lastSeen,
        },
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/presence?since=... — получение статусов и событий
app.get("/api/auth/presence", async (req, res) => {
  try {
    prunePresence();
    const since = Number(req.query.since) || 0;
    const accounts = await ensureAuthDb();

    const onlineAccounts = accounts
      .filter((account) => presenceRecords.has(account.id))
      .map((account) => {
        const record = presenceRecords.get(account.id);
        return {
          ...toPublicAccount(account),
          onlineAt: record.lastSeen,
        };
      });

    res.json({
      serverTime: Date.now(),
      onlineAccounts,
      events: presenceEvents.filter((event) => event.id > since),
      latestEventId: presenceEvents.at(-1)?.id || since,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PROJECTS ENDPOINTS
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/projects — получение проектов аккаунта
app.get("/api/projects", async (req, res) => {
  try {
    const accountId = String(req.query.accountId || "").trim();
    if (!accountId) {
      return res.json({ projects: [] });
    }
    const projects = await getProjectsForAccount(accountId);
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects — сохранение проектов аккаунта
app.post("/api/projects", async (req, res) => {
  try {
    const { accountId, projects } = req.body;
    if (!accountId || !Array.isArray(projects)) {
      return res.status(400).json({ error: "Ожидаются accountId и массив projects." });
    }
    await saveProjectsForAccount(accountId, projects);
    res.json({ ok: true, count: projects.length, accountId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// START
// ──────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ VIP Gantt API server running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/`);
});

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});
