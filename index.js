/**
 * WhatsApp Automation API – Production Hardened
 * Stack: Node.js, Express, whatsapp-web.js
 * Designed for long-running AWS VPS usage
 */

const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   GLOBAL STATE
========================= */

let client;
let qrCodeData = null;
let isAuthenticated = false;
let isReady = false;
let webhookUrl = null;
let isListening = false;
let lastReadyAt = null;
let restarting = false;

/* =========================
   HELPERS
========================= */

const sleep = ms => new Promise(r => setTimeout(r, ms));

const formatJID = (number) => {
    if (!number) return null;
    if (number.includes('@')) return number;
    if (number.includes('-')) return `${number}@g.us`;
    return `${number}@c.us`;
};

const resetRuntimeState = () => {
    qrCodeData = null;
    isAuthenticated = false;
    isReady = false;
};

/* =========================
   WHATSAPP INITIALIZATION
========================= */

const initializeClient = async () => {
    if (restarting) return;
    restarting = true;

    console.log('🚀 Initializing WhatsApp Client...');

    resetRuntimeState();

    client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'main-session'
        }),

        // STABLE WhatsApp Web version (critical)
        webVersionCache: {
            type: 'remote',
            remotePath:
                'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        },

        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ],
            userAgent:
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    /* =========================
       EVENTS
    ========================= */

    client.on('qr', async (qr) => {
        console.log('📸 QR RECEIVED');
        qrCodeData = await qrcode.toDataURL(qr);
        isAuthenticated = false;
        isReady = false;
    });

    client.on('authenticated', () => {
        console.log('🔐 AUTHENTICATED');
        isAuthenticated = true;
    });

    client.on('ready', () => {
        console.log('✅ CLIENT READY');
        isAuthenticated = true;
        isReady = true;
        qrCodeData = null;
        lastReadyAt = Date.now();
        restarting = false;
    });

    client.on('message', async msg => {
        if (!isListening || !webhookUrl) return;

        try {
            await axios.post(webhookUrl, {
                from: msg.from,
                body: msg.body,
                timestamp: msg.timestamp,
                chatId: msg.from,
                isGroup: msg.from.includes('@g.us'),
                hasMedia: msg.hasMedia
            });
        } catch (err) {
            console.error('⚠️ Webhook failed:', err.message);
        }
    });

    client.on('auth_failure', async msg => {
        console.error('❌ AUTH FAILURE:', msg);
        await hardRestart(true);
    });

    client.on('disconnected', async reason => {
        console.warn('🔌 DISCONNECTED:', reason);
        await hardRestart(false);
    });

    await client.initialize();
};

/* =========================
   AUTO-RECOVERY LOGIC
========================= */

const hardRestart = async (wipeAuth = false) => {
    if (restarting) return;

    restarting = true;
    console.log('♻️ Restarting WhatsApp client...');

    try {
        if (client) {
            await client.destroy();
        }
    } catch (e) {}

    if (wipeAuth) {
        console.log('🧹 Clearing auth cache...');
        fs.rmSync('.wwebjs_auth', { recursive: true, force: true });
        fs.rmSync('.wwebjs_cache', { recursive: true, force: true });
    }

    await sleep(5000);
    restarting = false;
    initializeClient();
};

/* =========================
   HEARTBEAT WATCHDOG
========================= */

setInterval(() => {
    if (!isReady) return;

    const now = Date.now();
    const diff = now - lastReadyAt;

    // If WhatsApp silently hangs for > 15 mins
    if (diff > 15 * 60 * 1000) {
        console.warn('💀 Heartbeat lost, restarting...');
        hardRestart(false);
    }
}, 60 * 1000);

/* =========================
   API ENDPOINTS
========================= */

app.get('/health', (req, res) => {
    res.json({
        status: isReady ? 'connected' : 'disconnected',
        authenticated: isAuthenticated,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/auth/qr', (req, res) => {
    if (isAuthenticated) {
        return res.json({ message: 'Client already authenticated' });
    }
    if (!qrCodeData) {
        return res.status(503).json({ message: 'QR not ready yet' });
    }
    res.json({ qr: qrCodeData });
});

app.post('/send', async (req, res) => {
    if (!isReady) return res.status(503).json({ error: 'Client not ready' });

    const { to, message } = req.body;

    try {
        const response = await client.sendMessage(formatJID(to), message);
        res.json({ success: true, response });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/reply', async (req, res) => {
    if (!isReady) return res.status(503).json({ error: 'Client not ready' });

    const { chatId, messageId, replyText } = req.body;

    try {
        const response = await client.sendMessage(
            chatId,
            replyText,
            { quotedMessageId: messageId }
        );
        res.json({ success: true, response });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/groups', async (req, res) => {
    if (!isReady) return res.status(503).json({ error: 'Client not ready' });

    try {
        const chats = await client.getChats();
        const groups = chats
            .filter(c => c.isGroup)
            .map(c => ({ id: c.id._serialized, name: c.name }));
        res.json({ groups });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/listen', (req, res) => {
    isListening = true;
    res.json({ message: 'Listening enabled' });
});

app.post('/webhook/set', (req, res) => {
    webhookUrl = req.body.url;
    res.json({ success: true, url: webhookUrl });
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
    console.log(`🚀 WhatsApp API running on port ${PORT}`);
    initializeClient();
});
