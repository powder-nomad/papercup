import "dotenv/config";
import {
  REST,
  Routes,
  SlashCommandBuilder,
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
    .setDescription("Pick up the cup — start a new conversation (voice or text)")
    .addStringOption((o) =>
      o.setName("name").setDescription("Optional name for this session").setRequired(false).setMaxLength(60),
    )
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("voice (default; joins your voice channel) or text (no voice join)")
        .setRequired(false)
        .addChoices({ name: "voice", value: "voice" }, { name: "text", value: "text" }),
    )
    .addStringOption((o) =>
      o
        .setName("model")
        .setDescription("Agent model id (e.g. claude-opus-4-7). Falls back to AGENT_MODEL env.")
        .setRequired(false)
        .setMaxLength(80),
    )
    .addStringOption((o) =>
      o
        .setName("effort")
        .setDescription("Reasoning effort (high uses more thinking tokens, slower but smarter)")
        .setRequired(false)
        .addChoices(
          { name: "minimal", value: "minimal" },
          { name: "low", value: "low" },
          { name: "medium", value: "medium" },
          { name: "high", value: "high" },
          { name: "xhigh (Opus only)", value: "xhigh" },
          { name: "max (Opus only)", value: "max" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("permission-mode")
        .setDescription("Tool permission policy. Default: text=bypassPermissions, voice=default.")
        .setRequired(false)
        .addChoices(
          { name: "default (prompt; will hang in piped stdio!)", value: "default" },
          { name: "acceptEdits (auto-allow edits)", value: "acceptEdits" },
          { name: "auto (auto-mode classifier)", value: "auto" },
          { name: "bypassPermissions (skip all checks; vibecoding)", value: "bypassPermissions" },
          { name: "plan (read-only planning)", value: "plan" },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("hangup")
    .setDescription("Hang up — bot leaves the voice channel; session is preserved")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("cancel")
    .setDescription("Abort the in-flight agent turn for the active session")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show the active session's config + currently-running extensions")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("new")
    .setDescription("Start a fresh session in the active container, inheriting model/effort/permissions")
    .addStringOption((o) =>
      o.setName("name").setDescription("Optional name for the new session").setRequired(false).setMaxLength(60),
    )
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
    .setDescription("(Admin) Bind THIS channel to a session — every message here routes to that session")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o
        .setName("session")
        .setDescription("Session name to bind to this channel")
        .setRequired(true)
        .setMaxLength(60),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("unbind")
    .setDescription("(Admin) Unbind THIS channel — bot reverts to @mention triggers here")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Set the agent model for the active session (e.g. claude-opus-4-7)")
    .addStringOption((o) =>
      o
        .setName("name")
        .setDescription("Model id (claude-opus-4-7, claude-sonnet-4-6, haiku, …). Leave blank to clear override.")
        .setRequired(false)
        .setMaxLength(80),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("effort")
    .setDescription("Set the reasoning effort for the active session")
    .addStringOption((o) =>
      o
        .setName("level")
        .setDescription("Reasoning effort. 'default' clears the override.")
        .setRequired(true)
        .addChoices(
          { name: "minimal", value: "minimal" },
          { name: "low", value: "low" },
          { name: "medium", value: "medium" },
          { name: "high", value: "high" },
          { name: "xhigh (Opus only)", value: "xhigh" },
          { name: "max (Opus only)", value: "max" },
          { name: "default", value: "default" },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("mcp")
    .setDescription("Enable/disable MCP servers' tools for the active session")
    .addStringOption((o) =>
      o
        .setName("action")
        .setDescription("enable, disable, or list")
        .setRequired(true)
        .addChoices(
          { name: "enable", value: "enable" },
          { name: "disable", value: "disable" },
          { name: "list", value: "list" },
        ),
    )
    .addStringOption((o) =>
      o
        .setName("name")
        .setDescription("MCP server name (e.g. plugin:ecc:playwright). Required for enable/disable.")
        .setRequired(false)
        .setMaxLength(120),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("permissions")
    .setDescription("Set the tool permission policy for the active session")
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("Permission mode. 'default-for-mode' clears the override.")
        .setRequired(true)
        .addChoices(
          { name: "default", value: "default" },
          { name: "acceptEdits", value: "acceptEdits" },
          { name: "auto", value: "auto" },
          { name: "bypassPermissions", value: "bypassPermissions" },
          { name: "plan (read-only)", value: "plan" },
          { name: "default-for-mode (clear override)", value: "default-for-mode" },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("notify")
    .setDescription("Toggle TTS notification when a spawned extension finishes")
    .addStringOption((o) =>
      o
        .setName("state")
        .setDescription("on or off")
        .setRequired(true)
        .addChoices({ name: "on", value: "on" }, { name: "off", value: "off" }),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("streaming")
    .setDescription("Show or set live progress streaming for this text session")
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("Off, summary (one sticky message), or full (reserved)")
        .setRequired(false)
        .addChoices(
          { name: "off", value: "off" },
          { name: "summary (sticky, latest activity)", value: "summary" },
          { name: "full (sticky, last 8 events scrolling)", value: "full" },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("backend")
    .setDescription("Show or switch the agent backend for this session")
    .addStringOption((o) =>
      o
        .setName("name")
        .setDescription("Backend to switch to. Omit to show current + list.")
        .setRequired(false)
        .addChoices(
          { name: "claude-code (CLI agent)", value: "claude-code" },
          { name: "codex (CLI agent)", value: "codex" },
          { name: "aider-cli", value: "aider-cli" },
          { name: "gemini-cli", value: "gemini-cli" },
          { name: "opencode-cli", value: "opencode-cli" },
          { name: "crush-cli", value: "crush-cli" },
          { name: "amp-cli", value: "amp-cli" },
          { name: "anthropic-api (HTTP)", value: "anthropic-api" },
          { name: "openai-compat (HTTP)", value: "openai-compat" },
          { name: "gemini-api (HTTP)", value: "gemini-api" },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("models")
    .setDescription("List known models and which backend(s) can run each")
    .addStringOption((o) =>
      o
        .setName("action")
        .setDescription("'list' (default) or 'refresh' (re-fetch from provider APIs)")
        .setRequired(false)
        .addChoices(
          { name: "list", value: "list" },
          { name: "refresh (re-fetch live)", value: "refresh" },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("reactivity")
    .setDescription("Show or set how this bot reacts to other bots' messages")
    .addStringOption((o) =>
      o
        .setName("mode")
        .setDescription("Reactivity to OTHER bots. Human messages are unaffected.")
        .setRequired(false)
        .addChoices(
          { name: "strict (only respond to other bots when @-mentioned)", value: "strict" },
          { name: "loose (respond to other bots without @-mention)", value: "loose" },
          { name: "chatty (reserved — same as loose today)", value: "chatty" },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("budget")
    .setDescription("Show today's token + USD usage; optionally set a daily cap")
    .addNumberOption((o) =>
      o
        .setName("set_usd")
        .setDescription("Set a new daily budget in USD (e.g. 10). 0 disables the cap.")
        .setRequired(false),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Post this bot's roster announcement in the configured #roster channel")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("refresh-roster")
    .setDescription("Re-scrape the #roster channel to refresh the in-memory roster")
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
