import { IgApiClient } from 'instagram-private-api';
import { withRealtime } from 'instagram_mqtt';
import { EventEmitter } from 'events';
// Use fs.promises for consistency with OriginalInstagramBot.js
import { promises as fsPromises } from 'fs'; // CHANGED: Use fs.promises
import { existsSync, mkdirSync } from 'fs'; // Keep sync for quick checks/mkdir
import tough from 'tough-cookie';
import { Collection } from '@discordjs/collection';
import User from '../utils/User.js';
import Chat from '../utils/Chat.js';
import Message from '../utils/Message.js';
import { logger } from '../utils/utils.js';
import path from 'path';
import { fileURLToPath } from 'url';
// import { writeFileSync } from 'fs'; // Not needed if using fsPromises.writeFile

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Enhanced Instagram client with rich object support and robust login
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
      // Align session path default with OriginalInstagramBot.js structure
      sessionPath: './session.json', // CHANGED: Default to session.json like OriginalInstagramBot.js
      messageCheckInterval: 5000,
      maxRetries: 3,
      autoReconnect: true,
      // Allow passing username/password via options if desired
      username: null,
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
     * Whether the client login process has started/finished successfully
     * @type {boolean}
     */
    this.loggedIn = false; // ADDED: Track login success
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
     * Last message check timestamp (if used for alternative dedup)
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

    // --- Add deduplication properties from OriginalInstagramBot.js ---
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
    // --- End deduplication properties ---
  }

  /**
   * Robust Login to Instagram using session, cookies, or password
   * Adapted from OriginalInstagramBot.js login logic
   * @param {string} username - Instagram username (can also be in options or env)
   * @param {string} password - Instagram password (can also be in options or env)
   * @returns {Promise<void>}
   */
// Updated login method for client.js
// Updated login method in client.js
// Updated login method in client.js
async login(username, password) {
  try {
    const finalUsername = username || this.options.username;
    const finalPassword = password || this.options.password;

    if (!finalUsername || !finalPassword) {
      throw new Error('Username and password are required');
    }

    logger.info(`🔑 Attempting login for @${finalUsername}...`);
    
    // 1. Initialize client with realistic device settings
    this.ig.state.generateDevice(finalUsername);
    this.ig.state.deviceString = 'Android/10.0.0'; // More realistic device string
    this.ig.state.deviceId = `android-${crypto.randomBytes(8).toString('hex')}`;
    
    // 2. Implement request throttling
    this.ig.request.end$.subscribe(() => {
      return new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay between requests
    });

    // 3. Try session login first if exists
    if (existsSync(this.options.sessionPath)) {
      try {
        const session = JSON.parse(await fsPromises.readFile(this.options.sessionPath));
        await this.ig.state.deserialize(session);
        
        // Verify session is still valid
        try {
          await this.ig.account.currentUser();
          logger.info('✅ Logged in from existing session');
          await this._completeLogin();
          return;
        } catch (sessionError) {
          logger.warn('⚠️ Session expired:', sessionError.message);
        }
      } catch (fileError) {
        logger.warn('⚠️ Failed to load session:', fileError.message);
      }
    }

    // 4. Implement retry mechanism with delays
    const maxRetries = 3;
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`Attempt ${attempt}/${maxRetries}`);
        
        // Add progressive delay between attempts
        if (attempt > 1) {
          const delaySeconds = Math.min(30, Math.pow(2, attempt)); // Exponential backoff
          logger.info(`⏳ Waiting ${delaySeconds} seconds before retry...`);
          await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
        }

        // 5. Modern login flow with proper headers
        await this.ig.simulate.preLoginFlow();
        const loggedInUser = await this.ig.account.login(finalUsername, finalPassword);
        await this.ig.simulate.postLoginFlow();

        // 6. Save session with additional metadata
        const state = await this.ig.state.serialize();
        state.loginTimestamp = Date.now();
        state.loginIP = await this._getPublicIP();
        await fsPromises.writeFile(this.options.sessionPath, JSON.stringify(state));
        logger.info('💾 Saved new session');

        await this._completeLogin();
        return;
        
      } catch (error) {
        lastError = error;
        
        // Handle specific error cases
        if (error.message.includes('token_expired') || error.message.includes('401')) {
          logger.warn(`⚠️ Instagram blocked request (attempt ${attempt}): ${error.message}`);
          continue;
        }
        
        if (error.name === 'IgCheckpointError') {
          logger.warn('⚠️ Checkpoint required - solving automatically');
          await this._solveCheckpoint(error);
          await this._completeLogin();
          return;
        }
        
        // For other errors, break the retry loop
        break;
      }
    }
    
    throw lastError || new Error('Login failed after multiple attempts');
    
  } catch (error) {
    logger.error('❌ Login failed:', error.message);
    this.ready = false;
    this.loggedIn = false;
    throw error;
  }
}

// Additional helper methods:

async _getPublicIP() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    const data = await response.json();
    return data.ip;
  } catch {
    return 'unknown';
  }
}

async _solveCheckpoint(error) {
  try {
    // Reset challenge state
    this.ig.state.challenge = null;
    
    // Get challenge
    const challenge = await this.ig.challenge.auto(false); // Disable auto-resolve
    
    if (!challenge) {
      throw new Error('No checkpoint challenge available');
    }
    
    // Select email verification by default
    const method = challenge.step_data?.choice || '1';
    await this.ig.challenge.selectVerifyMethod(method);
    
    // Get security code (implement your own logic here)
    const code = await this._getSecurityCode();
    
    // Submit code with delay
    await new Promise(resolve => setTimeout(resolve, 5000)); // 5s delay
    await this.ig.challenge.sendSecurityCode(code);
    
    // Verify challenge was solved
    await new Promise(resolve => setTimeout(resolve, 3000)); // 3s delay
    const user = await this.ig.account.currentUser();
    
    // Save session
    const state = await this.ig.state.serialize();
    await fsPromises.writeFile(this.options.sessionPath, JSON.stringify(state));
    
    logger.info('✅ Checkpoint solved successfully');
    return user;
    
  } catch (error) {
    logger.error('❌ Failed to solve checkpoint:', error.message);
    throw error;
  }
}

async _completeLogin() {
  // Initialize user
  const userInfo = await this.ig.account.currentUser();
  this.user = this._patchOrCreateUser(userInfo.pk, userInfo);
  
  // Load chats with delay
  await new Promise(resolve => setTimeout(resolve, 1000));
  await this._loadChats();
  
  // Connect to realtime with delay
  await new Promise(resolve => setTimeout(resolve, 2000));
  await this._setupRealtime();
  
  this.ready = true;
  this.loggedIn = true;
  logger.info(`🚀 Successfully logged in as @${this.user.username}`);
  this.emit('ready');
}

async _solveCheckpoint(error) {
  try {
    // Reset challenge state
    this.ig.state.challenge = null;
    
    // Alternative checkpoint solving
    const challenge = await this.ig.challenge.auto(true);
    if (!challenge) {
      throw new Error('No checkpoint challenge available');
    }
    
    // Select verification method (email by default)
    await this.ig.challenge.selectVerifyMethod(challenge.step_data?.choice || '1');
    
    // Get security code (you might need to implement this differently)
    const code = await this._getSecurityCode(); 
    
    // Submit code
    await this.ig.challenge.sendSecurityCode(code);
    
    // Save session
    const state = await this.ig.state.serialize();
    await fsPromises.writeFile(this.options.sessionPath, JSON.stringify(state));
    
  } catch (challengeError) {
    logger.error('❌ Failed to solve checkpoint:', challengeError.message);
    throw new Error('Checkpoint verification failed');
  }
}

async _getSecurityCode() {
  // Implement your code retrieval logic here
  // This could be:
  // 1. Manual input via console
  // 2. Email/SMS parsing
  // 3. Database lookup
  
  // Example: Prompt user for input
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise(resolve => {
    readline.question('Enter verification code: ', code => {
      readline.close();
      resolve(code);
    });
  });
}

async _setupRealtime() {
  try {
    await this.ig.realtime.connect({
      irisData: await this.ig.feed.directInbox().request(),
      connectOverrides: {
        auth: {
          user: this.ig.state.cookieUserId,
          pass: this.ig.state.cookiePassword
        }
      }
    });
    
    // Setup push notifications
    this.ig.fbns.push$.subscribe(data => this._handlePushNotification(data));
    await this.ig.fbns.connect();
    
    logger.info('📡 Realtime connection established');
  } catch (error) {
    logger.error('❌ Realtime connection failed:', error.message);
    throw error;
  }
}

async _handleCheckpoint() {
  try {
    // Implement your checkpoint handling logic
    const code = await prompt('Enter verification code from email/SMS:');
    await this.ig.challenge.sendSecurityCode(code);
    
    // Save session after successful verification
    const session = await this.ig.state.serialize();
    await fsPromises.writeFile(this.options.sessionPath, JSON.stringify(session, null, 2));
    
    logger.info('✅ Checkpoint verification successful');
  } catch (error) {
    logger.error('❌ Checkpoint verification failed:', error.message);
    throw error;
  }
}

async _handleTwoFactor() {
  try {
    // Implement your 2FA handling logic
    const code = await prompt('Enter 2FA code:');
    await this.ig.account.twoFactorLogin({
      username: this.ig.state.username,
      verificationCode: code,
      trustThisDevice: '1'
    });
    
    logger.info('✅ 2FA verification successful');
  } catch (error) {
    logger.error('❌ 2FA verification failed:', error.message);
    throw error;
  }
}
  /**
   * Setup realtime event handlers
   * @private
   */
  _setupRealtimeHandlers() {
    logger.info('📡 Setting up realtime handlers...');
    // Main message handler
    this.ig.realtime.on('message', async (data) => {
      try {
        if (!this.ready) { // Use 'ready' to check if fully initialized
          this._eventsToReplay.push(['message', data]);
          logger.debug('📨 Queued message event (not ready yet)');
          return;
        }
        // Use the original bot's deduplication logic
        if (!data.message || !this._isNewMessageById(data.message.item_id)) { // CHANGED: Use ID-based dedup
          // logger.debug(`⚠️ Message ${data.message?.item_id} filtered as duplicate`);
          return;
        }
        logger.debug('📨 Processing new message event');
        await this._handleMessage(data.message, data);
      } catch (error) {
        logger.error('❌ Message handler error:', error.message);
        logger.debug('Message handler error stack:', error.stack);
      }
    });
    // Direct events handler
    this.ig.realtime.on('direct', async (data) => {
      try {
        if (!this.ready) {
          this._eventsToReplay.push(['direct', data]);
          logger.debug('📨 Queued direct event (not ready yet)');
          return;
        }
        if (data.message && this._isNewMessageById(data.message.item_id)) { // CHANGED: Use ID-based dedup
           logger.debug('📨 Processing new direct event with message');
          await this._handleMessage(data.message, data);
        } else {
             logger.debug('ℹ️ Processing direct event (non-message or duplicate)');
             // Handle other direct events if needed
             this.emit('directEvent', data); // Example: emit for non-message direct events
        }
      } catch (error) {
        logger.error('❌ Direct handler error:', error.message);
        logger.debug('Direct handler error stack:', error.stack);
      }
    });

    // Connection events
    this.ig.realtime.on('error', (error) => {
      logger.error('🚨 Realtime error:', error.message);
      this.emit('error', error);
      if (this.options.autoReconnect && this._retryCount < this.options.maxRetries && this.running) {
        this._attemptReconnect();
      }
    });
    this.ig.realtime.on('close', () => {
      logger.warn('🔌 Realtime connection closed');
      this.ready = false; // Mark as not ready when connection closes
      this.emit('disconnect');
      if (this.running && this.options.autoReconnect) { // Only reconnect if intended to run
        this._attemptReconnect();
      }
    });
    // Debug events
    this.ig.realtime.on('receive', (topic, messages) => {
      const topicStr = String(topic || '');
      if (topicStr.includes('direct') || topicStr.includes('message')) {
        logger.debug(`📥 Realtime receive: ${topicStr}`);
      }
    });

    // Add connect/reconnect handlers for better state management
     this.ig.realtime.on('connect', () => {
      logger.info('🔗 Realtime connection successfully established');
      // this.ready is set to true in login after connect resolves
    });

    this.ig.realtime.on('reconnect', () => {
      logger.info('🔁 Realtime client is attempting to reconnect');
      this.ready = false; // Temporarily not ready during reconnect
    });
  }

  // --- Deduplication Logic (Integrated from OriginalInstagramBot.js) ---
  // Improved deduplication using message ID
  _isNewMessageById(messageId) {
    if (!messageId) {
        logger.warn('⚠️ Attempted to check message ID, but ID was missing.');
        return true; // Default to processing if ID is missing
    }
    if (this.processedMessageIds.has(messageId)) {
        return false; // Already processed
    }
    // Add new ID to the set
    this.processedMessageIds.add(messageId);
    // Prevent memory leak by removing oldest IDs
    if (this.processedMessageIds.size > this.maxProcessedMessageIds) {
        // Simple FIFO removal of the first (oldest) entry
        const first = this.processedMessageIds.values().next().value;
        if (first !== undefined) {
            this.processedMessageIds.delete(first);
        }
    }
    return true; // It's new
  }
  // --- End Deduplication Logic ---

  /**
   * Load cookies from file (Adapted from OriginalInstagramBot.js)
   * Handles loading from session.json (if it contains cookies) or cookies.json
   * @returns {Promise<void>}
   * @private
   */
  async _loadCookies() {
    let cookiesToLoad = [];
    let sourceDescription = '';

    // Strategy 1: Try loading cookies from the main session.json file (if it's the unified format)
    try {
        const sessionDataRaw = await fsPromises.readFile(this.options.sessionPath, 'utf-8');
        const sessionData = JSON.parse(sessionDataRaw);
        // Check if session.json has a cookies array directly (like the unified format)
        if (Array.isArray(sessionData.cookies)) {
            cookiesToLoad = sessionData.cookies;
            sourceDescription = `session file (${this.options.sessionPath})`;
            logger.debug(`🍪 Found ${cookiesToLoad.length} cookies in session.json`);
        } else {
            // If session.json exists but doesn't have cookies array, it might be the serialized state
            // without cookies, or an old format. We'll try cookies.json next.
            logger.debug(`📂 Session file found at ${this.options.sessionPath} but no cookies array found. Trying cookies.json...`);
        }
    } catch (sessionReadError) {
        // session.json doesn't exist or is invalid JSON, try cookies.json
        logger.debug(`📂 Session file not found or invalid at ${this.options.sessionPath}. Trying cookies.json...`);
    }

    // Strategy 2: If no cookies from session.json, try cookies.json
    if (cookiesToLoad.length === 0) {
        const cookiesPath = './cookies.json'; // Path used in OriginalInstagramBot.js
        try {
            await fsPromises.access(cookiesPath); // Use fs.promises
            const cookiesRaw = await fsPromises.readFile(cookiesPath, 'utf-8'); // Use fs.promises
            cookiesToLoad = JSON.parse(cookiesRaw);
            sourceDescription = 'cookies.json';
            logger.debug(`🍪 Found ${cookiesToLoad.length} cookies in cookies.json`);
        } catch (cookiesError) {
            // cookies.json doesn't exist or is invalid
            logger.debug(`📂 cookies.json not found or invalid: ${cookiesError.message}`);
            throw new Error('No valid cookies found in session.json or cookies.json');
        }
    }

    // If we found cookies, load them into the IgApiClient state
    if (cookiesToLoad.length > 0) {
        let cookiesLoaded = 0;
        for (const cookie of cookiesToLoad) {
            // Ensure cookie object has the expected structure
            if (!cookie.name || !cookie.value || !cookie.domain) {
                logger.warn(`⚠️ Skipping invalid cookie structure: ${JSON.stringify(cookie)}`);
                continue;
            }
            try {
                const toughCookie = new tough.Cookie({
                    key: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain.replace(/^\./, ''), // Remove leading dot if present
                    path: cookie.path || '/',
                    secure: cookie.secure !== false, // Default to true if not explicitly false
                    httpOnly: cookie.httpOnly !== false, // Default to true if not explicitly false
                    // Add expires if available
                    // expires: cookie.expires ? new Date(cookie.expires) : undefined
                });

                // Set the cookie in the jar
                await this.ig.state.cookieJar.setCookie(
                    toughCookie.toString(),
                    `https://${toughCookie.domain}${toughCookie.path}`
                );
                cookiesLoaded++;
            } catch (cookieProcessError) {
                 logger.warn(`⚠️ Error processing cookie ${cookie.name}:`, cookieProcessError.message);
                 // Continue with other cookies
            }
        }
        logger.info(`🍪 Successfully loaded ${cookiesLoaded}/${cookiesToLoad.length} cookies from ${sourceDescription}`);
        if (cookiesLoaded === 0) {
             throw new Error('No cookies could be successfully loaded and set.');
        }
    } else {
        // This case should ideally be caught by the throw above
        throw new Error('No cookies available to load.');
    }
  }

  /**
   * Save cookies/state to file (Adapted from OriginalInstagramBot.js logic within login)
   * This is now primarily handled within the main login flow after successful auth.
   * Keeping this method for potential future use or manual saving.
   * @returns {Promise<void>}
   * @private
   */
  async _saveCookies() {
    try {
      const state = await this.ig.state.serialize(); // includes cookies, device, etc.
      // Ensure directory exists
      const dir = path.dirname(this.options.sessionPath);
      if (!existsSync(dir)) { // Use sync version for mkdir
        mkdirSync(dir, { recursive: true });
      }
      await fsPromises.writeFile(this.options.sessionPath, JSON.stringify(state, null, 2)); // Use fs.promises
      logger.info(`🍪 Saved cookies and state to ${this.options.sessionPath}`);
    } catch (saveError) {
       logger.error(`❌ Error saving cookies/state to ${this.options.sessionPath}:`, saveError.message);
       logger.debug('Save cookies error stack:', saveError.stack);
       // Don't throw, as this is usually a non-fatal error
    }
  }

  /**
   * Disconnect from Instagram
   * @returns {Promise<void>}
   */
  async disconnect() {
    logger.info('🔌 Disconnecting from Instagram...');
    this.running = false;
    this.ready = false;
    this.loggedIn = false; // Update state
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
    // Main message handler
    this.ig.realtime.on('message', async (data) => {
      try {
        if (!this.ready) { // Use 'ready' to check if fully initialized
          this._eventsToReplay.push(['message', data]);
          logger.debug('📨 Queued message event (not ready yet)');
          return;
        }
        // Use the original bot's deduplication logic if preferred, or keep timestamp-based
        // if (!this._isNewMessageById(data.message?.item_id)) {
        if (!data.message || !this._isNewMessage(data.message)) { // Keep existing timestamp check for now
          // logger.debug(`⚠️ Message ${data.message?.item_id} filtered as duplicate`);
          return;
        }
        logger.debug('📨 Processing new message event');
        await this._handleMessage(data.message, data);
      } catch (error) {
        logger.error('❌ Message handler error:', error.message);
        logger.debug('Message handler error stack:', error.stack);
      }
    });
    // Direct events handler
    this.ig.realtime.on('direct', async (data) => {
      try {
        if (!this.ready) {
          this._eventsToReplay.push(['direct', data]);
          logger.debug('📨 Queued direct event (not ready yet)');
          return;
        }
        if (data.message && this._isNewMessage(data.message)) { // Keep existing check
           logger.debug('📨 Processing new direct event with message');
          await this._handleMessage(data.message, data);
        } else {
             logger.debug('ℹ️ Processing direct event (non-message or duplicate)');
             // Handle other direct events if needed
             this.emit('directEvent', data); // Example: emit for non-message direct events
        }
      } catch (error) {
        logger.error('❌ Direct handler error:', error.message);
        logger.debug('Direct handler error stack:', error.stack);
      }
    });

    // --- Integrate FBNS Push Handler from OriginalInstagramBot.js ---
    // Import camelcase-keys at the top: import camelcaseKeys from 'camelcase-keys';
    // For now, just log push events
    this.ig.realtime.on('push', async (data) => {
       logger.info('🔔 [Push] FBNS Push notification received (handler placeholder)');
       // logger.debug('🔔 [Push] Data:', JSON.stringify(data, null, 2));
       // Add processing logic similar to OriginalInstagramBot.js if needed
       // This primarily helps with deduplication, which is handled by the main handlers now
       // But good to log for visibility.
    });
    // --- End FBNS Push Handler ---

    // Connection events
    this.ig.realtime.on('error', (error) => {
      logger.error('🚨 Realtime error:', error.message);
      this.emit('error', error);
      if (this.options.autoReconnect && this._retryCount < this.options.maxRetries && this.running) {
        this._attemptReconnect();
      }
    });
    this.ig.realtime.on('close', () => {
      logger.warn('🔌 Realtime connection closed');
      this.ready = false; // Mark as not ready when connection closes
      this.emit('disconnect');
      if (this.running && this.options.autoReconnect) { // Only reconnect if intended to run
        this._attemptReconnect();
      }
    });
    // Debug events
    this.ig.realtime.on('receive', (topic, messages) => {
      const topicStr = String(topic || '');
      if (topicStr.includes('direct') || topicStr.includes('message')) {
        logger.debug(`📥 Realtime receive: ${topicStr}`);
      }
      // Log connect/reconnect for visibility
      if (topicStr.includes('iris')) {
         logger.debug(`🔄 Realtime IRIS data received: ${topicStr}`);
      }
    });

    // Add other handlers from OriginalInstagramBot.js if needed (typing, presence, etc.)
     this.ig.realtime.on('connect', () => {
      logger.info('🔗 Realtime connection successfully established');
      // Add this line to indicate FBNS is part of the active connection if push is fully integrated
      logger.info('✅ Realtime connected with FBNS (Push Notifications) support');
      // this.ready is set to true in login after connect resolves
      // this.emit('connect'); // Optional: emit a specific connect event if needed elsewhere
    });

    this.ig.realtime.on('reconnect', () => {
      logger.info('🔁 Realtime client is attempting to reconnect');
      this.ready = false; // Temporarily not ready during reconnect
      // Optional: emit a specific reconnect event
      // this.emit('reconnecting');
    });

    // --- Debugging Events ---
    this.ig.realtime.on('debug', (data) => {
      // Use a lower log level for verbose debugging info if needed
      // logger.trace('🐛 Realtime debug info:', data);
      logger.debug('🐛 Realtime debug info received'); // Simplified log
    });

  }


  // --- Deduplication Logic (Integrated from OriginalInstagramBot.js) ---
  // Improved deduplication using message ID (similar to OriginalInstagramBot.js)
  // Add this as a property in constructor if not already: this.processedMessageIds = new Set(); this.maxProcessedMessageIds = 1000;
  // Add to constructor:
  // this.processedMessageIds = new Set();
  // this.maxProcessedMessageIds = 1000;

  // Improved deduplication using message ID
  _isNewMessageById(messageId) {
    if (!messageId) {
        logger.warn('⚠️ Attempted to check message ID, but ID was missing.');
        return true; // Default to processing if ID is missing
    }
    if (this.processedMessageIds.has(messageId)) {
        return false; // Already processed
    }
    // Add new ID to the set
    this.processedMessageIds.add(messageId);
    // Prevent memory leak by removing oldest IDs
    if (this.processedMessageIds.size > this.maxProcessedMessageIds) {
        // Simple FIFO removal of the first (oldest) entry
        const first = this.processedMessageIds.values().next().value;
        if (first !== undefined) {
            this.processedMessageIds.delete(first);
        }
    }
    return true; // It's new
  }
  // --- End Deduplication Logic ---

  /**
   * Check if message is new (timestamp-based - original logic)
   * @param {Object} message - Message data
   * @returns {boolean}
   * @private
   */
  _isNewMessage(message) {
    // Prefer ID-based check if available and integrated
    // if (message?.item_id !== undefined) {
    //    return this._isNewMessageById(message.item_id);
    // }
    // Fallback to timestamp check
    try {
      const messageTimeMicroseconds = parseInt(message.timestamp, 10);
      if (isNaN(messageTimeMicroseconds)) {
          logger.warn('⚠️ Invalid message timestamp format');
          return true; // Default to processing
      }
      const messageTime = new Date(messageTimeMicroseconds / 1000); // Convert microseconds to milliseconds

      const isNew = messageTime > this.lastMessageCheck;
      if (isNew) {
        this.lastMessageCheck = messageTime;
        // logger.debug(`✅ Message ${message.item_id} is new (by timestamp)`);
      } else {
        // logger.debug(`❌ Message ${message.item_id} is old (by timestamp)`);
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
      if (!threadId) {
         logger.warn('⚠️ Received message data without thread ID');
         return;
      }

      // Ensure chat exists
      let chat = this.cache.chats.get(threadId);
      if (!chat) {
        // logger.debug(`💬 Chat ${threadId} not in cache, fetching...`);
        chat = await this.fetchChat(threadId);
      }
      // Create message object
      const message = this._createMessage(threadId, messageData);
      chat.messages.set(message.id, message);

      // Determine if message is from the bot itself (simplistic check)
      // A more robust check might involve comparing user.pk to this.user.id
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
      logger.debug('Message handling error stack:', error.stack);
    }
  }

  /**
   * Attempt to reconnect
   * @private
   */
  async _attemptReconnect() {
    if (!this.running) {
       logger.info('🔄 Reconnect attempt skipped (client is not marked as running)');
       return; // Don't reconnect if intentionally stopped
    }
    this._retryCount++;
    const delay = Math.min(1000 * Math.pow(2, this._retryCount), 30000);
    logger.info(`🔄 Attempting reconnect ${this._retryCount}/${this.options.maxRetries} in ${delay}ms...`);
    setTimeout(async () => {
      if (!this.running) { // Double-check before attempting
          logger.info('🔄 Reconnect attempt cancelled (client is no longer running)');
          return;
      }
      try {
        // Re-login might be necessary depending on why it disconnected
        // For now, just try re-connecting the realtime socket
        // If login is needed, you might need to call this.login() again with stored credentials
        // This is a complex area - socket reconnect vs full session re-auth
        // Let's assume the session is still valid for socket reconnect for now.
        await this.ig.realtime.connect({
          autoReconnect: this.options.autoReconnect,
          irisData: await this.ig.feed.directInbox().request()
        });
        this._retryCount = 0; // Reset on successful reconnect
        this.ready = true;    // Mark as ready again
        logger.info('✅ Reconnected successfully');
        this.emit('reconnected'); // Optional: emit event
      } catch (error) {
        logger.error('❌ Reconnect failed:', error.message);
        logger.debug('Reconnect error stack:', error.stack);
        if (this._retryCount >= this.options.maxRetries) {
          logger.error('❌ Max reconnect attempts reached');
          this.emit('maxRetriesReached');
          // Potentially trigger a full re-login or shutdown?
        }
      }
    }, delay);
  }

  /**
   * Replay queued events
   * @private
   */
  _replayEvents() {
    logger.info(`🔁 Replaying ${this._eventsToReplay.length} queued events...`);
    for (const [eventType, data] of this._eventsToReplay) {
      if (eventType === 'message') {
        // Pass through the main handler which now checks this.ready again
        // but it should be true now. Alternatively, call _handleMessage directly.
        // Using the event emitter mechanism again is safer.
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
   * Load cookies from file (Adapted from OriginalInstagramBot.js)
   * Handles loading from session.json (if it contains cookies) or cookies.json
   * @returns {Promise<void>}
   * @private
   */
  async _loadCookies() {
    let cookiesToLoad = [];
    let sourceDescription = '';

    // Strategy 1: Try loading cookies from the main session.json file (if it's the unified format)
    try {
        const sessionDataRaw = await fsPromises.readFile(this.options.sessionPath, 'utf-8');
        const sessionData = JSON.parse(sessionDataRaw);
        // Check if session.json has a cookies array directly (like the unified format)
        if (Array.isArray(sessionData.cookies)) {
            cookiesToLoad = sessionData.cookies;
            sourceDescription = `session file (${this.options.sessionPath})`;
            logger.debug(`🍪 Found ${cookiesToLoad.length} cookies in session.json`);
        } else {
            // If session.json exists but doesn't have cookies array, it might be the serialized state
            // without cookies, or an old format. We'll try cookies.json next.
            logger.debug(`📂 Session file found at ${this.options.sessionPath} but no cookies array found. Trying cookies.json...`);
        }
    } catch (sessionReadError) {
        // session.json doesn't exist or is invalid JSON, try cookies.json
        logger.debug(`📂 Session file not found or invalid at ${this.options.sessionPath}. Trying cookies.json...`);
    }

    // Strategy 2: If no cookies from session.json, try cookies.json
    if (cookiesToLoad.length === 0) {
        const cookiesPath = './cookies.json'; // Path used in OriginalInstagramBot.js
        try {
            await fsPromises.access(cookiesPath);
            const cookiesRaw = await fsPromises.readFile(cookiesPath, 'utf-8');
            cookiesToLoad = JSON.parse(cookiesRaw);
            sourceDescription = 'cookies.json';
            logger.debug(`🍪 Found ${cookiesToLoad.length} cookies in cookies.json`);
        } catch (cookiesError) {
            // cookies.json doesn't exist or is invalid
            logger.debug(`📂 cookies.json not found or invalid: ${cookiesError.message}`);
            throw new Error('No valid cookies found in session.json or cookies.json');
        }
    }

    // If we found cookies, load them into the IgApiClient state
    if (cookiesToLoad.length > 0) {
        let cookiesLoaded = 0;
        for (const cookie of cookiesToLoad) {
            // Ensure cookie object has the expected structure
            if (!cookie.name || !cookie.value || !cookie.domain) {
                logger.warn(`⚠️ Skipping invalid cookie structure: ${JSON.stringify(cookie)}`);
                continue;
            }
            try {
                const toughCookie = new tough.Cookie({
                    key: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain.replace(/^\./, ''), // Remove leading dot if present
                    path: cookie.path || '/',
                    secure: cookie.secure !== false, // Default to true if not explicitly false
                    httpOnly: cookie.httpOnly !== false, // Default to true if not explicitly false
                    // Add expires if available
                    // expires: cookie.expires ? new Date(cookie.expires) : undefined
                });

                // Set the cookie in the jar
                await this.ig.state.cookieJar.setCookie(
                    toughCookie.toString(),
                    `https://${toughCookie.domain}${toughCookie.path}`
                );
                cookiesLoaded++;
            } catch (cookieProcessError) {
                 logger.warn(`⚠️ Error processing cookie ${cookie.name}:`, cookieProcessError.message);
                 // Continue with other cookies
            }
        }
        logger.info(`🍪 Successfully loaded ${cookiesLoaded}/${cookiesToLoad.length} cookies from ${sourceDescription}`);
        if (cookiesLoaded === 0) {
             throw new Error('No cookies could be successfully loaded and set.');
        }
    } else {
        // This case should ideally be caught by the throw above
        throw new Error('No cookies available to load.');
    }
  }


  /**
   * Save cookies/state to file (Adapted from OriginalInstagramBot.js logic within login)
   * This is now primarily handled within the main login flow after successful auth.
   * Keeping this method for potential future use or manual saving.
   * @returns {Promise<void>}
   * @private
   */
  async _saveCookies() {
    try {
      const state = await this.ig.state.serialize(); // includes cookies, device, etc.
      // Ensure directory exists
      const dir = path.dirname(this.options.sessionPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      await fsPromises.writeFile(this.options.sessionPath, JSON.stringify(state, null, 2));
      logger.info(`🍪 Saved cookies and state to ${this.options.sessionPath}`);
    } catch (saveError) {
       logger.error(`❌ Error saving cookies/state to ${this.options.sessionPath}:`, saveError.message);
       logger.debug('Save cookies error stack:', saveError.stack);
       // Don't throw, as this is usually a non-fatal error
    }
  }

  /**
   * Get client statistics
   * @returns {Object}
   */
  getStats() {
    return {
      ready: this.ready,
      loggedIn: this.loggedIn, // Added loggedIn state
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
      loggedIn: this.loggedIn, // Added loggedIn state
      running: this.running,
      userId: this.user?.id,
      username: this.user?.username,
      stats: this.getStats()
    };
  }
}

export default InstagramClient;
