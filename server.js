import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3000;

// ═══ CONFIG ═══
const ADMIN_USERNAME = 'Jessemi123';   // Only this Roblox username can post/delete targets
const SESSION_DAYS = 30;

// ═══ DATABASE ═══
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false
});

// ═══ MIGRATIONS (run on boot) ═══
async function migrate() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS sessions (
            token       TEXT PRIMARY KEY,
            username    TEXT NOT NULL,
            user_id     TEXT,
            avatar_url  TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at  TIMESTAMPTZ NOT NULL
        );

        CREATE TABLE IF NOT EXISTS targets (
            id              TEXT PRIMARY KEY,
            username        TEXT NOT NULL,
            display_name    TEXT,
            user_id         TEXT,
            avatar_url      TEXT,
            reason          TEXT DEFAULT '',
            kill_reward     INTEGER NOT NULL DEFAULT 100,
            ransom_fee      INTEGER NOT NULL DEFAULT 1000,
            kills_required  INTEGER NOT NULL DEFAULT 5,
            kills           INTEGER NOT NULL DEFAULT 0,
            completion      INTEGER NOT NULL DEFAULT 0,
            eliminated      BOOLEAN NOT NULL DEFAULT FALSE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_targets_eliminated ON targets(eliminated);
    `);
    console.log('[db] Migrations complete');
}

// ═══ MIDDLEWARE ═══
app.use(cors({
    origin: true,                  // Allow any origin (or set specific ones)
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '100kb' }));

// Auth middleware
async function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No token provided' });

    try {
        const { rows } = await pool.query(
            `SELECT * FROM sessions WHERE token = $1 AND expires_at > NOW()`,
            [token]
        );
        if (!rows[0]) return res.status(401).json({ error: 'Invalid or expired token' });
        req.session = rows[0];
        next();
    } catch (err) {
        console.error('[auth] DB error:', err);
        res.status(500).json({ error: 'Auth check failed' });
    }
}

// ═══ HEALTH ═══
app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'VCN Backend', version: '2.0.0', time: new Date().toISOString() });
});

// ═══ SESSION ═══
app.post('/api/auth/session', async (req, res) => {
    const body = req.body || {};
    // Accept either robloxUsername or username
    const username = (body.robloxUsername || body.username || '').trim();

    if (!username) {
        return res.status(400).json({ error: 'robloxUsername or username required' });
    }

    try {
        // Generate a secure token
        const token = crypto.randomBytes(32).toString('hex');

        await pool.query(
            `INSERT INTO sessions (token, username, user_id, avatar_url, expires_at)
             VALUES ($1, $2, $3, $4, NOW() + INTERVAL '${SESSION_DAYS} days')`,
            [token, username, body.userId || body.robloxUserId || null, body.avatarUrl || null]
        );

        console.log(`[session] Created for ${username}: ${token.slice(0, 12)}...`);

        res.json({
            token,
            username,
            expiresIn: SESSION_DAYS * 24 * 60 * 60,
            isAdmin: username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
        });
    } catch (err) {
        console.error('[session] Error:', err);
        res.status(500).json({ error: 'Could not create session' });
    }
});

app.get('/api/me', auth, (req, res) => {
    res.json({
        username: req.session.username,
        userId: req.session.user_id,
        isAdmin: req.session.username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
    });
});

// ═══ TARGETS ═══
app.get('/api/targets', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, username, display_name, user_id, avatar_url, reason,
                    kill_reward, ransom_fee, kills_required, kills, completion,
                    eliminated, created_at
             FROM targets
             ORDER BY created_at DESC
             LIMIT 200`
        );

        // Map snake_case to camelCase for the frontend
        const targets = rows.map(t => ({
            id: t.id,
            username: t.username,
            displayName: t.display_name,
            userId: t.user_id,
            avatarUrl: t.avatar_url,
            reason: t.reason,
            killReward: t.kill_reward,
            ransomFee: t.ransom_fee,
            killsRequired: t.kills_required,
            kills: t.kills,
            completion: t.completion,
            eliminated: t.eliminated,
            createdAt: t.created_at
        }));

        res.json(targets);
    } catch (err) {
        console.error('[targets] GET error:', err);
        res.status(500).json({ error: 'Could not fetch targets' });
    }
});

app.post('/api/targets', auth, async (req, res) => {
    // Only admin can post
    if (req.session.username.toLowerCase() !== ADMIN_USERNAME.toLowerCase()) {
        return res.status(403).json({ error: `Only ${ADMIN_USERNAME} can post targets` });
    }

    const b = req.body || {};
    const username = (b.username || '').trim();
    if (!username) return res.status(400).json({ error: 'username required' });

    const id = 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const killReward = Math.max(1, parseInt(b.killReward, 10) || 100);
    const ransomFee = Math.max(1, parseInt(b.ransomFee, 10) || 1000);
    const killsRequired = Math.max(1, parseInt(b.killsRequired, 10) || 5);
    const completion = Math.min(100, Math.max(0, parseInt(b.completion, 10) || 0));

    try {
        const { rows } = await pool.query(
            `INSERT INTO targets
                (id, username, display_name, user_id, avatar_url, reason,
                 kill_reward, ransom_fee, kills_required, kills, completion)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING *`,
            [
                id, username,
                b.displayName || username,
                b.userId || null,
                b.avatarUrl || null,
                b.reason || '',
                killReward, ransomFee, killsRequired,
                0, completion
            ]
        );

        console.log(`[targets] POST by ${req.session.username}: ${username}`);

        const t = rows[0];
        res.status(201).json({
            id: t.id,
            username: t.username,
            displayName: t.display_name,
            userId: t.user_id,
            avatarUrl: t.avatar_url,
            reason: t.reason,
            killReward: t.kill_reward,
            ransomFee: t.ransom_fee,
            killsRequired: t.kills_required,
            kills: t.kills,
            completion: t.completion,
            eliminated: t.eliminated,
            createdAt: t.created_at
        });
    } catch (err) {
        console.error('[targets] POST error:', err);
        res.status(500).json({ error: 'Could not create target' });
    }
});

app.delete('/api/targets/:id', auth, async (req, res) => {
    if (req.session.username.toLowerCase() !== ADMIN_USERNAME.toLowerCase()) {
        return res.status(403).json({ error: `Only ${ADMIN_USERNAME} can delete targets` });
    }

    try {
        const { rowCount } = await pool.query('DELETE FROM targets WHERE id = $1', [req.params.id]);
        if (rowCount === 0) return res.status(404).json({ error: 'Target not found' });
        res.json({ ok: true, deleted: req.params.id });
    } catch (err) {
        console.error('[targets] DELETE error:', err);
        res.status(500).json({ error: 'Could not delete target' });
    }
});

// ═══ 404 + ERROR ═══
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));
app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).json({ error: err.message || 'Internal error' });
});

// ═══ BOOT ═══
(async () => {
    try {
        await migrate();
        app.listen(PORT, () => console.log(`[vcn] Listening on :${PORT}`));
    } catch (err) {
        console.error('[vcn] Boot failed:', err);
        process.exit(1);
    }
})();
