import "dotenv/config";
import { createServer, Server } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Interaction,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

type Choice = "rock" | "paper" | "scissors";

type GameState = {
  hostId: string;
  players: Set<string>;
  choices: Record<string, Choice>;
  status: "lobby" | "playing";
};

type LeaderboardRow = {
  user_id: string;
  wins: number;
  losses: number;
};

type RoundOutcome =
  | { kind: "no_choices"; losers: string[] }
  | { kind: "same_choice"; losers: string[] }
  | { kind: "all_symbols"; losers: string[] }
  | { kind: "elimination"; losers: string[]; winningChoice: Choice };

const CHOICES: Record<Choice, string> = {
  rock: "Kivi",
  paper: "Paperi",
  scissors: "Sakset",
};

const commands = [
  new SlashCommandBuilder()
    .setName("battle")
    .setDescription("Aloita kivi-paperi-sakset battle royale.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Nayta voittotilasto.")
    .toJSON(),
];

function getRequiredEnv(name: "TOKEN" | "CLIENT_ID"): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in environment variables.`);
  }

  return value;
}

function getDatabasePath(): string {
  const configuredPath = process.env.DATABASE_PATH?.trim();
  if (configuredPath) {
    return resolve(configuredPath);
  }

  const railwayVolume = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (railwayVolume) {
    return resolve(railwayVolume, "leaderboard.db");
  }

  return resolve("data", "leaderboard.db");
}

const TOKEN = getRequiredEnv("TOKEN");
const CLIENT_ID = getRequiredEnv("CLIENT_ID");
const PORT = Number(process.env.PORT ?? "3000");
const DATABASE_PATH = getDatabasePath();

mkdirSync(dirname(DATABASE_PATH), { recursive: true });

const db = new Database(DATABASE_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS leaderboard (
    user_id TEXT PRIMARY KEY,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0
  )
`);

const ensurePlayerStmt = db.prepare(`
  INSERT INTO leaderboard (user_id, wins, losses)
  VALUES (?, 0, 0)
  ON CONFLICT(user_id) DO NOTHING
`);
const addWinStmt = db.prepare(`
  UPDATE leaderboard
  SET wins = wins + 1
  WHERE user_id = ?
`);
const addLossStmt = db.prepare(`
  UPDATE leaderboard
  SET losses = losses + 1
  WHERE user_id = ?
`);
const topPlayersStmt = db.prepare(`
  SELECT user_id, wins, losses
  FROM leaderboard
  ORDER BY wins DESC, losses ASC, user_id ASC
  LIMIT 10
`);

const games = new Map<string, GameState>();
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let isDiscordReady = false;
let healthServer: Server | null = null;

function ensurePlayer(userId: string): void {
  ensurePlayerStmt.run(userId);
}

function addWin(userId: string): void {
  ensurePlayer(userId);
  addWinStmt.run(userId);
}

function addLoss(userId: string): void {
  ensurePlayer(userId);
  addLossStmt.run(userId);
}

function buildLobbyEmbed(game: GameState): EmbedBuilder {
  const players = [...game.players].map(id => `<@${id}>`).join("\n");

  return new EmbedBuilder()
    .setTitle("KPS Battle Royale")
    .setDescription(
      [
        "Liity peliin painikkeella.",
        "",
        `Pelaajat (${game.players.size}):`,
        players || "Ei pelaajia viela.",
      ].join("\n"),
    );
}

function lobbyButtons(hostId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("join_game")
      .setLabel("Liity peliin")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`start_game:${hostId}`)
      .setLabel("Aloita kierros")
      .setStyle(ButtonStyle.Success),
  );
}

function choiceButtons(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("rock")
      .setLabel("Kivi")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("paper")
      .setLabel("Paperi")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("scissors")
      .setLabel("Sakset")
      .setStyle(ButtonStyle.Secondary),
  );
}

function evaluateRound(game: GameState): RoundOutcome {
  const values = Object.values(game.choices);
  const hasRock = values.includes("rock");
  const hasPaper = values.includes("paper");
  const hasScissors = values.includes("scissors");

  if (values.length === 0) {
    return { kind: "no_choices", losers: [] };
  }

  if (values.every(choice => choice === values[0])) {
    return { kind: "same_choice", losers: [] };
  }

  if (hasRock && hasPaper && hasScissors) {
    return { kind: "all_symbols", losers: [] };
  }

  if (hasRock && hasScissors) {
    return {
      kind: "elimination",
      winningChoice: "rock",
      losers: Object.entries(game.choices)
        .filter(([, choice]) => choice === "scissors")
        .map(([id]) => id),
    };
  }

  if (hasPaper && hasRock) {
    return {
      kind: "elimination",
      winningChoice: "paper",
      losers: Object.entries(game.choices)
        .filter(([, choice]) => choice === "rock")
        .map(([id]) => id),
    };
  }

  if (hasScissors && hasPaper) {
    return {
      kind: "elimination",
      winningChoice: "scissors",
      losers: Object.entries(game.choices)
        .filter(([, choice]) => choice === "paper")
        .map(([id]) => id),
    };
  }

  return { kind: "same_choice", losers: [] };
}

function buildOutcomeLine(outcome: RoundOutcome): string {
  switch (outcome.kind) {
    case "no_choices":
      return "Kierrosta ei voitu ratkaista.";
    case "same_choice":
      return "Tasapeli: kaikki valitsivat saman merkin.";
    case "all_symbols":
      return "Tasapeli: kierroksella nakyi kaikki kolme merkkia.";
    case "elimination":
      return `Kierroksen voittava merkki: ${CHOICES[outcome.winningChoice]}.`;
  }
}

function buildRoundSummary(game: GameState, outcome: RoundOutcome): string {
  const lines = Object.entries(game.choices).map(
    ([id, choice]) => `<@${id}> -> ${CHOICES[choice]}`,
  );

  lines.push("", buildOutcomeLine(outcome));

  if (outcome.losers.length === 0) {
    lines.push("Kaikki selvisivat kierroksesta.");
  } else {
    lines.push(`Pudonneet: ${outcome.losers.map(id => `<@${id}>`).join(", ")}`);
  }

  lines.push(
    "",
    `Jaljella: ${[...game.players].map(id => `<@${id}>`).join(", ")}`,
  );

  return lines.join("\n");
}

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
}

function startHealthServer(): Server {
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    const isHealthy = isDiscordReady;

    if (path === "/health") {
      response.writeHead(isHealthy ? 200 : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({
          status: isHealthy ? "ok" : "starting",
          discordReady: isDiscordReady,
          databasePath: DATABASE_PATH,
        }),
      );
      return;
    }

    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("kps-bot is running\n");
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Health server listening on ${PORT}`);
  });

  return server;
}

async function handleBattleCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const existingGame = games.get(interaction.channelId);
  if (existingGame) {
    await interaction.reply({
      content: "Tassa kanavassa on jo peli kaynnissa.",
      ephemeral: true,
    });
    return;
  }

  const game: GameState = {
    hostId: interaction.user.id,
    players: new Set([interaction.user.id]),
    choices: {},
    status: "lobby",
  };

  games.set(interaction.channelId, game);

  await interaction.reply({
    embeds: [buildLobbyEmbed(game)],
    components: [lobbyButtons(interaction.user.id)],
  });
}

async function handleLeaderboardCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const rows = topPlayersStmt.all() as LeaderboardRow[];

  const description =
    rows.length === 0
      ? "Tilasto on viela tyhja."
      : rows
          .map(
            (row, index) =>
              `${index + 1}. <@${row.user_id}> - ${row.wins} voittoa, ${row.losses} tappiota`,
          )
          .join("\n");

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("Leaderboard")
        .setDescription(description),
    ],
    ephemeral: true,
  });
}

async function handleJoinButton(interaction: ButtonInteraction): Promise<void> {
  const game = games.get(interaction.channelId);

  if (!game || game.status !== "lobby") {
    await interaction.reply({
      content: "Liittyminen ei ole juuri nyt mahdollista.",
      ephemeral: true,
    });
    return;
  }

  game.players.add(interaction.user.id);

  await interaction.update({
    embeds: [buildLobbyEmbed(game)],
    components: [lobbyButtons(game.hostId)],
  });
}

async function handleStartButton(interaction: ButtonInteraction): Promise<void> {
  const game = games.get(interaction.channelId);

  if (!game || game.status !== "lobby") {
    await interaction.reply({
      content: "Tassa kanavassa ei ole aloitettavaa pelia.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.user.id !== game.hostId) {
    await interaction.reply({
      content: "Vain pelin aloittaja voi kaynnistaa kierroksen.",
      ephemeral: true,
    });
    return;
  }

  if (game.players.size < 2) {
    await interaction.reply({
      content: "Peli tarvitsee vahintaan kaksi pelaajaa.",
      ephemeral: true,
    });
    return;
  }

  game.status = "playing";
  game.choices = {};

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setTitle("Kierros kaynnissa")
        .setDescription(
          "Tee valintasi painamalla nappia. Vastaukset kirjataan salassa.",
        ),
    ],
    components: [choiceButtons()],
  });
}

async function sendToChannel(
  interaction: ButtonInteraction,
  payload: {
    embeds: EmbedBuilder[];
    components?: ActionRowBuilder<ButtonBuilder>[];
  },
): Promise<void> {
  const channel = interaction.channel;
  if (channel?.isSendable()) {
    await channel.send(payload);
  }
}

async function handleChoiceButton(interaction: ButtonInteraction): Promise<void> {
  const game = games.get(interaction.channelId);

  if (!game || game.status !== "playing") {
    await interaction.reply({
      content: "Peli ei ole juuri nyt valintavaiheessa.",
      ephemeral: true,
    });
    return;
  }

  if (!game.players.has(interaction.user.id)) {
    await interaction.reply({
      content: "Et ole mukana tassa pelissa.",
      ephemeral: true,
    });
    return;
  }

  const choice = interaction.customId as Choice;
  game.choices[interaction.user.id] = choice;

  await interaction.reply({
    content: `Valitsit: ${CHOICES[choice]}`,
    ephemeral: true,
  });

  if (Object.keys(game.choices).length !== game.players.size) {
    return;
  }

  const outcome = evaluateRound(game);
  outcome.losers.forEach(id => {
    game.players.delete(id);
    addLoss(id);
  });

  await sendToChannel(interaction, {
    embeds: [
      new EmbedBuilder()
        .setTitle("Kierroksen tulokset")
        .setDescription(buildRoundSummary(game, outcome)),
    ],
  });

  game.choices = {};

  if (game.players.size === 1) {
    const winner = [...game.players][0];
    addWin(winner);

    await sendToChannel(interaction, {
      embeds: [
        new EmbedBuilder()
          .setTitle("Voittaja")
          .setDescription(`<@${winner}> voitti Battle Royalen.`),
      ],
    });

    games.delete(interaction.channelId);
    return;
  }

  await sendToChannel(interaction, {
    embeds: [
      new EmbedBuilder()
        .setTitle("Seuraava kierros")
        .setDescription("Jaljella olevat pelaajat tekevat uuden valinnan."),
    ],
    components: [choiceButtons()],
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down.`);
  isDiscordReady = false;

  const closeHealthServer = new Promise<void>((resolveClose, rejectClose) => {
    if (!healthServer) {
      resolveClose();
      return;
    }

    healthServer.close(error => {
      if (error) {
        rejectClose(error);
        return;
      }

      resolveClose();
    });
  });

  await Promise.allSettled([client.destroy(), closeHealthServer]);
  db.close();
  process.exit(0);
}

client.once("ready", async readyClient => {
  await registerCommands();
  isDiscordReady = true;
  console.log(`Logged in as ${readyClient.user.tag}`);
  console.log(`Using database at ${DATABASE_PATH}`);
});

client.on("interactionCreate", async (interaction: Interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "battle") {
        await handleBattleCommand(interaction);
        return;
      }

      if (interaction.commandName === "leaderboard") {
        await handleLeaderboardCommand(interaction);
      }

      return;
    }

    if (!interaction.isButton()) {
      return;
    }

    if (interaction.customId === "join_game") {
      await handleJoinButton(interaction);
      return;
    }

    if (interaction.customId.startsWith("start_game:")) {
      await handleStartButton(interaction);
      return;
    }

    if (
      interaction.customId === "rock" ||
      interaction.customId === "paper" ||
      interaction.customId === "scissors"
    ) {
      await handleChoiceButton(interaction);
    }
  } catch (error) {
    console.error(error);

    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "Tapahtui virhe.",
        ephemeral: true,
      });
    }
  }
});

healthServer = startHealthServer();

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

void client.login(TOKEN);
