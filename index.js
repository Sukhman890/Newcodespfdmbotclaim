"use strict";

const { Client } = require("discord.js-selfbot-v13");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const { DISCORD_TOKEN, GUILD_ID, CHECK_CHANNEL_ID } = process.env;

const missing = ["DISCORD_TOKEN", "GUILD_ID", "CHECK_CHANNEL_ID"].filter(
  (k) => !process.env[k] || !process.env[k].trim()
);
if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Folder Persistence Setup
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "invites.json");

function ensureStorageExists() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ inviteCounts: {}, countedMembers: {}, userStages: {} }, null, 2)
    );
  }
}

ensureStorageExists();

function loadSavedData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Failed to read data/invites.json, initializing fresh data:", err.message);
    return { inviteCounts: {}, countedMembers: {}, userStages: {} };
  }
}

function saveData() {
  try {
    ensureStorageExists();
    const countsObj = {};
    for (const [inviterId, memberSet] of inviteCounts.entries()) {
      countsObj[inviterId] = Array.from(memberSet);
    }
    const membersObj = {};
    for (const [memberId, inviterId] of countedMembers.entries()) {
      membersObj[memberId] = inviterId;
    }
    const stagesObj = {};
    for (const [userId, stage] of userConversationStage.entries()) {
      stagesObj[userId] = stage;
    }
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ inviteCounts: countsObj, countedMembers: membersObj, userStages: stagesObj }, null, 2)
    );
  } catch (err) {
    console.error("Failed to save data to data/invites.json:", err.message);
  }
}

const initialData = loadSavedData();
const inviteCounts = new Map();
for (const [inviterId, memberArray] of Object.entries(initialData.inviteCounts || {})) {
  inviteCounts.set(inviterId, new Set(memberArray));
}
const countedMembers = new Map(Object.entries(initialData.countedMembers || {}));
const userConversationStage = new Map(Object.entries(initialData.userStages || {}));

// ---------------------------------------------------------------------------
// In-memory runtime state
// ---------------------------------------------------------------------------
let inviteCache = new Map();
const sentMilestones = new Map();
const lastCheck = new Map();
const humanInquiryCount = new Map();

const CHECK_COOLDOWN_MS = 2_000;
const MIN_ACCOUNT_AGE_DAYS = 7;
let checkChannel = null;

const TRIGGER_KEYWORDS = [
  "invite", "invites", "invited", "inv", "i invite 3 invites complete",
  "invites complete", "invite complete", "3 invites complete", "done",
  "completed", "i have completed my invites", "now my reward", "give me rewards",
  "reward", "check", "invites done", "i did", "finished", "claim", "i got",
  "i have", "have 3", "got 3", "have 8", "got 8", "have 11", "got 11",
  "i have already", "already invited", "already my invites", "already done", "check again"
];

const CLAIM_REGEX = /\b(invite|invites|invited|inv|have|got|did|done|made|already|check)\s*(\d+|\w+)?\b/i;

const HUMAN_BOT_KEYWORDS = [
  "are you bot", "are u bot", "r u bot", "u bot", "you bot", "are you a bot",
  "are u a bot", "r u a bot", "are you human", "are u human", "r u human",
  "is this a bot", "is this bot", "real person", "real human", "ai bot"
];

// ---------------------------------------------------------------------------
// Client Initialization
// ---------------------------------------------------------------------------
const client = new Client({ checkUpdate: false });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getCount(userId) {
  const set = inviteCounts.get(userId);
  return set ? set.size : 0;
}

function nextRequired(count) {
  if (count < 3) return 3;
  if (count < 8) return 8;
  return 8 + 3 * (Math.floor((count - 8) / 3) + 1);
}

function snapshot(inv) {
  return {
    code: inv.code,
    uses: inv.uses ?? 0,
    maxUses: inv.maxUses ?? 0,
    inviterId: inv.inviter?.id ?? null,
  };
}

// Auto-accept DM requests and send message
async function sendDM(channel, text) {
  try {
    if (typeof channel.accept === "function") {
      await channel.accept().catch(() => null);
    }
    await channel.send(text);
    return true;
  } catch (err) {
    console.error("Failed to send DM:", err.message);
    return false;
  }
}

async function sendSeparateDMs(channel, text1, text2) {
  try {
    if (typeof channel.accept === "function") {
      await channel.accept().catch(() => null);
    }
    if (text1) {
      await Promise.all([channel.send(text1), channel.send(text2)]);
    } else {
      await channel.send(text2);
    }
    return true;
  } catch (err) {
    console.error("Failed to send separate DMs:", err.message);
    return false;
  }
}

async function logToCheckChannel(text) {
  if (!checkChannel) return;
  try {
    await checkChannel.send({ content: text, allowedMentions: { parse: [] } });
  } catch (err) {
    console.error("Failed to write to check channel:", err.message);
  }
}

function isTriggerPhrase(text) {
  const lower = text.toLowerCase().trim();
  return TRIGGER_KEYWORDS.some((kw) => lower.includes(kw)) || CLAIM_REGEX.test(lower);
}

function isHumanBotInquiry(text) {
  const lower = text.toLowerCase().trim();
  return HUMAN_BOT_KEYWORDS.some((kw) => lower.includes(kw));
}

// ---------------------------------------------------------------------------
// Response Formatters
// ---------------------------------------------------------------------------
function getPreCheckingText(stage) {
  const variations = [
    "🎁 invite `3 people` to the server and the giftcard code/ mcfa is yours!",
    "yeah go ahead, just come back when you've got the 3 invites",
    "swamped rn 😭 if ur claiming just get the 3 invites and hit me up when they're in"
  ];
  return stage < variations.length ? variations[stage] : null;
}

function getUnderTargetText(current, target) {
  const remaining = Math.max(0, target - current);
  if (target === 3) {
    return `u only got ${current} rn bro, need 3 to unlock — almost there! just need ${remaining} more invites`;
  }
  return `ur at ${current} invites, u need ${remaining} more to unlock the reward`;
}

const MILESTONE_3_MESSAGE =
  "-# 🧑‍🌾 Thanks for INVITING! I appreciate you for giving your time.\n\n" +
  "💫 Either wait `2 weeks` to claim or get **__5 EXTRA INVITES__** to the server for an **INSTANT CLAIM**. ⚡\n\n" +
  "> ❤️ - We have this system to prevent people from abusing our systems because it has happened several times.";

const MILESTONE_8_MESSAGE =
  "👋 hey, sorry for the delay!\n" +
  "just checked ur invites on the bot and everything looks good! great job\n" +
  "you're so close to getting the reward. we only have a few left in stock but i saved one just for u! before i send it tho, could u invite **3 more people** to the server? ❄️\n" +
  "i wanna be fair, but with so many ppl messaging me, im giving it to whoever does this extra step! once ur done, dm me back and i'll send it immediately, no waiting!";

async function logCheck(userId) {
  const current = getCount(userId);
  const next = nextRequired(current);
  const remaining = Math.max(0, next - current);
  await logToCheckChannel(
    `🔎 Invite Check\n` +
      `User: <@${userId}>\n` +
      `User ID: ${userId}\n` +
      `Current valid invites: ${current}\n` +
      `Next milestone: ${next}\n` +
      `Remaining: ${remaining}`
  );
}

// ---------------------------------------------------------------------------
// Invite Tracking
// ---------------------------------------------------------------------------
async function refreshInviteCache(guild) {
  try {
    const fresh = await guild.invites.fetch();
    const map = new Map();
    for (const inv of fresh.values()) map.set(inv.code, snapshot(inv));
    inviteCache = map;
  } catch (err) {
    console.error("Could not fetch server invites:", err.message);
  }
}

async function detectUsedInvite(guild) {
  let fresh;
  try {
    fresh = await guild.invites.fetch();
  } catch (err) {
    return null;
  }

  const freshMap = new Map();
  for (const inv of fresh.values()) freshMap.set(inv.code, snapshot(inv));

  const increased = [];
  for (const [code, snap] of freshMap) {
    const old = inviteCache.get(code);
    if (old ? snap.uses > old.uses : snap.uses > 0) increased.push(snap);
  }

  let used = null;
  if (increased.length === 1) {
    used = increased[0];
  } else if (increased.length === 0) {
    const vanished = [];
    for (const [code, old] of inviteCache) {
      if (!freshMap.has(code) && old.maxUses > 0 && old.uses + 1 >= old.maxUses) {
        vanished.push(old);
      }
    }
    if (vanished.length === 1) used = vanished[0];
  }

  inviteCache = freshMap;
  return used;
}

let joinQueue = Promise.resolve();

async function handleJoin(member) {
  const used = await detectUsedInvite(member.guild);
  if (member.user.bot || !used || !used.inviterId) return;

  const accountAgeDays = (Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);
  if (accountAgeDays < MIN_ACCOUNT_AGE_DAYS) return;

  const inviterId = used.inviterId;
  if (inviterId === client.user.id || inviterId === member.id || countedMembers.has(member.id)) return;

  countedMembers.set(member.id, inviterId);
  if (!inviteCounts.has(inviterId)) inviteCounts.set(inviterId, new Set());
  inviteCounts.get(inviterId).add(member.id);

  saveData();
}

function handleLeave(member) {
  const inviterId = countedMembers.get(member.id);
  if (inviterId && inviteCounts.has(inviterId)) {
    inviteCounts.get(inviterId).delete(member.id);
    countedMembers.delete(member.id);
    saveData();
  }
}

// ---------------------------------------------------------------------------
// Client Events
// ---------------------------------------------------------------------------
client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) process.exit(1);

    const channel = await guild.channels.fetch(CHECK_CHANNEL_ID).catch(() => null);
    if (!channel) process.exit(1);
    checkChannel = channel;

    await refreshInviteCache(guild);
    console.log(`Account connected as ${client.user.tag}`);
  } catch (err) {
    console.error("Startup failed:", err.message);
    process.exit(1);
  }
});

client.on("inviteCreate", (invite) => {
  if (invite.guild && invite.guild.id === GUILD_ID) {
    inviteCache.set(invite.code, snapshot(invite));
  }
});

client.on("guildMemberAdd", (member) => {
  if (member.guild.id !== GUILD_ID) return;
  joinQueue = joinQueue.then(() => handleJoin(member)).catch((err) => console.error(err));
});

client.on("guildMemberRemove", (member) => {
  if (member.guild.id !== GUILD_ID) return;
  handleLeave(member);
});

// Auto-accept DM requests when receiving a message request
client.on("relationship", async (relationship) => {
  if (relationship.type === 1 || relationship.type === 2) return;
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || message.author.id === client.user.id) return;

    // Direct Messages Handling
    if (!message.guild) {
      const userId = message.author.id;
      const rawText = message.content.trim();

      // Always accept message requests on direct message
      if (typeof message.channel.accept === "function") {
        await message.channel.accept().catch(() => null);
      }

      if (isHumanBotInquiry(rawText)) {
        const askCount = humanInquiryCount.get(userId) || 0;
        humanInquiryCount.set(userId, askCount + 1);

        if (askCount % 2 === 0) {
          await sendDM(message.channel, "lmao bro im real i just got like 50 dms rn 😭");
        } else {
          await sendDM(message.channel, "bruh im real just type fast bc i got a lot of dms");
        }
        return;
      }

      if (!isTriggerPhrase(rawText)) return;

      const now = Date.now();
      if (now - (lastCheck.get(userId) || 0) < CHECK_COOLDOWN_MS) return;
      lastCheck.set(userId, now);

      let stage = userConversationStage.get(userId) ?? 0;

      const current = getCount(userId);
      const target = nextRequired(current);
      const flags = sentMilestones.get(userId) || { first: false, eight: false };
      sentMilestones.set(userId, flags);

      logCheck(userId);

      const preText = getPreCheckingText(stage);
      const progressMsg = getUnderTargetText(current, target);

      // Increment and save stage state
      userConversationStage.set(userId, stage + 1);
      saveData();

      if (current >= 3 && !flags.first) {
        flags.first = true;
        await sendSeparateDMs(message.channel, preText, MILESTONE_3_MESSAGE);
        return;
      }

      if (current >= 8 && !flags.eight) {
        flags.eight = true;
        await sendSeparateDMs(message.channel, preText, MILESTONE_8_MESSAGE);
        return;
      }

      await sendSeparateDMs(message.channel, preText, progressMsg);
    }
  } catch (err) {
    console.error("Message handling error:", err.message);
  }
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
client.login(DISCORD_TOKEN).catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
                         
