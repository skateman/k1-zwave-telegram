// TELEGRAM_BOT_TOKEN
// TELEGRAM_CHAT_ID
// ZWAVE_USB_PATH
// ZWAVE_NODE_ID
// PRINTER_HOSTNAME

const { Telegraf, Input } = require('telegraf');
const WebSocket = require('ws');
const EventEmitter = require('events');
const { Driver } = require('zwave-js');
const { stat } = require('fs');

const host = process.env.PRINTER_HOSTNAME;
const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = parseInt(process.env.TELEGRAM_CHAT_ID);
const zwavePath = process.env.ZWAVE_USB_PATH;
const nodeId = parseInt(process.env.ZWAVE_NODE_ID);

const scoreboard = {};
const topics = ['curPosition', 'nozzleTemp', 'bedTemp0', 'boxTemp', 'printJobTime', 'printLeftTime'];
let state = 'off';

const snapshot = () => Input.fromURLStream(`http://${host}:8080/?action=snapshot`, 'snapshot.jpg');

const buildStatusMessage = () => {
  const message = [
    `State: ${state}`,
    `Current position: ${scoreboard.curPosition}`,
    `Nozzle temperature: ${Math.round(scoreboard.nozzleTemp)}°C`,
    `Bed temperature: ${Math.round(scoreboard.bedTemp0)}°C`,
    `Box temperature: ${scoreboard.boxTemp}°C`
  ];

  if (state === 'printing') {
    message.push(`File: ${scoreboard.printFileName}`);
    message.push(`Progress: ${Math.round(scoreboard.printJobTime / (scoreboard.printJobTime + scoreboard.printLeftTime) * 100)}%`);
    message.push(`Time elapsed: ${scoreboard.printJobTime}`);
    message.push(`Time left: ${scoreboard.printLeftTime}`);
  }

  return message.join('\n');
};

// Wrap the bot's response function to only respond to messages from a specific chat ID
const guardedResponse = (fn) => (ctx) => {
  if (ctx.message.chat.id == chatId) {
    return fn(ctx);
  }
};

// Create a new Telegraf bot instance
const bot = new Telegraf(token);
// Create a new EventEmitter instance
const emitter = new EventEmitter();
// Instantiate the ZWave driver
const zwave = new Driver(zwavePath);

// Set up event handlers for the ZWave driver
zwave.on('error', console.error);

zwave.once("driver ready", async () => {
  // Retrieve the node with the given ID
  const node = zwave.controller.nodes.get(nodeId);
  // Wait for the node to be ready
  node.once('ready', async () => {
    const binarySwitchCC = node.commandClasses['Binary Switch'];
    const { currentValue } = await binarySwitchCC.get();

    // Set up event handlers for turning toggling the printer
    emitter.on('on', () => binarySwitchCC.set(true));
    emitter.on('off', () => binarySwitchCC.set(false));

    // Inform the client that the bot is ready
    bot.telegram.sendMessage(chatId, 'The bot is ready to receive commands.');

    // If the printer is on, emit the on event
    if (currentValue) {
      emitter.emit('on', 100);
    }
  });
});

// Start the ZWave driver in the background
(async () => zwave.start())();

bot.command('status', guardedResponse(async (ctx) => {
  if (state === 'off') {
    ctx.sendMessage('Printer is off');
  } else {
    ctx.replyWithPhoto(snapshot(), { caption: buildStatusMessage() });
  }
}));

bot.command('on', guardedResponse(async (ctx) => {
  if (state === 'off') {
    emitter.emit('on', 10000);
    ctx.reply('Printer is turning on...');
  }
}));

bot.command('off', guardedResponse(async (ctx) => {
  emitter.emit('off');
  state = 'off';
  ctx.reply('Printer is turning off...');
}));

// Event handling for turning on the printer
emitter.on('on' , async (delay) => {
  setTimeout(() => {
    const printer = new WebSocket(`ws://${host}:9999`);
    bot.telegram.sendMessage(chatId, 'Printer is on');

    printer.on('message', async (message) => {
      data = JSON.parse(message);
      // Store the interesting topics on the scoreboard
      topics.forEach((topic) => {
        scoreboard[topic] = data[topic] ? data[topic] : scoreboard[topic];
      });

      if (!data?.connect) {
        if (data?.printStartTime) {
          state = 'setup';
          scoreboard.printFileName = data.printFileName;
      
          bot.telegram.sendPhoto(
            process.env.TELEGRAM_CHAT_ID,
            Input.fromURLStream('http://192.168.1.51/downloads/original/current_print_image.png'),
            { caption: `Started printing ${data.printFileName}` }
          );
        }
      
        if (state === 'setup' && data?.withSelfTest === 100) {
          state = 'printing';
        }
      
        if (state === 'printing' && data?.printLeftTime === 0) {
          bot.telegram.sendPhoto(
            process.env.TELEGRAM_CHAT_ID,
            snapshot(),
            { caption: `Printing complete!\n\n${buildStatusMessage()}` }
          );

          delete scoreboard.printLeftTime;
          delete scoreboard.printJobTime;
          delete scoreboard.printFileName;
          state = 'complete';
        }
      
        if ((state === 'printing') && data?.state === 4) {
          bot.telegram.sendPhoto(
            process.env.TELEGRAM_CHAT_ID, 
            snapshot(), 
            { caption: `Printing aborted!\n\n${buildStatusMessage()}` }
          );

          delete scoreboard.printLeftTime;
          delete scoreboard.printJobTime;
          delete scoreboard.printFileName;
          state = 'aborted';
        }
      
        if (['complete', 'aborted'].includes(state) && data?.fan === 0) {
          state = 'idle';
        }
      }
    });

    emitter.on('off', async () => {
      printer.close();
    });

    state = 'idle';
  }, delay);
});

// Handling interrupt signals
['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.once(signal, async () => {
    bot.telegram.sendMessage(chatId, 'Bot is shutting down...');
    bot.stop(signal);
    await zwave.destroy();
    process.exit(0);
  });
});

// Start the telegram bot
bot.startPolling();
