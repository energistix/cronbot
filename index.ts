import {
  Client,
  GatewayIntentBits,
  Message,
  MessageReaction,
  PartialMessageReaction,
  PermissionsBitField,
  TextChannel,
  User,
} from "discord.js"
import Database from "bun:sqlite"
import cron from "node-cron"

// Initialize SQLite database
const db = new Database("cronbot.db")

class Pager {
  private static pagers = new Map<string, Pager>()

  private page: number
  private totalPages: number
  private perPage: number = 10
  private totalItems: number
  private itemsPerPage: number
  private items: string[]
  private message?: Message

  constructor(items: string[], channel: TextChannel) {
    this.items = items
    this.totalItems = items.length
    this.itemsPerPage = Math.ceil(this.totalItems / this.perPage)
    this.page = 1
    this.totalPages = this.itemsPerPage
    this.sendMessage(channel).then((message) => {
      this.message = message
      this.editMessage()
      Pager.pagers.set(this.message.id, this)
    })
  }

  async sendMessage(channel: TextChannel) {
    const message = await channel.send(
      `Page ${this.page} of ${this.totalPages}`
    )
    message.react("⬅️")
    message.react("➡️")
    return message
  }

  next() {
    this.page = Math.min(this.page + 1, this.totalPages)
    this.editMessage()
    return this.page
  }
  prev() {
    this.page = Math.max(this.page - 1, 1)
    this.editMessage()
    return this.page
  }

  static getPager(id: string) {
    return Pager.pagers.get(id)
  }

  static async deletePager(id: string) {
    const pager = Pager.pagers.get(id)
    if (pager) {
      await pager.message?.delete()
      Pager.pagers.delete(id)
    }
  }

  processReaction(reaction: MessageReaction | PartialMessageReaction) {
    if (reaction.emoji.name === "⬅️") {
      this.prev()
      reaction.users.cache.forEach((user) => {
        if (user.id !== client.user?.id) reaction.users.remove(user)
      })
      reaction.message.react("⬅️")
    } else if (reaction.emoji.name === "➡️") {
      this.next()
      reaction.users.cache.forEach((user) => {
        if (user.id !== client.user?.id) reaction.users.remove(user)
      })
      reaction.message.react("➡️")
    }
    this.editMessage()
  }

  editMessage() {
    this.message?.edit(
      `Page ${this.page} of ${this.totalPages}\n` +
        this.items
          .slice((this.page - 1) * this.perPage, this.page * this.perPage)
          .join("\n")
    )
  }
}

// Create the table for cron jobs if it doesn't exist
await db.exec(`
  CREATE TABLE IF NOT EXISTS cronJobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cronTime TEXT,
    message TEXT,
    channelId TEXT,
    guildId TEXT
  );
`)

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
})

// When the bot is ready
client.once("ready", () => {
  console.log(`Logged in as ${client.user?.tag}!`)
  loadCronJobs()
})

// Message event listener for text commands
client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return

  // Check if the message starts with the prefix and the command "addcron"
  if (message.content.startsWith("+addcron")) {
    if (
      !message.member?.permissions.has(PermissionsBitField.Flags.ManageGuild)
    ) {
      return message.reply(
        "You require the permission `MANAGE_GUILD` have permission to delete cron jobs."
      )
    }
    try {
      const { cronExpression, messageToSend } = parseCronJob(message.content)

      // Expect two arguments: cronTime and message
      if (!cronExpression || !messageToSend) {
        return message.reply("Usage: +addcron <cronTime> <message>")
      }

      if (!message.guild) {
        return message.reply("This command is only available in servers.")
      }

      // Validate cron expression
      if (!isValidCron(cronExpression)) {
        return message.reply("Invalid cron expression.")
      }

      // Store the cron job in SQLite
      await db.run(
        "INSERT INTO cronJobs (cronTime, message, channelId, guildId) VALUES (?, ?, ?, ?)",
        [cronExpression, messageToSend, message.channel.id, message.guild.id]
      )

      // Schedule the cron job
      cron.schedule(cronExpression, () => {
        const channel = message.channel as TextChannel
        if (channel) {
          channel.send(messageToSend)
        }
      })

      return message.reply(`Cron job scheduled!`)
    } catch (error) {
      console.error(error)
      return message.reply("Usage: +addcron <cronTime> <message>")
    }
  } else if (message.content.startsWith("+listcron")) {
    try {
      if (!message.guild) {
        return message.reply("This command is only available in servers.")
      }

      const rows = await db
        .prepare("SELECT * FROM cronJobs WHERE guildId = ?", [message.guild.id])
        .all()

      const formattedRows = rows.map((row) => {
        // @ts-ignore
        return `${row.id}: ${row.cronTime} - ${row.message.slice(0, 100)}`
      })

      new Pager(formattedRows, message.channel as TextChannel)
    } catch (error) {
      console.error(error)
      return message.reply("An error occurred while listing cron jobs.")
    }
  } else if (message.content.startsWith("+deletecron")) {
    if (
      !message.member?.permissions.has(PermissionsBitField.Flags.ManageGuild)
    ) {
      return message.reply(
        "You require the permission `MANAGE_GUILD` have permission to delete cron jobs."
      )
    }
    try {
      if (!message.guild) {
        return message.reply("This command is only available in servers.")
      }

      const { id } = parseDeleteJob(message.content)

      // Delete the cron job from SQLite
      await db.run("DELETE FROM cronJobs WHERE id = ?", [id])

      return message.reply(`Cron job deleted!`)
    } catch (error) {
      console.error(error)
      return message.reply("Usage: +delete <id>")
    }
  } else if (message.content.startsWith("+help")) {
    return message.reply(
      "Commands:\n" +
        "+addcron <cronTime> <message>\n" +
        "+listcron\n" +
        "+deletecron <id>"
    )
  }
})

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return
  const pager = Pager.getPager(reaction.message.id)
  if (pager) {
    pager.processReaction(reaction)
  }
})

function parseCronJob(input: string) {
  // Split the input into parts: the cron expression and the message
  const parts = input.split(" ")

  const cronExpression = parts.slice(1, 6).join(" ")

  // The remaining part is the message
  const messageToSend = parts.slice(6).join(" ")

  return {
    cronExpression,
    messageToSend,
  }
}

function parseDeleteJob(input: string) {
  // Split the input into parts: the id
  const parts = input.split(" ")

  const id = parts[1]

  return {
    id,
  }
}

// Helper function to validate cron expressions
function isValidCron(expression: string): boolean {
  const cronPattern =
    /(@(annually|yearly|monthly|weekly|daily|hourly|reboot))|(@every (\d+(ns|us|µs|ms|s|m|h))+)|((((\d+,)+\d+|(\d+(\/|-)\d+)|\d+|\*) ?){5,7})/
  return cronPattern.test(expression)
}

// Load existing cron jobs from SQLite and schedule them
async function loadCronJobs() {
  // Query all rows from the 'cronJobs' table
  const rows = await db.query("SELECT * FROM cronJobs").all()

  // For each row, schedule the cron job
  rows.forEach((row) => {
    // @ts-ignore
    const cronTime = row.cronTime as string
    // @ts-ignore
    const message = row.message as string
    // @ts-ignore
    const channelId = row.channelId as string

    // Schedule the cron job using node-cron
    cron.schedule(cronTime, () => {
      // Get the channel by channelId
      const channel = client.channels.cache.get(channelId) as TextChannel
      if (channel) {
        channel.send(message)
      }
    })
  })
}

// Log in to Discord with your bot's token
client.login(process.env.DISCORD_TOKEN)
