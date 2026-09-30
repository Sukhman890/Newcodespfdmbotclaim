"use strict";

const { Client } = require("discord.js-selfbot-v13");

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
// In-memory state
// ---------------------------------------------------------------------------
let inviteCache = new Map();
const inviteCounts = new Map();
const countedMembers = new Map();
const sentMilestones = new Map();
const lastCheck = new Map();
const userConversationStage = new Map(); // Tracks dynamic chat stages per user

const CHECK_COOLDOWN_MS = 5_000;
let checkChannel = null;

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

async function sendDM(user, text) {
  try {
    await user.send(text);
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

// ---------------------------------------------------------------------------
// Dynamic Response Formatters matching Cherpl Flow
// ---------------------------------------------------------------------------
function getPreCheckingText(stage) {
  const variations = [
    "sec, checking ur invites on the bot...",
    "one sec lemme check...",
    "checking rq..."
  ];
  return variations[stage % variations.length];
}

function getUnderTargetText(current, target, stage) {
  const remaining = Math.max(0, target - current);
  
  if (target === 3) {
    const texts = [
      `ur at ${current} rn, get ${remaining} more and ur good`,
      `u only got ${current} rn bro, need ${target} to unlock — almost there`,
      `showing ${current} invite(s) lol, just need ${remaining} more`
    ];
    return texts[stage % texts.length];
  } else {
    const texts = [
      `checked and u got ${current}, need ${target} to reserve ur prize. almost there bro`,
      `showing ${current} rn lol, get to ${target} and i lock ur payout in`,
      `showing ${current} rn lol, get to ${target} and i lock ur payout in`
    ];
    return texts[stage % texts.length];
  }
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
// Invite detection
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

  const inviterId = used.inviterId;
  if (inviterId === client.user.id || inviterId === member.id || countedMembers.has(member.id)) return;

  countedMembers.set(member.id, inviterId);
  if (!inviteCounts.has(inviterId)) inviteCounts.set(inviterId, new Set());
  inviteCounts.get(inviterId).add(member.id);
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

    const channel = await guild.channels.fetch(CHECK_CHANNEL_ID).catch(() => null);
    if (!channel || (channel.type !== "GUILD_TEXT" && !channel.isText())) {
      console.error("Private check channel not found or invalid. Exiting.");
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
  joinQueue = joinQueue
    .then(() => handleJoin(member))
    .catch((err) => console.error("Join handling error:", err.message));
});

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    // Direct Messages (DMs)
    if (!message.guild) {
      if (typeof message.channel.accept === "function") {
        await message.channel.accept().catch(() => null);
      }

      const userId = message.author.id;
      const lowerText = message.content.toLowerCase().trim();

      // Check fake/legit proof detection
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

      const now = Date.now();
      if (now - (lastCheck.get(userId) || 0) < CHECK_COOLDOWN_MS) return;
      lastCheck.set(userId, now);

      let stage = userConversationStage.get(userId) || 0;

      // Initial Conversational Warmup Sequence
      if (stage === 0) {
        await sendDM(message.author, "🎁 invite `3 people` to the server and the giftcard code is yours!");
        userConversationStage.set(userId, 1);
        return;
      }

      if (stage === 1) {
        await sendDM(message.author, "yeah go ahead, just come back when you've got the 3 invites");
        userConversationStage.set(userId, 2);
        return;
      }

      if (stage === 2 && !lowerText.includes("done") && !lowerText.includes("invite") && !lowerText.includes("check")) {
        await sendDM(message.author, "swamped rn 😭 if ur claiming just get the 3 invites and hit me up when they're in");
        userConversationStage.set(userId, 3);
        return;
      }

      // Check Invites Logic & Milestone handling
      userConversationStage.set(userId, stage + 1);
      const current = getCount(userId);
      const target = nextRequired(current);
      const flags = sentMilestones.get(userId) || { first: false, eight: false };
      sentMilestones.set(userId, flags);

      await logCheck(userId);

      // Send the pre-checking status phrase
      const preText = getPreCheckingText(stage);
      await sendDM(message.author, preText);

      // Milestone 1 (3 Invites)
      if (current >= 3 && !flags.first) {
        flags.first = true;
        await sendDM(message.author, MILESTONE_3_MESSAGE);
        return;
      }

      // Milestone 2 (8 Invites)
      if (current >= 8 && !flags.eight) {
        flags.eight = true;
        await sendDM(message.author, MILESTONE_8_MESSAGE);
        return;
      }

      // Progress Check Response if under required milestone target
      const progressMsg = getUnderTargetText(current, target, stage);
      await sendDM(message.author, progressMsg);
      return;
    }

    // Server Channel Command Handlers
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

      await logToCheckChannel(
        `♻️ Invites Reset\nUser: <@${target.id}>\nUser ID: ${target.id}\nReset by: <@${message.author.id}>`
      );
      await message.reply({
        content: `Reset tracked invites for <@${target.id}>.`,
        allowedMentions: { parse: [] },
      });
    }
  } catch (err) {
    console.error("Message handling error:", err.message);
  }
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
client.login(DISCORD_TOKEN).catch((err) => {
  console.error("Login failed (invalid personal token?):", err.message);
  process.exit(1);
});
  
