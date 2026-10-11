import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = 'Jessemi123';

// ═══ HARD FAIL if DATABASE_URL is missing ═══
if (!process.env.DATABASE_URL) {
    console.error('[BOOT] DATABASE_URL is not set. Add it in Render → Environment.');
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('render.com')
        ? { rejectUnauthorized: false }
        : false,
    max: 5,
    connectionTimeoutMillis: 10000
});

pool.on('error', (err) => console.error('[pg] Pool error:', err.message));

// ═══ Migrations ═══
async function migrate() {
    console.log('[db] Running migrations...');
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

// ═══ Middleware ═══
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '100kb' }));

// ═══ Health ═══
app.get('/api/health', (req, res) => {
    res.json({ ok: true, service: 'VCN Backend', version: '2.0.0', time: new Date().toISOString() });
});

// ═══ Auth ═══
async function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        const { rows } = await pool.query(
            `SELECT * FROM sessions WHERE token = $1 AND expires_at > NOW()`,
            [token]
        );
        if (!rows[0]) return res.status(401).json({ error: 'Invalid/expired token' });
        req.session = rows[0];
        next();
    } catch (err) {
        console.error('[auth] error:', err.message);
        res.status(500).json({ error: 'Auth failed' });
    }
}

// ═══ Session creation ═══
app.post('/api/auth/session', async (req, res) => {
    try {
        const b = req.body || {};
        const username = (b.robloxUsername || b.username || '').trim();
        if (!username) return res.status(400).json({ error: 'username required' });

        const token = crypto.randomBytes(32).toString('hex');
        await pool.query(
            `INSERT INTO sessions (token, username, user_id, avatar_url, expires_at)
             VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')`,
            [token, username, b.userId || b.robloxUserId || null, b.avatarUrl || null]
        );

        console.log(`[session] created for ${username}`);
        res.json({
            token,
            username,
            isAdmin: username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
        });
    } catch (err) {
        console.error('[session] error:', err.message);
        res.status(500).json({ error: 'Session creation failed: ' + err.message });
    }
});

// ═══ Me ═══
app.get('/api/me', auth, (req, res) => {
    res.json({
        username: req.session.username,
        userId: req.session.user_id,
        isAdmin: req.session.username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
    });
});

// ═══ Targets ═══
app.get('/api/targets', async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT * FROM targets ORDER BY created_at DESC LIMIT 200`
        );
        res.json(rows.map(t => ({
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
        })));
    } catch (err) {
        console.error('[targets GET] error:', err.message);
        res.status(500).json({ error: 'Fetch failed: ' + err.message });
    }
});

app.post('/api/targets', auth, async (req, res) => {
    if (req.session.username.toLowerCase() !== ADMIN_USERNAME.toLowerCase()) {
        return res.status(403).json({ error: `Only ${ADMIN_USERNAME} can post targets` });
    }
    try {
        const b = req.body || {};
        const username = (b.username || '').trim();
        if (!username) return res.status(400).json({ error: 'username required' });

        const id = 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
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
                Math.max(1, parseInt(b.killReward, 10) || 100),
                Math.max(1, parseInt(b.ransomFee, 10) || 1000),
                Math.max(1, parseInt(b.killsRequired, 10) || 5),
                0,
                Math.min(100, Math.max(0, parseInt(b.completion, 10) || 0))
            ]
        );
        console.log(`[targets POST] ${username} by ${req.session.username}`);
        const t = rows[0];
        res.status(201).json({
            id: t.id,
            username: t.username,
            displayName: t.display_name,
            killReward: t.kill_reward,
            ransomFee: t.ransom_fee,
            killsRequired: t.kills_required,
            kills: t.kills,
            completion: t.completion,
            eliminated: t.eliminated
        });
    } catch (err) {
        console.error('[targets POST] error:', err.message);
        res.status(500).json({ error: 'Create failed: ' + err.message });
    }
});

app.delete('/api/targets/:id', auth, async (req, res) => {
    if (req.session.username.toLowerCase() !== ADMIN_USERNAME.toLowerCase()) {
        return res.status(403).json({ error: 'Admin only' });
    }
    try {
        const { rowCount } = await pool.query('DELETE FROM targets WHERE id = $1', [req.params.id]);
        if (!rowCount) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══ 404 + error handler ═══
app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.path }));
app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).json({ error: err.message });
});

// ═══ Boot ═══
(async () => {
    try {
        console.log('[boot] Connecting to database...');
        await pool.query('SELECT 1');
        console.log('[boot] Database reachable');
        await migrate();
        app.listen(PORT, () => console.log(`[boot] Listening on :${PORT}`));
    } catch (err) {
        console.error('[BOOT FAILED]', err);
        process.exit(1);
    }
})();
