const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/* ═══ HELPERS ═══ */
function computeRansomOwed(t) {
    if (t.isCleared) return 0;
    const elapsed = Date.now() - new Date(t.ransomPaidUntil).getTime();
    if (elapsed <= 0) return t.ransomBase;
    const weeksOverdue = Math.floor(elapsed / WEEK_MS) + 1;
    return t.ransomBase + (weeksOverdue - 1) * t.ransomPerWeek;
}

async function getSession(req) {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '');
    if (!token) return null;
    const session = await prisma.session.findUnique({
        where: { token },
        include: { user: true }
    });
    if (!session || session.expiresAt < new Date()) return null;
    return session;
}

/* ═══ HEALTH ═══ */
app.get('/api/health', async (req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({ status: 'ok', db: 'connected' });
    } catch {
        res.status(500).json({ status: 'error', db: 'disconnected' });
    }
});

/* ═══ SESSION ═══ */
app.post('/api/auth/session', async (req, res) => {
    const { robloxUserId, robloxUsername, displayName, avatarUrl } = req.body;
    if (!robloxUserId || !robloxUsername) {
        return res.status(400).json({ error: 'robloxUserId and robloxUsername required' });
    }

    let user = await prisma.user.findUnique({ where: { robloxUserId } });
    if (!user) {
        user = await prisma.user.create({
            data: {
                robloxUserId,
                robloxUsername,
                displayName: displayName || robloxUsername,
                avatarUrl: avatarUrl || null
            }
        });
    } else {
        user = await prisma.user.update({
            where: { id: user.id },
            data: {
                robloxUsername,
                displayName: displayName || robloxUsername,
                avatarUrl: avatarUrl || user.avatarUrl
            }
        });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await prisma.session.create({ data: { token, userId: user.id, expiresAt } });

    res.json({ token, user });
});

app.get('/api/me', async (req, res) => {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ user: session.user });
});

/* ═══ TARGETS ═══ */
app.get('/api/targets', async (req, res) => {
    try {
        const posts = await prisma.targetPost.findMany({
            where: { status: { in: ['active', 'cleared'] } },
            orderBy: { createdAt: 'desc' },
            take: 100
        });
        const list = posts.map(t => ({
            ...t,
            ransomOwed: computeRansomOwed(t),
            bountyPool: computeRansomOwed(t)
        }));
        res.json({ targets: list });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/targets', async (req, res) => {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });

    const {
        targetRobloxId, targetUsername, targetDisplay, targetAvatar,
        reason, killReward
    } = req.body;

    if (!targetRobloxId || !targetUsername) {
        return res.status(400).json({ error: 'Target ID and username required' });
    }
    if (!reason || reason.trim().length < 10) {
        return res.status(400).json({ error: 'Reason must be at least 10 characters' });
    }
    if (reason.length > 500) {
        return res.status(400).json({ error: 'Reason too long (max 500)' });
    }
    const kr = parseInt(killReward) || 10;
    if (kr < 1 || kr > 10000) {
        return res.status(400).json({ error: 'Kill reward must be between 1 and 10,000 R$' });
    }
    if (targetRobloxId === session.user.robloxUserId) {
        return res.status(400).json({ error: 'You cannot target yourself' });
    }

    const existing = await prisma.targetPost.findFirst({
        where: { targetRobloxId, status: 'active' }
    });
    if (existing) {
        return res.status(409).json({ error: 'Already on the bounty list' });
    }

    try {
        const post = await prisma.targetPost.create({
            data: {
                creatorId: session.user.id,
                targetRobloxId,
                targetUsername,
                targetDisplay: targetDisplay || targetUsername,
                targetAvatar: targetAvatar || null,
                reason: reason.trim(),
                killReward: kr,
                ransomBase: 1000,
                ransomPerWeek: 100,
                ransomPaidUntil: new Date()
            }
        });
        res.json({ target: post });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create target' });
    }
});

app.delete('/api/targets/:id', async (req, res) => {
    const session = await getSession(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });

    try {
        const post = await prisma.targetPost.findUnique({ where: { id: req.params.id } });
        if (!post) return res.status(404).json({ error: 'Not found' });
        if (post.creatorId !== session.user.id) {
            return res.status(403).json({ error: 'Only the creator can delete' });
        }
        await prisma.targetPost.delete({ where: { id: post.id } });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Delete failed' });
    }
});

/* ═══ START ═══ */
app.listen(PORT, () => {
    console.log(`VCN backend running on port ${PORT}`);
});
