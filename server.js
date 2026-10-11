import express from 'express';
import cors from 'cors';
import pg from 'pg';
import crypto from 'node:crypto';

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USERNAME = 'Jessemi123';

// ═══ BOOT CHECK ═══
if (!process.env.DATABASE_URL) {
    console.error('[BOOT] FATAL: DATABASE_URL environment variable is missing.');
    console.error('       Add it in Render → your web service → Environment tab.');
    process.exit(1);
}

// ═══ DB POOL ═══
const isRender = process.env.DATABASE_URL.includes('render.com') ||
                 process.env.DATABASE_URL.includes('dpg-');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isRender ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
    console.error('[pg] Unexpected pool error:', err.message);
});

// ═══ MIGRATIONS (idempotent — safe to run every boot) ═══
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
    `);
    console.log('[db] ✓ sessions table');

    await pool.query(`
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
    `);
    console.log('[db] ✓ targets table');

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_targets_eliminated
        ON targets(eliminated);
    `);
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_targets_created
        ON targets(created_at DESC);
    `);
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_sessions_expires
        ON sessions(expires_at);
    `);
    console.log('[db] ✓ indexes');

    console.log('[db] Migrations complete');
}

// ═══ MIDDLEWARE ═══
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '100kb' }));

// ═══ HEALTH ═══
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            ok: true,
            service: 'VCN Backend',
            version: '2.0.0',
            database: 'connected',
            time: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: 'Database unreachable', detail: err.message });
    }
});

// ═══ AUTH MIDDLEWARE ═══
async function auth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return res.status(401).json({ error: 'No authorization token' });

    try {
        const { rows } = await pool.query(
            `SELECT username, user_id, avatar_url
             FROM sessions
             WHERE token = $1 AND expires_at > NOW()`,
            [token]
        );
        if (!rows[0]) return res.status(401).json({ error: 'Invalid or expired token' });
        req.session = rows[0];
        next();
    } catch (err) {
        console.error('[auth] DB error:', err.message);
        res.status(500).json({ error: 'Auth check failed' });
    }
}

// ═══ SESSION CREATION ═══
app.post('/api/auth/session', async (req, res) => {
    try {
        const b = req.body || {};
        const username = String(b.robloxUsername || b.username || '').trim();

        if (!username) return res.status(400).json({ error: 'username required' });

        const token = crypto.randomBytes(32).toString('hex');
        const userId = b.userId || b.robloxUserId || null;
        const avatarUrl = b.avatarUrl || null;

        await pool.query(
            `INSERT INTO sessions (token, username, user_id, avatar_url, expires_at)
             VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')`,
            [token, username, userId, avatarUrl]
        );

        console.log(`[session] created for ${username} (${token.slice(0, 12)}…)`);

        res.json({
            token,
            username,
            isAdmin: username.toLowerCase() === ADMIN_USERNAME.toLowerCase(),
            expiresIn: 30 * 24 * 60 * 60
        });
    } catch (err) {
        console.error('[session] error:', err.message);
        res.status(500).json({ error: 'Session creation failed: ' + err.message });
    }
});

// ═══ CURRENT USER ═══
app.get('/api/me', auth, (req, res) => {
    res.json({
        username: req.session.username,
        userId: req.session.user_id,
        avatarUrl: req.session.avatar_url,
        isAdmin: req.session.username.toLowerCase() === ADMIN_USERNAME.toLowerCase()
    });
});

// ═══ LIST TARGETS (public) ═══
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

        res.json(rows.map(t => ({
            id: t.id,
            username: t.username,
            displayName: t.display_name || t.username,
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
        res.status(500).json({ error: 'Failed to fetch targets' });
    }
});

// ═══ CREATE TARGET (admin only) ═══
app.post('/api/targets', auth, async (req, res) => {
    if (req.session.username.toLowerCase() !== ADMIN_USERNAME.toLowerCase()) {
        return res.status(403).json({
            error: `Only ${ADMIN_USERNAME} can post targets (you are ${req.session.username})`
        });
    }

    try {
        const b = req.body || {};
        const username = String(b.username || '').trim();
        if (!username) return res.status(400).json({ error: 'username required' });

        const id = 't-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
        const killReward = Math.max(1, parseInt(b.killReward, 10) || 100);
        const ransomFee = Math.max(1, parseInt(b.ransomFee, 10) || 1000);
        const killsRequired = Math.max(1, parseInt(b.killsRequired, 10) || 5);
        const completion = Math.min(100, Math.max(0, parseInt(b.completion, 10) || 0));

        const { rows } = await pool.query(
            `INSERT INTO targets
                (id, username, display_name, user_id, avatar_url, reason,
                 kill_reward, ransom_fee, kills_required, kills, completion)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING *`,
            [
                id, username,
                b.displayName || username,
                b.userId || null,
                b.avatarUrl || null,
                b.reason || '',
                killReward, ransomFee, killsRequired, 0, completion
            ]
        );

        const t = rows[0];
        console.log(`[targets POST] ${username} posted by ${req.session.username}`);

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
        console.error('[targets POST] error:', err.message);
        res.status(500).json({ error: 'Failed to create target: ' + err.message });
    }
});

// ═══ DELETE TARGET (admin only) ═══
app.delete('/api/targets/:id', auth, async (req, res) => {
    if (req.session.username.toLowerCase() !== ADMIN_USERNAME.toLowerCase()) {
        return res.status(403).json({ error: 'Admin only' });
    }
    try {
        const { rowCount } = await pool.query(
            'DELETE FROM targets WHERE id = $1',
            [req.params.id]
        );
        if (rowCount === 0) return res.status(404).json({ error: 'Target not found' });
        console.log(`[targets DELETE] ${req.params.id} by ${req.session.username}`);
        res.json({ ok: true, deleted: req.params.id });
    } catch (err) {
        console.error('[targets DELETE] error:', err.message);
        res.status(500).json({ error: 'Failed to delete' });
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
        console.log('[boot] Verifying database connection...');
        const { rows } = await pool.query('SELECT NOW() as now');
        console.log('[boot] DB reachable at', rows[0].now);

        await migrate();

        app.listen(PORT, () => {
            console.log(`[boot] VCN Backend listening on :${PORT}`);
            console.log(`[boot] Admin user: ${ADMIN_USERNAME}`);
        });
    } catch (err) {
        console.error('[BOOT] FATAL:', err);
        process.exit(1);
    }
})();
