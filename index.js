client.on("messageCreate", async (message) => {
  try {
    // Ignore ALL bot messages AND messages sent by this selfbot account
    if (message.author.bot || message.author.id === client.user.id) return;

    // Direct Messages (DMs)
    if (!message.guild) {
      if (typeof message.channel.accept === "function") {
        await message.channel.accept().catch(() => null);
      }

      const userId = message.author.id;
      const rawText = message.content.trim();
      const lowerText = rawText.toLowerCase();

      // Check for human/bot questions
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

      // Scam/proof detection
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

      // Unrelated Messages Flow
      if (!isTriggerPhrase(rawText)) {
        if (stage === 0) {
          await sendDM(message.author, "🎁 invite `3 people` to the server and the giftcard code is yours!");
          userConversationStage.set(userId, 1);
        } else if (stage === 1) {
          await sendDM(message.author, "yeah go ahead, just come back when you've got the 3 invites");
          userConversationStage.set(userId, 2);
        } else {
          await sendDM(
            message.author,
            "swamped rn 😭 if ur claiming just get the 3 invites and hit me up when they're in. you will get rewards do invites fast I'm waiting for you"
          );
        }
        return;
      }

      // Trigger Phrase / Invite Check Flow
      userConversationStage.set(userId, stage + 1);
      const current = getCount(userId);
      const target = nextRequired(current);
      const flags = sentMilestones.get(userId) || { first: false, eight: false };
      sentMilestones.set(userId, flags);

      await logCheck(userId);

      const preText = getPreCheckingText(stage);
      const wasAlready = isAlreadyPhrase(rawText);
      const progressMsg = getUnderTargetText(current, target, stage, wasAlready);

      // Milestone 1 (3 Invites)
      if (current >= 3 && !flags.first) {
        flags.first = true;
        await sendDM(message.author, `${preText}\n\n${MILESTONE_3_MESSAGE}`);
        return;
      }

      // Milestone 2 (8 Invites)
      if (current >= 8 && !flags.eight) {
        flags.eight = true;
        await sendDM(message.author, `${preText}\n\n${MILESTONE_8_MESSAGE}`);
        return;
      }

      await sendDM(message.author, `${preText}\n${progressMsg}`);
      return;
    }

    // Server Channels
    if (message.guild.id !== GUILD_ID) return;

    const content = message.content.trim();

    // Admin reset command
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

      await logToCheckChannel(
        `♻️ Invites Reset\nUser: <@${target.id}>\nUser ID: ${target.id}\nReset by: <@${message.author.id}>`
      );
      await message.reply({
        content: `Reset tracked invites for <@${target.id}>.`,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Channel Mentions Trigger
    if (message.mentions.users.has(client.user.id)) {
      const userId = message.author.id;

      // Check human/bot inquiry via channel mention
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

      if (!isTriggerPhrase(content)) return;

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

      // Milestone 1 (3 Invites)
      if (current >= 3 && !flags.first) {
        flags.first = true;
        await sendChannelMessage(message.channel, `${preText}\n\n${MILESTONE_3_MESSAGE}`);
        return;
      }

      // Milestone 2 (8 Invites)
      if (current >= 8 && !flags.eight) {
        flags.eight = true;
        await sendChannelMessage(message.channel, `${preText}\n\n${MILESTONE_8_MESSAGE}`);
        return;
      }

      await sendChannelMessage(message.channel, `${preText}\n${progressMsg}`);
    }
  } catch (err) {
    console.error("Message handling error:", err.message);
  }
});
