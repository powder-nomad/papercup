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
  ChannelType,
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
import { SileroVad } from "@papercup/voice-stack/vad";
import { WhisperSidecar } from "@papercup/voice-stack/stt";
import { createTts, type TtsEngine } from "@papercup/voice-stack/tts";
import {
  stereo48kS16ToMono16kF32,
  mono24kS16ToStereo48kS16,
} from "@papercup/voice-stack/audio";
import { ExtensionManager } from "@papercup/voice-stack/extensions";
import { ExtensionMcpServer } from "@papercup/voice-stack/extensions/mcp";
import { SpeakerAgent } from "./agent/speaker.js";
import { SessionStore, type Session } from "./session/store.js";
import { GuildConfigStore } from "./config/guild-config.js";

const token = required("DISCORD_TOKEN");
const silenceMs = Number(process.env.SILENCE_MS ?? 600);
const vadThreshold = Number(process.env.VAD_THRESHOLD ?? 0.4);
const vadMinSpeechWindows = Number(process.env.VAD_MIN_SPEECH_WINDOWS ?? 3);
const boundTextChannelId = process.env.BOT_TEXT_CHANNEL_ID?.trim() || undefined;

const VAD_WINDOW_SAMPLES = 512; // 32 ms @ 16 kHz mono

const vad = new SileroVad();
const stt = new WhisperSidecar();
const tts: TtsEngine = createTts(process.env.TTS_ENGINE ?? "kokoro");
const sessions = new SessionStore();
const guildConfig = new GuildConfigStore();
const extensions = new ExtensionManager();
const extMcp = new ExtensionMcpServer(extensions);

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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged — must be enabled in dev portal
  ],
});

client.once("clientReady", (c) => {
  console.log(`Cup ready as ${c.user.tag}. Waiting for /pickup.`);
});

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

const mcpInfo = await extMcp.start();
process.env.PAPERCUP_MCP_URL = mcpInfo.url;
console.log(`[mcp] tools available at ${mcpInfo.url}`);

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

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
  const session = await sessions.create({ name });
  await joinAndStart(interaction, session, false);
}

async function handleResume(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const name = interaction.options.getString("name", true);
  const session = sessions.findByName(name);
  if (!session) {
    await interaction.editReply(`No session named "${name}". Try /sessions to see what's available.`);
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
  await agent.start({ sessionId: startSessionId, resume });
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
  if (!conn) {
    await interaction.editReply("No active line.");
    return;
  }
  conn.destroy();
  lines.delete(guildId);
  const sessName = state ? `"${state.session.name}"` : "";
  await interaction.editReply(`Hung up${sessName ? ` — ${sessName} preserved` : ""}.`);
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
  const newName = interaction.options.getString("name", true);
  try {
    const renamed = await sessions.rename(state.session.id, newName);
    state.session = renamed;
    await interaction.editReply(`Renamed → **${renamed.name}**`);
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
  // Defense in depth — Discord enforces the perm via setDefaultMemberPermissions,
  // but check here too in case Discord routes anomalously.
  const member = interaction.member;
  if (!(member instanceof GuildMember) || !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.editReply("You need the **Manage Server** permission to bind the bot.");
    return;
  }

  const channel = interaction.options.getChannel("channel", true);
  if (channel.type !== ChannelType.GuildText) {
    await interaction.editReply("Pick a text channel.");
    return;
  }

  await guildConfig.setBoundChannel(interaction.guildId, channel.id);
  console.log(`[bind] guild ${interaction.guildId} bound to channel ${channel.id} by ${member.user.tag}`);
  await interaction.editReply(
    `🔗 Bound to <#${channel.id}>. Every message there now goes to Papercup; other channels are ignored.`,
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
    await interaction.editReply("You need the **Manage Server** permission to unbind the bot.");
    return;
  }

  await guildConfig.clearBoundChannel(interaction.guildId);
  console.log(`[unbind] guild ${interaction.guildId} unbound by ${member.user.tag}`);
  await interaction.editReply("🔓 Unbound. Bot now responds to @mentions across all channels.");
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
  if (msg.author.bot) return;
  if (!msg.guild) return; // text-channel handler is guild-only for now

  const me = client.user;
  if (!me) return;

  // Routing modes (per-guild bind takes precedence over env var):
  //   bound     — guild has a bound channel via /bind. Listen to every message
  //               there; ignore other channels.
  //   mention   — fallback. Listen anywhere, but only when @-mentioned.
  const guildBound = guildConfig.get(msg.guild.id).boundTextChannelId ?? boundTextChannelId;
  let userText: string;
  if (guildBound) {
    if (msg.channelId !== guildBound) return;
    userText = msg.content.trim();
    if (userText.length === 0) return;
  } else {
    if (!msg.mentions.users.has(me.id)) return;
    userText = msg.content.replace(new RegExp(`<@!?${me.id}>`, "g"), "").trim();
    if (userText.length === 0) return;
  }

  console.log(`[text] from ${msg.author.tag} in #${"name" in (msg.channel as TextBasedChannel) ? (msg.channel as { name: string }).name : msg.channelId}: "${userText}"`);

  // Route: if this guild has an active voice line, append to that session and
  // also speak the reply. Otherwise spin up (or reuse) a text-only chat keyed
  // by channel.
  const activeLine = lines.get(msg.guild.id);
  if (activeLine) {
    await handleTextIntoActiveLine(msg, activeLine, userText);
    return;
  }

  await handleTextOnlyChat(msg, userText);
}

async function handleTextIntoActiveLine(
  msg: Message,
  state: LineState,
  userText: string,
): Promise<void> {
  // Show "Papercup is typing..." immediately so the channel knows we got it.
  if ("sendTyping" in msg.channel) {
    msg.channel.sendTyping().catch(() => { /* ignore */ });
  }
  const tStart = Date.now();
  let reply;
  try {
    reply = await state.agent.respond(userText);
  } catch (err) {
    console.error("[text→line] agent failed:", err);
    await msg.reply(`❌ Agent failed: ${(err as Error).message}`);
    return;
  }
  await syncBackendId(state);
  const replyText = reply.text || "(empty)";
  console.log(`[text→line] reply (${reply.elapsedMs}ms): "${replyText}"`);
  await sessions.touch(state.session.id);

  // Reply in chat for the visible record.
  await msg.reply(replyText.length > 1900 ? replyText.slice(0, 1897) + "…" : replyText);

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

async function handleTextOnlyChat(msg: Message, userText: string): Promise<void> {
  if ("sendTyping" in msg.channel) {
    msg.channel.sendTyping().catch(() => { /* ignore */ });
  }

  let chat = textChats.get(msg.channelId);
  if (!chat) {
    const channelName = "name" in msg.channel ? (msg.channel as { name: string }).name : msg.channelId;
    const session = await sessions.create({ name: `chat-${channelName}` });
    const agent = new SpeakerAgent();
    await agent.start({ sessionId: session.id, resume: false });
    chat = { session, agent };
    textChats.set(msg.channelId, chat);
    console.log(`[text-chat] new session "${session.name}" for channel ${msg.channelId}`);
  }

  const tStart = Date.now();
  let reply;
  try {
    reply = await chat.agent.respond(userText);
  } catch (err) {
    console.error("[text-chat] agent failed:", err);
    await msg.reply(`❌ Agent failed: ${(err as Error).message}`);
    return;
  }
  console.log(`[text-chat] reply (${reply.elapsedMs}ms, total ${Date.now() - tStart}ms): "${reply.text}"`);
  await sessions.touch(chat.session.id);

  const replyText = reply.text || "(empty)";
  await msg.reply(replyText.length > 1900 ? replyText.slice(0, 1897) + "…" : replyText);
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
