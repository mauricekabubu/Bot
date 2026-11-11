
import { config } from "./config/env.js";
import { logger } from "./utils/logger.js";

import { openDatabase } from "./memory/database.js";
import { ConversationMemory } from "./memory/conversationMemory.js";
import { LongTermMemory } from "./memory/longTermMemory.js";

import { GeminiProvider } from "./ai/gemini.js";
import {
  AnthropicProvider,
  OllamaProvider,
  OpenAIProvider,
} from "./ai/providers.js";
import { ModelRouter } from "./ai/modelRouter.js";
import { Agent } from "./ai/agent.js";

import { createToolRegistry } from "./tools/registry.js";
import { ReminderService } from "./tools/reminders.js";

import { RateLimiter } from "./security/rateLimiter.js";

import { createMessageHandler } from "./whatsapp/messageHandler.js";
import { createWhatsAppClient } from "./whatsapp/client.js";
import { NewsletterStore } from "./whatsapp/newsletterStore.js";
import { IncomingMediaStore } from "./whatsapp/mediaStore.js";
import { InboundMessageStore } from "./whatsapp/inboundStore.js";
import { OutboundMessageService, normalizeRecipient } from "./whatsapp/outbound.js";

const log = logger(config.LOG_LEVEL);

const db = openDatabase(config.DATABASE_PATH);

let whatsapp;
let reminderTimer;
let reminderTickRunning = false;
let shuttingDown = false;
const cliArgs = process.argv.slice(2);

// Initialize AI components
const conversation = new ConversationMemory(db);
const longTerm = new LongTermMemory(db);
const gemini = new GeminiProvider(config, log);
const modelRouter = new ModelRouter({
  db,
  providers: [
    gemini,
    new OpenAIProvider(config),
    new AnthropicProvider(config),
    new OllamaProvider(config),
  ],
  logger: log,
  priorities: config.AI_PROVIDER_PRIORITY,
  maxFailoverAttempts: config.AI_MAX_FAILOVER_ATTEMPTS,
  maxOutputTokens: config.MAX_OUTPUT_TOKENS,
  temperature: config.TEMPERATURE,
});
const tools = createToolRegistry(config);

const agent = new Agent({
  conversation,
  longTerm,
  gemini,
  router: modelRouter,
  tools,
  logger: log,
});

const outbound = new OutboundMessageService({
  db,
  getClient: () => whatsapp?.client,
  isReady: () => Boolean(whatsapp?.isReady()),
  logger: log,
  testRecipients: config.OUTBOUND_TEST_RECIPIENTS,
});
const newsletterStore = new NewsletterStore(db);
const inboundStore = new InboundMessageStore(db);
const mediaStore = new IncomingMediaStore({
  db,
  directory: config.WHATSAPP_MEDIA_PATH,
  maxFileBytes: Math.floor(config.MAX_FILE_SIZE_MB * 1024 * 1024),
  maxTotalBytes: config.WHATSAPP_MEDIA_MAX_TOTAL_MB * 1024 * 1024,
  logger: log,
});

const errorMetadata = (error) => error instanceof Error
  ? { name: error.name, message: error.message, stack: error.stack }
  : { reasonType: typeof error, message: typeof error === "string" ? error : undefined };

process.on("uncaughtExceptionMonitor", (error, origin) => {
  log.error("uncaught_exception_observed", {
    ...errorMetadata(error),
    origin,
  });
});
process.on("unhandledRejection", (reason) => {
  log.error("unhandled_rejection_observed", errorMetadata(reason));
});

// Initialize message handler
const limiter = new RateLimiter(
  config.RATE_LIMIT_PER_MINUTE
);

const handler = createMessageHandler({
  agent,
  limiter,
  logger: log,
  config,
  outbound,
  newsletterStore,
  mediaStore,
  inboundStore,
  modelRouter,
  adminContacts: config.AI_ADMIN_CONTACTS.split(",").map((contact) => contact.trim()),
});

// Initialize WhatsApp
whatsapp = createWhatsAppClient({
  config,
  handler,
  logger: log,
  outbound,
  enableUnreadRecovery: cliArgs.length === 0,
});

// Initialize reminders
const reminders = new ReminderService(
  db,
  async (id, text, { reminderId, attempt }) => {
    return outbound.sendText(id, text, {
      messageType: "reminder",
      idempotencyKey: `reminder:${reminderId}:attempt:${attempt}`,
    });
  }
);

// Prevent overlapping reminder executions
async function processReminders() {
  if (reminderTickRunning || shuttingDown) return;

  reminderTickRunning = true;

  try {
    const failures = await reminders.tick();
    for (const reminder of failures) {
      log.warn("reminder_delivery_failed", {
        reminderId: reminder.id
      });
    }
  } catch (error) {
    log.error("reminder_tick_failed", {
      code: error.code || error.name
    });
  } finally {
    reminderTickRunning = false;
  }
}

// Graceful shutdown
async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  log.info("application_shutdown_started", { signal });

  if (reminderTimer) {
    clearInterval(reminderTimer);
  }

  try {
    if (whatsapp) {
      await whatsapp.destroy(signal);
    }
  } catch (error) {
    log.error("whatsapp_shutdown_failed", {
      error: error.message
    });
  }

  try {
    db.close();
    log.info("database_closed");
  } catch (error) {
    log.error("database_shutdown_failed", {
      error: error.message
    });
  }

  log.info("application_shutdown_complete");
}

// Register shutdown handlers
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// Start application
async function start() {
  try {
    log.info("atom_starting");

    await whatsapp.initialize();

    log.info("atom_started");

    // Start reminders after successful initialization
    reminderTimer = setInterval(
      processReminders,
      30_000
    );

    // Check existing reminders immediately
    await processReminders();

  } catch (error) {
    log.error("atom_startup_failed", {
      error: error.message
    });

    await shutdown("STARTUP_FAILURE");

    process.exitCode = 1;
  }
}

async function runCli() {
  const [command, value, ...flags] = cliArgs;
  const confirmed = flags.includes("--confirm");
  if (!command) return false;
  const failCli = (message) => {
    db.close();
    throw new Error(message);
  };
  if (command === "--help") {
    console.log([
      "Atom commands:",
      "  --whatsapp-diagnostic",
      "  --outbound-report",
      "  --lookup-contact <number>",
      "  --approve-test-recipient <number>",
      "  --test-send <approved-number> --confirm",
      "  --suppress-recipient <number>",
      "  --unsuppress-recipient <number>",
    ].join("\n"));
    db.close();
    return true;
  }
  if (command === "--outbound-report") {
    console.log(JSON.stringify(outbound.getReport(), null, 2));
    db.close();
    return true;
  }
  if (command === "--approve-test-recipient" || command === "--suppress-recipient" ||
      command === "--unsuppress-recipient") {
    const recipient = normalizeRecipient(value);
    if (!recipient) return failCli("A valid recipient number is required.");
    if (command === "--approve-test-recipient") outbound.approveTestRecipient(recipient);
    else outbound.setSuppressed(recipient, command === "--suppress-recipient");
    console.log(JSON.stringify({ command, recipient: recipient.replace(/\d(?=\d{4}@c\.us$)/g, "*") }));
    db.close();
    return true;
  }
  if (command !== "--whatsapp-diagnostic" && command !== "--lookup-contact" &&
      command !== "--test-send") {
    if (command.startsWith("--")) return failCli(`Unknown Atom command: ${command}`);
    return false;
  }

  const testRecipient = command === "--test-send" ? normalizeRecipient(value) : null;
  const lookupRecipient = command === "--lookup-contact" ? normalizeRecipient(value) : null;
  if (command === "--lookup-contact" && !lookupRecipient) {
    return failCli("A valid contact number is required.");
  }
  if (command === "--test-send") {
    if (!testRecipient) return failCli("A valid recipient number is required.");
    if (!confirmed) return failCli("A real test message requires the explicit --confirm flag.");
    if (!outbound.isApprovedTestRecipient(testRecipient)) {
      return failCli("Approve this test recipient before sending.");
    }
    if (outbound.isSuppressed(testRecipient)) {
      return failCli("This recipient is suppressed; remove suppression before sending.");
    }
  }

  try {
    await whatsapp.initialize();
    const diagnostic = {
      ...whatsapp.diagnostics(),
      outboundServiceOperational: typeof outbound.sendText === "function" &&
        typeof outbound.getReport === "function",
    };
    if (command === "--whatsapp-diagnostic") {
      console.log(JSON.stringify(diagnostic, null, 2));
    } else if (command === "--lookup-contact") {
      const contact = await whatsapp.lookupContact(lookupRecipient);
      console.log(JSON.stringify({ contactLookup: contact }, null, 2));
      if (!contact.found) process.exitCode = 1;
    } else {
      const recipient = testRecipient;
      const contact = await whatsapp.lookupContact(recipient);
      if (!contact.found) {
        console.log(JSON.stringify({ diagnostic, contactLookup: contact, sendSkipped: true }, null, 2));
        process.exitCode = 1;
        return true;
      }
      const result = await outbound.sendText(
        recipient,
        "Hello! This is a connectivity test from Atom AI. No action is required.",
        {
          messageType: "test",
          testMode: true,
          idempotencyKey: `test:${recipient}:${new Date().toISOString().slice(0, 10)}`,
        },
      );
      const acknowledgement = result.recordId && result.accepted
        ? await outbound.waitForAcknowledgement(result.recordId)
        : null;
      console.log(JSON.stringify({ diagnostic, contactLookup: contact, result, acknowledgement }, null, 2));
      if (!result.ok) process.exitCode = 1;
    }
  } finally {
    await whatsapp.destroy("cli_complete");
    db.close();
  }
  return true;
}

if (!(await runCli())) await start();
