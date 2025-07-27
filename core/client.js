import { IgApiClient } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import { EventEmitter } from 'events';
import fs from 'fs'; // Keep original fs for sync operations used in code 3
import { promises as fsPromises } from 'fs'; // Add fs.promises for async operations like in code 2
import tough from 'tough-cookie';
import { Collection } from '@discordjs/collection';
import User from '../utils/User.js';
import Chat from '../utils/Chat.js';
import Message from '../utils/Message.js';
import { logger } from '../utils/utils.js';
import camelcaseKeys from 'camelcase-keys'; // Import for push notification parsing (from code 2)
import { config } from '../config.js';
import path from 'path';
/**
 * Enhanced Instagram client with rich object support and robust login logic from instagram-bot.js
 * @extends {EventEmitter}
 */
export class InstagramClient extends EventEmitter {
  constructor(options = {}) {
    super();
    /**
     * Client options
     * @type {Object}
     */
    this.options = {
      disableReplyPrefix: false,
      sessionPath: './session/session.json', // Keep original path from code 3
      messageCheckInterval: 5000,
      maxRetries: 3,
      autoReconnect: true,
      username: null, // Add username/password options like in code 2
      password: null,
      ...options
    };
    /**
     * Instagram API client
     * @type {IgApiClient}
     */
    this.ig = withRealtime(new IgApiClient());
    /**
     * Bot user object
     * @type {User|null}
     */
    this.user = null;
    /**
     * Whether the client is ready (fully initialized and connected)
     * @type {boolean}
     */
    this.ready = false;
    /**
     * Whether the client is running (intended to be connected)
     * @type {boolean}
     */
    this.running = false;
    /**
     * Cache for users, chats, and messages
     * @type {Object}
     */
    this.cache = {
      users: new Collection(),
      chats: new Collection(),
      pendingChats: new Collection(),
      messages: new Collection()
    };
    /**
     * Last message check timestamp (legacy timestamp-based dedup)
     * @type {Date}
     */
    this.lastMessageCheck = new Date(Date.now() - 60000);
    /**
     * Events to replay after ready
     * @type {Array}
     * @private
     */
    this._eventsToReplay = [];
    /**
     * Connection retry count
     * @type {number}
     * @private
     */
    this._retryCount = 0;
    // --- Add deduplication properties from code 2 ---
    /**
     * Set for tracking processed message IDs for deduplication
     * @type {Set<string>}
     */
    this.processedMessageIds = new Set();
    /**
     * Maximum size of the processedMessageIds set to prevent memory leaks
     * @type {number}
     */
    this.maxProcessedMessageIds = 1000;
    // --- Store for push notification context (from code 2) ---
    this.pushContext = {}; // Store thread_id, item_id, etc. from push notifications
    // --- End push context ---
  }

  /**
   * Robust Login to Instagram using session, cookies, or password
   * Adapted EXCLUSIVELY from the login logic in instagram-bot.js (code 2)
   * @param {string} [username] - Instagram username (can also be in options)
   * @param {string} [password] - Instagram password (can also be in options)
   * @returns {Promise<void>}
   */
 async login(username, password) { // Accept password as argument
    try {
      logger.info('🔑 Logging into Instagram...');
      this.ig.state.generateDevice(username);

      let loginSuccessful = false;

      // Try to load session first (the file specified in options)
      try {
        if (fs.existsSync(this.options.sessionPath)) { // Check if sessionPath file exists
          logger.info(`📂 Attempting login using session file: ${this.options.sessionPath}`);
          const sessionDataRaw = await fsPromises.readFile(this.options.sessionPath, 'utf-8');
          const sessionData = JSON.parse(sessionDataRaw);
          await this.ig.state.deserialize(sessionData);

          // --- CRITICAL: Validate the loaded session ---
          await this.ig.account.currentUser();
          logger.info('✅ Logged in using saved session file');
          loginSuccessful = true;
        } else {
           logger.info(`📂 Session file not found at ${this.options.sessionPath}, attempting fresh login...`);
        }
      } catch (sessionError) {
        logger.warn(`⚠️ Failed to load or validate session from ${this.options.sessionPath}:`, sessionError.message);
        // Fall through to fresh login
      }

      // If session login failed, attempt fresh login
      if (!loginSuccessful) {
        if (!password) { // Check if password was provided
          throw new Error('❌ Password required for fresh login, but not provided.');
        }
        logger.info('🔑 Attempting fresh login...');
        await this.ig.account.login(username, password);

        // --- CRITICAL: Save the FULL session state AFTER successful fresh login ---
        // Ensure directory exists for sessionPath
        const sessionDir = path.dirname(this.options.sessionPath);
        if (!fs.existsSync(sessionDir)) {
          fs.mkdirSync(sessionDir, { recursive: true });
        }
        const session = await this.ig.state.serialize(); // Serialize the full state
        // DO NOT delete session.constants; // Keep all data including cookies
        await fsPromises.writeFile(this.options.sessionPath, JSON.stringify(session, null, 2)); // Save full state using fs.promises
        logger.info(`✅ Fresh login successful. Full session state saved to ${this.options.sessionPath}`);
        loginSuccessful = true;
         // --- No separate _saveCookies call needed, session.json has everything ---
      }

      if (loginSuccessful) {
        // Get user info
        const userInfo = await this.ig.account.currentUser();
        this.user = this._patchOrCreateUser(userInfo.pk, userInfo);

        // Load existing chats
        await this._loadChats();

        // Setup realtime handlers
        this._setupRealtimeHandlers();

        // Connect to realtime
        logger.info('📡 Connecting to Instagram realtime service...');
        await this.ig.realtime.connect({
          autoReconnect: this.options.autoReconnect,
          irisData: await this.ig.feed.directInbox().request()
        });

        this.ready = true;
        this.running = true;
        this._retryCount = 0;
        logger.info(`✅ Connected as @${this.user.username} (ID: ${this.user.id})`);
        this.emit('ready');

        // Replay queued events
        this._replayEvents();

      } else {
         throw new Error('Login process did not complete successfully.');
      }

    } catch (error) {
      this.ready = false;
      this.running = false;
      logger.error('❌ Login failed:', error.message);
      logger.debug('Login error stack:', error.stack);
      throw error;
    }
  }

  /**
   * Load cookies from file (Simplified to only use session.json)
   * @returns {Promise<void>}
   * @private
   */
  async _loadCookies() {
    // --- ONLY load from the main session.json file ---
    const sessionPath = this.options.sessionPath; // Use the configured path
    try {
      logger.debug(`📂 Attempting to load session/cookies from ${sessionPath}...`);
      await fsPromises.access(sessionPath); // Use fs.promises
      const sessionDataRaw = await fsPromises.readFile(sessionPath, 'utf-8'); // Use fs.promises
      const sessionData = JSON.parse(sessionDataRaw);

      // Try to deserialize the full session state
      // This should correctly populate ig.state.cookieJar if the session data is complete
      await this.ig.state.deserialize(sessionData);
      logger.info(`🍪 Session and cookies loaded from ${sessionPath} using state.deserialize`);
      // --- End loading from session.json ---
    } catch (error) {
      logger.debug(`📂 Failed to load/parse session from ${sessionPath}:`, error.message);
      throw error; // Re-throw to let the login function handle it (e.g., trigger fresh login)
    }
  }

  /**
   * Save cookies to file (Simplified to only save session.json)
   * @returns {Promise<void>}
   * @private
   */
  async _saveCookies() {
    // --- ONLY save to the main session.json file ---
    const sessionPath = this.options.sessionPath; // Use the configured path
    try {
      // Ensure directory exists for sessionPath
      const sessionDir = path.dirname(sessionPath);
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }

      const session = await this.ig.state.serialize(); // Serialize the full state
      // DO NOT delete session.constants; // Keep all data including cookies
      await fsPromises.writeFile(sessionPath, JSON.stringify(session, null, 2)); // Save full state using fs.promises
      logger.info(`🍪 Full session state saved to ${sessionPath}`);
      // --- End saving to session.json ---
    } catch (error) {
       logger.error(`❌ Error saving session to ${sessionPath}:`, error.message);
       logger.debug('Save session error stack:', error.stack);
       // Don't throw, as this is usually a non-fatal error for immediate functionality
       // But it might cause issues on next restart if session wasn't saved.
    }

  /**
   * Disconnect from Instagram
   * @returns {Promise<void>}
   */
  async disconnect() {
    logger.info('🔌 Disconnecting from Instagram...');
    this.running = false;
    this.ready = false;
    // --- Clear Push Context on Disconnect (from code 2) ---
    this.pushContext = {}; // Clear push context on disconnect
    logger.debug('🧹 [Push] Cleared push context on disconnect.');
    // --- End Clear Push Context ---
    try {
      if (this.ig.realtime) {
        await this.ig.realtime.disconnect();
      }
      logger.info('✅ Disconnected successfully');
    } catch (error) {
      logger.warn('⚠️ Error during disconnect:', error.message);
    }
    this.emit('disconnect');
  }

  /**
   * Create or get a user object
   * @param {string} userId - User ID
   * @param {Object} userData - User data from API
   * @returns {User}
   * @private
   */
  _patchOrCreateUser(userId, userData) {
    if (this.cache.users.has(userId)) {
      this.cache.users.get(userId)._patch(userData);
    } else {
      this.cache.users.set(userId, new User(this, userData));
    }
    return this.cache.users.get(userId);
  }

  /**
   * Create a message object
   * @param {string} chatId - Chat ID
   * @param {Object} messageData - Message data from API
   * @returns {Message}
   * @private
   */
  _createMessage(chatId, messageData) {
    const message = new Message(this, chatId, messageData);
    this.cache.messages.set(message.id, message);
    return message;
  }

  /**
   * Fetch a user by ID or username
   * @param {string} query - User ID or username
   * @param {boolean} force - Force fetch from API
   * @returns {Promise<User>}
   */
  async fetchUser(query, force = false) {
    const isId = /^\d+$/.test(query);
    const userId = isId ? query : await this.ig.user.getIdByUsername(query);
    if (!this.cache.users.has(userId) || force) {
      const userData = await this.ig.user.info(userId);
      this._patchOrCreateUser(userId, userData);
    }
    return this.cache.users.get(userId);
  }

  /**
   * Fetch a chat by ID
   * @param {string} chatId - Chat ID
   * @param {boolean} force - Force fetch from API
   * @returns {Promise<Chat>}
   */
  async fetchChat(chatId, force = false) {
    if (!this.cache.chats.has(chatId) || force) {
      const { thread: chatData } = await this.ig.feed.directThread({ thread_id: chatId }).request();
      if (!this.cache.chats.has(chatId)) {
        this.cache.chats.set(chatId, new Chat(this, chatId, chatData));
      } else {
        this.cache.chats.get(chatId)._patch(chatData);
      }
    }
    return this.cache.chats.get(chatId);
  }

  /**
   * Create a new chat
   * @param {string[]} userIds - User IDs to include
   * @returns {Promise<Chat>}
   */
  async createChat(userIds) {
    const threadData = await this.ig.direct.createGroupThread(userIds);
    const chat = new Chat(this, threadData.thread_id, threadData);
    this.cache.chats.set(chat.id, chat);
    return chat;
  }

  /**
   * Load existing chats
   * @returns {Promise<void>}
   * @private
   */
  async _loadChats() {
    try {
      const [inbox, pending] = await Promise.all([
        this.ig.feed.directInbox().items(),
        this.ig.feed.directPending().items()
      ]);
      // Load inbox chats
      for (const thread of inbox) {
        const chat = new Chat(this, thread.thread_id, thread);
        this.cache.chats.set(chat.id, chat);
      }
      // Load pending chats
      for (const thread of pending) {
        const chat = new Chat(this, thread.thread_id, thread);
        this.cache.chats.set(chat.id, chat);
        this.cache.pendingChats.set(chat.id, chat);
      }
      logger.info(`📥 Loaded ${inbox.length} chats and ${pending.length} pending chats`);
    } catch (error) {
      logger.error('❌ Failed to load chats:', error.message);
    }
  }

  /**
   * Setup realtime event handlers
   * @private
   */
  _setupRealtimeHandlers() {
    logger.info('📡 Setting up realtime handlers...');
    // Main message handler for direct messages wrapped in realtime protocol
    this.ig.realtime.on('message', async (data) => {
      try {
        logger.debug('📨 [Realtime] Raw message event data received');
        if (!data.message) {
          logger.warn('⚠️ No message payload in event data');
          return;
        }
        // Use improved deduplication (potentially enhanced by push context) (from code 2)
        // --- Modified call to pass thread_id (from code 2) ---
        if (!this._isNewMessageById(data.message.item_id, data.message.thread_id)) {
          logger.debug(`⚠️ Message ${data.message.item_id} filtered as duplicate (by ID or Push Context)`);
          return;
        }
        // --- End modification ---
        logger.info('✅ Processing new message (by ID)...');
        await this._handleMessage(data.message, data);
      } catch (err) {
        logger.error('❌ Critical error in main message handler:', err.message);
      }
    });

    // Handler for other direct message related events (might overlap with 'message')
    this.ig.realtime.on('direct', async (data) => {
      try {
        logger.debug('📨 [Realtime] Raw direct event data received');
        // Check if the direct event *also* contains a message payload
        if (data.message) {
          // Apply deduplication here too (potentially enhanced by push context) (from code 2)
          // --- Modified call to pass thread_id (from code 2) ---
          if (!this._isNewMessageById(data.message.item_id, data.message.thread_id)) {
            logger.debug(`⚠️ Direct message ${data.message.item_id} filtered as duplicate (by ID or Push Context)`);
            return;
          }
          // --- End modification ---
          logger.info('✅ Processing new direct message (by ID)...');
          await this._handleMessage(data.message, data); // Process if it's a new message
        } else {
          // Handle other direct events that are NOT message payloads
          logger.info('ℹ️ Received non-message direct event');
          logger.debug('Direct event details:', JSON.stringify(data, null, 2));
          this.emit('directEvent', data); // Example: emit for non-message direct events
        }
      } catch (err) {
        logger.error('❌ Critical error in direct handler:', err.message);
      }
    });

    // --- Push Notification Handling (FBNS) (from code 2) ---
    logger.info('🔔 Setting up FBNS (Push Notification) listener...');
    this.ig.realtime.on('push', async (data) => { // <-- Add this 'push' listener
      try {
        logger.info('🔔 [Push] FBNS Push notification received');
        // logger.debug('Push notification ', JSON.stringify(data, null, 2)); // Uncomment for full details
        // --- Process the Push Notification (Similar to push.example.ts) (from code 2) ---
        // Use camelcaseKeys to convert snake_case keys to camelCase for easier JS access
        const { collapseKey, payload } = camelcaseKeys(data, { deep: true });
        // Check if it's a direct message notification
        if (collapseKey === 'direct_v2_message') {
          logger.info('🔔 [Push] Identified as Direct Message notification');
          // Extract thread_id and item_id from the payload string
          const threadIdMatch = payload?.match?.(/thread_id=(\d+)/);
          const itemIdMatch = payload?.match?.(/item_id=([^&]+)/); // Capture until next '&'
          const threadId = threadIdMatch?.[1];
          const itemId = itemIdMatch?.[1];
          logger.info(`🔔 [Push] Extracted - Thread ID: ${threadId}, Item ID: ${itemId}`);
          if (threadId && itemId) {
            // --- Store Context for Deduplication (from code 2) ---
            if (!this.pushContext[threadId]) {
              this.pushContext[threadId] = new Set();
            }
            this.pushContext[threadId].add(itemId);
            // Simple cleanup: Clear context if it gets too large (basic memory management)
            if (Object.keys(this.pushContext).length > 100) { // Arbitrary limit
              this.pushContext = {};
              logger.debug('🧹 [Push] Cleared push context cache (size limit)');
            }
            // --- End Store Context ---
            logger.info(`🔔 [Push] Awaiting 'message'/'direct' event for T:${threadId} I:${itemId}`);
          } else {
            logger.warn('🔔 [Push] Could not extract thread_id or item_id from payload');
            // logger.debug('Payload snippet:', payload?.substring(0, 200)); // Uncomment for payload debugging
          }
        } else {
          logger.info(`🔔 [Push] Received non-direct message push notification. Collapse Key: ${collapseKey}`);
          // Handle other types of pushes if necessary (e.g., activity) (from code 2)
          if (collapseKey === 'consolidated_notification_ig' || collapseKey?.startsWith('notification')) {
            this.ig.realtime.emit('activity', data); // Forward to existing 'activity' handler
            logger.info('🔔 [Push] Forwarded potential activity notification.');
          }
        }
        // --- End Process Push Notification ---
      } catch (pushError) {
        logger.error('❌ Error processing push notification:', pushError.message);
        // logger.debug('Push error stack:', pushError.stack); // Uncomment for error debugging
        // Don't let push errors crash the handler
      }
    });
    logger.info('🔔 FBNS (Push Notification) listener setup complete.');
    // --- End Push Notification Handling ---

    // --- Connection events (updated like code 2) ---
    this.ig.realtime.on('error', (error) => {
      logger.error('🚨 Realtime error:', error.message);
      this.emit('error', error);
      if (this.options.autoReconnect && this._retryCount < this.options.maxRetries && this.running) {
        this._attemptReconnect();
      }
    });

    this.ig.realtime.on('close', () => {
      logger.warn('🔌 Realtime connection closed');
      this.ready = false; // Mark as not ready when connection closes (like code 2)
      this.emit('disconnect');
      if (this.running && this.options.autoReconnect) { // Only reconnect if intended to run (like code 2)
        this._attemptReconnect();
      }
    });

    // --- Debug events (keep original logic from code 3, but log connect/reconnect like code 2) ---
    this.ig.realtime.on('receive', (topic, messages) => {
      const topicStr = String(topic || '');
      if (topicStr.includes('direct') || topicStr.includes('message')) {
        logger.debug(`📥 Realtime receive: ${topicStr}`);
      }
    });

    // Add connect/reconnect handlers for better state management (like code 2)
     this.ig.realtime.on('connect', () => {
      logger.info('🔗 Realtime connection successfully established');
      // Add this line to indicate FBNS is part of the active connection (like code 2)
      logger.info('✅ Realtime connected with FBNS (Push Notifications) support');
      // this.ready is set to true in login after connect resolves
    });

    this.ig.realtime.on('reconnect', () => {
      logger.info('🔁 Realtime client is attempting to reconnect');
      this.ready = false; // Temporarily not ready during reconnect (like code 2)
    });
    // --- End Connection events ---
  }

  // --- Deduplication Logic (Integrated from code 2) ---
  // Improved deduplication using message ID and enhanced with Push Context (from code 2)
  // --- Modified signature to accept threadId (from code 2) ---
  _isNewMessageById(messageId, threadId = null) {
    // --- End modification ---
    if (!messageId) {
      logger.warn('⚠️ Attempted to check message ID, but ID was missing.');
      return true; // Default to processing if ID is missing
    }
    if (this.processedMessageIds.has(messageId)) {
      return false; // Already processed via standard dedup
    }
    // --- Check against Push Context (Add this block from code 2) ---
    // If we have threadId and messageId from push, check that too.
    if (threadId && this.pushContext[threadId]?.has(messageId)) {
      logger.debug(`⚠️ Message ${messageId} filtered as duplicate (by Push Context for thread ${threadId})`);
      // Keep in context for now, rely on periodic cleanup or size limits in push handler.
      return false; // Filtered by push context
    }
    // --- End Push Context Check ---
    // Add new ID to the standard set
    this.processedMessageIds.add(messageId);
    if (this.processedMessageIds.size > this.maxProcessedMessageIds) {
      const first = this.processedMessageIds.values().next().value;
      if (first !== undefined) {
        this.processedMessageIds.delete(first);
      }
    }
    return true; // It's new according to both checks
  }
  // --- End Deduplication Logic ---

  /**
   * Check if message is new (timestamp-based - original logic from code 3)
   * @param {Object} message - Message data
   * @returns {boolean}
   * @private
   */
  _isNewMessage(message) {
    try {
      const messageTime = new Date(parseInt(message.timestamp) / 1000);
      const isNew = messageTime > this.lastMessageCheck;
      if (isNew) {
        this.lastMessageCheck = messageTime;
      }
      return isNew;
    } catch (error) {
      logger.error('❌ Error checking message timestamp:', error.message);
      return true; // Default to processing
    }
  }

  /**
   * Handle incoming message
   * @param {Object} messageData - Raw message data
   * @param {Object} eventData - Event data
   * @returns {Promise<void>}
   * @private
   */
  async _handleMessage(messageData, eventData) {
    try {
      const threadId = eventData.thread?.thread_id || messageData.thread_id;
      if (!threadId) return;
      // Ensure chat exists
      let chat = this.cache.chats.get(threadId);
      if (!chat) {
        chat = await this.fetchChat(threadId);
      }
      // Create message object
      const message = this._createMessage(threadId, messageData);
      chat.messages.set(message.id, message);
      // Determine if message is from the bot itself (simplistic check)
      message.fromBot = message.sender.id === this.user.id;
      // Emit events
      this.emit('messageCreate', message);
      if (message.fromBot) {
        this.emit('messageSent', message);
      } else {
        this.emit('messageReceived', message);
      }
    } catch (error) {
      logger.error('❌ Error handling message:', error.message);
    }
  }

  /**
   * Attempt to reconnect
   * @private
   */
  async _attemptReconnect() {
    // Add check for running state like updated code 3 logic
    if (!this.running) {
       logger.info('🔄 Reconnect attempt skipped (client is not marked as running)');
       return;
    }
    this._retryCount++;
    const delay = Math.min(1000 * Math.pow(2, this._retryCount), 30000);
    logger.info(`🔄 Attempting reconnect ${this._retryCount}/${this.options.maxRetries} in ${delay}ms...`);
    setTimeout(async () => {
      // Double-check before attempting like updated code 3 logic
      if (!this.running) {
          logger.info('🔄 Reconnect attempt cancelled (client is no longer running)');
          return;
      }
      try {
        await this.ig.realtime.connect({
          autoReconnect: this.options.autoReconnect,
          irisData: await this.ig.feed.directInbox().request()
        });
        this._retryCount = 0;
        this.ready = true; // Mark as ready again like updated code 3 logic
        logger.info('✅ Reconnected successfully');
      } catch (error) {
        logger.error('❌ Reconnect failed:', error.message);
        if (this._retryCount >= this.options.maxRetries) {
          logger.error('❌ Max reconnect attempts reached');
          this.emit('maxRetriesReached');
        }
      }
    }, delay);
  }

  /**
   * Replay queued events
   * @private
   */
  _replayEvents() {
    // Keep original replay logic from code 3, but use the new realtime emit mechanism
    logger.info(`🔁 Replaying ${this._eventsToReplay.length} queued events...`);
    for (const [eventType, data] of this._eventsToReplay) {
      if (eventType === 'message') {
        this.ig.realtime.emit('message', data); // Re-emit to trigger handler
      } else if (eventType === 'direct') {
        this.ig.realtime.emit('direct', data); // Re-emit to trigger handler
      }
      // Add other event types if queued
    }
    this._eventsToReplay = [];
    logger.info('✅ Finished replaying queued events.');
  }




  /**
   * Get client statistics
   * @returns {Object}
   */
  getStats() {
    return {
      ready: this.ready,
      running: this.running,
      users: this.cache.users.size,
      chats: this.cache.chats.size,
      pendingChats: this.cache.pendingChats.size,
      messages: this.cache.messages.size,
      retryCount: this._retryCount,
      lastMessageCheck: this.lastMessageCheck,
      processedMessageIdsCount: this.processedMessageIds?.size || 0 // Added dedup cache size
    };
  }

  /**
   * JSON representation
   * @returns {Object}
   */
  toJSON() {
    return {
      ready: this.ready,
      running: this.running,
      userId: this.user?.id,
      username: this.user?.username,
      stats: this.getStats()
    };
  }
}

export default InstagramClient;
