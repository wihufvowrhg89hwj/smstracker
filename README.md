# SMS Forwarder Telegram Bot Server (Python & Node.js)

Flask (Python) and Express (Node.js) Backend Bot for managing multiple Android SMS Forwarder devices with Render.com self-ping keep-alive and Telegram Group Forwarding.

---

## 🌟 Features

- **Render.com Keep-Alive Self-Ping**: Automatically sends HTTP GET ping every 5 minutes (`300000` ms) to prevent Render free tier web service from sleeping after 15 minutes!
- **Telegram Group Forwarding**: Forwards incoming SMS messages to both Admin Chat ID and a designated Telegram Group.
- **Group ID Discovery Command**: Add bot to any Telegram Group and type `/start` or `/groupid` to reveal the Group Chat ID!
- **Interactive Device Control Center**:
  - Live status monitoring (🟢 Online / 🔴 Offline).
  - Battery level % & charging status.
  - Remote SMS Forwarding ON/OFF toggle.
  - Device rename support (`/rename <new_name>`).
  - Sync past inbox SMS from Android device.

---

## 👥 How to Forward SMS to a Telegram Group

1. Create or open your Telegram Group.
2. Add your Telegram Bot (`@your_bot_name`) to the group.
3. Send `/start` or `/groupid` inside the Telegram Group.
4. The bot will instantly reply with the **Group Chat ID** (e.g., `-1001234567890`).
5. Copy the Group Chat ID and set it in your Render Environment Variables (`GROUP_CHAT_ID=-1001234567890`).

---

## 🚀 How to Deploy on Render.com (Python Web Service)

### Step 1: Push Code to GitHub / GitLab
1. Upload the `bot/` folder contents to your GitHub repository.

### Step 2: Create Web Service on Render
1. Go to [https://render.com](https://render.com) and log in.
2. Click **New +** -> **Web Service**.
3. Connect your GitHub repository containing the bot code.
4. Set the build settings:
   - **Name**: `sms-forwarder-bot`
   - **Environment**: `Python 3`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app`
   - **Plan**: `Free`

### Step 3: Add Environment Variables on Render
Under **Environment Variables**, add:

| Key | Value | Note |
| :--- | :--- | :--- |
| `BOT_TOKEN` | `8832238459:AAGR6_N00HtDjJv7IEdwu-y-1U2RW9VO9rk` | Your Telegram Bot Token |
| `ADMIN_CHAT_ID` | `8753024194` | Your Telegram Admin Chat ID |
| `GROUP_CHAT_ID` | `-100XXXXXXXXXX` | Your Telegram Group Chat ID (Optional) |
| `RENDER_EXTERNAL_URL` | `https://sms-forwarder-bot.onrender.com` | Your Render Public URL |

### Step 4: Deploy & Verify
1. Click **Create Web Service**.
2. Once live, test `https://your-bot.onrender.com/ping` -> returns `{"status": "alive"}`.
3. Every 5 minutes, the bot will automatically ping itself (`RENDER_EXTERNAL_URL/ping`) to keep the Render free web service running 24/7 without going to sleep!
