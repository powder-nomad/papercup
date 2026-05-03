import "dotenv/config";
import {
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error("Missing DISCORD_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID in .env");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("pickup")
    .setDescription("Pick up the cup — start a new conversation")
    .addStringOption((o) =>
      o.setName("name").setDescription("Optional name for this session").setRequired(false).setMaxLength(60),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("hangup")
    .setDescription("Hang up — bot leaves the voice channel; session is preserved")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Resume an existing session by name")
    .addStringOption((o) =>
      o.setName("name").setDescription("Name of session to resume").setRequired(true).setMaxLength(60),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("sessions")
    .setDescription("List recent sessions")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("rename")
    .setDescription("Rename the current session")
    .addStringOption((o) =>
      o.setName("name").setDescription("New name").setRequired(true).setMaxLength(60),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("say")
    .setDescription("Make the bot speak the given text into the active voice channel")
    .addStringOption((o) =>
      o.setName("text").setDescription("What to say").setRequired(true).setMaxLength(500),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("bind")
    .setDescription("(Admin) Bind the bot to a text channel — every message there becomes a prompt")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Channel to bind")
        .setRequired(true)
        .addChannelTypes(ChannelType.GuildText),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("unbind")
    .setDescription("(Admin) Unbind the bot — falls back to @mention triggers across all channels")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(token);

try {
  console.log(`Registering ${commands.length} guild commands…`);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log("Done.");
} catch (err) {
  console.error("Failed to register commands:", err);
  process.exit(1);
}
