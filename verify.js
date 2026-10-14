

const { 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    PermissionFlagsBits,
    ChannelType 
} = require('discord.js');


const guildConfig = require("./lib/guildConfig");
const { parseCommand, getPrefix } = require("./lib/prefix");

const pendingCaptchas = new Map(); // guildId:userId -> { answer, attempts, timeoutId }
const cooldowns = new Map();       // guildId:userId -> timestamp expiration
const deletedMessages = new Map(); // channelId -> Array of up to 15 deleted messages

module.exports = function(client) {
    // 1. Global Message Deletion Caching (Snipe System)
    client.on("messageDelete", (message) => {
        try {
            if (!message || !message.guild || message.author?.bot) return;

            const channelId = message.channel.id;
            if (!deletedMessages.has(channelId)) {
                deletedMessages.set(channelId, []);
            }

            const channelSnipes = deletedMessages.get(channelId);
            
            let content = message.content || "";
            if (message.stickers && message.stickers.size > 0) {
                const stickerNames = message.stickers.map(s => s.name).join(", ");
                content += ` [Sticker: ${stickerNames}]`;
            }
            if (!content.trim()) {
                content = "[Embed or Attachment]";
            }

            channelSnipes.unshift({
                author: message.author,
                content: content,
                image: message.attachments.first()?.proxyURL || null,
                time: Date.now()
            });

            if (channelSnipes.length > 15) {
                channelSnipes.pop();
            }
        } catch (error) {
            console.error("Error handling message deletion cache:", error);
        }
    });

    // 2. Snipe Command Listener with Manage Messages Filter and Navigation Buttons
    client.on("messageCreate", async (message) => {
        try {
            if (!message.guild || message.author.bot) return;

            const parsed = await parseCommand(message);
            if (!parsed) return;

            const { command, args } = parsed;

            if (command === "snipe") {
                if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                    return message.reply({ content: "❌ You do not have permission to use this command (Requires **Manage Messages**).", ephemeral: true }).catch(() => {});
                }

                const channelId = message.channel.id;
                const channelSnipes = deletedMessages.get(channelId);

                if (!channelSnipes || channelSnipes.length === 0) {
                    return message.reply("There are no recently deleted messages to snipe in this channel.").catch(() => {});
                }

                let currentIndex = 0;
                if (args[0] && !isNaN(args[0])) {
                    const parsedIndex = parseInt(args[0]) - 1;
                    if (parsedIndex >= 0 && parsedIndex < channelSnipes.length) {
                        currentIndex = parsedIndex;
                    }
                }

                const generateSnipeMessage = (index) => {
                    const sniped = channelSnipes[index];
                    const total = channelSnipes.length;

                    const timeString = new Date(sniped.time).toLocaleString("en-US", {
                        weekday: "long",
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                        hour12: true
                    });

                    const embed = new EmbedBuilder()
                        .setTitle("Sniped Message")
                        .addFields(
                            { name: "Content:", value: sniped.content, inline: false },
                            { name: "Author", value: sniped.author.username, inline: false },
                            { name: "Timestamp", value: timeString, inline: false }
                        )
                        .setFooter({ text: `Channel: #${message.channel.name} | Snipe #${index + 1}/${total}` });

                    if (sniped.image) {
                        embed.setImage(sniped.image);
                    }

                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId("snipe_first").setEmoji("⏮️").setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
                        new ButtonBuilder().setCustomId("snipe_prev").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(index === 0),
                        new ButtonBuilder().setCustomId("snipe_stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger),
                        new ButtonBuilder().setCustomId("snipe_next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(index === total - 1),
                        new ButtonBuilder().setCustomId("snipe_last").setEmoji("⏭️").setStyle(ButtonStyle.Secondary).setDisabled(index === total - 1)
                    );

                    return { embeds: [embed], components: [row] };
                };

                const sentMessage = await message.reply(generateSnipeMessage(currentIndex)).catch(() => {});
                if (!sentMessage) return;

                const collector = sentMessage.createMessageComponentCollector({ time: 60000 });

                collector.on("collect", async (interaction) => {
                    try {
                        if (interaction.user.id !== message.author.id) {
                            return interaction.reply({ content: "You cannot use these buttons.", ephemeral: true }).catch(() => {});
                        }

                        if (interaction.customId === "snipe_first") {
                            currentIndex = 0;
                        } else if (interaction.customId === "snipe_prev") {
                            if (currentIndex > 0) currentIndex--;
                        } else if (interaction.customId === "snipe_next") {
                            if (currentIndex < channelSnipes.length - 1) currentIndex++;
                        } else if (interaction.customId === "snipe_last") {
                            currentIndex = channelSnipes.length - 1;
                        } else if (interaction.customId === "snipe_stop") {
                            collector.stop();
                            await interaction.update({ components: [] }).catch(() => {});
                            return;
                        }

                        await interaction.update(generateSnipeMessage(currentIndex)).catch(() => {});
                    } catch (err) {
                        console.error("Error handling snipe interaction:", err);
                    }
                });

                collector.on("end", async () => {
                    try {
                        const disabledRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId("snipe_first").setEmoji("⏮️").setStyle(ButtonStyle.Secondary).setDisabled(true),
                            new ButtonBuilder().setCustomId("snipe_prev").setEmoji("◀️").setStyle(ButtonStyle.Secondary).setDisabled(true),
                            new ButtonBuilder().setCustomId("snipe_stop").setEmoji("⏹️").setStyle(ButtonStyle.Danger).setDisabled(true),
                            new ButtonBuilder().setCustomId("snipe_next").setEmoji("▶️").setStyle(ButtonStyle.Secondary).setDisabled(true),
                            new ButtonBuilder().setCustomId("snipe_last").setEmoji("⏭️").setStyle(ButtonStyle.Secondary).setDisabled(true)
                        );
                        await sentMessage.edit({ components: [disabledRow] }).catch(() => {});
                    } catch {}
                });
            }
        } catch (error) {
            console.error("Error in snipe command handler:", error);
        }
    });


    
    

    
    client.on('messageCreate', async message => {
        try {
            if (!message || message.author.bot || !message.guild) return;
            
            const parsed = await parseCommand(message);
            if (!parsed) return;

            const { command, args } = parsed;

            // ==================== VERIFICATION PANEL ====================
            // Roles/channels come from the config command (verifyChannel, verifiedRole, unverifiedRole).
            if (command === 'setupverify') {
                if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                    return await message.reply('❌ You need the **Manage Server** permission to deploy the verification panel.');
                }

                const result = await sendVerificationPanel(message.guild, message.client);
                return await message.reply(
                    result.ok
                        ? '✅ Verification panel deployed successfully.'
                        : `❌ ${result.error}`
                );
            }

            
            if (command === "role") {
                if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
                    const embed = new EmbedBuilder()
                        .setColor(0xe74c3c)
                        .setDescription("❌ You lack the **Manage Roles** permission required to execute this command.");
                    return message.reply({ embeds: [embed] });
                }

                if (!message.guild.members.me.permissions.has(PermissionFlagsBits.ManageRoles)) {
                    const embed = new EmbedBuilder()
                        .setColor(0xe74c3c)
                        .setDescription("❌ I lack the **Manage Roles** permission required to modify roles in this server.");
                    return message.reply({ embeds: [embed] });
                }

                const member = message.mentions.members.first();
                if (!member) {
                    const embed = new EmbedBuilder()
                        .setColor(0xe74c3c)
                        .setDescription("❌ Please mention a valid server member. Example: `role @username Members`");
                    return message.reply({ embeds: [embed] });
                }

                const roleQuery = args
                    .filter(arg => !arg.match(/<@!?\d+>/))
                    .join(" ")
                    .trim();

                if (!roleQuery) {
                    const embed = new EmbedBuilder()
                        .setColor(0xe74c3c)
                        .setDescription("❌ Please specify a target role name, ID, or mention. Example: `role @username Members`");
                    return message.reply({ embeds: [embed] });
                }

                const cleanedQuery = roleQuery.toLowerCase();
                const roleMentionId = roleQuery.replace(/[<@&>]/g, "");

                const role = 
                    message.guild.roles.cache.get(roleMentionId) || 
                    message.guild.roles.cache.find(r => r.name.toLowerCase() === cleanedQuery) ||
                    message.guild.roles.cache.find(r => r.name.toLowerCase().includes(cleanedQuery));

                if (!role) {
                    const embed = new EmbedBuilder()
                        .setColor(0xe74c3c)
                        .setDescription(`❌ Could not locate any matching role for \`${roleQuery}\`.`);
                    return message.reply({ embeds: [embed] });
                }

                if (member.permissions.has(PermissionFlagsBits.Administrator) && message.guild.ownerId !== message.author.id) {
                    const embed = new EmbedBuilder()
                        .setColor(0xe74c3c)
                        .setDescription("❌ You cannot modify roles for server administrators unless you are the server owner.");
                    return message.reply({ embeds: [embed] });
                }

                if (role.position >= message.guild.members.me.roles.highest.position) {
                    const embed = new EmbedBuilder()
                        .setColor(0xe74c3c)
                        .setDescription("❌ I cannot manage this role because it is positioned higher than or equal to my highest role.");
                    return message.reply({ embeds: [embed] });
                }

                if (role.position >= message.member.roles.highest.position && message.guild.ownerId !== message.author.id) {
                    const embed = new EmbedBuilder()
                        .setColor(0xe74c3c)
                        .setDescription("❌ You cannot manage this role because it is positioned higher than or equal to your own highest role.");
                    return message.reply({ embeds: [embed] });
                }

                if (member.roles.cache.has(role.id)) {
                    await member.roles.remove(role);
                    const embed = new EmbedBuilder()
                        .setColor(0xe74c3c)
                        .setDescription(`➖ **Role Removed:** Successfully revoked **${role.name}** from ${member}.`)
                        .setTimestamp();
                    return message.reply({ embeds: [embed] });
                } else {
                    await member.roles.add(role);
                    const embed = new EmbedBuilder()
                        .setColor(0x2ecc71)
                        .setDescription(`➕ **Role Added:** Successfully assigned **${role.name}** to ${member}.`)
                        .setTimestamp();
                    return message.reply({ embeds: [embed] });
                }
            }

        } catch (error) {
            console.error("Command Execution Error:", error);
            return message.reply("❌ An error occurred while attempting to process that command.").catch(() => {});
        }
    });

    
    client.on('interactionCreate', async interaction => {
        try {
            if (interaction.isButton()) {
                if (interaction.customId !== 'start_verify_btn') return;

                const userId = `${interaction.guildId}:${interaction.user.id}`;
                const now = Date.now();

                if (cooldowns.has(userId)) {
                    const expirationTime = cooldowns.get(userId);
                    if (now < expirationTime) {
                        const timeLeftMinutes = Math.ceil((expirationTime - now) / 1000 / 60);
                        return interaction.reply({ 
                            content: `❌ Security Cooldown Active: You have exceeded maximum failed attempts. Please try again in approximately **${timeLeftMinutes} minute(s)**.`, 
                            ephemeral: true 
                        });
                    } else {
                        cooldowns.delete(userId);
                    }
                }

                if (pendingCaptchas.has(userId)) {
                    return interaction.reply({ 
                        content: `⚠️ You already have an active verification session pending. Please complete the open modal prompt or wait for it to time out.`, 
                        ephemeral: true 
                    });
                }

                
                const operators = ['+', '-', '*'];
                const operator = operators[Math.floor(Math.random() * operators.length)];
                let num1, num2, correctAnswer;

                if (operator === '+') {
                    num1 = Math.floor(Math.random() * 12) + 1;
                    num2 = Math.floor(Math.random() * 12) + 1;
                    correctAnswer = num1 + num2;
                } else if (operator === '-') {
                    num1 = Math.floor(Math.random() * 12) + 5;
                    num2 = Math.floor(Math.random() * num1) + 1;
                    correctAnswer = num1 - num2;
                } else {
                    num1 = Math.floor(Math.random() * 8) + 1;
                    num2 = Math.floor(Math.random() * 5) + 1;
                    correctAnswer = num1 * num2;
                }

                const timeoutId = setTimeout(() => {
                    if (pendingCaptchas.has(userId)) {
                        pendingCaptchas.delete(userId);
                    }
                }, 60000);

                pendingCaptchas.set(userId, {
                    answer: correctAnswer,
                    attempts: 0,
                    timeoutId: timeoutId
                });

                const modal = new ModalBuilder()
                    .setCustomId('verify_modal')
                    .setTitle('Security Checkpoint');

                const mathInput = new TextInputBuilder()
                    .setCustomId('math_answer_input')
                    .setLabel(`Solve: What is ${num1} ${operator} ${num2}?`)
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('Enter numeric answer...')
                    .setRequired(true);

                const row = new ActionRowBuilder().addComponents(mathInput);
                modal.addComponents(row);

                await interaction.showModal(modal);

            } else if (interaction.isModalSubmit()) {
                if (interaction.customId !== 'verify_modal') return;

                await interaction.deferReply({ ephemeral: true });

                const userId = `${interaction.guildId}:${interaction.user.id}`;
                const userCaptcha = pendingCaptchas.get(userId);

                if (!userCaptcha) {
                    return interaction.editReply({ content: '❌ Verification session expired or not found. Please click the verify button again.' });
                }

                const rawInput = interaction.fields.getTextInputValue('math_answer_input').trim();
                const numericValue = Number(rawInput);

                if (!rawInput || !Number.isInteger(numericValue)) {
                    userCaptcha.attempts += 1;
                    
                    if (userCaptcha.attempts >= 3) {
                        clearTimeout(userCaptcha.timeoutId);
                        pendingCaptchas.delete(userId);
                        cooldowns.set(userId, Date.now() + (5 * 60 * 1000));
                        return interaction.editReply({ content: '❌ Invalid input format. You have exhausted your 3 attempts and are temporarily locked out for **5 minutes**.' });
                    }

                    const attemptsLeft = 3 - userCaptcha.attempts;
                    return interaction.editReply({ content: `❌ Invalid numeric value provided. You have **${attemptsLeft} attempt(s)** remaining.` });
                }

                if (numericValue === userCaptcha.answer) {
                    clearTimeout(userCaptcha.timeoutId);
                    pendingCaptchas.delete(userId);
                    cooldowns.delete(userId);

                    const member = interaction.member;
                    const guild = interaction.guild;

                    const cfg = await guildConfig.get(guild.id);

                    const verifiedRole = cfg.verifiedRole
                        ? guild.roles.cache.get(cfg.verifiedRole)
                        : null;

                    const unverifiedRole = cfg.unverifiedRole
                        ? guild.roles.cache.get(cfg.unverifiedRole)
                        : null;

                    if (!verifiedRole) {
                        return interaction.editReply({ content: `❌ Verification is not set up yet: an admin needs to run \`${await getPrefix(guild.id)}config set verifiedRole @role\`.` });
                    }

                    if (member.roles.cache.has(verifiedRole.id)) {
                        return interaction.editReply({ content: 'ℹ️ You are already verified in this server!' });
                    }

                    await member.roles.add(verifiedRole).catch(err => console.error("Failed adding verified role:", err));
                    if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
                        await member.roles.remove(unverifiedRole).catch(err => console.error("Failed removing unverified role:", err));
                    }

                    await interaction.editReply({ content: '✅ Correct! Verification successful. Server access granted.' });

                    {
                        const logChannel = await guildConfig.getLogChannel(guild);
                        if (logChannel) {
                            const logEmbed = new EmbedBuilder()
                                .setTitle('User Verification Succeeded')
                                .setDescription(`**${member.user.tag}** (\`${member.id}\`) successfully solved the math CAPTCHA and obtained access.`)
                                .setColor(0x2ecc71)
                                .setTimestamp();
                            await logChannel.send({ embeds: [logEmbed] }).catch(() => {});
                        }
                    }

                } else {
                    userCaptcha.attempts += 1;

                    if (userCaptcha.attempts >= 3) {
                        clearTimeout(userCaptcha.timeoutId);
                        pendingCaptchas.delete(userId);
                        cooldowns.set(userId, Date.now() + (5 * 60 * 1000));

                        {
                            const logChannel = await guildConfig.getLogChannel(interaction.guild);
                            if (logChannel) {
                                const logEmbed = new EmbedBuilder()
                                    .setTitle('User Verification Failed')
                                    .setDescription(`**${interaction.user.tag}** (\`${interaction.user.id}\`) failed the CAPTCHA 3 times and is locked out for 5 minutes.`)
                                    .setColor(0xe74c3c)
                                    .setTimestamp();
                                await logChannel.send({ embeds: [logEmbed] }).catch(() => {});
                            }
                        }

                        return interaction.editReply({ content: '❌ Incorrect answer. You have failed 3 times and are temporarily locked out for **5 minutes**.' });
                    }

                    const attemptsLeft = 3 - userCaptcha.attempts;
                    return interaction.editReply({ content: `❌ Incorrect answer! You have **${attemptsLeft} attempt(s)** remaining. Click the verify button again to try a new question.` });
                }
            }
        } catch (error) {
            console.error("Interaction execution error:", error);
            if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ An unexpected error occurred while processing your request.', ephemeral: true }).catch(() => {});
            }
        }
    });
};

// Helper function to send or edit the verification panel
async function sendVerificationPanel(guild, client) {
    try {
        const cfg = await guildConfig.get(guild.id);

        if (!cfg.verifyChannel) {
            return { ok: false, error: `No verify channel is set. Run \`${await getPrefix(guild.id)}config set verifyChannel #channel\` first.` };
        }

        if (!cfg.verifiedRole) {
            return { ok: false, error: `No verified role is set. Run \`${await getPrefix(guild.id)}config set verifiedRole @role\` first.` };
        }

        const channel = await guildConfig.resolveChannel(guild, cfg.verifyChannel);
        if (!channel || !channel.isTextBased()) {
            return { ok: false, error: 'I can\'t access the configured verify channel.' };
        }

        const embed = new EmbedBuilder()
            .setTitle('Server Verification Checkpoint')
            .setDescription('Click the **Verify** button below to complete a quick mathematical safety CAPTCHA and unlock the server channels.')
            .setColor(0x2ecc71)
            .setTimestamp();

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('start_verify_btn')
                    .setLabel('Verify')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✅')
            );

        const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
        if (messages) {
            const existingPanel = messages.find(m => m.author.id === client.user.id && m.components.length > 0);
            if (existingPanel) {
                await existingPanel.edit({ embeds: [embed], components: [row] });
                return { ok: true };
            }
        }

        await channel.send({ embeds: [embed], components: [row] });
        return { ok: true };
    } catch (error) {
        console.error('Error deploying verification panel:', error);
        return { ok: false, error: 'Something went wrong while posting the panel (check my permissions in that channel).' };
    }
}
