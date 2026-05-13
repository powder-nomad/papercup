import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  Client,
  MessageFlags,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { randomUUID } from "node:crypto";

export const ANSWER_TALK_ABOUT_IT = "__USER_WANTS_TO_DISCUSS__";
export const ANSWER_SKIP_INTERVIEW = "__SKIP_TO_PLAN__";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BUTTON_LABEL = 80;
const MAX_TEXT_INPUT = 2000;

export interface AskOptions {
  question: string;
  options: string[];
  channelId: string;
  ownerUserId: string;
  timeoutMs?: number;
}

export interface QuestionDispatcher {
  ask(opts: AskOptions): Promise<string>;
}

interface PendingQuestion {
  resolve: (answer: string) => void;
  ownerUserId: string;
  options: string[];
  question: string;
  timeout: ReturnType<typeof setTimeout>;
  messageId?: string;
  channelId: string;
}

export class DiscordQuestionDispatcher implements QuestionDispatcher {
  private pending = new Map<string, PendingQuestion>();

  constructor(private readonly client: Client) {}

  async ask(opts: AskOptions): Promise<string> {
    const channel = await this.client.channels.fetch(opts.channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new Error(`channel ${opts.channelId} is not a sendable text channel`);
    }

    const id = randomUUID().slice(0, 12);
    const opts2to4 = opts.options.slice(0, 4);

    const optionsRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...opts2to4.map((label, i) =>
        new ButtonBuilder()
          .setCustomId(`plan:opt:${id}:${i}`)
          .setLabel(truncateLabel(label))
          .setStyle(ButtonStyle.Primary),
      ),
    );

    const exitRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`plan:other:${id}`)
        .setLabel("Other...")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`plan:talk:${id}`)
        .setLabel("Talk about it")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`plan:skip:${id}`)
        .setLabel("Skip interview")
        .setStyle(ButtonStyle.Secondary),
    );

    const body = formatBody(opts.question, opts2to4);

    const promise = new Promise<string>((resolve) => {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        console.log(`[plan-mode] question ${id} timed out → ${ANSWER_TALK_ABOUT_IT}`);
        resolve(ANSWER_TALK_ABOUT_IT);
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        ownerUserId: opts.ownerUserId,
        options: opts2to4,
        question: opts.question,
        timeout,
        channelId: opts.channelId,
      });
    });

    const sent = await (channel as { send: (payload: object) => Promise<{ id: string }> }).send({
      content: body,
      components: [optionsRow, exitRow],
    });
    const p = this.pending.get(id);
    if (p) p.messageId = sent.id;

    console.log(`[plan-mode] asked question ${id} in channel ${opts.channelId} (msg ${sent.id})`);
    return promise;
  }

  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const customId = interaction.customId;
    if (!customId.startsWith("plan:")) return false;

    const parts = customId.split(":");
    const kind = parts[1];
    const id = parts[2];
    if (!kind || !id) {
      await interaction.reply({
        content: "Malformed plan-mode interaction id.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const pending = this.pending.get(id);

    if (!pending) {
      await interaction.reply({
        content: "This planning question expired or was already answered.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (interaction.user.id !== pending.ownerUserId) {
      await interaction.reply({
        content: "Only the session owner can answer this question.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (kind === "opt") {
      const idx = parseInt(parts[3] ?? "", 10);
      if (Number.isNaN(idx) || idx < 0 || idx >= pending.options.length) {
        await interaction.reply({ content: "Invalid option.", flags: MessageFlags.Ephemeral });
        return true;
      }
      const answer = pending.options[idx]!;
      this.resolvePending(id, answer);
      await interaction.update({
        content: `${formatBody(pending.question, pending.options)}\n\n✅ **answered:** ${answer}`,
        components: [],
      });
      return true;
    }

    if (kind === "skip") {
      this.resolvePending(id, ANSWER_SKIP_INTERVIEW);
      await interaction.update({
        content: `${formatBody(pending.question, pending.options)}\n\n⏭️ **skipped interview** — planning now`,
        components: [],
      });
      return true;
    }

    if (kind === "other") {
      const modal = new ModalBuilder()
        .setCustomId(`plan-modal:other:${id}`)
        .setTitle("Custom answer");
      const input = new TextInputBuilder()
        .setCustomId("answer")
        .setLabel("Your answer")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(MAX_TEXT_INPUT);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    if (kind === "talk") {
      const modal = new ModalBuilder()
        .setCustomId(`plan-modal:talk:${id}`)
        .setTitle("Drop to free chat");
      const input = new TextInputBuilder()
        .setCustomId("opening")
        .setLabel("Opening message (optional)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(MAX_TEXT_INPUT);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return true;
    }

    return false;
  }

  async handleModal(interaction: ModalSubmitInteraction): Promise<boolean> {
    const customId = interaction.customId;
    if (!customId.startsWith("plan-modal:")) return false;

    const parts = customId.split(":");
    const kind = parts[1];
    const id = parts[2];
    if (!kind || !id) {
      await interaction.reply({
        content: "Malformed plan-mode interaction id.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const pending = this.pending.get(id);

    if (!pending) {
      await interaction.reply({
        content: "This planning question expired or was already answered.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (interaction.user.id !== pending.ownerUserId) {
      await interaction.reply({
        content: "Only the session owner can answer this question.",
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    if (kind === "other") {
      const text = interaction.fields.getTextInputValue("answer").trim();
      if (!text) {
        await interaction.reply({
          content: "Empty answer — try again.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      this.resolvePending(id, text);
      await interaction.reply({
        content: `📝 **custom answer:** ${truncatePreview(text)}`,
      });
      return true;
    }

    if (kind === "talk") {
      const opening = interaction.fields.getTextInputValue("opening").trim();
      const answer = opening
        ? `${ANSWER_TALK_ABOUT_IT}\n${opening}`
        : ANSWER_TALK_ABOUT_IT;
      this.resolvePending(id, answer);
      await interaction.reply({
        content: opening
          ? `💬 **dropped to free chat:** ${truncatePreview(opening)}`
          : `💬 **dropped to free chat**`,
      });
      return true;
    }

    return false;
  }

  private resolvePending(id: string, answer: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timeout);
    this.pending.delete(id);
    p.resolve(answer);
  }
}

function truncateLabel(s: string): string {
  if (s.length <= MAX_BUTTON_LABEL) return s;
  return s.slice(0, MAX_BUTTON_LABEL - 1) + "…";
}

function truncatePreview(s: string): string {
  if (s.length <= 200) return s;
  return s.slice(0, 199) + "…";
}

function formatBody(question: string, options: string[]): string {
  const numbered = options.map((o, i) => `**${i + 1}.** ${o}`).join("\n");
  return `**🧭 Plan-mode question**\n${question}\n\n${numbered}`;
}
