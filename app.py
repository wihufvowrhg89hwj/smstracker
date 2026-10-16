import os
import time
import requests
import threading
from flask import Flask, request, jsonify
import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton

# Configuration & Environment Variables
BOT_TOKEN = os.environ.get("BOT_TOKEN", "8832238459:AAGR6_N00HtDjJv7IEdwu-y-1U2RW9VO9rk")
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID", "8753024194")
GROUP_CHAT_ID = os.environ.get("GROUP_CHAT_ID", "")
RENDER_EXTERNAL_URL = os.environ.get("RENDER_EXTERNAL_URL", "")

app = Flask(__name__)
bot = telebot.TeleBot(BOT_TOKEN)

# In-Memory Device Storage
devices = {}

# ----------------------------------------------------
# 1. FLASK HTTP ENDPOINTS & KEEP-ALIVE
# ----------------------------------------------------
@app.route("/")
def index():
    return jsonify({
        "status": "online",
        "app": "SMS Forwarder Telegram Bot (Python)",
        "connected_devices": len(devices),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")
    })

@app.route("/ping")
def ping():
    return jsonify({"status": "alive", "time": time.time()})

@app.route("/api/register-device", methods=["POST"])
def register_device():
    data = request.get_json() or {}
    dev_id = data.get("deviceId")
    if not dev_id:
        return jsonify({"error": "deviceId is required"}), 400

    devices[dev_id] = {
        "deviceId": dev_id,
        "deviceAlias": data.get("deviceAlias") or data.get("model") or "Android Device",
        "model": data.get("model", "Unknown Model"),
        "batteryLevel": data.get("batteryLevel", -1),
        "isCharging": bool(data.get("isCharging")),
        "isServiceRunning": bool(data.get("isServiceRunning")),
        "isForwardingEnabled": data.get("isForwardingEnabled", True),
        "killReason": data.get("killReason", "Running smoothly"),
        "lastSeen": time.time()
    }
    print(f"[Device Registered/Updated] {dev_id} ({devices[dev_id]['deviceAlias']})")
    return jsonify({"success": True})

@app.route("/api/forward-sms", methods=["POST"])
def forward_sms():
    data = request.get_json() or {}
    dev_id = data.get("deviceId")
    sender = data.get("sender", "Unknown")
    body = data.get("body", "")
    sim_slot = data.get("simSlot", "SIM 1")
    timestamp = data.get("timestamp")

    time_str = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(timestamp / 1000.0)) if timestamp else time.strftime("%Y-%m-%d %H:%M:%S")
    dev = devices.get(dev_id, {"deviceAlias": "Android Device"})

    formatted_msg = (
        f"📩 *New SMS Received*\n\n"
        f"📱 *Device:* `{dev['deviceAlias']}`\n"
        f"👤 *From:* `{sender}`\n"
        f"💳 *SIM:* `{sim_slot}`\n"
        f"⏰ *Time:* `{time_str}`\n\n"
        f"💬 *Message:*\n`{body}`"
    )

    targets = set()
    if ADMIN_CHAT_ID:
        targets.add(ADMIN_CHAT_ID)
    if GROUP_CHAT_ID:
        targets.add(GROUP_CHAT_ID)

    for target in targets:
        try:
            bot.send_message(target, formatted_msg, parse_mode="Markdown")
        except Exception as e:
            print(f"Error sending SMS to target {target}: {e}")

    return jsonify({"success": True})

# ----------------------------------------------------
# 2. RENDER SELF-PING KEEP-ALIVE THREAD (EVERY 5 MINS)
# ----------------------------------------------------
def start_keep_alive_ping():
    while True:
        time.sleep(300)  # 5 Minutes
        if RENDER_EXTERNAL_URL:
            try:
                ping_url = f"{RENDER_EXTERNAL_URL.rstrip('/')}/ping"
                print(f"[Keep-Alive] Self-pinging {ping_url}...")
                res = requests.get(ping_url, timeout=10)
                print(f"[Keep-Alive] Ping response status: {res.status_code}")
            except Exception as err:
                print(f"[Keep-Alive] Ping error: {err}")

# ----------------------------------------------------
# 3. TELEGRAM BOT HANDLERS & INLINE KEYBOARDS
# ----------------------------------------------------
def build_device_control_message(dev):
    is_online = (time.time() - dev.get("lastSeen", 0)) < 180  # 3 mins
    live_status = "🟢 *Online & Active*" if is_online else "🔴 *Offline / Inactive*"
    fwd_status = "🟢 *ENABLED (ON)*" if dev.get("isForwardingEnabled", True) else "🔴 *DISABLED (OFF)*"
    bat_level = dev.get("batteryLevel", -1)
    bat_text = f"{bat_level}% {'🔌 (Charging)' if dev.get('isCharging') else '🔋'}" if bat_level >= 0 else "Unknown"

    return (
        f"📱 *DEVICE CONTROL CENTER*\n"
        f"━━━━━━━━━━━━━━━━━━━━━\n"
        f"🏷️ *Device Name:* `{dev['deviceAlias']}`\n"
        f"🆔 *Device ID:* `{dev['deviceId']}`\n"
        f"📲 *Model:* `{dev['model']}`\n"
        f"⚡ *Battery:* {bat_text}\n\n"
        f"⚡ *Live Status:* {live_status}\n"
        f"💬 *SMS Forwarding:* {fwd_status}\n"
        f"📋 *Status Info:* {dev.get('killReason', 'Running smoothly')}\n"
        f"━━━━━━━━━━━━━━━━━━━━━\n"
        f"_Select an action below to manage this device:_"
    )

def build_device_keyboard(dev_id, is_fwd_on):
    markup = InlineKeyboardMarkup()
    sms_btn_text = "🔴 Turn SMS OFF" if is_fwd_on else "🟢 Turn SMS ON"
    sms_btn_cb = f"sms_off_{dev_id}" if is_fwd_on else f"sms_on_{dev_id}"

    markup.row(InlineKeyboardButton(sms_btn_text, callback_data=sms_btn_cb))
    markup.row(
        InlineKeyboardButton("📥 Sync Old Inbox SMS", callback_data=f"sync_old_{dev_id}"),
        InlineKeyboardButton("✏️ Rename Device", callback_data=f"rename_{dev_id}")
    )
    markup.row(
        InlineKeyboardButton("🔄 Refresh Status", callback_data=f"refresh_{dev_id}"),
        InlineKeyboardButton("📋 All Devices List", callback_data="dev_list")
    )
    return markup

@bot.message_handler(commands=['start', 'groupid', 'id', 'devices', 'status'])
def handle_commands(message):
    chat_id = str(message.chat.id)
    chat_type = message.chat.type

    # If inside Telegram Group/Channel
    if chat_type in ['group', 'supergroup', 'channel']:
        group_title = message.chat.title or "Telegram Group"
        reply_text = (
            f"📌 *TELEGRAM GROUP DETAILS*\n"
            f"━━━━━━━━━━━━━━━━━━━━━\n"
            f"🏷️ *Group Title:* `{group_title}`\n"
            f"🆔 *Group Chat ID:* `{chat_id}`\n"
            f"━━━━━━━━━━━━━━━━━━━━━\n"
            f"_Copy the Group Chat ID above and set `GROUP_CHAT_ID={chat_id}` in Render Environment Variables!_"
        )
        return bot.send_message(chat_id, reply_text, parse_mode="Markdown")

    # If direct private chat with Admin
    if chat_id != ADMIN_CHAT_ID:
        return bot.send_message(chat_id, "❌ Unauthorized user.")

    if not devices:
        return bot.send_message(chat_id, "📱 *No Devices Connected Yet.*\n\nInstall the SMS Forwarder app on your Android device to see devices here.", parse_mode="Markdown")

    if len(devices) == 1:
        dev = list(devices.values())[0]
        return bot.send_message(
            chat_id,
            build_device_control_message(dev),
            parse_mode="Markdown",
            reply_markup=build_device_keyboard(dev["deviceId"], dev.get("isForwardingEnabled", True))
        )

    markup = InlineKeyboardMarkup()
    for dev in devices.values():
        status_icon = "🟢" if dev.get("isForwardingEnabled", True) else "🔴"
        btn_text = f"{status_icon} {dev['deviceAlias']} ({dev['model']})"
        markup.row(InlineKeyboardButton(btn_text, callback_data=f"dev_info_{dev['deviceId']}"))

    bot.send_message(chat_id, "📱 *Connected Devices List:*\nSelect a device to control:", parse_mode="Markdown", reply_markup=markup)

@bot.message_handler(commands=['rename'])
def handle_rename(message):
    chat_id = str(message.chat.id)
    if chat_id != ADMIN_CHAT_ID:
        return

    text_parts = message.text.split(maxsplit=1)
    if len(text_parts) < 2:
        return bot.send_message(chat_id, "Usage: `/rename New Device Name`", parse_mode="Markdown")

    new_name = text_parts[1].strip()
    if not devices:
        return bot.send_message(chat_id, "❌ No connected devices found.")

    dev = list(devices.values())[0]
    old_name = dev["deviceAlias"]
    dev["deviceAlias"] = new_name
    devices[dev["deviceId"]] = dev

    bot.send_message(chat_id, f"✅ Device renamed from `{old_name}` to `{new_name}`!", parse_mode="Markdown")
    bot.send_message(
        chat_id,
        build_device_control_message(dev),
        parse_mode="Markdown",
        reply_markup=build_device_keyboard(dev["deviceId"], dev.get("isForwardingEnabled", True))
    )

@bot.callback_query_handler(func=lambda call: True)
def handle_callback(call):
    chat_id = str(call.message.chat.id)
    message_id = call.message.message_id
    data = call.data

    if chat_id != ADMIN_CHAT_ID:
        return bot.answer_callback_query(call.id, "❌ Unauthorized")

    if data == "dev_list":
        if not devices:
            return bot.answer_callback_query(call.id, "No devices connected")
        markup = InlineKeyboardMarkup()
        for dev in devices.values():
            status_icon = "🟢" if dev.get("isForwardingEnabled", True) else "🔴"
            btn_text = f"{status_icon} {dev['deviceAlias']} ({dev['model']})"
            markup.row(InlineKeyboardButton(btn_text, callback_data=f"dev_info_{dev['deviceId']}"))
        bot.edit_message_text("📱 *Connected Devices List:*\nSelect a device to control:", chat_id, message_id, parse_mode="Markdown", reply_markup=markup)
        return bot.answer_callback_query(call.id, "Updated list")

    parts = data.split("_")
    if len(parts) < 2:
        return

    dev_id = parts[-1]
    action = "_".join(parts[:-1])
    dev = devices.get(dev_id)

    if not dev:
        return bot.answer_callback_query(call.id, "⚠️ Device not found")

    if action in ["dev_info", "refresh"]:
        bot.edit_message_text(build_device_control_message(dev), chat_id, message_id, parse_mode="Markdown", reply_markup=build_device_keyboard(dev_id, dev.get("isForwardingEnabled", True)))
        bot.answer_callback_query(call.id, "Refreshed live status")
    elif action == "sms_on":
        dev["isForwardingEnabled"] = True
        devices[dev_id] = dev
        bot.edit_message_text(build_device_control_message(dev), chat_id, message_id, parse_mode="Markdown", reply_markup=build_device_keyboard(dev_id, True))
        bot.answer_callback_query(call.id, "🟢 SMS Forwarding Enabled")
    elif action == "sms_off":
        dev["isForwardingEnabled"] = False
        devices[dev_id] = dev
        bot.edit_message_text(build_device_control_message(dev), chat_id, message_id, parse_mode="Markdown", reply_markup=build_device_keyboard(dev_id, False))
        bot.answer_callback_query(call.id, "🔴 SMS Forwarding Disabled")
    elif action == "sync_old":
        bot.answer_callback_query(call.id, "📥 Sync requested")
        bot.send_message(chat_id, f"📥 Syncing past inbox SMS for `{dev['deviceAlias']}`...", parse_mode="Markdown")
    elif action == "rename":
        bot.answer_callback_query(call.id, "Send rename command")
        bot.send_message(chat_id, f"✏️ *To Rename Device `{dev['deviceAlias']}`:*\n\nSend command:\n`/rename New Device Name`", parse_mode="Markdown")

# ----------------------------------------------------
# 4. RUN THREADS: TELEGRAM BOT + KEEP-ALIVE
# ----------------------------------------------------
def start_bot_polling():
    while True:
        try:
            bot.infinity_polling(timeout=20, long_polling_timeout=20)
        except Exception as e:
            print(f"Bot polling error: {e}")
            time.sleep(5)

# Start Keep-Alive Thread
threading.Thread(target=start_keep_alive_ping, daemon=True).start()

# Start Telegram Bot Polling Thread
threading.Thread(target=start_bot_polling, daemon=True).start()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
