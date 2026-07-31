import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import logger from "./logger.js";

// ── Paths ─────────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const DATA_DIR = resolve(__dirname, "data");
const AUTH_DB_PATH = resolve(DATA_DIR, "auth-db.json");
const PROJECTS_DB_PATH = resolve(DATA_DIR, "projects-db.json");
const PROJECTS_BACKUP_PATH = resolve(DATA_DIR, "projects-db.backup.json");

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

function stripBom(text) {
  return typeof text === "string" && text.charAt(0) === "\uFEFF" ? text.slice(1) : text;
}

async function hashPassword(password) {
  return bcrypt.hash(String(password || ""), 10);
}

async function verifyPassword(password, passwordHash) {
  if (!passwordHash) return String(password || "") === "" ? false : false;
  if (typeof passwordHash === "string" && passwordHash.startsWith("$2")) {
    return bcrypt.compare(String(password || ""), passwordHash);
  }
  return String(password || "") === String(passwordHash || "");
}

async function normalizeAuthAccounts(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const next = [];
  for (const account of list) {
    if (!account || typeof account !== "object") continue;
    const normalized = { ...account };
    if (!normalized.passwordHash && normalized.password) {
      normalized.passwordHash = await hashPassword(normalized.password);
    }
    delete normalized.password;
    next.push(normalized);
  }
  return next;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
let presenceRecords = new Map(); // accountId -> { lastSeen, name, initials, ... }
let presenceEvents = [];
let nextPresenceEventId = 1;
const PRESENCE_TTL_MS = 25000;
const PRESENCE_MAX_EVENTS = 40;
const DEFAULT_BOOT_ACCOUNTS = [
  { id: "admin", name: "Администратор", email: "admin", password: "admin", initials: "AD", color: "#007bff", themeColor: "#007bff", photoUrl: "", role: "Администратор", createdAt: Date.now() },
  { id: "midan", name: "Гость", email: "midan", password: "midan", initials: "GV", color: "#34a853", themeColor: "#34a853", photoUrl: "", role: "Гость", createdAt: Date.now() },
];

function mergeSeedAccounts(accounts) {
  const seen = new Map();
  const merged = Array.isArray(accounts) ? accounts : [];
  for (const entry of merged) {
    if (entry?.id) seen.set(entry.id, entry);
  }
  for (const seed of DEFAULT_BOOT_ACCOUNTS) {
    if (!seen.has(seed.id)) {
      merged.push(seed);
      seen.set(seed.id, seed);
    }
  }
  return merged;
}

async function ensureAuthDb() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(AUTH_DB_PATH)) {
    const seeded = mergeSeedAccounts([]);
    const normalized = await normalizeAuthAccounts(seeded);
    await writeFile(AUTH_DB_PATH, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  }
  try {
    const text = await readFile(AUTH_DB_PATH, "utf8");
    const parsed = JSON.parse(text);
    const merged = mergeSeedAccounts(parsed);
    const normalized = await normalizeAuthAccounts(merged);
    if (JSON.stringify(normalized) !== JSON.stringify(parsed)) {
      await saveAuthDb(normalized);
    }
    return normalized;
  } catch {
    const seeded = mergeSeedAccounts([]);
    const normalized = await normalizeAuthAccounts(seeded);
    await writeFile(AUTH_DB_PATH, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  }
}

async function saveAuthDb(accounts) {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(AUTH_DB_PATH, JSON.stringify(accounts, null, 2), "utf8");
}

function safeProjectId(rawId) {
  const normalized = String(rawId || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "proj";
}

function makeUniqueProjectId(baseId, existingIds) {
  let id = baseId;
  let suffix = 1;
  while (existingIds.has(id)) {
    id = `${baseId}-${suffix++}`;
  }
  existingIds.add(id);
  return id;
}

const CYRILLIC_TRANSLITERATION = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  А: "A", Б: "B", В: "V", Г: "G", Д: "D", Е: "E", Ё: "Yo", Ж: "Zh", З: "Z", И: "I", Й: "Y", К: "K", Л: "L", М: "M", Н: "N", О: "O", П: "P", Р: "R", С: "S", Т: "T", У: "U", Ф: "F", Х: "H", Ц: "Ts", Ч: "Ch", Ш: "Sh", Щ: "Shch", Ы: "Y", Э: "E", Ю: "Yu", Я: "Ya",
};

function transliterate(name) {
  return String(name || "")
    .split("")
    .map((char) => CYRILLIC_TRANSLITERATION[char] ?? char)
    .join("");
}

function makeProjectId(name, existingIds) {
  const normalized = transliterate(name)
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/^-+|-+$/g, "") || "proj";
  return makeUniqueProjectId(`proj-${normalized}`, existingIds);
}

function normalizeProjectList(projects, existingIds = new Set()) {
  const seenNames = new Set();
  const normalized = [];

  for (const project of Array.isArray(projects) ? projects : []) {
    const name = String(project?.name || "").trim().normalize("NFC");
    if (!name) continue;

    const nameKey = name.toLowerCase().replace(/\s+/g, " ");
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);

    const rawId = typeof project.id === "string" ? project.id.trim().normalize("NFC") : "";
    let id = rawId ? safeProjectId(rawId) : "";
    if (!id) {
      id = makeProjectId(name, existingIds);
    } else if (existingIds.has(id)) {
      id = makeUniqueProjectId(id, existingIds);
    } else {
      existingIds.add(id);
    }

    normalized.push({ ...project, id, name });
  }

  return normalized;
}

function mergeProjectLists(existingProjects, importedProjects) {
  const usedIds = new Set();
  const merged = normalizeProjectList(existingProjects, usedIds);
  const existingNames = new Set(merged.map((p) => String(p.name || "").trim().toLowerCase().replace(/\s+/g, " ")));

  for (const project of normalizeProjectList(importedProjects, usedIds)) {
    const projectNameKey = String(project.name || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!existingNames.has(projectNameKey)) {
      merged.push(project);
      existingNames.add(projectNameKey);
    }
  }

  return merged;
}

async function loadProjectsDb() {
  const readFromFile = async (filePath) => {
    if (!existsSync(filePath)) return null;
    try {
      const text = await readFile(filePath, "utf8");
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const primary = await readFromFile(PROJECTS_DB_PATH);
  if (primary !== null) {
    const normalized = primary.map((entry) => ({
      ...entry,
      projects: normalizeProjectList(entry.projects || []),
    }));
    await saveProjectsDb(normalized);
    return normalized;
  }

  const backup = await readFromFile(PROJECTS_BACKUP_PATH);
  if (backup !== null) {
    const normalized = backup.map((entry) => ({
      ...entry,
      projects: normalizeProjectList(entry.projects || []),
    }));
    await writeFile(PROJECTS_DB_PATH, JSON.stringify(normalized, null, 2), "utf8");
    await writeFile(PROJECTS_BACKUP_PATH, JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  }

  return [];
}

async function saveProjectsDb(projects) {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  const serialized = JSON.stringify(projects, null, 2);
  await writeFile(PROJECTS_DB_PATH, serialized, "utf8");
  await writeFile(PROJECTS_BACKUP_PATH, serialized, "utf8");
}

async function loadProjectsFromDataFiles() {
  const files = [];
  try {
    const entries = await readdir(resolve(PROJECT_ROOT, "data"), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        files.push(entry.name);
      }
    }
  } catch {
    return [];
  }

  const projects = [];
  const existingIds = new Set();

  for (const file of files) {
    const path = resolve(PROJECT_ROOT, "data", file);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(stripBom(raw));
      const projectRoot = parsed.Project || parsed["?xml"]?.Project;
      const name = file.replace(/\.json$/i, "").replace(/_/g, " ").trim();
      if (!projectRoot || typeof projectRoot !== "object") continue;
      const tasksRaw = projectRoot.Tasks?.Task;
      if (!Array.isArray(tasksRaw) && typeof tasksRaw !== "object") continue;
      const tasksArray = Array.isArray(tasksRaw) ? tasksRaw : [tasksRaw];
      const convertedTasks = tasksArray
        .filter((task) => task && typeof task === "object")
        .map((task, index) => {
          const start = task.Start ? task.Start.split("T")[0] : null;
          const end = task.Finish ? task.Finish.split("T")[0] : start;
          const percent = Number(task.PercentComplete ?? task.PercentDone ?? 0);
          const progress = Math.max(0, Math.min(1, percent / 100));
          const status = progress >= 1 ? "completed" : progress > 0 ? "on_track" : "not_started";
          return {
            id: index + 1,
            parentId: undefined,
            type: task.Milestone === "1" || task.Milestone === 1 ? "milestone" : task.Summary === "1" || task.Summary === 1 ? "group" : "task",
            name: String(task.Name || task.Title || "Без названия").trim(),
            assignees: [],
            resourceIds: [],
            priority: "medium",
            budget: 0,
            comments: "",
            attachments: [],
            start: start || "1970-01-01",
            end: end || "1970-01-01",
            progress,
            status,
            barColor: status === "completed" ? "#34a853" : status === "on_track" ? "#1271e0" : "#8b9ab0",
            indent: 0,
          };
        });
      if (convertedTasks.length > 0) {
        projects.push({
          id: makeProjectId(name, existingIds),
          name,
          scale: "week",
          visualScale: 1,
          tasks: convertedTasks,
          dependencies: [],
          resources: [],
          templates: [],
          archived: false,
        });
      }
    } catch {
      continue;
    }
  }

  return projects;
}

async function getProjectsForAccount(accountId) {
  const entries = await loadProjectsDb();
  const normalizedAccountId = String(accountId || "").trim();
  const importedProjects = await loadProjectsFromDataFiles();

  const allProjectRecords = [];
  for (const entry of entries) {
    for (const project of Array.isArray(entry.projects) ? entry.projects : []) {
      const ownerId = String(project.ownerId || entry.accountId || "").trim();
      const withMembers = {
        ...project,
        ownerId,
        members: normalizeProjectMembers(project.members, ownerId),
      };
      allProjectRecords.push(withMembers);
    }
  }

  const visibleProjects = allProjectRecords.filter((project) => {
    const ownerId = String(project.ownerId || "").trim();
    const members = Array.isArray(project.members) ? project.members : [];
    return ownerId === normalizedAccountId || members.some((member) => member.id === normalizedAccountId);
  });

  const decorateProject = (project) => {
    const ownerId = String(project.ownerId || "").trim();
    const members = normalizeProjectMembers(project.members, ownerId);
    const memberRecord = members.find((member) => member.id === normalizedAccountId);
    const isOwner = ownerId === normalizedAccountId;

    return {
      ...project,
      ownerId,
      members,
      isOwner,
      role: isOwner ? "Владелец" : memberRecord?.role || "Редактор",
    };
  };

  if (visibleProjects.length > 0) {
    const canonical = normalizeProjectList(visibleProjects);
    if (importedProjects.length > 0) {
      const merged = mergeProjectLists(canonical, importedProjects);
      await saveProjectsForAccount(normalizedAccountId, merged);
      return normalizeProjectList(merged.map((project) => decorateProject({
        ...project,
        ownerId: project.ownerId || normalizedAccountId,
        members: normalizeProjectMembers(project.members, project.ownerId || normalizedAccountId),
      })));
    }
    return normalizeProjectList(canonical.map((project) => decorateProject({
      ...project,
      ownerId: project.ownerId || normalizedAccountId,
      members: normalizeProjectMembers(project.members, project.ownerId || normalizedAccountId),
    })));
  }

  if (importedProjects.length > 0) {
    const seeded = importedProjects.map((project) => ({
      ...project,
      ownerId: normalizedAccountId,
      members: normalizeProjectMembers(project.members, normalizedAccountId),
    }));
    await saveProjectsForAccount(normalizedAccountId, seeded);
    return normalizeProjectList(seeded.map((project) => decorateProject(project)));
  }

  return [];
}

async function saveProjectsForAccount(accountId, projects) {
  const entries = await loadProjectsDb();
  const index = entries.findIndex((item) => item.accountId === accountId);
  const existingEntry = index >= 0 ? entries[index] : null;
  const existingProjects = Array.isArray(existingEntry?.projects) ? existingEntry.projects : [];
  const nextProjects = Array.isArray(projects) && projects.length > 0
    ? projects.map((project) => ({
        ...project,
        ownerId: String(project.ownerId || accountId || "").trim() || accountId,
        members: normalizeProjectMembers(project.members, project.ownerId || accountId),
      }))
    : existingProjects;

  const nextEntry = { accountId, projects: nextProjects };
  if (index === -1) entries.push(nextEntry);
  else entries[index] = nextEntry;
  await saveProjectsDb(entries);
  return nextEntry;
}

function normalizeProjectMembers(projectMembers = [], fallbackOwnerId = "") {
  const seen = new Set();
  const normalized = [];
  const ownerId = String(fallbackOwnerId || "").trim();

  if (ownerId) {
    normalized.push({ id: ownerId, role: "Владелец", name: "", email: "" });
    seen.add(ownerId);
  }

  for (const member of Array.isArray(projectMembers) ? projectMembers : []) {
    const id = String(member?.id || "").trim();
    const role = String(member?.role || "Редактор").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      id,
      role: ROLES.includes(role) ? role : "Редактор",
      name: String(member?.name || "").trim(),
      email: String(member?.email || "").trim(),
      joinedAt: typeof member?.joinedAt === "number" ? member.joinedAt : Date.now(),
    });
  }

  return normalized;
}

function toPublicAccount(account) {
  const { password, passwordHash, ...publicAccount } = account;
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

// CORS: разрешаем запросы с домена и localhost
app.use(cors({
  origin: [
    "https://vipgant.ru",
    "http://localhost:5173",
    "http://localhost:4173",
    "http://localhost:3000",
    "https://vipgant-backend-production.up.railway.app",
  ],
  credentials: true,
}));

app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  if (req.method === "GET" && (req.path === "/" || req.path.startsWith("/assets/") || req.path.endsWith(".html") || req.path.endsWith(".js") || req.path.endsWith(".css"))) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }
  next();
});

// Serve built frontend from the same server in production-style deployment
const distCandidates = [join(PROJECT_ROOT, "dist"), join(PROJECT_ROOT, "server", "dist")];
let distDir = null;
for (const candidate of distCandidates) {
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    distDir = candidate;
    break;
  }
}
if (distDir) {
  logger.info(`🔸 Serving static from ${distDir}`);
  app.use(express.static(distDir));
}

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
    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (accounts.some((a) => String(a.email || "").toLowerCase() === normalizedEmail)) {
      return res.status(409).json({ error: "Пользователь с таким email уже существует." });
    }

    const passwordHash = await hashPassword(password);
    const newAccount = {
      id: randomUUID(),
      name: String(name || "").trim(),
      email: normalizedEmail,
      passwordHash,
      initials: makeInitials(name),
      color: COLORS[accounts.length % COLORS.length],
      themeColor: themeColor || COLORS[accounts.length % COLORS.length],
      photoUrl: photoUrl || "",
      role: "Редактор",
      createdAt: Date.now(),
      lastLoginClientId: clientId || "",
    };

    accounts.push(newAccount);
    await saveAuthDb(accounts);

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
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const account = accounts.find((a) => String(a.email || "").toLowerCase() === normalizedEmail);

    if (!account) {
      return res.status(401).json({ error: "Неверный email или пароль." });
    }

    const passwordMatches = await verifyPassword(password, account.passwordHash || account.password);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Неверный email или пароль." });
    }

    account.lastLoginClientId = clientId || "";
    await saveAuthDb(accounts);

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

    const nextThemeColor = themeColor !== undefined ? themeColor : (accounts[index].themeColor || accounts[index].color);
    const nextPhotoUrl = photoUrl !== undefined ? photoUrl : (accounts[index].photoUrl || "");
    accounts[index] = {
      ...accounts[index],
      name: name.trim(),
      initials: makeInitials(name),
      color: nextThemeColor,
      themeColor: nextThemeColor,
      photoUrl: nextPhotoUrl,
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

    if (!["Владелец", "Создатель", "Администратор"].includes(actor.role)) {
      return res.status(403).json({ error: "Только владелец, создатель или администратор может назначать роли." });
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

// GET /api/projects/:projectId/members — список участников проекта
app.get("/api/projects/:projectId/members", async (req, res) => {
  try {
    const { projectId } = req.params;
    const entries = await loadProjectsDb();
    const project = entries.flatMap((entry) => Array.isArray(entry.projects) ? entry.projects : []).find((item) => item.id === projectId);
    if (!project) {
      return res.status(404).json({ error: "Проект не найден." });
    }

    const ownerId = String(project.ownerId || "").trim();
    const members = normalizeProjectMembers(project.members, ownerId);
    const accounts = await ensureAuthDb();
    const membersWithProfiles = members.map((member) => {
      const account = accounts.find((item) => item.id === member.id);
      return {
        ...member,
        name: member.name || account?.name || member.id,
        email: member.email || account?.email || "",
      };
    });

    res.json({ members: membersWithProfiles, ownerId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/invite — приглашение участника по email
app.post("/api/projects/:projectId/invite", async (req, res) => {
  try {
    const { projectId } = req.params;
    const { actorId, email, role = "Редактор" } = req.body;
    if (!actorId || !email || !role) {
      return res.status(400).json({ error: "Ожидаются actorId, email и role." });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: "Недопустимая роль участника." });
    }

    const accounts = await ensureAuthDb();
    const actor = accounts.find((account) => account.id === actorId);
    if (!actor) {
      return res.status(404).json({ error: "Инициатор не найден." });
    }

    const target = accounts.find((account) => String(account.email || "").toLowerCase() === String(email || "").trim().toLowerCase());
    if (!target) {
      return res.status(404).json({ error: "Пользователь с таким email не найден." });
    }

    const entries = await loadProjectsDb();
    let updatedProject = null;
    let isAllowed = false;

    for (const entry of entries) {
      const nextProjects = (Array.isArray(entry.projects) ? entry.projects : []).map((project) => {
        if (project.id !== projectId) return project;

        const ownerId = String(project.ownerId || entry.accountId || "").trim();
        const members = normalizeProjectMembers(project.members, ownerId);
        const actorIsOwner = ownerId === actorId;
        const actorIsAdmin = members.some((member) => member.id === actorId && ["Владелец", "Создатель", "Администратор"].includes(member.role));
        if (!actorIsOwner && !actorIsAdmin) {
          isAllowed = false;
          return project;
        }

        isAllowed = true;
        const foundMemberIndex = members.findIndex((member) => member.id === target.id);
        if (foundMemberIndex >= 0) {
          members[foundMemberIndex] = { ...members[foundMemberIndex], role, name: target.name, email: target.email };
        } else {
          members.push({ id: target.id, role, name: target.name, email: target.email, joinedAt: Date.now() });
        }

        updatedProject = { ...project, ownerId, members };
        return { ...project, ownerId, members };
      });

      entry.projects = nextProjects;
    }

    if (!isAllowed) {
      return res.status(403).json({ error: "Только владелец или администратор проекта может приглашать участников." });
    }

    await saveProjectsDb(entries);
    res.json({ ok: true, project: updatedProject });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:projectId/members/:userId — удалить участника проекта
app.delete("/api/projects/:projectId/members/:userId", async (req, res) => {
  try {
    const { projectId, userId } = req.params;
    const { actorId } = req.body || {};
    if (!actorId) {
      return res.status(400).json({ error: "Ожидается actorId." });
    }

    const accounts = await ensureAuthDb();
    const actor = accounts.find((account) => account.id === actorId);
    if (!actor) {
      return res.status(404).json({ error: "Инициатор не найден." });
    }

    const entries = await loadProjectsDb();
    let updatedProject = null;
    let allowed = false;

    for (const entry of entries) {
      const nextProjects = (Array.isArray(entry.projects) ? entry.projects : []).map((project) => {
        if (project.id !== projectId) return project;
        const ownerId = String(project.ownerId || entry.accountId || "").trim();
        const members = normalizeProjectMembers(project.members, ownerId);
        const actorIsOwner = ownerId === actorId;
        const actorIsAdmin = members.some((member) => member.id === actorId && ["Владелец", "Создатель", "Администратор"].includes(member.role));
        if (!actorIsOwner && !actorIsAdmin) {
          return project;
        }

        allowed = true;
        const nextMembers = members.filter((member) => member.id !== userId);
        updatedProject = { ...project, ownerId, members: nextMembers };
        return { ...project, ownerId, members: nextMembers };
      });

      entry.projects = nextProjects;
    }

    if (!allowed) {
      return res.status(403).json({ error: "Только владелец или администратор проекта может удалять участников." });
    }

    await saveProjectsDb(entries);
    res.json({ ok: true, project: updatedProject });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/members — управление участниками проекта
app.post("/api/projects/members", async (req, res) => {
  try {
    const { actorId, projectId, targetId, role, action = "add" } = req.body;
    if (!actorId || !projectId || !targetId || !action) {
      return res.status(400).json({ error: "Ожидаются actorId, projectId, targetId и action." });
    }

    if (!ROLES.includes(role || "Редактор")) {
      return res.status(400).json({ error: "Недопустимая роль участника." });
    }

    const accounts = await ensureAuthDb();
    const actor = accounts.find((account) => account.id === actorId);
    const target = accounts.find((account) => account.id === targetId);
    if (!actor || !target) {
      return res.status(404).json({ error: "Участник или инициатор не найден." });
    }

    const entries = await loadProjectsDb();
    let updatedProject = null;
    let allowed = false;

    for (const entry of entries) {
      const nextProjects = (Array.isArray(entry.projects) ? entry.projects : []).map((project) => {
        if (project.id !== projectId) return project;

        const ownerId = String(project.ownerId || entry.accountId || "").trim();
        const members = normalizeProjectMembers(project.members, ownerId);
        const actorIsOwner = ownerId === actorId;
        const actorProjectMember = members.find((member) => member.id === actorId);
        const actorIsAdmin = ["Владелец", "Создатель", "Администратор"].includes(actorProjectMember?.role || "");

        if (!actorIsOwner && !actorIsAdmin) {
          return project;
        }

        allowed = true;
        const foundMemberIndex = members.findIndex((member) => member.id === targetId);

        if (action === "remove") {
          const nextMembers = members.filter((member) => member.id !== targetId);
          updatedProject = { ...project, ownerId, members: nextMembers };
          return { ...project, ownerId, members: nextMembers };
        }

        if (action === "role") {
          if (foundMemberIndex === -1) {
            return project;
          }
          const nextMembers = members.map((member) => member.id === targetId ? { ...member, role } : member);
          updatedProject = { ...project, ownerId, members: nextMembers };
          return { ...project, ownerId, members: nextMembers };
        }

        if (foundMemberIndex >= 0) {
          members[foundMemberIndex] = { ...members[foundMemberIndex], role, name: target.name, email: target.email };
          updatedProject = { ...project, ownerId, members };
          return { ...project, ownerId, members };
        }

        members.push({
          id: target.id,
          role,
          name: target.name,
          email: target.email,
          joinedAt: Date.now(),
        });

        updatedProject = { ...project, ownerId, members };
        return { ...project, ownerId, members };
      });

      entry.projects = nextProjects;
    }

    if (!allowed) {
      return res.status(403).json({ error: "Только владелец или администратор проекта может управлять участниками." });
    }

    await saveProjectsDb(entries);
    res.json({ ok: true, project: updatedProject });
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
const server = app.listen(PORT, () => {
  logger.info(`✅ VIP Gantt API server running on port ${PORT}`);
  logger.info(`   Health check: http://localhost:${PORT}/`);
});

server.on("error", (err) => {
  if (err && typeof err === "object" && "code" in err && err.code === "EADDRINUSE") {
    logger.warn(`⚠️ Port ${PORT} is already in use. Another server instance is already running.`);
    process.exit(0);
  }
  logger.error(typeof err === "object" && err ? JSON.stringify(err) : String(err));
  process.exit(1);
});

// Health check
app.get("/", (_req, res) => {
  if (distDir) {
    res.sendFile(resolve(distDir, "index.html"));
    return;
  }
  res.json({ status: "ok", uptime: process.uptime() });
});

// POST /api/logs/client — клиент может отправлять ошибки/логи сюда
app.post("/api/logs/client", (req, res) => {
  try {
    const { level = "error", message = "client-log", extra } = req.body || {};
    const text = typeof message === "string" ? message : JSON.stringify(message);
    const extraText = extra ? ` | extra: ${JSON.stringify(extra)}` : "";
    logger.log({ level: level === "warn" ? "warn" : level === "info" ? "info" : "error", message: text + extraText });
    res.json({ ok: true });
  } catch (err) {
    logger.error("Failed to write client log: " + (err && err.message ? err.message : String(err)));
    res.status(500).json({ error: "failed" });
  }
});
