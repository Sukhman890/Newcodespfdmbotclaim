"use strict";

// Swapped to selfbot library to support personal account tokens
const { Client } = require("discord.js-selfbot-v13");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const { DISCORD_TOKEN, GUILD_ID, FALCON_ID, CHECK_CHANNEL_ID } = process.env;

const missing = ["DISCORD_TOKEN", "GUILD_ID", "FALCON_ID", "CHECK_CHANNEL_ID"].filter(
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

const CHECK_COOLDOWN_MS = 10_000;
let checkChannel = null;

// ---------------------------------------------------------------------------
// Client Initialization (No Intents for User Accounts)
// ---------------------------------------------------------------------------
const client = new Client({
  checkUpdate: false,
});

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

function isMilestone(count) {
  return count === 3 || (count >= 8 && (count - 8) % 3 === 0);
}

function getStatus(userId) {
  const current = getCount(userId);
  const next = nextRequired(current);
  const remaining = Math.max(0, next - current);
  return { current, next, remaining };
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

function buildMentionDM(userId) {
  const { current, next, remaining } = getStatus(userId);
  let line;
  if (current === 3) {
    line = `showing 3 invite(s) — first step complete.`;
  } else if (current >= 8 && isMilestone(current)) {
    line = `showing ${current} invite(s) — milestone reached.`;
  } else if (remaining === 1) {
    line = `showing ${current} invite(s), get to ${next} and ur good`;
  } else if (current > 0 && current < 3) {
    line = `showing ${current} invite(s) lol, just need ${remaining} more`;
  } else if (current === 0) {
    line = `showing 0 invite(s), need ${remaining} to get started`;
  } else {
    line = `showing ${current} invite(s), just need ${remaining} more`;
  }
  return `checking rq...\n\n${line}`;
}

function buildInvitesCommandDM(userId) {
  const { current, next, remaining } = getStatus(userId);
  return (
    `📊 Invite Check\n\n` +
    `You currently have: ${current} valid invites\n` +
    `🎯 Next milestone: ${next}\n` +
    `👥 Remaining: ${remaining}`
  );
}

const MILESTONE_3_MESSAGE =
  "# 🧑‍🌾 Thanks for INVITING! I appreciate you for giving your time.\n\n" +
  "💫 Either wait `2 weeks` to claim or get **5 EXTRA INVITES** to the server for an **INSTANT CLAIM.** ⚡\n\n" +
  "> ❤️ - We have this system to prevent people from abusing our systems because it has happened several times.";

const MILESTONE_8_MESSAGE =
  "👋 hey, sorry for the delay!\n" +
  "just checked ur invites on the bot and everything looks good! great job\n\n" +
  "you're so close to getting the reward. before i send it tho, could u invite **3 more people** to the server? ❄️\n\n" +
  "i wanna be fair, but with so many ppl messaging me, im giving it to whoever does this extra step! once ur done, dm me back and i'll send it immediately, no waiting!";

async function maybeSendMilestones(user, count) {
  const flags = sentMilestones.get(user.id) || { first: false, eight: false };
  sentMilestones.set(user.id, flags);

  if (count >= 3 && !flags.first) {
    if (await sendDM(user, MILESTONE_3_MESSAGE)) flags.first = true;
  }
  if (count >= 8 && !flags.eight) {
    if (await sendDM(user, MILESTONE_8_MESSAGE)) flags.eight = true;
  }
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
    console.error("Invite fetch failed (Account needs 'Manage Server' permission):", err.message);
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

  if (member.user.bot) return;
  if (!used || !used.inviterId) return;

  const inviterId = used.inviterId;
  if (inviterId === client.user.id) return;
  if (inviterId === member.id) return;
  if (countedMembers.has(member.id)) return;

  countedMembers.set(member.id, inviterId);
  if (!inviteCounts.has(inviterId)) inviteCounts.set(inviterId, new Set());
  inviteCounts.get(inviterId).add(member.id);

  const count = getCount(inviterId);

  if (count === 3 || count === 8) {
    try {
      const inviter = await client.users.fetch(inviterId);
      if (inviter.bot) return;
      await maybeSendMilestones(inviter, count);
    } catch (err) {
      console.error("Milestone delivery failed:", err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Invite check flow
// ---------------------------------------------------------------------------
async function logCheck(userId) {
  const { current, next, remaining } = getStatus(userId);
  await logToCheckChannel(
    `🔎 Invite Check\n` +
      `User: <@${userId}>\n` +
      `User ID: ${userId}\n` +
      `Current valid invites: ${current}\n` +
      `Next milestone: ${next}\n` +
      `Remaining: ${remaining}`
  );
}

async function runCheck(message, dmText) {
  const user = message.author;

  await logCheck(user.id);

  const delivered = await sendDM(user, dmText(user.id));
  if (!delivered) {
    try {
      await message.channel.send(
        "I couldn't DM you — please enable DMs from this server and mention me again."
      );
    } catch (err) {
      console.error("Could not send DM-failure notice:", err.message);
    }
    return;
  }

  await maybeSendMilestones(user, getCount(user.id));
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
    if (!guild) {
      console.error("Configured guild is not available to the account. Exiting.");
      process.exit(1);
    }

    const channel = await guild.channels.fetch(CHECK_CHANNEL_ID).catch(() => null);
    
    // Fixed compatibility for channel type check
    if (!channel || (channel.type !== "GUILD_TEXT" && !channel.isText())) {
      console.error("Private check channel not found or not a text channel. Exiting.");
      process.exit(1);
    }
    checkChannel = channel;

    try {
      await refreshInviteCache(guild);
    } catch (err) {
      console.error("Initial invite fetch failed (Manage Server permission needed):", err.message);
    }

    console.log(`Account connected as ${client.user.tag}`);
  } catch (err) {
    console.error("Startup failed:", err.message);
    process.exit(1);
  }
});

client.on("inviteCreate", (invite) => {
  if (!invite.guild || invite.guild.id !== GUILD_ID) return;
  inviteCache.set(invite.code, snapshot(invite));
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

    const content = message.content.trim();

    // -----------------------------------------------------------------------
    // Direct Messages (DMs)
    // -----------------------------------------------------------------------
    if (!message.guild) {
      const now = Date.now();
      if (now - (lastCheck.get(message.author.id) || 0) < CHECK_COOLDOWN_MS) return;
      lastCheck.set(message.author.id, now);

      await runCheck(message, buildMentionDM);
      return;
    }

    // -----------------------------------------------------------------------
    // Server Channels
    // -----------------------------------------------------------------------
    if (message.guild.id !== GUILD_ID) return;

    // !resetinvites @user
    if (content.toLowerCase().startsWith("!resetinvites")) {
      if (!message.member?.permissions.has("ADMINISTRATOR")) return;

      const target = message.mentions.users.first();
      if (!target) {
        await message.reply("Usage: `!resetinvites @user`");
        return;
      }

      inviteCounts.delete(target.id);
      sentMilestones.delete(target.id);

      await logToCheckChannel(
        `♻️ Invites Reset\nUser: <@${target.id}>\nUser ID: ${target.id}\nReset by: <@${message.author.id}>`
      );
      await message.reply({
        content: `Reset tracked invites for <@${target.id}>.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // !invites
    if (content.toLowerCase() === "!invites") {
      await runCheck(message, buildInvitesCommandDM);
      return;
    }

    // Account mention
    if (message.mentions.users.has(client.user.id)) {
      const now = Date.now();
      if (now - (lastCheck.get(message.author.id) || 0) < CHECK_COOLDOWN_MS) return;
      lastCheck.set(message.author.id, now);

      await message.channel.send("sec, checking ur invites on the bot...");
      await runCheck(message, buildMentionDM);
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
                                            
