const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Identifiants du tableau de bord (à changer via variables d'environnement) ---
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'change-moi-2026';

const questions = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')
);

/* =========================================================================
   STOCKAGE
   - Si des variables Upstash/KV Redis sont présentes (Vercel) : Redis.
   - Sinon (ton ordi) : repli sur un fichier JSON. Sur un disque en lecture
     seule (Vercel sans Redis), on bascule sur le dossier temporaire /tmp
     pour ne JAMAIS planter au démarrage.
   ========================================================================= */
const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_API_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_API_TOKEN;

const REDIS_KEY = 'appam:responses';
let storage;

if (REDIS_URL && REDIS_TOKEN) {
  // ----- Mode Redis (Upstash) -----
  const { Redis } = require('@upstash/redis');
  const redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });

  storage = {
    mode: 'redis',
    async read() {
      const items = await redis.lrange(REDIS_KEY, 0, -1);
      return items.map((it) => (typeof it === 'string' ? JSON.parse(it) : it));
    },
    async add(entry) {
      await redis.rpush(REDIS_KEY, JSON.stringify(entry));
    },
  };
} else {
  // ----- Mode fichier (incassable) -----
  let DATA_DIR = path.join(__dirname, 'data');
  // Sur Vercel, le dossier de l'app est en lecture seule -> utiliser /tmp.
  if (process.env.VERCEL) DATA_DIR = path.join(os.tmpdir(), 'appam-data');
  const DATA_FILE = path.join(DATA_DIR, 'responses.json');

  function ensureFile() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
      return true;
    } catch (e) {
      console.error('Stockage fichier indisponible :', e.message);
      return false;
    }
  }
  ensureFile();

  storage = {
    mode: process.env.VERCEL ? 'fichier-temporaire (⚠️ non persistant)' : 'fichier',
    async read() {
      try {
        return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      } catch {
        return [];
      }
    },
    async add(entry) {
      if (!ensureFile()) throw new Error('Stockage indisponible');
      const all = await this.read();
      all.push(entry);
      fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2));
    },
  };
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- API publique : le schéma des questions ---
app.get('/api/questions', (req, res) => res.json(questions));

// --- API publique : enregistrer une réponse ---
app.post('/api/responses', async (req, res) => {
  try {
    const answers = req.body && req.body.answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      return res.status(400).json({ error: 'Réponses invalides.' });
    }

    // Validation des questions obligatoires
    for (const q of questions.questions) {
      if (!q.required) continue;
      const v = answers[q.id];
      const empty =
        v === undefined ||
        v === null ||
        (typeof v === 'string' && v.trim() === '') ||
        (Array.isArray(v) && v.length === 0);
      if (empty) {
        return res
          .status(400)
          .json({ error: `Merci de répondre à : « ${q.label} »` });
      }
    }

    await storage.add({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      answers,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erreur enregistrement :', err);
    res.status(500).json({ error: 'Erreur serveur, réessaie dans un instant.' });
  }
});

// --- Authentification HTTP Basic pour les routes privées ---
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const [type, encoded] = header.split(' ');
  if (type === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (safeEqual(user, DASHBOARD_USER) && safeEqual(pass, DASHBOARD_PASSWORD)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Tableau de bord AppAM"');
  res.status(401).send('Authentification requise.');
}

// --- Diagnostic protégé (pour vérifier le mode de stockage) ---
app.get('/api/health', auth, (req, res) => {
  res.json({
    storageMode: storage.mode,
    redisDetected: Boolean(REDIS_URL && REDIS_TOKEN),
    onVercel: Boolean(process.env.VERCEL),
  });
});

// --- Tableau de bord protégé ---
app.get('/dashboard', auth, (req, res) =>
  res.sendFile(path.join(__dirname, 'private', 'dashboard.html'))
);

app.get('/api/responses', auth, async (req, res) => {
  try {
    res.json(await storage.read());
  } catch (err) {
    console.error('Erreur lecture :', err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// --- Export CSV protégé ---
app.get('/api/export.csv', auth, async (req, res) => {
  const responses = await storage.read();
  const cols = questions.questions;

  const esc = (val) => {
    const s = Array.isArray(val) ? val.join(' | ') : val == null ? '' : String(val);
    return '"' + s.replace(/"/g, '""') + '"';
  };

  const header = ['Date', ...cols.map((q) => q.label)];
  const rows = responses.map((r) => {
    const line = [new Date(r.createdAt).toLocaleString('fr-FR')];
    for (const q of cols) {
      let v = r.answers[q.id];
      const other = r.answers[q.id + '_other'];
      if (other) v = (Array.isArray(v) ? v.join(' | ') : v || '') + ' (Autre: ' + other + ')';
      line.push(v);
    }
    return line;
  });

  const csv = [header, ...rows].map((line) => line.map(esc).join(',')).join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reponses-appam.csv"');
  res.send('\uFEFF' + csv); // BOM pour Excel
});

// --- Démarrage local uniquement (sur Vercel, l'app est utilisée comme handler) ---
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('');
    console.log('  ✅ AppAM lancé (stockage : ' + storage.mode + ')');
    console.log('  📋 Formulaire :   http://localhost:' + PORT + '/');
    console.log('  📊 Tableau de bord : http://localhost:' + PORT + '/dashboard');
    console.log('     (identifiant: ' + DASHBOARD_USER + ' — mot de passe défini dans DASHBOARD_PASSWORD)');
    console.log('');
  });
}

module.exports = app;
