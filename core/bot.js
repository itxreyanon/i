// bot.js
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { config } from '../config.js';
// Import the new Client class
import { Client } from './client.js'; // Adjust path if client.js is in a different directory

// Main execution logic
async function main() {
  let igClient; // Use igClient instead of bot
  try {
    // --- Instantiate the new Client ---
    igClient = new Client({
        sessionPath: './session.json', // Match your original path
        disableReplyPrefix: false,     // Default
        autoReconnect: true,           // Default
        maxRetries: 3,                 // Default
        // Add other options from config if needed (proxy would need integration into client.js)
    });
    // --- End Instantiate ---

    // --- Adapt Login ---
    // The new Client's login expects username/password.
    // Since you load from cookies, you can pass dummy values or the actual username.
    // The modified client.js will prioritize cookies.json.
    const username = config.instagram?.username || 'dummy_username_for_cookies';
    const password = config.instagram?.password || 'dummy_password'; // Not used if cookies work

    // Wrap the client's login in a promise to handle it like the old bot.login()
    await new Promise((resolve, reject) => {
        // Listen for the 'connected' event from the new Client
        igClient.once('connected', () => {
            console.log('🚀 [bot.js] New Client reported connected');
            resolve();
        });

        // Listen for errors during login/connect
        igClient.once('error', (err) => {
            console.error('❌ [bot.js] Error during Client initialization:', err.message);
            // Differentiate login errors if possible, or just reject
            reject(err);
        });

        // Initiate the login process
        console.log(`[INFO] [bot.js] Initiating login for @${username} using new Client...`);
        igClient.login(username, password).catch(reject); // Catch errors during the login call itself
    });
    // --- End Adapt Login ---

    // --- Load Modules ---
    const moduleManager = new ModuleManager(igClient); // Pass igClient instead of bot
    await moduleManager.loadModules();
    console.log('[INFO] [bot.js] ✅ Modules loaded');
    // --- End Load Modules ---

    // --- Setup Message Handler ---
    // Assuming MessageHandler can adapt to the new Message object
    // You might need to modify MessageHandler to expect Message/Chat/User objects
    // from the new Client instead of plain data objects.
    const messageHandler = new MessageHandler(igClient, moduleManager, null);
    console.log('[INFO] [bot.js] ✅ Message handler setup');
    // --- End Setup Message Handler ---

    // --- Adapt Event Listeners ---
    // Listen for new messages using the new Client's event
    igClient.on('messageCreate', async (message) => {
        // 'message' is now an instance of the Message class from client.js
        // console.log(`💬 [New Message Event] From: ${message.author?.username || message.authorID}, Content: "${message.content}", Chat: ${message.chat?.name || message.chatID}`);
        try {
            // Pass the Message object to your handler
            // You'll likely need to modify MessageHandler.handleMessage to work
            // with the Message, Chat, and User objects provided by the new Client.
            await messageHandler.handleMessage(message);
        } catch (handlerError) {
            console.error(`❌ [bot.js] Error in message handler for message ${message.id}:`, handlerError.message);
        }
    });

    // Listen for pending requests (optional, but demonstrates new events)
    igClient.on('pendingRequest', async (chat) => {
        // 'chat' is an instance of the Chat class
        console.log(`📬 [Pending Request] New chat request: ${chat.name || chat.id}`);
        // Example: Auto-approve (be careful!)
        // try {
        //     await chat.approve();
        //     console.log(`✅ Auto-approved chat request: ${chat.id}`);
        // } catch (approveError) {
        //     console.error(`❌ Failed to auto-approve chat ${chat.id}:`, approveError.message);
        // }
    });

    // Listen for new followers (optional, demonstrates FBNS)
    igClient.on('newFollower', async (user) => {
        // 'user' is an instance of the User class
        console.log(`👤 [New Follower] @${user.username} (ID: ${user.id}) started following you!`);
        // Example: Send a thank you message
        // try {
        //     const dmChat = await user.fetchPrivateChat(); // Get the DM chat
        //     await dmChat.send("Thanks for the follow! 👋");
        //     console.log(`📤 Sent thank you message to new follower @${user.username}`);
        // } catch (dmError) {
        //     console.error(`❌ Failed to send thank you message to @${user.username}:`, dmError.message);
        // }
    });

    // Listen for follow requests (optional)
     igClient.on('followRequest', async (user) => {
        console.log(`.New Follow Request from: @${user.username} (ID: ${user.id})`);
        // Example: Auto-approve follow requests (be careful!)
        // try {
        //     await user.approveFollow();
        //     console.log(`✅ Auto-approved follow request from @${user.username}`);
        // } catch (approveError) {
        //     console.error(`❌ Failed to auto-approve follow request from @${user.username}:`, approveError.message);
        // }
     });

    // Listen for errors from the Client
    igClient.on('error', (err) => {
        console.error('🚨 [Client Error]', err.message);
        // Add specific error handling logic if needed
    });

    // Listen for disconnection
    igClient.on('disconnect', () => {
        console.log('🔌 [Client Disconnected]');
        // Add reconnection logic or shutdown logic if needed
        // The Client has autoReconnect, but you might want to handle max retries reached
    });

    // Optional: Listen for reconnection
    igClient.on('reconnected', () => {
        console.log('🔁 [Client Reconnected]');
    });

    igClient.on('maxRetriesReached', () => {
         console.error('💀 [Client] Maximum reconnection retries reached. Client likely stopped.');
         // Trigger shutdown or alert
    });
    // --- End Adapt Event Listeners ---

    // --- Adapt Message Requests Monitor (Optional/Alternative) ---
    // The new Client emits 'pendingRequest' events via FBNS, which might be sufficient.
    // If you still want periodic checks, you can adapt the old logic:
    /*
    async function startMessageRequestsMonitor(client, intervalMs = 300000) {
        console.log(`[INFO] [bot.js] 🕒 Starting message requests monitor (checking every ${intervalMs / 1000 / 60} minutes)`);
        setInterval(async () => {
            if (client.ready) { // Check if client is ready
                try {
                     // Use the client's cache or fetch method
                     const pendingChatsCache = client.cache.pendingChats;
                     console.log(`📬 [Monitor] Current pending requests in cache: ${pendingChatsCache.size}`);
                     // Or fetch fresh:
                     // const pendingThreads = await client.ig.feed.directPending().items();
                     // console.log(`📬 [Monitor] Fetched ${pendingThreads.length} pending requests`);
                     // Process pendingThreads if needed beyond the 'pendingRequest' event
                } catch (error) {
                    console.error('[ERROR] [bot.js] Error in periodic message requests check:', error.message);
                }
            }
        }, intervalMs);
    }
    // Call it after the client is connected
    // startMessageRequestsMonitor(igClient);
    */
    // --- End Adapt Message Requests Monitor ---

    console.log('🚀 [bot.js] Bot is running with full module support using the new Client. Type .help or use your commands.');

    // --- Adapt Heartbeat ---
    setInterval(() => {
      const isReady = igClient.ready;
      const hasUser = Boolean(igClient.user);
      const userId = igClient.user?.id || 'N/A';
      const chatCount = igClient.cache.chats.size;
      const userCount = igClient.cache.users.size;
      console.log(`💓 [${new Date().toISOString()}] Bot heartbeat - Ready: ${isReady}, User ID: ${userId}, Chats: ${chatCount}, Users: ${userCount}`);
    }, 300000); // Every 5 minutes
    // --- End Adapt Heartbeat ---

    // --- Adapt Graceful Shutdown ---
    const shutdownHandler = async () => {
      console.log('\n👋 [SIGINT/SIGTERM] Shutting down gracefully...');
      if (igClient && igClient.ready) {
        try {
            // Use the new Client's logout method which handles disconnects
            await igClient.logout();
            console.log('✅ [bot.js] Client logged out and disconnected successfully.');
        } catch (logoutError) {
            console.error('❌ [bot.js] Error during client logout:', logoutError.message);
        }
      } else if (igClient && igClient.ig) {
          // If client was initialized but not fully ready, try direct disconnect
          console.log('[INFO] [bot.js] Client not fully ready, attempting direct disconnect...');
          try {
              if (igClient.ig.realtime && typeof igClient.ig.realtime.disconnect === 'function') {
                  await igClient.ig.realtime.disconnect();
                  console.log('✅ [bot.js] Realtime disconnected.');
              }
              if (igClient.ig.fbns && typeof igClient.ig.fbns.disconnect === 'function') {
                   await igClient.ig.fbns.disconnect();
                   console.log('✅ [bot.js] FBNS disconnected.');
              }
          } catch (disconnectError) {
               console.error('❌ [bot.js] Error during direct disconnect:', disconnectError.message);
          }
      }
      console.log('🛑 [bot.js] Shutdown complete.');
      process.exit(0);
    };

    process.on('SIGINT', shutdownHandler);
    process.on('SIGTERM', shutdownHandler);
    // --- End Adapt Graceful Shutdown ---

  } catch (error) {
    console.error('❌ [bot.js] Bot failed to start:', error.message);
    console.error('Stack:', error.stack);

    // Attempt cleanup if client was partially initialized
    if (igClient) {
        try {
            await igClient.logout(); // Try logout/disconnect
            console.log('✅ [bot.js] Cleanup disconnect attempted.');
        } catch (disconnectError) {
            console.error('❌ [bot.js] Error during cleanup disconnect:', disconnectError.message);
        }
    }
    process.exit(1);
  }
}

// Run main only if this file is executed directly
// Assuming your project uses ES Modules (based on import/export in your original file)
// Check if the current module is the main module being run
if (process.argv[1] && process.argv[1].endsWith('bot.js')) { // Adjust filename check if needed
    main().catch((error) => {
        console.error('❌ [bot.js] Unhandled error in main execution:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    });
}

// If you still want to export something (though main execution handles instantiation)
// You could export the setup logic or the client instance getter if needed elsewhere
// export { main as runBot }; // Example export
