import { Client, GatewayIntentBits, Message, TextChannel } from "discord.js"
import Database from "bun:sqlite"
import cron from "node-cron"

// Initialize SQLite database
const db = new Database("cronbot.db")

// Create the table for cron jobs if it doesn't exist
await db.exec(`
  CREATE TABLE IF NOT EXISTS cronJobs (
    id TEXT PRIMARY KEY,
    cronTime TEXT,
    message TEXT,
    channelId TEXT
  );
`)

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
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
    try {
      const { cronExpression, messageToSend } = parseCronJob(message.content)
      console.log(`${cronExpression} : ${messageToSend}`)

      // Expect two arguments: cronTime and message
      if (!cronExpression || !messageToSend) {
        return message.reply("Usage: +addcron <cronTime> <message>")
      }

      // Validate cron expression
      if (!isValidCron(cronExpression)) {
        return message.reply("Invalid cron expression.")
      }

      // Store the cron job in SQLite
      const jobId = `${message.author.id}-${Date.now()}`
      await db.run(
        "INSERT INTO cronJobs (id, cronTime, message, channelId) VALUES (?, ?, ?, ?)",
        [jobId, cronExpression, messageToSend, message.channel.id]
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
