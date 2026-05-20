import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ChatInputCommandInteraction,
  GuildMember,
  MessageFlags,
  Message,
  TextBasedChannel,
  PermissionFlagsBits,
  ButtonInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import {
  joinVoiceChannel,
  EndBehaviorType,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
  AudioPlayer,
  AudioPlayerStatus,
  entersState,
  getVoiceConnection,
  NoSubscriberBehavior,
} from "@discordjs/voice";
import prism from "prism-media";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { SileroVad } from "@papercup/voice-stack/vad";
import { WhisperSidecar } from "@papercup/voice-stack/stt";
import { createTts, type TtsEngine } from "@papercup/voice-stack/tts";
import {
  stereo48kS16ToMono16kF32,
  mono24kS16ToStereo48kS16,
} from "@papercup/voice-stack/audio";
import { ExtensionManager, type Extension } from "@papercup/voice-stack/extensions";
import { ExtensionMcpServer } from "@papercup/voice-stack/extensions/mcp";
import { SpeakerAgent } from "./agent/speaker.js";
import { SessionStore, type Session } from "./session/store.js";
import { GuildConfigStore } from "./config/guild-config.js";
import { DiscordQuestionDispatcher } from "./plan-mode/dispatcher.js";
import { processRegistry } from "./agent/process-registry.js";
import { ProgressRenderer, type StreamingMode } from "./streaming/progress.js";
import * as modelCatalog from "./agent/model-catalog.js";
import { listBackends } from "./agent/backend.js";
import type { SessionReactivity } from "./session/store.js";
import { budget, richPresenceText } from "./agent/budget.js";
import { botIdentity } from "./agent/bot-identity.js";
import * as roster from "./agent/roster.js";
import { ActivityType } from "discord.js";

const token = required("DISCORD_TOKEN");
const silenceMs = Number(process.env.SILENCE_MS ?? 600);
const vadThreshold = Number(process.env.VAD_THRESHOLD ?? 0.4);
const vadMinSpeechWindows = Number(process.env.VAD_MIN_SPEECH_WINDOWS ?? 3);
const boundTextChannelId = process.env.BOT_TEXT_CHANNEL_ID?.trim() || undefined;

// User allowlist — comma-separated Discord user IDs. When set, the bot only
// responds to messages and slash commands from those IDs; everyone else gets
// a polite refusal (slash) or silent ignore (text). Empty/unset → respond to
// everyone (backward compat). Set this BEFORE going public.
const allowedUserIds = new Set(
  (process.env.BOT_ALLOWED_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
if (allowedUserIds.size > 0) {
  console.log(`[security] BOT_ALLOWED_USERS active — ${allowedUserIds.size} user(s) on the allowlist`);
}

function isAllowed(userId: string): boolean {
  return allowedUserIds.size === 0 || allowedUserIds.has(userId);
}

const VAD_WINDOW_SAMPLES = 512; // 32 ms @ 16 kHz mono

const vad = new SileroVad();
const stt = new WhisperSidecar();
const tts: TtsEngine = createTts(process.env.TTS_ENGINE ?? "kokoro");
const sessions = new SessionStore();
const guildConfig = new GuildConfigStore();
const extensions = new ExtensionManager();

// Plan-mode interactive question dispatcher state. Constructed after the
// Discord client is created (further down). `currentPlanContext` is set
// right before agent.respond() in plan mode and cleared after; the MCP
// `present_options` tool reads it to know which channel/user to post to.
// MVP: single-user assumption — one in-flight plan-mode turn at a time.
let currentPlanContext: { channelId: string; ownerUserId: string } | undefined;
let questionDispatcher: DiscordQuestionDispatcher;
let extMcp: ExtensionMcpServer;

// Track 2 Phase 1: bot-to-bot loop guard. Counts papercup's consecutive
// replies in a channel since the last human message; reset when a human
// speaks. When ≥ MAX_BOT_TURNS, papercup ignores further bot messages until
// a human resets the counter.
const MAX_BOT_TURNS = Number(process.env.BOT_BOT_MAX_TURNS ?? 3);
const botReplyCount = new Map<string, number>();

// Channels where we've already announced "📍 Session X (new|resumed) …" in
// this bot's lifetime. Resets on restart so the indicator fires once per
// channel per process.
const firstTurnAnnounced = new Set<string>();

// Context-pressure warnings: track the highest pct threshold already shown
// in each channel so we don't spam the same warning every turn. Cleared on
// /bind, /unbind, /compact when the channel switches sessions.
//   0    = no warning shown yet
//   0.7  = "consider /compact" shown
//   0.85 = "compact now" shown
const contextPressureWarned = new Map<string, number>();

// Conservative effective conversation budget. Claude 4.x's nominal window is
// 200k tokens, but claude-code reserves headroom for tools, system prompts,
// hooks, and the next user turn. 180k is a safe practical ceiling.
const CONTEXT_WINDOW_TOKENS = Number(process.env.AGENT_CONTEXT_WINDOW ?? 180_000);
const CONTEXT_WARN_PCT = 0.7;
const CONTEXT_URGENT_PCT = 0.85;

/**
 * Post a one-time warning in `channel` when the session's most recent
 * `inputTokens` crosses 70% or 85% of the effective context budget. Each
 * threshold fires at most once per channel until the channel rebinds or
 * its session is compacted (state reset by callers).
 */
async function maybeWarnContextPressure(
  channel: TextBasedChannel,
  channelId: string,
  sessionName: string,
  inputTokens: number,
): Promise<void> {
  if (!inputTokens || inputTokens <= 0) return;
  const pct = inputTokens / CONTEXT_WINDOW_TOKENS;
  const shown = contextPressureWarned.get(channelId) ?? 0;
  let level: number | undefined;
  let icon = "";
  let line = "";
  if (pct >= CONTEXT_URGENT_PCT && shown < CONTEXT_URGENT_PCT) {
    level = CONTEXT_URGENT_PCT;
    icon = "🚨";
    line =
      `Context near the ceiling — run \`/compact name:${sessionName}\` now. ` +
      `Sessions break when the window overflows.`;
  } else if (pct >= CONTEXT_WARN_PCT && shown < CONTEXT_WARN_PCT) {
    level = CONTEXT_WARN_PCT;
    icon = "⚠️";
    line =
      `Context getting large — consider \`/compact\` soon to avoid an overflow ` +
      `(\`/compact name:${sessionName}\` forks this session with a summary).`;
  }
  if (level === undefined) return;
  contextPressureWarned.set(channelId, level);
  const pctStr = `${Math.round(pct * 100)}%`;
  const k = `${Math.round(inputTokens / 1000)}k`;
  const budgetK = `${Math.round(CONTEXT_WINDOW_TOKENS / 1000)}k`;
  const text = `${icon} **Context ${pctStr}** (${k}/${budgetK} tokens for \`${sessionName}\`). ${line}`;
  if (!("send" in channel)) return;
  try {
    await (channel as { send: (s: string) => Promise<unknown> }).send(text);
  } catch (err) {
    console.warn(`[context-pressure] post failed: ${(err as Error).message}`);
  }
}

/**
 * Post a single "📍 Session X (new|resumed) …" line in the message's channel.
 * Caller is responsible for the once-per-channel-per-bot-lifetime gating via
 * `firstTurnAnnounced`. Best-effort: errors get swallowed so a Discord
 * permission gap doesn't break the turn.
 */
async function postSessionIndicator(
  msg: Message,
  session: Session,
  agent: SpeakerAgent,
  kind: "new" | "resumed",
): Promise<void> {
  if (!("send" in msg.channel)) return;
  const icon = kind === "resumed" ? "♻️" : "✨";
  const verb = kind === "resumed" ? "resumed" : "new";
  const backend = agent.getBackendName();
  const parts = [`${icon} Session \`${session.name}\` ${verb} · backend=\`${backend}\``];
  if (session.model) parts.push(`model=\`${session.model}\``);
  if (kind === "resumed") parts.push(`last used ${humanAgo(session.lastActiveAt)}`);
  try {
    await (msg.channel as { send: (s: string) => Promise<{ id: string }> }).send(parts.join(" · "));
  } catch (err) {
    console.warn(`[session-indicator] post failed: ${(err as Error).message}`);
  }
}

/**
 * Look up the reactivity setting for whatever session is active in the given
 * message's guild/channel. Defaults to "strict" when no session is bound yet.
 */
function getSessionReactivity(msg: Message): SessionReactivity {
  if (msg.guild) {
    const line = lines.get(msg.guild.id);
    if (line?.session.reactivity) return line.session.reactivity;
  }
  const chat = textChats.get(msg.channelId);
  if (chat?.session.reactivity) return chat.session.reactivity;
  return "strict";
}

/**
 * Set the channel + owner context the `present_options` MCP tool reads from
 * during this respond() call. Used in any text-mode turn so the model can
 * ask via Discord buttons when it needs to (previously gated on plan-mode
 * only; the same dispatcher now serves AskUserQuestion-style asks in
 * regular text turns too). Voice mode doesn't get context because TTS can't
 * render buttons; the underlying tool isn't in the voice-mode allowlist
 * either.
 */
async function withPlanContext<T>(
  session: Session,
  channelId: string,
  ownerUserId: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (session.mode !== "text") return fn();
  if (currentPlanContext) {
    console.warn(
      "[plan-context] another text turn is in flight; new context overwrites the previous (single-user MVP)",
    );
  }
  currentPlanContext = { channelId, ownerUserId };
  try {
    return await fn();
  } finally {
    currentPlanContext = undefined;
  }
}

function required(key: string): string {
  const v = process.env[key];
  if (!v) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
  return v;
}

type LineState = {
  connection: VoiceConnection;
  player: AudioPlayer;
  userId: string;
  capturing: boolean;
  interaction: ChatInputCommandInteraction;
  history: string[];
  statusUpdateAt: number;
  agent: SpeakerAgent;
  session: Session;
};

const STATUS_HISTORY_LINES = 4;
const STATUS_MIN_INTERVAL_MS = 1000; // throttle editReply

const lines = new Map<string, LineState>();

// Per-channel text-only sessions for users who @mention the bot when no voice
// line is active. Keyed by channelId, value pairs the Session with a started
// SpeakerAgent so we can keep the conversation across messages.
type TextChat = { session: Session; agent: SpeakerAgent };
const textChats = new Map<string, TextChat>();

// Per-guild pinned "active session" message in the bound channel.
// {channelId, messageId} so we can edit-in-place on knob changes.
const sessionPins = new Map<string, { channelId: string; messageId: string }>();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — must be enabled in dev portal
  ],
});

questionDispatcher = new DiscordQuestionDispatcher(client);
extMcp = new ExtensionMcpServer(
  extensions,
  questionDispatcher,
  () => currentPlanContext,
);

client.once("clientReady", async (c) => {
  console.log(`Cup ready as ${c.user.tag}. Waiting for /pickup.`);
  // Track 2 Phase 2: rich-presence broadcast of budget %.
  refreshRichPresence();
  // Periodic refresh so the status flips to the new day's bucket after UTC
  // midnight even if no turns happen. 10 min is plenty — Discord's
  // rate-limit on activity updates is generous, and the user-visible
  // staleness window after midnight is bounded by this interval.
  setInterval(refreshRichPresence, 10 * 60 * 1000);
  // Track 2 Phase 3: scrape #roster channel + workdir-overlap check (best-effort).
  const rosterChannelId = process.env.BOT_ROSTER_CHANNEL_ID?.trim();
  if (rosterChannelId) {
    try {
      const result = await roster.scrapeChannel(client, rosterChannelId);
      console.log(
        `[roster] scrape scanned=${result.scanned} parsed=${result.parsed} new=${result.newOrUpdated}; roster=${roster.list().length}`,
      );
      const ourWorkdir = process.env.BOT_WORKDIR ?? process.cwd();
      const warnings = roster.checkWorkdirOverlap(c.user.id, ourWorkdir);
      for (const w of warnings) {
        console.warn(
          `[roster] WORKDIR OVERLAP (${w.reason}): ours=${w.ourWorkdir} vs bot=${w.otherBotId} theirs=${w.otherWorkdir}`,
        );
      }
    } catch (err) {
      console.warn(`[roster] boot scrape failed: ${(err as Error).message}`);
    }
  } else {
    console.log("[roster] BOT_ROSTER_CHANNEL_ID not set — skipping boot scrape");
  }
});

function refreshRichPresence(): void {
  try {
    client.user?.setActivity({ name: richPresenceText(), type: ActivityType.Custom });
  } catch (err) {
    console.warn(`[presence] update failed: ${(err as Error).message}`);
  }
}

await vad.load();
console.log("[vad] silero loaded");

await stt.start();
console.log("[stt] whisper sidecar online");

await tts.start();
console.log("[tts] engine online");

await sessions.load();
console.log(`[sessions] loaded ${sessions.list().length} session(s)`);

await guildConfig.load();
console.log("[guild-config] loaded");
if (boundTextChannelId) {
  console.log(`[text] BOT_TEXT_CHANNEL_ID env override → ${boundTextChannelId}`);
}

await extensions.load();
console.log(`[extensions] loaded ${extensions.list().length} record(s)`);

await processRegistry.load();
console.log(`[process-registry] loaded ${processRegistry.list().length} record(s)`);

await modelCatalog.loadCache();
console.log(
  `[model-catalog] loaded ${modelCatalog.list().length} model(s)` +
  (modelCatalog.isCacheFresh() ? ` (cache fresh)` : ` (cache stale or empty — use /models refresh)`),
);

await budget.load();
console.log(
  `[budget] loaded — daily cap ${budget.getBudgetUsd() > 0 ? `$${budget.getBudgetUsd()}` : "unlimited"}; today $${budget.getToday().costUsd.toFixed(4)}`,
);

await botIdentity.loadOrGenerate();
console.log(`[bot-identity] fingerprint ${botIdentity.getFingerprint()}`);

await roster.loadCache();
console.log(`[roster] cache has ${roster.list().length} entry(ies)`);
const reaped = await processRegistry.reapOrphans(process.pid);
if (reaped.killed.length) {
  console.log(
    `[process-registry] reaped ${reaped.killed.length} orphan(s) from a previous bot: ${reaped.killed.join(",")}`,
  );
}
if (reaped.alreadyDead.length) {
  console.log(
    `[process-registry] cleared ${reaped.alreadyDead.length} dead entry(ies): ${reaped.alreadyDead.join(",")}`,
  );
}
if (reaped.skipped.length) {
  for (const s of reaped.skipped) {
    console.warn(`[process-registry] skipped pid=${s.pid}: ${s.reason}`);
  }
}

extensions.on("settled", (ext) => {
  // Voice lines: speak a one-line completion notice if /notify is on.
  for (const [, state] of lines) {
    if (!state.session.notify) continue;
    void announceExtensionSettledVoice(state, ext);
  }
  // Text chats: drop a Discord message in the channel if /notify is on.
  for (const [channelId, chat] of textChats) {
    if (!chat.session.notify) continue;
    void announceExtensionSettledText(channelId, chat, ext);
  }
});

const mcpInfo = await extMcp.start();
process.env.PAPERCUP_MCP_URL = mcpInfo.url;
console.log(`[mcp] tools available at ${mcpInfo.url}`);

client.on("interactionCreate", async (interaction) => {
  // Plan-mode interactive question: route button clicks and modal submits to
  // the dispatcher before the chat-command path. Owner-id check is enforced
  // inside the dispatcher (per-pending-question), so we keep allowlist gating
  // here too as a coarse outer fence.
  if (interaction.isButton() || interaction.isModalSubmit()) {
    if (!isAllowed(interaction.user.id)) {
      try {
        await interaction.reply({
          content: "Not on the allowlist.",
          flags: MessageFlags.Ephemeral,
        });
      } catch { /* ignore */ }
      return;
    }
    try {
      if (interaction.isButton()) {
        await questionDispatcher.handleButton(interaction as ButtonInteraction);
      } else {
        await questionDispatcher.handleModal(interaction as ModalSubmitInteraction);
      }
    } catch (err) {
      console.error("[plan-mode] interaction handler error:", err);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (!isAllowed(interaction.user.id)) {
    console.log(`[security] denied /${interaction.commandName} from ${interaction.user.tag} (${interaction.user.id})`);
    try {
      await interaction.reply({
        content: "You're not on this Papercup's allowlist. Ask the operator to add your Discord user ID to BOT_ALLOWED_USERS.",
        flags: MessageFlags.Ephemeral,
      });
    } catch { /* ignore */ }
    return;
  }

  try {
    if (interaction.commandName === "pickup") {
      await handlePickup(interaction);
    } else if (interaction.commandName === "hangup") {
      await handleHangup(interaction);
    } else if (interaction.commandName === "say") {
      await handleSay(interaction);
    } else if (interaction.commandName === "resume") {
      await handleResume(interaction);
    } else if (interaction.commandName === "sessions") {
      await handleSessions(interaction);
    } else if (interaction.commandName === "rename") {
      await handleRename(interaction);
    } else if (interaction.commandName === "bind") {
      await handleBind(interaction);
    } else if (interaction.commandName === "unbind") {
      await handleUnbind(interaction);
    } else if (interaction.commandName === "new") {
      await handleNew(interaction);
    } else if (interaction.commandName === "cancel") {
      await handleCancel(interaction);
    } else if (interaction.commandName === "status") {
      await handleStatus(interaction);
    } else if (interaction.commandName === "model") {
      await handleModel(interaction);
    } else if (interaction.commandName === "effort") {
      await handleEffort(interaction);
    } else if (interaction.commandName === "permissions") {
      await handlePermissions(interaction);
    } else if (interaction.commandName === "mcp") {
      await handleMcp(interaction);
    } else if (interaction.commandName === "notify") {
      await handleNotify(interaction);
    } else if (interaction.commandName === "streaming") {
      await handleStreaming(interaction);
    } else if (interaction.commandName === "backend") {
      await handleBackend(interaction);
    } else if (interaction.commandName === "models") {
      await handleModels(interaction);
    } else if (interaction.commandName === "reactivity") {
      await handleReactivity(interaction);
    } else if (interaction.commandName === "budget") {
      await handleBudget(interaction);
    } else if (interaction.commandName === "announce") {
      await handleAnnounce(interaction);
    } else if (interaction.commandName === "refresh-roster") {
      await handleRefreshRoster(interaction);
    }
  } catch (err) {
    console.error(`handler error on /${interaction.commandName}:`, err);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply("Something broke. Check homelab logs.").catch(() => {});
    }
  }
});

client.on("messageCreate", async (msg) => {
  try {
    await handleMessage(msg);
  } catch (err) {
    console.error("handler error on messageCreate:", err);
  }
});

client.on("error", (err) => console.error("client error:", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

async function handlePickup(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const name = interaction.options.getString("name") ?? undefined;
  const mode = (interaction.options.getString("mode") ?? "voice") as "voice" | "text";
  const model = interaction.options.getString("model") ?? undefined;
  const effort = interaction.options.getString("effort") as
    | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
  const permissionMode = interaction.options.getString("permission-mode") as
    | "default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan" | null;

  const session = await sessions.create({ name });
  if (model) await sessions.setModel(session.id, model);
  if (effort) await sessions.setEffort(session.id, effort);
  if (permissionMode) await sessions.setPermissionMode(session.id, permissionMode);
  await sessions.setMode(session.id, mode);
  // Refresh from store so we pass the persisted values into the agent.
  const fresh = sessions.findByName(session.name) ?? session;
  Object.assign(session, fresh);

  if (mode === "text") {
    await startTextSession(interaction, session);
  } else {
    await joinAndStart(interaction, session, false);
  }
}

async function startTextSession(
  interaction: ChatInputCommandInteraction,
  session: Session,
  resume = false,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.editReply("Use /pickup mode:text in a guild text channel.");
    return;
  }

  // Replace any auto-spawned or prior chat for this channel.
  const existing = textChats.get(interaction.channelId);
  if (existing) {
    try { existing.agent.stop?.(); } catch { /* ignore */ }
    textChats.delete(interaction.channelId);
  }

  const agent = new SpeakerAgent();
  const startSessionId = resume ? (session.backendId ?? session.id) : session.id;
  await agent.start({
    sessionId: startSessionId,
    resume,
    model: session.model,
    effort: session.effort,
    permissionMode: session.permissionMode,
    allowedMcps: session.allowedMcps,
    mode: "text",
    backendName: session.backend,
  });
  textChats.set(interaction.channelId, { session, agent });
  await sessions.touch(session.id);
  console.log(
    `[text-chat] ${resume ? "resume" : "/pickup"} mode:text "${session.name}" model=${session.model ?? "(default)"} effort=${session.effort ?? "(default)"} channel=${interaction.channelId}`,
  );

  const verb = resume ? "Resumed" : "active";
  const lines: string[] = [
    resume
      ? `🔁 Text session **${session.name}** ${verb} in this channel.`
      : `📝 Text session **${session.name}** ${verb} in this channel.`,
    `Send messages here and I'll reply in text — no voice join.`,
  ];
  if (session.model) lines.push(`Model: \`${session.model}\``);
  if (session.effort) lines.push(`Effort: \`${session.effort}\``);
  lines.push(`Toggle extension-completion alerts with \`/notify state:on\`. End with \`/hangup\`.`);
  await interaction.editReply(lines.join("\n"));
  if (interaction.guildId) {
    void updateSessionPin(interaction.guildId, session);
  }
}

async function handleResume(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const name = interaction.options.getString("name", true);
  const session = sessions.findByName(name);
  if (!session) {
    await interaction.editReply(`No session named "${name}". Try /sessions to see what's available.`);
    return;
  }

  // Auto-mode ladder:
  // 1. Active voice line in this guild → resume into voice (rejoin same call)
  // 2. Active text chat in this channel → resume into text (replace it)
  // 3. Saved Session.mode → use it
  // 4. User is currently sitting in a voice channel → voice
  // 5. Otherwise → text (safer default — at least it'll work without a VC)
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  const activeVoice = guildId ? lines.has(guildId) : false;
  const activeText = textChats.has(channelId);
  const memberInVoice =
    interaction.member instanceof GuildMember && interaction.member.voice.channel != null;

  let mode: "voice" | "text";
  if (activeVoice) {
    mode = "voice";
  } else if (activeText) {
    mode = "text";
  } else if (session.mode) {
    mode = session.mode;
  } else if (memberInVoice) {
    mode = "voice";
  } else {
    mode = "text";
  }

  console.log(
    `[resume] "${session.name}" → ${mode} ` +
    `(activeVoice=${activeVoice} activeText=${activeText} ` +
    `sessMode=${session.mode ?? "(unset)"} memberInVoice=${memberInVoice})`,
  );

  if (mode === "text") {
    await startTextSession(interaction, session, true);
    return;
  }
  await joinAndStart(interaction, session, true);
}

async function joinAndStart(
  interaction: ChatInputCommandInteraction,
  session: Session,
  resume: boolean,
): Promise<void> {
  const member = interaction.member;
  if (!(member instanceof GuildMember) || !member.voice.channel) {
    await interaction.editReply("Join a voice channel first, then call /pickup.");
    return;
  }

  const channel = member.voice.channel;
  const guildId = channel.guild.id;

  if (lines.has(guildId)) {
    await interaction.editReply("Already on a line here. /hangup first.");
    return;
  }

  const verb = resume ? "resuming" : "joining";
  console.log(`[pickup] ${verb} ${channel.name} (${channel.id}) for user ${member.id}, session=${session.name} (${session.id})`);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  connection.on("stateChange", (oldState, newState) => {
    console.log(`[voice] ${oldState.status} → ${newState.status}`);
  });
  connection.on("error", (err) => console.error("[voice] error:", err));

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  player.on("stateChange", (o, n) => console.log(`[player] ${o.status} → ${n.status}`));
  player.on("error", (err) => console.error("[player] error:", err));
  connection.subscribe(player);

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    console.log("[voice] connection ready");
  } catch (err) {
    console.error("[voice] failed to reach Ready in 15s:", err);
    connection.destroy();
    await interaction.editReply("Couldn't establish the voice connection. Try again.");
    return;
  }

  vad.reset();

  const agent = new SpeakerAgent();
  // Resume uses whatever id the backend recorded last time (might differ from
  // session.id for backends like codex that assign their own thread UUID).
  const startSessionId = resume ? (session.backendId ?? session.id) : session.id;
  await agent.start({
    sessionId: startSessionId,
    resume,
    model: session.model,
    effort: session.effort,
    permissionMode: session.permissionMode,
    allowedMcps: session.allowedMcps,
    mode: "voice",
    backendName: session.backend,
  });
  await sessions.touch(session.id);

  const state: LineState = {
    connection,
    player,
    userId: member.id,
    capturing: false,
    interaction,
    history: [],
    statusUpdateAt: 0,
    agent,
    session,
  };
  lines.set(guildId, state);

  beginCaptureLoop(state);

  const greeting = resume
    ? `🔁 Resumed "${session.name}" — listening...`
    : `🎤 New session "${session.name}" — listening...`;
  await renderStatus(state, greeting);
  void updateSessionPin(guildId, session);
}

async function handleHangup(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Not in a guild.");
    return;
  }
  const state = lines.get(guildId);
  const conn = state?.connection ?? getVoiceConnection(guildId);

  // Voice line, if any.
  if (conn) {
    conn.destroy();
    lines.delete(guildId);
    const sessName = state ? `"${state.session.name}"` : "";
    await interaction.editReply(`Hung up${sessName ? ` — ${sessName} preserved` : ""}.`);
    void clearSessionPin(guildId);
    return;
  }

  // No voice — close the text chat for this channel if one exists.
  const chat = textChats.get(interaction.channelId);
  if (chat) {
    try { chat.agent.stop?.(); } catch { /* ignore */ }
    textChats.delete(interaction.channelId);
    await interaction.editReply(`📝 Text session "${chat.session.name}" closed — preserved for /resume.`);
    void clearSessionPin(guildId);
    return;
  }

  await interaction.editReply("No active line or text session here.");
}

async function handleNew(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  if (!guildId) {
    await interaction.editReply("Not in a guild.");
    return;
  }

  const voice = lines.get(guildId);
  const chat = textChats.get(channelId);
  if (!voice && !chat) {
    console.log(
      `[new] no active container — guildId=${guildId} channelId=${channelId} ` +
      `lines.keys=[${[...lines.keys()].join(",")}] textChats.keys=[${[...textChats.keys()].join(",")}]`,
    );
    await interaction.editReply(
      "No active session. /pickup first, then /new.\n\n" +
      "Note: text chats are in-memory only — a bot restart drops them. /resume name:<x> to reattach a saved session.",
    );
    return;
  }

  // Inherit knobs from the current session — but not notify (per-conversation).
  const prior = voice ? voice.session : chat!.session;
  const desiredName = interaction.options.getString("name") ?? undefined;

  const fresh = await sessions.create({ name: desiredName });
  if (prior.mode) await sessions.setMode(fresh.id, prior.mode);
  if (prior.model) await sessions.setModel(fresh.id, prior.model);
  if (prior.effort) await sessions.setEffort(fresh.id, prior.effort);
  if (prior.permissionMode) await sessions.setPermissionMode(fresh.id, prior.permissionMode);
  if (prior.allowedMcps?.length) await sessions.setAllowedMcps(fresh.id, prior.allowedMcps);
  // Refresh from store so all the persisted values land on the in-memory object.
  const refreshed = sessions.findByName(fresh.name) ?? fresh;
  Object.assign(fresh, refreshed);

  if (voice) {
    // Replace the voice line's agent + session in place; keep the connection.
    try { voice.agent.stop?.(); } catch { /* ignore */ }
    voice.agent = new SpeakerAgent();
    await voice.agent.start({
      sessionId: fresh.id,
      resume: false,
      model: fresh.model,
      effort: fresh.effort,
      permissionMode: fresh.permissionMode,
      allowedMcps: fresh.allowedMcps,
      mode: "voice",
      backendName: fresh.backend,
    });
    voice.session = fresh;
    await sessions.touch(fresh.id);
    console.log(`[new] voice line replaced — "${prior.name}" → "${fresh.name}" (inherited model=${fresh.model ?? "(default)"} effort=${fresh.effort ?? "(default)"})`);
    await interaction.editReply(
      `🎤 Fresh voice session **${fresh.name}** active. Inherited from "${prior.name}":` +
      `${fresh.model ? `\nModel: \`${fresh.model}\`` : ""}` +
      `${fresh.effort ? `\nEffort: \`${fresh.effort}\`` : ""}` +
      `${fresh.permissionMode ? `\nPermissions: \`${fresh.permissionMode}\`` : ""}`,
    );
    void updateSessionPin(guildId, fresh);
  } else if (chat) {
    try { chat.agent.stop?.(); } catch { /* ignore */ }
    const agent = new SpeakerAgent();
    await agent.start({
      sessionId: fresh.id,
      resume: false,
      model: fresh.model,
      effort: fresh.effort,
      permissionMode: fresh.permissionMode,
      allowedMcps: fresh.allowedMcps,
      mode: "text",
      backendName: fresh.backend,
    });
    textChats.set(channelId, { session: fresh, agent });
    await sessions.touch(fresh.id);
    console.log(`[new] text chat replaced — "${prior.name}" → "${fresh.name}" (inherited model=${fresh.model ?? "(default)"} effort=${fresh.effort ?? "(default)"})`);
    await interaction.editReply(
      `📝 Fresh text session **${fresh.name}** active. Inherited from "${prior.name}":` +
      `${fresh.model ? `\nModel: \`${fresh.model}\`` : ""}` +
      `${fresh.effort ? `\nEffort: \`${fresh.effort}\`` : ""}` +
      `${fresh.permissionMode ? `\nPermissions: \`${fresh.permissionMode}\`` : ""}`,
    );
    void updateSessionPin(guildId, fresh);
  }
}

async function handleCancel(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const active = findActiveContainer(interaction);
  if (!active) {
    await interaction.editReply("No active session to cancel against.");
    return;
  }
  const agent = active.kind === "voice" ? active.state.agent : active.chat.agent;
  const session = active.kind === "voice" ? active.state.session : active.chat.session;
  const cancelled = agent.cancel();
  if (cancelled) {
    console.log(`[cancel] aborted speaker turn for "${session.name}"`);
    await interaction.editReply(`✋ Cancelled the in-flight turn for "${session.name}". History preserved; just send another message.`);
  } else {
    await interaction.editReply(`Nothing in flight to cancel.`);
  }
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const active = findActiveContainer(interaction);
  const lines: string[] = [];

  if (active) {
    const session = active.kind === "voice" ? active.state.session : active.chat.session;
    lines.push(`📍 **Active session: \`${session.name}\`** (${active.kind})`);
    lines.push(`Mode: \`${session.mode ?? "voice"}\``);
    if (session.model) lines.push(`Model: \`${session.model}\``);
    else lines.push(`Model: \`${process.env.AGENT_MODEL ?? "(env default)"}\``);
    if (session.effort) lines.push(`Effort: \`${session.effort}\``);
    if (session.permissionMode) {
      lines.push(`Permissions: \`${session.permissionMode}\``);
    } else {
      const def = active.kind === "text" ? "bypassPermissions (text default)" : "default (voice default)";
      lines.push(`Permissions: \`${def}\``);
    }
    if (session.allowedMcps?.length) {
      lines.push(`MCPs: ${session.allowedMcps.map((n) => `\`${n}\``).join(", ")}`);
    }
    lines.push(`Extension-completion notify: ${session.notify ? "🔔 on" : "🔕 off"}`);
  } else {
    lines.push(`📭 No active session in this guild/channel. \`/pickup\` to start one.`);
  }

  // Currently-running extensions across the bot — useful regardless of
  // whether this guild/channel has an active session.
  const running = extensions.list().filter((e) => e.status === "running");
  lines.push("");
  if (running.length === 0) {
    lines.push(`🟢 No background extensions running.`);
  } else {
    lines.push(`🟡 **${running.length} extension${running.length === 1 ? "" : "s"} running:**`);
    for (const ext of running.slice(0, 10)) {
      const ageSec = Math.floor((Date.now() - ext.startedAt) / 1000);
      const ageMin = Math.floor(ageSec / 60);
      const human = ageMin >= 1 ? `${ageMin}m${ageSec % 60}s` : `${ageSec}s`;
      const taskPreview = ext.task.length > 70 ? ext.task.slice(0, 67) + "…" : ext.task;
      lines.push(`• \`${ext.name}\` (${human}) — "${taskPreview}"`);
    }
    if (running.length > 10) lines.push(`… and ${running.length - 10} more`);
  }

  await interaction.editReply(lines.join("\n"));
}

async function handleSessions(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const list = sessions.list().slice(0, 15);
  if (list.length === 0) {
    await interaction.editReply("No sessions yet. /pickup to start one.");
    return;
  }
  const rows = list.map((s, i) => {
    const ago = humanAgo(s.lastActiveAt);
    return `${i + 1}. **${s.name}** — ${ago}`;
  });
  await interaction.editReply(`Recent sessions:\n${rows.join("\n")}`);
}

async function handleRename(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const active = findActiveContainer(interaction);
  if (!active) {
    await interaction.editReply("No active session. /pickup first, then /rename.");
    return;
  }

  const session = active.kind === "voice" ? active.state.session : active.chat.session;
  const newName = interaction.options.getString("name", true);
  try {
    const renamed = await sessions.rename(session.id, newName);
    Object.assign(session, renamed);
    await interaction.editReply(`Renamed → **${renamed.name}**`);
    void refreshSessionPinFor(active, session);
  } catch (err) {
    await interaction.editReply(`❌ ${(err as Error).message}`);
  }
}

async function handleBind(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guildId || !interaction.guild) {
    await interaction.editReply("Not in a guild.");
    return;
  }
  const member = interaction.member;
  if (!(member instanceof GuildMember) || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply("You need the **Manage Server** permission to bind a channel.");
    return;
  }

  const sessionName = interaction.options.getString("session", true);
  const target = sessions.findByName(sessionName);
  if (!target) {
    await interaction.editReply(`No session named "${sessionName}". /sessions to list available ones.`);
    return;
  }

  const channelId = interaction.channelId;

  // If another session was previously bound to this channel, clear its
  // channelId so the channel→session mapping stays 1:1.
  for (const s of sessions.list()) {
    if (s.channelId === channelId && s.id !== target.id) {
      await sessions.setChannelId(s.id, undefined);
    }
  }
  await sessions.setChannelId(target.id, channelId);
  await sessions.setMode(target.id, "text");
  await guildConfig.addBoundChannel(interaction.guildId, channelId);

  // Drop any in-memory chat for this channel — next message will resume
  // the newly-bound session via findLatestForChannel.
  const existing = textChats.get(channelId);
  if (existing) {
    try { existing.agent.stop?.(); } catch { /* ignore */ }
    textChats.delete(channelId);
  }
  firstTurnAnnounced.delete(channelId);
  contextPressureWarned.delete(channelId);

  console.log(
    `[bind] guild ${interaction.guildId} channel ${channelId} → session "${target.name}" by ${member.user.tag}`,
  );
  await interaction.editReply(
    `🔗 This channel is now bound to session **${target.name}**. Every message here routes to it.`,
  );
}

async function handleUnbind(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.guildId || !interaction.guild) {
    await interaction.editReply("Not in a guild.");
    return;
  }
  const member = interaction.member;
  if (!(member instanceof GuildMember) || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply("You need the **Manage Server** permission to unbind a channel.");
    return;
  }

  const channelId = interaction.channelId;
  const wasBound = guildConfig.isBound(interaction.guildId, channelId);
  await guildConfig.removeBoundChannel(interaction.guildId, channelId);

  const existing = textChats.get(channelId);
  if (existing) {
    try { existing.agent.stop?.(); } catch { /* ignore */ }
    textChats.delete(channelId);
  }
  firstTurnAnnounced.delete(channelId);
  contextPressureWarned.delete(channelId);

  console.log(`[unbind] guild ${interaction.guildId} channel ${channelId} by ${member.user.tag}`);
  await interaction.editReply(
    wasBound
      ? "🔓 This channel is unbound. Bot reverts to @mention triggers here."
      : "This channel wasn't bound. No change.",
  );
}

/**
 * Find whichever container is active for a slash-command interaction:
 * a voice line (per-guild) or a text chat (per-channel). Voice takes
 * precedence — once /pickup mode:voice is active, /model and /notify
 * apply to the call, not to a stale text chat in the same channel.
 */
type ActiveContainer =
  | { kind: "voice"; state: LineState }
  | { kind: "text"; chat: TextChat; channelId: string };

function findActiveContainer(interaction: ChatInputCommandInteraction): ActiveContainer | undefined {
  if (interaction.guildId) {
    const state = lines.get(interaction.guildId);
    if (state) return { kind: "voice", state };
  }
  const chat = textChats.get(interaction.channelId);
  if (chat) return { kind: "text", chat, channelId: interaction.channelId };
  return undefined;
}

async function refreshSessionPinFor(active: ActiveContainer, session: Session): Promise<void> {
  const guildId = active.kind === "voice"
    ? (active.state.connection?.joinConfig.guildId)
    : undefined;
  // For text chats we don't have a direct guildId — find via Discord channel.
  if (active.kind === "text") {
    const channel = await client.channels.fetch(active.channelId).catch(() => null);
    if (channel && "guildId" in channel && channel.guildId) {
      await updateSessionPin(channel.guildId, session);
    }
    return;
  }
  if (guildId) {
    await updateSessionPin(guildId, session);
  }
}

async function hotSwapAgent(active: ActiveContainer, session: Session): Promise<void> {
  // Re-start the agent under the new model/effort. Backend resume preserves history.
  if (active.kind === "voice") {
    try { active.state.agent.stop?.(); } catch { /* fine */ }
    active.state.agent = new SpeakerAgent();
    const startSessionId = session.backendId ?? session.id;
    await active.state.agent.start({
      sessionId: startSessionId,
      resume: true,
      model: session.model,
      effort: session.effort,
      permissionMode: session.permissionMode,
      allowedMcps: session.allowedMcps,
      mode: "voice",
      backendName: session.backend,
    });
    await syncBackendId(active.state);
  } else {
    try { active.chat.agent.stop?.(); } catch { /* fine */ }
    active.chat.agent = new SpeakerAgent();
    const startSessionId = session.backendId ?? session.id;
    await active.chat.agent.start({
      sessionId: startSessionId,
      resume: true,
      model: session.model,
      effort: session.effort,
      permissionMode: session.permissionMode,
      allowedMcps: session.allowedMcps,
      backendName: session.backend,
      mode: "text",
    });
  }
}

async function handleModel(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const active = findActiveContainer(interaction);
  if (!active) {
    await interaction.editReply("No active session. /pickup first, then /model.");
    return;
  }

  const session = active.kind === "voice" ? active.state.session : active.chat.session;
  const requested = interaction.options.getString("name") ?? "";
  const updated = await sessions.setModel(session.id, requested);
  if (!updated) {
    await interaction.editReply("Couldn't update session — record missing.");
    return;
  }
  Object.assign(session, updated);

  await hotSwapAgent(active, session);
  void refreshSessionPinFor(active, session);

  if (session.model) {
    await interaction.editReply(`🧠 "${session.name}" model → \`${session.model}\`. History preserved.`);
  } else {
    await interaction.editReply(`🧠 "${session.name}" model override cleared. Falls back to AGENT_MODEL env (\`${process.env.AGENT_MODEL ?? "default"}\`).`);
  }
}

async function handleEffort(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const active = findActiveContainer(interaction);
  if (!active) {
    await interaction.editReply("No active session. /pickup first, then /effort.");
    return;
  }

  const session = active.kind === "voice" ? active.state.session : active.chat.session;
  const level = interaction.options.getString("level", true) as
    | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default";
  const value = level === "default" ? undefined : level;
  const updated = await sessions.setEffort(session.id, value);
  if (!updated) {
    await interaction.editReply("Couldn't update session — record missing.");
    return;
  }
  Object.assign(session, updated);

  await hotSwapAgent(active, session);
  void refreshSessionPinFor(active, session);

  if (session.effort) {
    await interaction.editReply(`🧠 "${session.name}" effort → \`${session.effort}\`. History preserved.`);
  } else {
    await interaction.editReply(`🧠 "${session.name}" effort cleared (backend default).`);
  }
}

async function handlePermissions(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const active = findActiveContainer(interaction);
  if (!active) {
    await interaction.editReply("No active session. /pickup first, then /permissions.");
    return;
  }

  const session = active.kind === "voice" ? active.state.session : active.chat.session;
  const choice = interaction.options.getString("mode", true);
  const value = choice === "default-for-mode"
    ? undefined
    : (choice as "default" | "acceptEdits" | "auto" | "bypassPermissions" | "plan");
  const updated = await sessions.setPermissionMode(session.id, value);
  if (!updated) {
    await interaction.editReply("Couldn't update session — record missing.");
    return;
  }
  Object.assign(session, updated);

  await hotSwapAgent(active, session);
  void refreshSessionPinFor(active, session);

  if (session.permissionMode) {
    await interaction.editReply(`🔐 "${session.name}" permission mode → \`${session.permissionMode}\`.`);
  } else {
    const fallback = active.kind === "text" ? "bypassPermissions" : "default";
    await interaction.editReply(`🔐 "${session.name}" permission override cleared. Using mode default: \`${fallback}\`.`);
  }
}

async function handleMcp(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const active = findActiveContainer(interaction);
  if (!active) {
    await interaction.editReply("No active session. /pickup first, then /mcp.");
    return;
  }
  const session = active.kind === "voice" ? active.state.session : active.chat.session;
  const action = interaction.options.getString("action", true) as "enable" | "disable" | "list";
  const name = interaction.options.getString("name") ?? "";
  const current = session.allowedMcps ?? [];

  if (action === "list") {
    const enabled = current.length > 0
      ? current.map((n) => `\`${n}\``).join(", ")
      : "_(none)_";

    // Discover available MCPs by shelling out to `claude mcp list`. Parses
    // lines like "plugin:ecc:playwright: <url-or-cmd> - ✓ Connected".
    const available = await listAvailableMcps();
    const connected = available.filter((m) => m.connected);
    const needsAuth = available.filter((m) => !m.connected);

    const lines: string[] = [];
    lines.push(`🔌 **MCPs enabled for \`${session.name}\`:** ${enabled}`);
    lines.push("");
    if (connected.length > 0) {
      lines.push(`**Available + connected** (use \`/mcp action:enable name:<n>\`):`);
      for (const m of connected.slice(0, 20)) {
        const onSession = current.includes(m.name) ? " ✓" : "";
        lines.push(`• \`${m.name}\`${onSession}`);
      }
      if (connected.length > 20) lines.push(`… ${connected.length - 20} more`);
    } else if (available.length === 0) {
      lines.push(`_No MCPs configured. Add one with \`claude mcp add <name> <command>\` in your terminal._`);
    }
    if (needsAuth.length > 0) {
      lines.push("");
      lines.push(`**Need authentication** (won't work until set up):`);
      for (const m of needsAuth.slice(0, 10)) {
        lines.push(`• \`${m.name}\``);
      }
    }
    await interaction.editReply(lines.join("\n").slice(0, 1900));
    return;
  }

  if (!name) {
    await interaction.editReply("`name:` is required for enable/disable.");
    return;
  }

  let next: string[];
  if (action === "enable") {
    if (current.includes(name)) {
      await interaction.editReply(`✓ \`${name}\` already enabled for "${session.name}".`);
      return;
    }
    next = [...current, name];
  } else {
    if (!current.includes(name)) {
      await interaction.editReply(`\`${name}\` wasn't enabled for "${session.name}".`);
      return;
    }
    next = current.filter((n) => n !== name);
  }

  const updated = await sessions.setAllowedMcps(session.id, next);
  if (!updated) {
    await interaction.editReply("Couldn't update session — record missing.");
    return;
  }
  Object.assign(session, updated);

  await hotSwapAgent(active, session);
  void refreshSessionPinFor(active, session);

  await interaction.editReply(
    `🔌 ${action === "enable" ? "Enabled" : "Disabled"} \`${name}\` on "${session.name}". ` +
    `Now: ${next.length > 0 ? next.map((n) => `\`${n}\``).join(", ") : "_(none)_"}`,
  );
}

async function handleNotify(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const active = findActiveContainer(interaction);
  if (!active) {
    await interaction.editReply("No active session. /pickup first, then /notify.");
    return;
  }

  const session = active.kind === "voice" ? active.state.session : active.chat.session;
  const wantOn = interaction.options.getString("state", true) === "on";
  const updated = await sessions.setNotify(session.id, wantOn);
  if (!updated) {
    await interaction.editReply("Couldn't update session — record missing.");
    return;
  }
  Object.assign(session, updated);

  const surface = active.kind === "voice" ? "voice TTS" : "channel text";
  await interaction.editReply(
    wantOn
      ? `🔔 Extension-completion alerts ON for "${session.name}" — delivered as ${surface}.`
      : `🔕 Alerts OFF for "${session.name}".`,
  );
  void refreshSessionPinFor(active, session);
}

async function handleStreaming(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const active = findActiveContainer(interaction);
  if (!active) {
    await interaction.editReply("No active session. /pickup first, then /streaming.");
    return;
  }
  const session = active.kind === "voice" ? active.state.session : active.chat.session;
  const mode = interaction.options.getString("mode") as StreamingMode | null;
  if (!mode) {
    const current = session.streaming ?? "off";
    await interaction.editReply(
      `Streaming for "${session.name}": \`${current}\`. ` +
      `Use \`/streaming mode: <off|summary|full>\` to change.`,
    );
    return;
  }
  const updated = await sessions.setStreaming(session.id, mode);
  if (!updated) {
    await interaction.editReply("Couldn't update session — record missing.");
    return;
  }
  Object.assign(session, updated);
  await interaction.editReply(
    mode === "off"
      ? `🔕 Live progress OFF for "${session.name}". Final reply only.`
      : `📡 Live progress \`${mode}\` for "${session.name}". Threshold 5s · throttled edits.`,
  );
}

async function handleBackend(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const active = findActiveContainer(interaction);
  if (!active) {
    await interaction.editReply("No active session. /pickup first, then /backend.");
    return;
  }
  const session = active.kind === "voice" ? active.state.session : active.chat.session;
  const agent = active.kind === "voice" ? active.state.agent : active.chat.agent;
  const requested = interaction.options.getString("name");

  if (!requested) {
    const current = agent.getBackendName();
    await interaction.editReply(
      `Backend for "${session.name}": \`${current}\`\n` +
      `Available: ${listBackends().map((b) => `\`${b}\``).join(", ")}\n` +
      `Use \`/backend name:<one of the above>\` to switch. ` +
      `Note: switching resets the conversation history (cross-backend resume isn't possible).`,
    );
    return;
  }

  if (!listBackends().includes(requested)) {
    await interaction.editReply(`Unknown backend: \`${requested}\`. Available: ${listBackends().join(", ")}`);
    return;
  }

  if (requested === agent.getBackendName()) {
    await interaction.editReply(`Already on \`${requested}\`. No change.`);
    return;
  }

  try {
    await agent.swapBackend(requested, {
      sessionId: session.id,
      resume: false, // fresh start on new backend
      model: session.model,
      effort: session.effort,
      permissionMode: session.permissionMode,
      allowedMcps: session.allowedMcps,
      mode: session.mode ?? "text",
    });
  } catch (err) {
    await interaction.editReply(`Failed to switch to \`${requested}\`: ${(err as Error).message}`);
    return;
  }

  await sessions.setBackend(session.id, requested);
  Object.assign(session, { backend: requested });

  await interaction.editReply(
    `🔁 Switched "${session.name}" → \`${requested}\`. ` +
    `Conversation history reset (cross-backend resume isn't supported).`,
  );
}

async function handleModels(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const action = interaction.options.getString("action") ?? "list";

  if (action === "refresh") {
    await interaction.editReply("🔄 Re-fetching model lists from configured providers…");
    const status = await modelCatalog.refreshLiveCatalog();
    const lines: string[] = ["**Refresh result:**"];
    for (const [provider, s] of Object.entries(status)) {
      lines.push(s.ok
        ? `✅ \`${provider}\`: ${s.count} model(s)`
        : `❌ \`${provider}\`: ${s.error}`);
    }
    lines.push("", `Total in catalog now: ${modelCatalog.list().length}`);
    await interaction.editReply(lines.join("\n"));
    return;
  }

  // action === "list"
  const byProvider = modelCatalog.listByProvider();
  const providers = Object.keys(byProvider).sort();
  const lines: string[] = [`**Known models** (${modelCatalog.list().length}; cache ${modelCatalog.isCacheFresh() ? "fresh" : "stale/empty"})`];
  for (const p of providers) {
    const arr = byProvider[p]!.slice(0, 15);
    lines.push(`\n__${p}__`);
    for (const m of arr) {
      lines.push(`• \`${m.id}\` → ${m.backends.map((b) => `\`${b}\``).join(", ")}${m.notes ? ` _(${m.notes})_` : ""}`);
    }
    if (byProvider[p]!.length > 15) lines.push(`  …and ${byProvider[p]!.length - 15} more`);
  }
  const body = lines.join("\n").slice(0, 1900); // Discord 2000-char cap
  await interaction.editReply(body);
}

async function handleReactivity(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const active = findActiveContainer(interaction);
  if (!active) {
    await interaction.editReply("No active session. /pickup first, then /reactivity.");
    return;
  }
  const session = active.kind === "voice" ? active.state.session : active.chat.session;
  const mode = interaction.options.getString("mode") as SessionReactivity | null;
  if (!mode) {
    const current = session.reactivity ?? "strict";
    const channelCount = botReplyCount.get(interaction.channelId ?? "") ?? 0;
    await interaction.editReply(
      `Reactivity for "${session.name}": \`${current}\`.\n` +
      `Bot-loop cap: ${MAX_BOT_TURNS} consecutive papercup replies before requiring a human turn.\n` +
      `This channel's counter: ${channelCount}/${MAX_BOT_TURNS}.`,
    );
    return;
  }
  const updated = await sessions.setReactivity(session.id, mode);
  if (!updated) {
    await interaction.editReply("Couldn't update session — record missing.");
    return;
  }
  Object.assign(session, updated);
  const explain =
    mode === "strict" ? "ignore other bots unless they @-mention me"
      : mode === "loose"  ? "respond to other bots without @-mention"
      : "reserved — behaves like loose today";
  await interaction.editReply(`🤖 Reactivity for "${session.name}" → \`${mode}\` (${explain}).`);
}

async function handleBudget(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const newCap = interaction.options.getNumber("set_usd");
  if (newCap !== null) {
    await budget.setBudgetUsd(newCap);
    refreshRichPresence();
    await interaction.editReply(
      newCap > 0
        ? `💰 Daily budget set to **$${newCap.toFixed(2)}**.`
        : `💰 Daily budget cap **disabled** (unlimited).`,
    );
    return;
  }
  const today = budget.getToday();
  const pct = budget.getTodayPercent();
  const recent = budget.getRecent(7);
  const recentLines = recent
    .slice()
    .reverse()
    .map((u) => `  ${u.date}: ${u.inputTokens + u.outputTokens} tok · $${u.costUsd.toFixed(4)}`)
    .join("\n");
  const cap = budget.getBudgetUsd();
  await interaction.editReply(
    `**Budget**\n` +
    `Today (${today.date}): ${today.inputTokens + today.outputTokens} tok · **$${today.costUsd.toFixed(4)}**${cap > 0 ? ` · ${pct.toFixed(1)}% of $${cap.toFixed(2)}` : ` (no cap)`}\n` +
    (recent.length > 1 ? `\nLast 7 days:\n${recentLines}` : ""),
  );
}

async function handleAnnounce(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const rosterChannelId = process.env.BOT_ROSTER_CHANNEL_ID?.trim();
  if (!rosterChannelId) {
    await interaction.editReply(
      "BOT_ROSTER_CHANNEL_ID not set. Pick a `#roster` channel by Discord-channel-id convention and set the env var, then restart.",
    );
    return;
  }
  const me = client.user;
  if (!me) {
    await interaction.editReply("Bot user not ready.");
    return;
  }
  const channel = await client.channels.fetch(rosterChannelId).catch(() => null);
  if (!channel || !("send" in channel) || !channel.isTextBased()) {
    await interaction.editReply(`Couldn't access roster channel ${rosterChannelId}.`);
    return;
  }
  const ownerId = process.env.BOT_OWNER_DISCORD_ID?.trim();
  const content = roster.buildAnnouncement({
    botId: me.id,
    owner: ownerId ? `<@${ownerId}>` : "(unset; set BOT_OWNER_DISCORD_ID)",
    workdir: process.env.BOT_WORKDIR ?? process.cwd(),
    reactivity: process.env.BOT_DEFAULT_REACTIVITY ?? "strict",
    budget: budget.getBudgetUsd() > 0 ? `$${budget.getBudgetUsd().toFixed(2)}/day` : "unset",
    publicKey: botIdentity.getPublicKeyBase64() || "(unavailable)",
    fingerprint: botIdentity.getFingerprint(),
  });
  try {
    await (channel as { send: (s: string) => Promise<{ id: string }> }).send(content);
  } catch (err) {
    await interaction.editReply(`Announce failed: ${(err as Error).message}`);
    return;
  }
  await interaction.editReply(
    `📣 Announced in <#${rosterChannelId}>. Fingerprint \`${botIdentity.getFingerprint()}\`.`,
  );
}

async function handleRefreshRoster(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const rosterChannelId = process.env.BOT_ROSTER_CHANNEL_ID?.trim();
  if (!rosterChannelId) {
    await interaction.editReply("BOT_ROSTER_CHANNEL_ID not set.");
    return;
  }
  try {
    const result = await roster.scrapeChannel(client, rosterChannelId);
    const me = client.user;
    const warnings = me ? roster.checkWorkdirOverlap(me.id, process.env.BOT_WORKDIR ?? process.cwd()) : [];
    const lines = roster.list().map((e) =>
      `• \`${e.botId}\` (${e.owner}) — workdir=\`${e.workdir}\`, reactivity=\`${e.reactivity}\`, fingerprint=\`${e.fingerprint}\``,
    );
    const warningLines = warnings.map((w) => `⚠️ overlap with \`${w.otherBotId}\`: ${w.reason}`);
    await interaction.editReply(
      `**Roster** (scanned ${result.scanned}, parsed ${result.parsed}, new/updated ${result.newOrUpdated})\n` +
      (lines.length ? lines.join("\n") : "_(empty)_") +
      (warningLines.length ? `\n\n${warningLines.join("\n")}` : ""),
    );
  } catch (err) {
    await interaction.editReply(`Refresh failed: ${(err as Error).message}`);
  }
}

async function syncBackendId(state: LineState): Promise<void> {
  const id = state.agent.getBackendId();
  if (!id || id === state.session.backendId) return;
  await sessions.setBackendId(state.session.id, id, process.env.AGENT_BACKEND ?? "claude-code");
  state.session.backendId = id;
}

function humanAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

async function handleMessage(msg: Message): Promise<void> {
  if (!msg.guild) return; // text-channel handler is guild-only for now

  const me = client.user;
  if (!me) return;

  // Don't react to our own messages.
  if (msg.author.id === me.id) return;

  // Track 2 Phase 2: budget hard cap. Over-budget → tell humans, silent
  // to other bots (don't waste a token).
  if (budget.isOverBudget()) {
    const isOtherBot = msg.author.bot;
    if (!isOtherBot) {
      try {
        await msg.reply(
          `💸 Today's budget ($${budget.getBudgetUsd().toFixed(2)}) is spent. ` +
          `Resets at UTC midnight; raise the cap with \`/budget set_usd:<n>\` if needed.`,
        );
      } catch { /* ignore */ }
    }
    return;
  }

  // Track 2 Phase 1: bot-vs-human routing.
  const isOtherBot = msg.author.bot;
  if (!isOtherBot) {
    // Human message resets the bot-loop counter for this channel.
    botReplyCount.set(msg.channelId, 0);
    if (!isAllowed(msg.author.id)) {
      // Silent ignore — bot stays out of channel chatter for non-allowlisted
      // humans. Slash commands give an explicit denied reply.
      return;
    }
  } else {
    // Loop cap: ignore other-bot messages when papercup has already replied
    // MAX_BOT_TURNS times since the last human message in this channel.
    const count = botReplyCount.get(msg.channelId) ?? 0;
    if (count >= MAX_BOT_TURNS) {
      console.log(
        `[track2] bot-loop cap (${MAX_BOT_TURNS}) hit for channel ${msg.channelId} — ignoring msg from ${msg.author.tag}`,
      );
      return;
    }
    // Reactivity filter: strict (default) requires direct @-mention from
    // the other bot. loose/chatty fall through to the existing routing logic.
    const reactivity = getSessionReactivity(msg);
    if (reactivity === "strict" && !msg.mentions.users.has(me.id)) {
      return;
    }
    // Mention allowlist also gates bot-originated messages.
    if (!isAllowed(msg.author.id)) {
      return;
    }
  }

  // Routing modes (per-channel bind via /bind takes precedence over env var):
  //   bound     — this channel is in the guild's boundChannels list. Listen
  //               to every message here; routes to the session whose
  //               channelId == this channel.
  //   mention   — fallback. Listen anywhere, but only when @-mentioned.
  const isBoundChannel =
    guildConfig.isBound(msg.guild.id, msg.channelId) ||
    msg.channelId === boundTextChannelId;
  let userText: string;
  const hasAttachments = msg.attachments.size > 0;
  if (isBoundChannel) {
    userText = msg.content.trim();
    // Attachments-only messages are valid — no early return on empty text.
    if (userText.length === 0 && !hasAttachments) return;
  } else {
    if (!msg.mentions.users.has(me.id)) return;
    userText = msg.content.replace(new RegExp(`<@!?${me.id}>`, "g"), "").trim();
    if (userText.length === 0 && !hasAttachments) return;
  }

  // Pull attachments into the per-channel inbox + augment userText with paths
  // so the agent can Read them. Also prepare a per-turn outbox the agent
  // can Write to — files there are attached to our reply.
  let outboxDir: string | undefined;
  try {
    const augment = await ingestAttachments(msg);
    const ob = await prepareOutbox(msg);
    outboxDir = ob.dir;
    const combined = [augment, ob.hint].filter(Boolean).join("\n\n");
    if (combined) {
      userText = userText ? `${userText}\n\n${combined}` : combined;
    }
  } catch (err) {
    console.error(`[file-io] failed to set up turn IO:`, err);
  }

  console.log(`[text] from ${msg.author.tag} in #${"name" in (msg.channel as TextBasedChannel) ? (msg.channel as { name: string }).name : msg.channelId}: "${userText.slice(0, 80)}${userText.length > 80 ? "…" : ""}"`);

  // Route: if this guild has an active voice line, append to that session and
  // also speak the reply. Otherwise spin up (or reuse) a text-only chat keyed
  // by channel.
  const activeLine = lines.get(msg.guild.id);
  if (activeLine) {
    await handleTextIntoActiveLine(msg, activeLine, userText, outboxDir);
    return;
  }

  await handleTextOnlyChat(msg, userText, outboxDir);
}

async function handleTextIntoActiveLine(
  msg: Message,
  state: LineState,
  userText: string,
  outboxDir?: string,
): Promise<void> {
  // Heartbeat typing — keep "Papercup is typing…" visible for the whole turn.
  // Discord's typing expires after ~10s, so we ping every 8s while waiting.
  const stopHeartbeat = beginTypingHeartbeat(msg.channel);
  const renderer = makeProgressRenderer(state.session, msg.channel);
  const tStart = Date.now();
  let reply;
  try {
    reply = await withPlanContext(
      state.session,
      msg.channelId,
      msg.author.id,
      () => state.agent.respond(userText, renderer ? { onEvent: (e) => renderer.handle(e) } : undefined),
    );
  } catch (err) {
    stopHeartbeat();
    await renderer?.finalize(false, 0);
    if ((err as Error).message === "cancelled") {
      console.log(`[text→line] cancelled by user`);
      return;
    }
    console.error("[text→line] agent failed:", err);
    await msg.reply(`❌ Agent failed: ${(err as Error).message}`);
    return;
  }
  stopHeartbeat();
  await renderer?.finalize(true, (reply.text ?? "").length);
  await syncBackendId(state);
  const replyText = reply.text || "(empty)";
  console.log(`[text→line] reply (${reply.elapsedMs}ms): "${replyText}"`);
  await sessions.touch(state.session.id);

  // Reply in chat for the visible record. Splits long replies into
  // multiple messages instead of truncating; outbox files attach to the
  // last chunk.
  const files = outboxDir ? await scanOutbox(outboxDir) : [];
  await replyChunked(msg, replyText, files);
  botReplyCount.set(msg.channelId, (botReplyCount.get(msg.channelId) ?? 0) + 1);
  await budget.record(state.session.model, reply.inputTokens, reply.outputTokens);
  refreshRichPresence();
  void maybeWarnContextPressure(msg.channel, msg.channelId, state.session.name, reply.inputTokens);

  // Also speak it on the active voice line.
  if (reply.text) {
    try {
      const synth = await tts.synthesize(reply.text);
      const stereo = mono24kS16ToStereo48kS16(synth.pcm);
      playBack(state, stereo);
    } catch (err) {
      console.error("[text→line] tts failed:", err);
    }
  }

  void renderStatus(state, `💬 (chat) "${userText}" → "${replyText}" (${Date.now() - tStart}ms)`, true);
}

async function handleTextOnlyChat(msg: Message, userText: string, outboxDir?: string): Promise<void> {
  const stopHeartbeat = beginTypingHeartbeat(msg.channel);

  let chat = textChats.get(msg.channelId);
  let firstTurnKind: "new" | "resumed" | undefined;
  if (!chat) {
    // Prefer resuming the most-recently-active session bound to this channel.
    // Survives bot restarts so the user keeps their context.
    let prior = sessions.findLatestForChannel(msg.channelId, "text");
    const channelName = "name" in msg.channel ? (msg.channel as { name: string }).name : msg.channelId;
    // Auto-migration: older sessions don't have channelId set. If a session
    // exists with the conventional name `chat-<channel>` and no channelId,
    // adopt it for this channel and persist the binding so subsequent
    // restarts find it via the fast path above.
    if (!prior) {
      const byName = sessions.findByName(`chat-${channelName}`);
      if (byName && !byName.channelId && byName.mode === "text") {
        await sessions.setChannelId(byName.id, msg.channelId);
        prior = byName;
        console.log(`[text-chat] migrated legacy session "${byName.name}" → channelId=${msg.channelId}`);
      }
    }
    let session: Session;
    let resume = false;
    if (prior) {
      session = prior;
      resume = true;
      firstTurnKind = "resumed";
      console.log(`[text-chat] resuming "${session.name}" (last used ${humanAgo(session.lastActiveAt)}) for channel ${msg.channelId}`);
    } else {
      session = await sessions.create({ name: `chat-${channelName}` });
      await sessions.setMode(session.id, "text");
      await sessions.setChannelId(session.id, msg.channelId);
      Object.assign(session, sessions.findByName(session.name) ?? session);
      firstTurnKind = "new";
      console.log(`[text-chat] auto-spawn "${session.name}" for channel ${msg.channelId}`);
    }
    const agent = new SpeakerAgent();
    const startSessionId = resume ? (session.backendId ?? session.id) : session.id;
    await agent.start({
      sessionId: startSessionId,
      resume,
      model: session.model,
      effort: session.effort,
      permissionMode: session.permissionMode,
      allowedMcps: session.allowedMcps,
      mode: "text",
      backendName: session.backend,
    });
    chat = { session, agent };
    textChats.set(msg.channelId, chat);
  }

  // One-time per-channel session indicator. Fires for both new and resumed
  // first turns after each bot start.
  if (firstTurnKind && !firstTurnAnnounced.has(msg.channelId)) {
    firstTurnAnnounced.add(msg.channelId);
    await postSessionIndicator(msg, chat.session, chat.agent, firstTurnKind);
  }

  const tStart = Date.now();
  const renderer = makeProgressRenderer(chat.session, msg.channel);
  let reply;
  try {
    reply = await withPlanContext(
      chat.session,
      msg.channelId,
      msg.author.id,
      () => chat.agent.respond(
        userText,
        renderer ? { onEvent: (e) => renderer.handle(e) } : undefined,
      ),
    );
  } catch (err) {
    stopHeartbeat();
    await renderer?.finalize(false, 0);
    if ((err as Error).message === "cancelled") {
      console.log(`[text-chat] cancelled by user`);
      return;
    }
    console.error("[text-chat] agent failed:", err);
    await msg.reply(`❌ Agent failed: ${(err as Error).message}`);
    return;
  }
  stopHeartbeat();
  await renderer?.finalize(true, (reply.text ?? "").length);
  console.log(`[text-chat] reply (${reply.elapsedMs}ms, total ${Date.now() - tStart}ms): "${reply.text}"`);
  await sessions.touch(chat.session.id);

  const replyText = reply.text || "(empty)";
  const files = outboxDir ? await scanOutbox(outboxDir) : [];
  await replyChunked(msg, replyText, files);
  botReplyCount.set(msg.channelId, (botReplyCount.get(msg.channelId) ?? 0) + 1);
  await budget.record(chat.session.model, reply.inputTokens, reply.outputTokens);
  refreshRichPresence();
  void maybeWarnContextPressure(msg.channel, msg.channelId, chat.session.name, reply.inputTokens);
}

/**
 * Returns a ProgressRenderer if the session has streaming enabled and the
 * channel supports sending text messages; undefined otherwise. Caller's
 * onEvent callsite handles undefined (no streaming UI).
 */
function makeProgressRenderer(
  session: Session,
  channel: TextBasedChannel,
): ProgressRenderer | undefined {
  const mode = (session.streaming ?? "off") as StreamingMode;
  if (mode === "off") return undefined;
  if (!("send" in channel)) return undefined;
  return new ProgressRenderer(channel, mode);
}

async function handleSay(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const text = interaction.options.getString("text", true);
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.editReply("Not in a guild.");
    return;
  }
  const state = lines.get(guildId);
  if (!state) {
    await interaction.editReply("No active line. /pickup first.");
    return;
  }

  await interaction.editReply(`🗣️ Synthesizing: "${text}"`);
  const t0 = Date.now();
  let result;
  try {
    result = await tts.synthesize(text);
  } catch (err) {
    console.error("[say] synth failed:", err);
    await interaction.editReply(`❌ TTS failed: ${(err as Error).message}`);
    return;
  }
  const synthMs = Date.now() - t0;

  const stereo48k = mono24kS16ToStereo48kS16(result.pcm);
  console.log(`[say] synth ${result.durationMs.toFixed(0)}ms in ${synthMs}ms; playing ${stereo48k.length} bytes`);
  playBack(state, stereo48k);

  await interaction.editReply(
    `🗣️ "${text}"\n` +
    `📡 ${result.durationMs.toFixed(0)}ms audio synthesized in ${synthMs}ms (RTF ${(synthMs / result.durationMs).toFixed(2)})`,
  );
}

function beginCaptureLoop(state: LineState): void {
  const { connection, userId } = state;

  // The receive subscription stream ends after `silenceMs` of silence,
  // then we re-subscribe for the next utterance.
  const captureOnce = (): void => {
    if (connection.state.status === VoiceConnectionStatus.Destroyed) {
      console.log("[capture] connection destroyed; loop exit");
      return;
    }

    console.log(`[capture] subscribing to user ${userId}, silence=${silenceMs}ms`);
    const opusStream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: silenceMs },
    });

    let opusFrames = 0;
    opusStream.on("data", () => {
      opusFrames++;
      if (opusFrames === 1) console.log("[capture] first opus frame");
    });

    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 2,
      frameSize: 960,
    });

    const pcmChunks: Buffer[] = [];
    const pcmStream = opusStream.pipe(decoder);

    // Any of {end, error on opus, error on pcm} can fire — but only one
    // should re-subscribe, otherwise we'd have parallel subscriptions racing
    // for the same user. Guard with a one-shot flag.
    let restarted = false;
    const restart = (reason: string): void => {
      if (restarted) return;
      restarted = true;
      console.log(`[capture] restart (${reason})`);
      try { opusStream.destroy(); } catch { /* already gone */ }
      setImmediate(captureOnce);
    };

    pcmStream.on("data", (chunk: Buffer) => {
      pcmChunks.push(chunk);
    });

    pcmStream.once("end", () => {
      if (restarted) return;
      restarted = true;
      const buf = Buffer.concat(pcmChunks);
      void handleUtterance(state, buf, opusFrames).then(() => setImmediate(captureOnce));
    });

    pcmStream.once("error", (err) => {
      console.error("[capture] pcm stream error:", err);
      restart("pcm-error");
    });

    opusStream.once("error", (err) => {
      // DAVE decryption races, network glitches, etc. The receive subscription
      // is dead once this fires — re-subscribe instead of going silent.
      console.error("[capture] opus stream error:", err);
      restart("opus-error");
    });
  };

  captureOnce();
}

function extensionSettledText(ext: Extension): string {
  const label = ext.name || ext.task.slice(0, 60);
  const seconds = ext.durationMs ? Math.round(ext.durationMs / 1000) : 0;
  const minutes = Math.floor(seconds / 60);
  const human =
    minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${seconds} seconds`;
  return ext.status === "completed"
    ? `Heads up — ${label} just finished after ${human}. Want the rundown?`
    : ext.status === "failed"
    ? `${label} failed after ${human}. Check the logs when you have a sec.`
    : `${label} got interrupted before it finished.`;
}

async function announceExtensionSettledVoice(state: LineState, ext: Extension): Promise<void> {
  const text = extensionSettledText(ext);
  console.log(`[notify:voice] ${ext.id} (${ext.status}) → ${text.slice(0, 60)}`);
  let synth;
  try {
    synth = await tts.synthesize(text);
  } catch (err) {
    console.error("[notify:voice] synth failed:", err);
    return;
  }
  const stereo48k = mono24kS16ToStereo48kS16(synth.pcm);
  playBack(state, stereo48k);
}

async function announceExtensionSettledText(
  channelId: string,
  chat: TextChat,
  ext: Extension,
): Promise<void> {
  const text = extensionSettledText(ext);
  console.log(`[notify:text] ${ext.id} (${ext.status}) → ${text.slice(0, 60)} (chat=${chat.session.name})`);
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && "send" in channel) {
      const summaryLine = ext.summary ? `\n> ${ext.summary.slice(0, 400)}${ext.summary.length > 400 ? "…" : ""}` : "";
      await channel.send(`🔔 ${text}${summaryLine}`);
    }
  } catch (err) {
    console.error("[notify:text] send failed:", err);
  }
}

/**
 * Pin a message in the guild's bound channel showing the currently-active
 * session card (name + mode/model/effort/permissions/mcps/notify). Edits in
 * place if a pin already exists; creates + pins a new message otherwise.
 *
 * Skips silently when:
 *  - The guild has no /bind config
 *  - The bound channel can't be fetched
 *  - The bot lacks MANAGE_MESSAGES (pin attempt fails — message still posts)
 */
async function updateSessionPin(guildId: string, session: Session): Promise<void> {
  const boundChannelId = guildConfig.get(guildId).boundTextChannelId ?? boundTextChannelId;
  if (!boundChannelId) return;

  const channel = await client.channels.fetch(boundChannelId).catch(() => null);
  if (!channel || !("send" in channel) || !("messages" in channel)) return;

  const lines: string[] = [];
  lines.push(`📍 **Active session: \`${session.name}\`**`);
  lines.push(`Mode: \`${session.mode ?? "voice"}\``);
  if (session.model) lines.push(`Model: \`${session.model}\``);
  if (session.effort) lines.push(`Effort: \`${session.effort}\``);
  if (session.permissionMode) lines.push(`Permissions: \`${session.permissionMode}\``);
  if (session.allowedMcps?.length) {
    lines.push(`MCPs: ${session.allowedMcps.map((n) => `\`${n}\``).join(", ")}`);
  }
  if (session.notify) lines.push(`🔔 Extension-completion notify: on`);
  lines.push(`-# Pin updates on each /model, /effort, /permissions, /mcp, /notify, /rename, /new. Unpins on /hangup.`);
  const text = lines.join("\n");

  const existing = sessionPins.get(guildId);
  if (existing && existing.channelId === boundChannelId) {
    try {
      const msg = await channel.messages.fetch(existing.messageId);
      await msg.edit(text);
      return;
    } catch {
      // Pinned message was deleted; fall through to create a new one.
      sessionPins.delete(guildId);
    }
  }

  try {
    const sent = await channel.send(text);
    try {
      await sent.pin();
    } catch (err) {
      console.warn(`[pin] sent but couldn't pin (missing MANAGE_MESSAGES?):`, (err as Error).message);
    }
    sessionPins.set(guildId, { channelId: boundChannelId, messageId: sent.id });
  } catch (err) {
    console.error(`[pin] failed to send session card:`, (err as Error).message);
  }
}

async function clearSessionPin(guildId: string): Promise<void> {
  const existing = sessionPins.get(guildId);
  if (!existing) return;
  sessionPins.delete(guildId);

  const channel = await client.channels.fetch(existing.channelId).catch(() => null);
  if (!channel || !("messages" in channel)) return;

  try {
    const msg = await channel.messages.fetch(existing.messageId);
    await msg.unpin().catch(() => { /* ignore — pin might already be gone */ });
    await msg.delete().catch(() => { /* ignore */ });
  } catch { /* message might have been deleted manually */ }
}

/**
 * Keep "Papercup is typing…" alive in the channel until stop() is called.
 * Discord's typing indicator expires after ~10s; we ping every 8s while a
 * turn is in flight so the user has a continuous visible cue.
 */
function beginTypingHeartbeat(channel: TextBasedChannel): () => void {
  if (!("sendTyping" in channel)) {
    return () => {};
  }
  const tick = () => channel.sendTyping().catch(() => { /* ignore */ });
  tick();
  const interval = setInterval(tick, 8_000);
  return () => clearInterval(interval);
}

/**
 * Download Discord attachments to data/inbox/<channel>/<msg-id>/ and return
 * a markdown-style augmentation to append to the user's text so the agent
 * knows what was attached and where to find it.
 *
 * Skips files larger than 25MB (Discord's effective per-message ceiling for
 * the bot's reply path; if Discord delivered it, we can fetch it). Fails
 * soft — single attachment failure doesn't block the rest.
 */
async function ingestAttachments(msg: Message): Promise<string> {
  if (msg.attachments.size === 0) return "";
  const inboxRoot = path.join(process.cwd(), "data", "inbox", msg.channelId, msg.id);
  await fsp.mkdir(inboxRoot, { recursive: true });

  const lines: string[] = [];
  for (const att of msg.attachments.values()) {
    const safeName = att.name?.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
    const localPath = path.join(inboxRoot, safeName);
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(localPath, buf);
      const ct = att.contentType ?? "application/octet-stream";
      const isImage = ct.startsWith("image/");
      lines.push(
        `📎 ${isImage ? "image" : "file"} attached: \`${safeName}\` ` +
        `(${ct}, ${buf.length} bytes) — saved at \`${localPath}\``,
      );
    } catch (err) {
      console.error(`[inbox] failed ${att.name}:`, err);
    }
  }
  if (lines.length === 0) return "";

  // Wrapper tells the agent how to use the paths. Claude-code's Read tool
  // handles images natively for vision-capable models (Opus/Sonnet) — same
  // path works for both code and images.
  return [
    "[Files attached to this message. Use Read on each path below — for images, ",
    " Read returns vision input automatically when the model supports it:]",
    ...lines,
  ].join("\n");
}

/**
 * Markdown-aware splitter for Discord replies. Discord's per-message ceiling
 * is 2000 chars; we cap at 1950 for safety. The fix avoids these footguns:
 *  - Don't split inside ``` fenced blocks without closing + reopening with
 *    the same language tag.
 *  - Don't split inside `inline code` (would orphan a backtick).
 *  - Don't split inside [link](url) syntax.
 *  - Prefer paragraph / newline / sentence boundaries — and if we're inside
 *    a code block, prefer splitting at a code-line boundary.
 */
function splitMarkdownSafe(text: string, max: number): string[] {
  if (text.length <= max) return [text];

  // For a `remaining` string, find the open code block at offset `max`
  // (if any), so we know whether to close + reopen with a language tag.
  // Returns {inBlock: true, lang} if offset `max` is inside a fenced block.
  const blockStateAt = (s: string, offset: number): { inBlock: boolean; lang: string } => {
    let pos = 0;
    let inBlock = false;
    let lang = "";
    const re = /```([^\n`]*)\n/g;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m.index >= offset) break;
      if (!inBlock) {
        inBlock = true;
        lang = (m[1] ?? "").trim();
      } else {
        inBlock = false;
        lang = "";
      }
      pos = m.index + m[0].length;
    }
    void pos;
    return { inBlock, lang };
  };

  // Find a safe cut <= max in `s`. Returns the cut index.
  const findSafeCut = (s: string): number => {
    const window = s.slice(0, max);
    const candidates: number[] = [];
    const para = window.lastIndexOf("\n\n");
    const nl = window.lastIndexOf("\n");
    const sent = window.lastIndexOf(". ");
    const word = window.lastIndexOf(" ");
    for (const c of [para, nl, sent, word]) {
      if (c >= max * 0.4) candidates.push(c);
    }
    candidates.push(max - 1);

    for (const cut of candidates) {
      const piece = s.slice(0, cut);
      // Avoid severing single-backtick inline code (odd backtick count where
      // ``` doesn't apply). Easier heuristic: count standalone single
      // backticks not part of triples.
      const noTriples = piece.replace(/```/g, "");
      const singles = (noTriples.match(/`/g) ?? []).length;
      if (singles % 2 !== 0) continue;
      // Don't sever an in-progress markdown link.
      if (/\[[^\]]*$/.test(piece)) continue;
      if (/\]\([^)]*$/.test(piece)) continue;
      return cut;
    }
    return max;
  };

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    const cut = findSafeCut(remaining);
    let piece = remaining.slice(0, cut);
    let next = remaining.slice(cut).replace(/^\n+/, "");

    const { inBlock, lang } = blockStateAt(remaining, cut);
    if (inBlock) {
      if (!piece.endsWith("\n")) piece += "\n";
      piece += "```";
      next = "```" + (lang || "") + "\n" + next;
    }

    chunks.push(piece);
    remaining = next;
  }
  chunks.push(remaining);
  return chunks;
}

/**
 * Send a long text reply as multiple Discord messages. Files (if any)
 * attach to the LAST chunk only — user gets the explanation followed by
 * the artifact.
 */
async function replyChunked(
  msg: Message,
  content: string,
  files?: string[],
): Promise<void> {
  const chunks = splitMarkdownSafe(content || "(empty)", 1950);
  const channel = msg.channel;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const opts = {
      content: chunks[i],
      ...(isLast && files && files.length ? { files } : {}),
    };
    try {
      if (i === 0) {
        await msg.reply(opts);
      } else if ("send" in channel) {
        await channel.send(opts);
      }
    } catch (err) {
      console.error(`[reply-chunked] chunk ${i + 1}/${chunks.length} failed:`, err);
    }
  }
}

/**
 * Reserve a per-turn outbox directory the agent can write files to. After
 * respond(), scanOutbox() picks up anything new and the bot attaches it to
 * the reply. Returns the dir + a hint string to append to the user prompt.
 */
async function prepareOutbox(msg: Message): Promise<{ dir: string; hint: string }> {
  const dir = path.join(process.cwd(), "data", "outbox", msg.channelId, msg.id);
  await fsp.mkdir(dir, { recursive: true });
  const hint =
    `[Outbox: any files you Write to \`${dir}\` will be attached to my reply ` +
    `(max 10 files, 25MB each). Use this for charts, generated code, screenshots, etc. ` +
    `Don't mention the outbox path in your reply text — just write the file.]`;
  return { dir, hint };
}

/**
 * Scan the outbox dir for files the agent created. Returns absolute paths
 * suitable for Discord's `files: [...]` reply option. Caps at 10 files
 * (Discord limit) and skips files >24MB (slightly under the 25MB ceiling
 * for safety on non-boosted servers).
 */
async function scanOutbox(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const p = path.join(dir, e.name);
    try {
      const stat = await fsp.stat(p);
      if (stat.size > 24 * 1024 * 1024) {
        console.warn(`[outbox] skipping ${e.name}: ${stat.size} bytes (>24MB)`);
        continue;
      }
      out.push(p);
      if (out.length >= 10) break;
    } catch { /* file disappeared between readdir and stat */ }
  }
  return out;
}

/**
 * Discover MCP servers available on this box by shelling out to
 * `claude mcp list`. Parses lines like:
 *   plugin:ecc:playwright: npx -y @playwright/mcp@0.0.69 - ✓ Connected
 *   claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication
 */
async function listAvailableMcps(): Promise<{ name: string; connected: boolean }[]> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["mcp", "list"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    proc.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
    proc.on("error", () => resolve([]));
    proc.on("exit", () => {
      const out: { name: string; connected: boolean }[] = [];
      for (const line of stdout.split("\n")) {
        const m = line.match(/^([^:]+(?::[^:]+)*?):\s.*\s-\s(✓\s*Connected|!\s*Needs authentication)/);
        if (m && m[1] && m[2]) {
          out.push({ name: m[1].trim(), connected: m[2].includes("Connected") });
        }
      }
      resolve(out);
    });
  });
}

function playBack(state: LineState, pcm: Buffer): void {
  const seconds = pcm.length / (48000 * 2 * 2);
  console.log(`[playback] echoing ${seconds.toFixed(2)}s of audio`);
  const resource = createAudioResource(Readable.from(pcm), {
    inputType: StreamType.Raw,
  });
  state.player.play(resource);
}

async function handleUtterance(
  state: LineState,
  pcm48kStereoS16: Buffer,
  opusFrames: number,
): Promise<void> {
  if (pcm48kStereoS16.length === 0) {
    console.log(`[capture] empty utterance (${opusFrames} opus frames); skipping`);
    return;
  }

  const mono16k = stereo48kS16ToMono16kF32(pcm48kStereoS16);

  // Diagnostic: peak of raw s16 PCM and resampled f32 mono.
  let s16Peak = 0;
  for (let i = 0; i + 1 < pcm48kStereoS16.length; i += 2) {
    const v = Math.abs(pcm48kStereoS16.readInt16LE(i));
    if (v > s16Peak) s16Peak = v;
  }
  let f32Peak = 0;
  for (let i = 0; i < mono16k.length; i++) {
    const v = Math.abs(mono16k[i] ?? 0);
    if (v > f32Peak) f32Peak = v;
  }
  console.log(`[debug] s16 peak: ${s16Peak} (max 32767), f32 peak: ${f32Peak.toFixed(4)}`);

  // Dump first non-trivial utterance to disk for offline analysis.
  if (process.env.DUMP_PCM === "1" && s16Peak > 1000 && !((globalThis as unknown as { __dumped?: boolean }).__dumped)) {
    (globalThis as unknown as { __dumped?: boolean }).__dumped = true;
    const fs = await import("node:fs/promises");
    await fs.writeFile("/tmp/papercup-mono16k.f32", Buffer.from(mono16k.buffer, mono16k.byteOffset, mono16k.byteLength));
    await fs.writeFile("/tmp/papercup-stereo48k.s16", pcm48kStereoS16);
    console.log(`[debug] dumped PCM: /tmp/papercup-mono16k.f32 (${mono16k.length * 4} bytes), /tmp/papercup-stereo48k.s16 (${pcm48kStereoS16.length} bytes)`);
  }


  const windows = Math.floor(mono16k.length / VAD_WINDOW_SAMPLES);
  const probs: number[] = [];
  let sum = 0;
  let max = 0;
  let speechWindows = 0;
  for (let i = 0; i < windows; i++) {
    // Copy into a fresh, owned buffer — ONNX Runtime can be picky about subarray views.
    const slice = new Float32Array(
      mono16k.subarray(i * VAD_WINDOW_SAMPLES, (i + 1) * VAD_WINDOW_SAMPLES),
    );
    const p = await vad.run(slice);
    probs.push(p);
    sum += p;
    if (p > max) max = p;
    if (p >= vadThreshold) speechWindows++;
  }
  const avg = windows > 0 ? sum / windows : 0;

  console.log(
    `[capture] utterance: ${opusFrames} opus frames, ${pcm48kStereoS16.length} bytes, ` +
    `${windows} VAD windows, avg=${avg.toFixed(4)}, max=${max.toFixed(4)}, speech=${speechWindows}`,
  );
  if (probs.length > 0) {
    const sample = probs.slice(0, Math.min(8, probs.length)).map(p => p.toFixed(4)).join(", ");
    console.log(`[debug] first probs: [${sample}]`);
  }

  const seconds = mono16k.length / 16000;

  if (speechWindows < vadMinSpeechWindows) {
    console.log(`[capture] noise-only (speech<${vadMinSpeechWindows}); skipping playback`);
    void renderStatus(
      state,
      `🔇 ${seconds.toFixed(1)}s — no speech detected (max ${max.toFixed(2)})`,
      true,
    );
    return;
  }

  void renderStatus(
    state,
    `💬 ${seconds.toFixed(1)}s speech (max ${max.toFixed(2)}) — transcribing`,
    true,
  );

  // Don't block the capture loop on STT/agent/TTS. Run the conversation
  // pipeline async.
  void runAgent(state, mono16k);
}

async function runAgent(state: LineState, mono16k: Float32Array): Promise<void> {
  const tStart = Date.now();
  let transcript;
  try {
    transcript = await stt.transcribe(mono16k);
  } catch (err) {
    console.error("[agent] stt failed:", err);
    void renderStatus(state, `❌ STT failed`, true);
    return;
  }
  const userText = transcript.text.trim();
  console.log(
    `[agent] heard "${userText || "(empty)"}" (${transcript.duration}s in ${transcript.elapsed}s, RTF=${transcript.rtf})`,
  );
  if (!userText) {
    void renderStatus(state, `🤐 transcript empty — skipping`, true);
    return;
  }
  void renderStatus(state, `🗣️ you: "${userText}" — thinking`, true);

  let reply;
  try {
    reply = await state.agent.respond(userText);
  } catch (err) {
    console.error("[agent] llm failed:", err);
    void renderStatus(state, `❌ Agent failed: ${(err as Error).message}`, true);
    return;
  }
  await syncBackendId(state);
  console.log(
    `[agent] reply (${reply.elapsedMs}ms, in=${reply.inputTokens} out=${reply.outputTokens}): "${reply.text}"`,
  );
  if (!reply.text) {
    void renderStatus(state, `🤔 (agent returned empty)`, true);
    return;
  }
  void renderStatus(state, `🤖 cup: "${reply.text}" — synthesizing`, true);

  let synth;
  try {
    // Pass the user's detected language to TTS — AutoTtsEngine uses this to
    // route Korean → MeloTTS, everything else → Kokoro. The agent system
    // prompt instructs it to reply in the user's language, so this is a
    // reasonable proxy for the reply's language too.
    synth = await tts.synthesize(reply.text, { lang: transcript.lang ?? undefined });
  } catch (err) {
    console.error("[agent] tts failed:", err);
    void renderStatus(state, `❌ TTS failed: ${(err as Error).message}`, true);
    return;
  }
  const stereo = mono24kS16ToStereo48kS16(synth.pcm);
  playBack(state, stereo);
  const totalMs = Date.now() - tStart;
  console.log(`[agent] full loop: ${totalMs}ms (heard→spoke), lang=${transcript.lang ?? "?"}`);
  void renderStatus(state, `🔊 cup: "${reply.text}" — loop ${totalMs}ms`, true);
}

async function renderStatus(
  state: LineState,
  event: string,
  pushHistory: boolean = false,
): Promise<void> {
  const now = Date.now();
  if (pushHistory) {
    state.history.push(event);
    if (state.history.length > STATUS_HISTORY_LINES) {
      state.history = state.history.slice(-STATUS_HISTORY_LINES);
    }
  }

  // Throttle. Discord rate-limits editReply hard; once/second is safe.
  if (now - state.statusUpdateAt < STATUS_MIN_INTERVAL_MS) return;
  state.statusUpdateAt = now;

  const lines: string[] = ["📡 **On a line — listening**"];
  if (state.history.length > 0) {
    lines.push("");
    for (const h of state.history) lines.push(h);
  }
  if (!pushHistory) {
    lines.push("");
    lines.push(event);
  }

  try {
    await state.interaction.editReply(lines.join("\n"));
  } catch (err) {
    console.error("[status] editReply failed:", err);
  }
}

await client.login(token);
