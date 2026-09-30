"use strict";

const { Client } = require("discord.js-selfbot-v13");

// ---------------------------------------------------------------------------
// Global Error Handlers (Prevents silent crashes)
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Promise Rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

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
// In-memory runtime state
// ---------------------------------------------------------------------------
const lastCheck = new Map();
const userConversationStage = new Map();
const humanInquiryCount = new Map();
const sentMilestones = new Map();

const CHECK_COOLDOWN_MS = 5_000;
const RESPONSE_DELAY_MS = 15_000;
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
// Client Initialization with Safe Intents
// ---------------------------------------------------------------------------
const client = new Client({
  checkUpdate: false,
  intents: [
    "GUILDS",
    "GUILD_MESSAGES",
    "DIRECT_MESSAGES",
    "GUILD_MEMBERS"
  ]
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getRealInviteCount(guild, userId) {
  try {
    const invites = await guild.invites.fetch();
    let totalUses = 0;

    for (const invite of invites.values()) {
      if (invite.inviter && invite.inviter.id === userId) {
        totalUses += invite.uses || 0;
      }
    }
    return totalUses;
  } catch (err) {
    console.error("Failed to fetch guild invites:", err.message);
    return 0;
  }
}

function nextRequired(count) {
  if (count < 3) return 3;
  if (count < 8) return 8;
  return 8 + 3 * (Math.floor((count - 8) / 3) + 1);
}

async function sendDM(user, text) {
  try {
    await delay(RESPONSE_DELAY_MS);
    await user.send(text);
    return true;
  } catch (err) {
    console.error("Failed to send DM:", err.message);
    return false;
  }
}

async function sendSeparateDMs(user, text1, text2) {
  try {
    await delay(RESPONSE_DELAY_MS);
    await user.send(text1);
    await delay(2000);
    await user.send(text2);
    return true;
  } catch (err) {
    console.error("Failed to send separate DMs:", err.message);
    return false;
  }
}

async function sendChannelMessage(channel, text) {
  try {
    await delay(RESPONSE_DELAY_MS);
    await channel.send(text);
    return true;
  } catch (err) {
    console.error("Failed to send channel message:", err.message);
    return false;
  }
}

async function sendSeparateChannelMessages(channel, text1, text2) {
  try {
    await delay(RESPONSE_DELAY_MS);
    await channel.send(text1);
    await delay(2000);
    await channel.send(text2);
    return true;
  } catch (err) {
    console.error("Failed to send separate channel messages:", err.message);
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

function isLegitimacyInquiry(text) {
  const lower = text.toLowerCase().trim();
  return (
    lower.includes("fake") ||
    lower.includes("legit") ||
    lower.includes("proof") ||
    lower.includes("scam") ||
    lower.includes("real")
  );
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
  "> ❤️ - We have this system to prevent people from abusing our systems because it has happened several times.";

const MILESTONE_8_MESSAGE =
  "👋 hey, sorry for the delay!\n" +
  "just checked ur invites on the bot and everything looks good! great job\n" +
  "you're so close to getting the reward. we only have a few left in stock but i saved one just for u! before i send it tho, could u invite **3 more people** to the server? ❄️\n" +
  "i wanna be fair, but with so many ppl messaging me, im giving it to whoever does this extra step! once ur done, dm me back and i'll send it immediately, no waiting!";

async function logCheck(userId, current) {
  const target = nextRequired(current);
  const remaining = Math.max(0, target - current);
  await logToCheckChannel(
    `🔎 Invite Check\n` +
      `User: <@${userId}>\n` +
      `User ID: ${userId}\n` +
      `Current valid invites: ${current}\n` +
      `Next milestone: ${target}\n` +
      `Remaining: ${remaining}`
  );
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

    console.log(`Account connected successfully as ${client.user.tag}`);
  } catch (err) {
    console.error("Startup failed:", err.message);
    process.exit(1);
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot || message.author.id === client.user.id) return;

    // Direct Messages (DMs)
    if (!message.guild) {
      // Automatically accept message requests if the function exists
      if (typeof message.channel.accept === "function") {
        await message.channel.accept().catch(() => {});
      }

      const userId = message.author.id;
      const rawText = message.content.trim();

      // 1. Handle Human/Bot Inquiry
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

      // 2. Handle Legitimacy / Scam Inquiry
      if (isLegitimacyInquiry(rawText)) {
        await sendDM(
          message.author,
          "ngl https://discord.com/channels/1268246037844201483/1496153079060365322, tons of people already got paid"
        );
        return;
      }

      // 3. Handle Invite Trigger Phrases
      if (isTriggerPhrase(rawText)) {
        const now = Date.now();
        if (now - (lastCheck.get(userId) || 0) < CHECK_COOLDOWN_MS) return;
        lastCheck.set(userId, now);

        let stage = userConversationStage.get(userId) || 0;
        userConversationStage.set(userId, stage + 1);

        const current = targetGuild ? await getRealInviteCount(targetGuild, userId) : 0;
        const target = nextRequired(current);
        const flags = sentMilestones.get(userId) || { first: false, eight: false };
        sentMilestones.set(userId, flags);

        await logCheck(userId, current);

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

      return;
    }

    // Server Channels - Enforce matching target GUILD_ID and user mentioning the bot
    if (message.guild.id !== GUILD_ID) return;

    if (message.mentions.users.has(client.user.id)) {
      const userId = message.author.id;
      const content = message.content.trim();

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

      if (isTriggerPhrase(content)) {
        const now = Date.now();
        if (now - (lastCheck.get(userId) || 0) < CHECK_COOLDOWN_MS) return;
        lastCheck.set(userId, now);

        let stage = userConversationStage.get(userId) || 0;
        userConversationStage.set(userId, stage + 1);

        const current = await getRealInviteCount(targetGuild, userId);
        const target = nextRequired(current);
        const flags = sentMilestones.get(userId) || { first: false, eight: false };
        sentMilestones.set(userId, flags);

        await logCheck(userId, current);

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
  
