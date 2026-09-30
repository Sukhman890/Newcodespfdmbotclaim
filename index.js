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
// Folder Persistence Setup (Saves to ./data/invites.json)
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "invites.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSavedData() {
  if (!fs.existsSync(DATA_FILE)) return { inviteCounts: {}, countedMembers: {}, introSent: [] };
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      inviteCounts: parsed.inviteCounts || {},
      countedMembers: parsed.countedMembers || {},
      introSent: parsed.introSent || []
    };
  } catch (err) {
    console.error("Failed to read data/invites.json, initializing fresh data:", err.message);
    return { inviteCounts: {}, countedMembers: {}, introSent: [] };
  }
}

function saveData() {
  try {
    const countsObj = {};
    for (const [inviterId, memberSet] of inviteCounts.entries()) {
      countsObj[inviterId] = Array.from(memberSet);
    }
    const membersObj = {};
    for (const [memberId, inviterId] of countedMembers.entries()) {
      membersObj[memberId] = inviterId;
    }
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(
        {
          inviteCounts: countsObj,
          countedMembers: membersObj,
          introSent: Array.from(sentIntroMessage)
        },
        null,
        2
      )
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
const sentIntroMessage = new Set(initialData.introSent || []);

// ---------------------------------------------------------------------------
// In-memory runtime state
// ---------------------------------------------------------------------------
let inviteCache = new Map();
const sentMilestones = new Map();
const lastCheck = new Map();
const userConversationStage = new Map();
const humanInquiryCount = new Map();

const CHECK_COOLDOWN_MS = 5_000;
const RESPONSE_DELAY_MS = 3_000;
const MIN_ACCOUNT_AGE_DAYS = 7;
let targetGuild = null;
let checkChannel = null;

// Trigger keywords for invite checking
const TRIGGER_KEYWORDS = [
  "invite",
  "invites",
  "invited",
  "inv",
  "i invite",
  "i invite 3 invites complete",
  "invites complete",
  "invite complete",
  "3 invites complete",
  "done",
  "completed",
  "i have completed my invites",
  "now my reward",
  "give me rewards",
  "reward",
  "check",
  "invites done",
  "i did",
  "finished",
  "claim",
  "i got",
  "i have",
  "have 3",
  "got 3",
  "have 8",
  "got 8",
  "have 11",
  "got 11",
  "i have already",
  "already invited",
  "already my invites",
  "already done"
];

const CLAIM_REGEX = /\b(invite|invites|invited|inv|have|got|did|done|made|already|check)\b/i;

// Keywords for "are you human/bot" inquiries
const HUMAN_BOT_KEYWORDS = [
  "are you bot",
  "are u bot",
  "r u bot",
  "u bot",
  "you bot",
  "are you a bot",
  "are u a bot",
  "r u a bot",
  "are you human",
  "are u human",
  "r u human",
  "is this a bot",
  "is this bot",
  "real person",
  "real human",
  "ai bot"
];

// ---------------------------------------------------------------------------
// Client Initialization
// ---------------------------------------------------------------------------
const client = new Client({ checkUpdate: false });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function sendDM(user, text) {
  try {
    await delay(RESPONSE_DELAY_MS);
    await user.send(text);
    return true;
  } catch (err) {
    return false;
  }
}

async function sendSeparateDMs(user, text1, text2) {
  try {
    await user.send(text1);
    await delay(2000);
    await user.send(text2);
    return true;
  } catch (err) {
    return false;
  }
}

async function sendChannelMessage(channel, text) {
  try {
    await delay(RESPONSE_DELAY_MS);
    await channel.send(text);
    return true;
  } catch (err) {
    return false;
  }
}

async function sendSeparateChannelMessages(channel, text1, text2) {
  try {
    await channel.send(text1);
    await delay(2000);
    await channel.send(text2);
    return true;
  } catch (err) {
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
  const matchedKeyword = TRIGGER_KEYWORDS.some((kw) => lower.includes(kw));
  const matchedRegex = CLAIM_REGEX.test(lower);
  return matchedKeyword || matchedRegex;
}

function isAlreadyPhrase(text) {
  const lower = text.toLowerCase().trim();
  return lower.includes("already") || lower.includes("already my invites") || lower.includes("i have already");
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
    "one sec lemme check...",
    "checking rq...",
    "sec, checking ur invites on the bot..."
  ];
  return variations[stage % variations.length];
}

function getUnderTargetText(current, target, stage, wasAlreadyClaim) {
  const remaining = Math.max(0, target - current);
  let mainText;

  if (target === 3) {
    const texts = [
      `u only got ${current} rn bro, need ${target} to unlock — almost there`,
      `showing ${current} invite(s) lol, just need ${remaining} more`,
      `ur at ${current} rn, get ${remaining} more and ur good`,
      `almost, ${current} rn just need ${remaining} more`,
      `checked and u got ${current}, need ${target} to reserve ur prize. almost there bro`
    ];
    mainText = texts[stage % texts.length];
  } else {
    const texts = [
      `showing ${current} rn lol, get to ${target} and i lock ur payout in`,
      `ur at ${current}, need ${target} total to get in the instant payout line`,
      `checked and u got ${current}, need ${target} to reserve ur prize. almost there bro`
    ];
    mainText = texts[stage % texts.length];
  }

  if (wasAlreadyClaim) {
    mainText += `\n\ncomplete fast and hit me when it's done, type "done" when you have the invites!`;
  }

  return mainText;
}

const MILESTONE_3_MESSAGE =
  "-# 🧑‍🌾 Thanks for INVITING! I appreciate you for giving your time.\n\n" +
  "💫 Either wait `2 weeks` to claim or get **__5 EXTRA INVITES__** to the server for an **INSTANT CLAIM**. ⚡\n\n" +
  "> ❤️️ - We have this system to prevent people from abusing our systems because it has happened several times.";

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
// Invite Detection & Syncing
// ---------------------------------------------------------------------------
async function refreshInviteCache(guild) {
  const fresh = await guild.invites.fetch();
  const map = new Map();
  for (const inv of fresh.values()) map.set(inv.code, snapshot(inv));
  inviteCache = map;
}

async function detectUsedInvite(guild) {
  let fresh;
  try {
    fresh = await guild.invites.fetch();
  } catch (err) {
    console.error("Invite fetch failed (Needs Manage Server permission):", err.message);
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
  if (accountAgeDays < MIN_ACCOUNT_AGE_DAYS) {
    return;
  }

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
// Events
// ---------------------------------------------------------------------------
client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) {
      console.error("Configured guild is not available. Exiting.");
      process.exit(1);
    }
    targetGuild = guild;

    const channel = await guild.channels.fetch(CHECK_CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.error("Check channel not found. Exiting.");
      process.exit(1);
    }
    checkChannel = channel;

    await refreshInviteCache(guild).catch(() => null);
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
  joinQueue = joinQueue.then(() => handleJoin(member)).catch(() => {});
});

client.on("guildMemberRemove", (member) => {
  if (member.guild.id !== GUILD_ID) return;
  handleLeave(member);
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || message.author.id === client.user.id) return;

    // Direct Messages (DMs) - Only process if user is in the target server
    if (!message.guild) {
      if (!targetGuild) return;
      
      let member = targetGuild.members.cache.get(message.author.id);
      if (!member) {
        try {
          member = await targetGuild.members.fetch(message.author.id);
        } catch (err) {
          return;
        }
      }

      if (typeof message.channel.accept === "function") {
        await message.channel.accept().catch(() => null);
      }

      const userId = message.author.id;
      const rawText = message.content.trim();
      const lowerText = rawText.toLowerCase();

      if (isHumanBotInquiry(rawText)) {
        const askCount = humanInquiryCount.get(userId) || 0;
        humanInquiryCount.set(userId, askCount + 1);

        if (askCount === 0) {
          await sendDM(message.author, "lmao bro im real i just got like 50 dms rn 😭");
        } else {
          await sendDM(message.author, "bruh im real just type fast bc i got a lot of dms");
        }
        return;
      }

      if (
        lowerText.includes("fake") ||
        lowerText.includes("legit") ||
        lowerText.includes("proof") ||
        lowerText.includes("scam")
      ) {
        await sendDM(
          message.author,
          "ngl https://discord.com/channels/1268246037844201483/1496153079060365322, tons of people already got paid"
        );
        return;
      }

      if (!isTriggerPhrase(rawText)) {
        if (!sentIntroMessage.has(userId)) {
          sentIntroMessage.add(userId);
          saveData();
          await sendDM(message.author, "🎁 invite `3 people` to the server and the giftcard code is yours!");
        } else {
          const followUps = [
            "yeah go ahead, just come back when you've got the 3 invites",
            "swamped rn 😭 if ur claiming just get the 3 invites and hit me up when they're in"
          ];
          const followUpMsg = followUps[Math.floor(Math.random() * followUps.length)];
          await sendDM(message.author, followUpMsg);
        }
        return;
      }

      const now = Date.now();
      if (now - (lastCheck.get(userId) || 0) < CHECK_COOLDOWN_MS) return;
      lastCheck.set(userId, now);

      let stage = userConversationStage.get(userId) || 0;
      userConversationStage.set(userId, stage + 1);

      const current = getCount(userId);
      const target = nextRequired(current);
      const flags = sentMilestones.get(userId) || { first: false, eight: false };
      sentMilestones.set(userId, flags);

      await logCheck(userId);

      const preText = getPreCheckingText(stage);
      const wasAlready = isAlreadyPhrase(rawText);
      const progressMsg = getUnderTargetText(current, target, stage, wasAlready);

      if (current >= 3 && !flags.first) {
        flags.first = true;
        await sendSeparateDMs(message.author, preText, MILESTONE_3_MESSAGE);
        return;
      }

      if (current >= 8 && !flags.eight) {
        flags.eight = true;
        await sendSeparateDMs(message.author, preText, MILESTONE_8_MESSAGE);
        return;
      }

      await sendSeparateDMs(message.author, preText, progressMsg);
      return;
    }

    // Server Channels - Enforce matching target GUILD_ID exactly
    if (message.guild.id !== GUILD_ID) return;

    const content = message.content.trim();

    if (content.toLowerCase().startsWith("!resetinvites")) {
      if (!message.member?.permissions.has("ADMINISTRATOR")) return;

      const target = message.mentions.users.first();
      if (!target) {
        await message.reply("Usage: `!resetinvites @user`");
        return;
      }

      inviteCounts.delete(target.id);
      sentMilestones.delete(target.id);
      userConversationStage.delete(target.id);
      humanInquiryCount.delete(target.id);
      sentIntroMessage.delete(target.id);

      saveData();

      await logToCheckChannel(
        `♻️ Invites Reset\nUser: <@${target.id}>\nUser ID: ${target.id}\nReset by: <@${message.author.id}>`
      );
      await message.reply({
        content: `Reset tracked invites for <@${target.id}>.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (message.mentions.users.has(client.user.id)) {
      const userId = message.author.id;

      if (isHumanBotInquiry(content)) {
        const askCount = humanInquiryCount.get(userId) || 0;
        humanInquiryCount.set(userId, askCount + 1);

        if (askCount === 0) {
          await sendChannelMessage(message.channel, "lmao bro im real i just got like 50 dms rn 😭");
        } else {
          await sendChannelMessage(message.channel, "bruh im real just type fast bc i got a lot of dms");
        }
        return;
      }

      if (!isTriggerPhrase(content)) {
        if (!sentIntroMessage.has(userId)) {
          sentIntroMessage.add(userId);
          saveData();
          await sendChannelMessage(message.channel, "🎁 invite `3 people` to the server and the giftcard code is yours!");
        } else {
          const followUps = [
            "yeah go ahead, just come back when you've got the 3 invites",
            "swamped rn 😭 if ur claiming just get the 3 invites and hit me up when they're in"
          ];
          const followUpMsg = followUps[Math.floor(Math.random() * followUps.length)];
          await sendChannelMessage(message.channel, followUpMsg);
        }
        return;
      }

      const now = Date.now();
      if (now - (lastCheck.get(userId) || 0) < CHECK_COOLDOWN_MS) return;
      lastCheck.set(userId, now);

      let stage = userConversationStage.get(userId) || 0;
      userConversationStage.set(userId, stage + 1);

      const current = getCount(userId);
      const target = nextRequired(current);
      const flags = sentMilestones.get(userId) || { first: false, eight: false };
      sentMilestones.set(userId, flags);

      await logCheck(userId);

      const preText = getPreCheckingText(stage);
      const wasAlready = isAlreadyPhrase(content);
      const progressMsg = getUnderTargetText(current, target, stage, wasAlready);

      if (current >= 3 && !flags.first) {
        flags.first = true;
        await sendSeparateChannelMessages(message.channel, preText, MILESTONE_3_MESSAGE);
        return;
      }

      if (current >= 8 && !flags.eight) {
        flags.eight = true;
        await sendSeparateChannelMessages(message.channel, preText, MILESTONE_8_MESSAGE);
        return;
      }

      await sendSeparateChannelMessages(message.channel, preText, progressMsg);
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
                  
