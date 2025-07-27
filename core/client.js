import { IgApiClient } from 'instagram-private-api';
import { withFbnsAndRealtime } from 'instagram_mqtt';
import { EventEmitter } from 'events';
import { promises as fsPromises } from 'fs';
import fs from 'fs';
import tough from 'tough-cookie';
import { Collection } from '@discordjs/collection';
import User from '../utils/User.js';
import Chat from '../utils/Chat.js';
import Message from '../utils/Message.js';
import { logger } from '../utils/utils.js';
import path from 'path';
import camelcaseKeys from 'camelcase-keys';
import Util from '../utils/Util.js';

/**
 * Enhanced Instagram client with rich object support
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
      sessionPath: './session/session.json',
      messageCheckInterval: 5000,
      maxRetries: 3,
      autoReconnect: true,
      ...options
    };

    /**
     * Instagram API client
     * @type {IgApiClient}
     */
    this.ig = withFbnsAndRealtime(new IgApiClient());

    /**
     * Bot user object
     * @type {User|null}
     */
    this.user = null;

    /**
     * Whether the client is ready
     * @type {boolean}
     */
    this.ready = false;

    /**
     * Whether the client is running
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
     * Last message check timestamp
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
  }

  /**
   * Login to Instagram
   * @param {string} username - Instagram username
   * @param {string} password - Instagram password
   * @returns {Promise<void>}
   */
  async login(username, password) {
    try {
      logger.info('🔑 Logging into Instagram...');

      this.ig.state.generateDevice(username);

      // Try to load cookies first
      try {
        await this._loadCookies();
        await this.ig.account.currentUser();
        logger.info('✅ Logged in using saved cookies');
      } catch (error) {
        if (!password) {
          throw new Error('❌ Password required for fresh login');
        }

        logger.info('🔑 Attempting fresh login...');
        await this.ig.account.login(username, password);
        await this._saveCookies();
        logger.info('✅ Fresh login successful');
      }

      // Get user info
      const response = await this.ig.user.usernameinfo(username);
      const userData = await this.ig.user.info(response.pk);
      this.user = this._patchOrCreateUser(response.pk, { ...response, ...userData });
      this.cache.users.set(this.user.id, this.user);
      this.emit('debug', 'logged', this.user);

      // Load existing chats
      await this._loadChats();

      // Setup handlers
      this._setupRealtimeHandlers();
      this._setupFbnsHandlers();

      // Connect to Realtime
      await this.ig.realtime.connect({
        autoReconnect: this.options.autoReconnect,
        irisData: await this.ig.feed.directInbox().request()
      });

      // Connect to FBNS
      await this.ig.fbns.connect({
        autoReconnect: this.options.autoReconnect
      });

      this.ready = true;
      this.running = true;
      this._retryCount = 0;

      logger.info(`✅ Connected as @${this.user.username} (ID: ${this.user.id})`);
      this.emit('connected');
      this.emit('ready');

      // Replay queued events
      this._replayEvents();
    } catch (error) {
      logger.error('❌ Login failed:', error.message);
      this.emit('error', error);
      throw error;
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

    try {
      await this.ig.account.logout();
      await this.ig.realtime.disconnect();
      await this.ig.fbns.disconnect();
      logger.info('✅ Disconnected successfully');
    } catch (error) {
      logger.warn('⚠️ Error during disconnect:', error.message);
      this.emit('error', error);
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
    const userId = Util.isID(query) ? query : await this.ig.user.getIdByUsername(query);

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
      this.emit('error', error);
    }
  }

  /**
   * Setup Realtime event handlers
   * @private
   */
  _setupRealtimeHandlers() {
    logger.info('📡 Setting up Realtime handlers...');

    this.ig.realtime.on('receive', (topic, payload) => {
      this.handleRealtimeReceive(topic, payload);
    });

    this.ig.realtime.on('error', (error) => {
      logger.error('🚨 Realtime error:', error.message);
      this.emit('error', error);
      if (this.options.autoReconnect && this._retryCount < this.options.maxRetries) {
        this._attemptReconnect();
      }
    });

    this.ig.realtime.on('close', () => {
      logger.warn('🔌 Realtime connection closed');
      this.emit('disconnect');
      if (this.running && this.options.autoReconnect) {
        this._attemptReconnect();
      }
    });

    this.ig.realtime.on('receive', (topic, messages) => {
      const topicStr = String(topic || '');
      if (topicStr.includes('direct') || topicStr.includes('message')) {
        logger.debug(`📥 Realtime receive: ${topicStr}`);
      }
    });
  }

  /**
   * Setup FBNS event handlers
   * @private
   */
  _setupFbnsHandlers() {
    logger.info('📡 Setting up FBNS handlers...');

    this.ig.fbns.push$.subscribe((data) => this.handleFbnsReceive(data));
  }

  /**
   * Handle Realtime messages
   * @param {Object} topic
   * @param {Object} payload
   * @private
   */
  async handleRealtimeReceive(topic, payload) {
    if (!this.ready) {
      this._eventsToReplay.push(['realtime', topic, payload]);
      return;
    }

    this.emit('rawRealtime', topic, payload);

    if (topic.id === '146') {
      const rawMessages = JSON.parse(payload);
      rawMessages.forEach(async (rawMessage) => {
        rawMessage.data.forEach((data) => {
          switch (data.op) {
            case 'replace': {
              const isInboxThreadPath = Util.matchInboxThreadPath(data.path, false);
              if (isInboxThreadPath) {
                const [threadID] = Util.matchInboxThreadPath(data.path, true);
                if (this.cache.chats.has(threadID)) {
                  const chat = this.cache.chats.get(threadID);
                  const oldChat = Object.assign(Object.create(chat), chat);
                  chat._patch(JSON.parse(data.value));

                  if (oldChat.name !== chat.name) {
                    this.emit('chatNameUpdate', chat, oldChat.name, chat.name);
                  }

                  if (oldChat.users.size < chat.users.size) {
                    const userAdded = chat.users.find((u) => !oldChat.users.has(u.id));
                    if (userAdded) this.emit('chatUserAdd', chat, userAdded);
                  } else if (oldChat.users.size > chat.users.size) {
                    const userRemoved = oldChat.users.find((u) => !chat.users.has(u.id));
                    if (userRemoved) this.emit('chatUserRemove', chat, userRemoved);
                  }

                  if (!oldChat.calling && chat.calling) {
                    this.emit('callStart', chat);
                  } else if (oldChat.calling && !chat.calling) {
                    this.emit('callEnd', chat);
                  }
                } else {
                  const chat = new Chat(this, threadID, JSON.parse(data.value));
                  this.cache.chats.set(chat.id, chat);
                }
                return;
              }

              const isMessagePath = Util.matchMessagePath(data.path, false);
              if (isMessagePath) {
                const [threadID] = Util.matchMessagePath(data.path, true);
                const chat = await this.fetchChat(threadID);
                const messagePayload = JSON.parse(data.value);
                if (chat.messages.has(messagePayload.item_id)) {
                  const message = chat.messages.get(messagePayload.item_id);
                  const oldMessage = Object.assign(Object.create(message), message);
                  message._patch(messagePayload);

                  if (oldMessage.likes.length > message.likes.length) {
                    const removed = oldMessage.likes.find(
                      (like) => !message.likes.some((l) => l.userID === like.userID)
                    );
                    if (removed) {
                      const user = await this.fetchUser(removed.userID);
                      this.emit('likeRemove', user, message);
                    }
                  } else if (message.likes.length > oldMessage.likes.length) {
                    const added = message.likes.find(
                      (like) => !oldMessage.likes.some((l) => l.userID === like.userID)
                    );
                    if (added) {
                      const user = await this.fetchUser(added.userID);
                      this.emit('likeAdd', user, message);
                    }
                  }
                }
              }
              break;
            }

            case 'add': {
              const isAdminPath = Util.matchAdminPath(data.path, false);
              if (isAdminPath) {
                const [threadID, userID] = Util.matchAdminPath(data.path, true);
                const chat = await this.fetchChat(threadID);
                chat.adminUserIDs.push(userID);
                const user = await this.fetchUser(userID);
                this.emit('chatAdminAdd', chat, user);
                return;
              }

              const isMessagePath = Util.matchMessagePath(data.path, false);
              if (isMessagePath) {
                const [threadID] = Util.matchMessagePath(data.path, true);
                const chat = await this.fetchChat(threadID);
                const messagePayload = JSON.parse(data.value);
                const message = this._createMessage(threadID, messagePayload);
                chat.messages.set(message.id, message);
                if (Util.isMessageValid(message)) {
                  this.emit('messageCreate', message);
                  if (message.fromBot) {
                    this.emit('messageSent', message);
                  } else {
                    this.emit('messageReceived', message);
                  }
                }
              }
              break;
            }

            case 'remove': {
              const isAdminPath = Util.matchAdminPath(data.path, false);
              if (isAdminPath) {
                const [threadID, userID] = Util.matchAdminPath(data.path, true);
                const chat = await this.fetchChat(threadID);
                chat.adminUserIDs = chat.adminUserIDs.filter((id) => id !== userID);
                const user = await this.fetchUser(userID);
                this.emit('chatAdminRemove', chat, user);
                return;
              }

              const isMessagePath = Util.matchMessagePath(data.path, false);
              if (isMessagePath) {
                const [threadID] = Util.matchMessagePath(data.path, true);
                const chat = await this.fetchChat(threadID);
                const messageID = data.value;
                const existing = chat.messages.get(messageID);
                if (existing) {
                  chat.messages.delete(messageID);
                  this.cache.messages.delete(messageID);
                  this.emit('messageDelete', existing);
                }
              }
              break;
            }
          }
        });
      });
    }
  }

  /**
   * Handle FBNS messages
   * @param {Object} data
   * @private
   */
  async handleFbnsReceive(data) {
    if (!this.ready) {
      this._eventsToReplay.push(['fbns', data]);
      return;
    }

    this.emit('rawFbns', data);

    if (data.pushCategory === 'new_follower') {
      const user = await this.fetchUser(data.sourceUserId);
      this.emit('newFollower', user);
    }

    if (data.pushCategory === 'private_user_follow_request') {
      const user = await this.fetchUser(data.sourceUserId);
      this.emit('followRequest', user);
    }

    if (data.pushCategory === 'direct_v2_pending') {
      if (!this.cache.pendingChats.get(data.actionParams.id)) {
        const pendingRequests = await this.ig.feed.directPending().items();
        pendingRequests.forEach((thread) => {
          const chat = new Chat(this, thread.thread_id, thread);
          this.cache.chats.set(thread.thread_id, chat);
          this.cache.pendingChats.set(thread.thread_id, chat);
        });
      }
      const pendingChat = this.cache.pendingChats.get(data.actionParams.id);
      if (pendingChat) {
        this.emit('pendingRequest', pendingChat);
      }
    }
  }

  /**
   * Check if message is new
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
      if (!this._isNewMessage(messageData)) return;

      const threadId = eventData.thread?.thread_id || messageData.thread_id;
      if (!threadId) return;

      let chat = this.cache.chats.get(threadId);
      if (!chat) {
        chat = await this.fetchChat(threadId);
      }

      const message = this._createMessage(threadId, messageData);
      chat.messages.set(message.id, message);

      if (Util.isMessageValid(message)) {
        this.emit('messageCreate', message);
        if (message.fromBot) {
          this.emit('messageSent', message);
        } else {
          this.emit('messageReceived', message);
        }
      }
    } catch (error) {
      logger.error('❌ Error handling message:', error.message);
      this.emit('error', error);
    }
  }

  /**
   * Attempt to reconnect
   * @private
   */
  async _attemptReconnect() {
    this._retryCount++;
    const delay = Math.min(1000 * Math.pow(2, this._retryCount), 30000);

    logger.info(`🔄 Attempting reconnect ${this._retryCount}/${this.options.maxRetries} in ${delay}ms...`);

    setTimeout(async () => {
      try {
        await this.ig.realtime.connect({
          autoReconnect: this.options.autoReconnect,
          irisData: await this.ig.feed.directInbox().request()
        });
        await this.ig.fbns.connect({
          autoReconnect: this.options.autoReconnect
        });
        this._retryCount = 0;
        logger.info('✅ Reconnected successfully');
      } catch (error) {
        logger.error('❌ Reconnect failed:', error.message);
        this.emit('error', error);
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
    for (const [eventType, ...args] of this._eventsToReplay) {
      if (eventType === 'realtime') {
        this.handleRealtimeReceive(...args);
      } else if (eventType === 'fbns') {
        this.handleFbnsReceive(...args);
      } else if (eventType === 'message' || eventType === 'direct') {
        this._handleMessage(args[0].message, args[0]);
      }
    }
    this._eventsToReplay = [];
  }

  /**
   * Load cookies from file
   * @returns {Promise<void>}
   * @private
   */
  async _loadCookies() {
    const cookiePath = this.options.sessionPath.replace('.json', '_cookies.json');

    if (!fs.existsSync(cookiePath)) {
      throw new Error('No cookies found');
    }

    const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));

    for (const cookie of cookies) {
      const toughCookie = new tough.Cookie({
        key: cookie.name,
        value: cookie.value,
        domain: cookie.domain.replace(/^\./, ''),
        path: cookie.path || '/',
        secure: cookie.secure !== false,
        httpOnly: cookie.httpOnly !== false
      });

      await this.ig.state.cookieJar.setCookie(
        toughCookie.toString(),
        `https://${toughCookie.domain}${toughCookie.path}`
      );
    }

    logger.info(`🍪 Loaded ${cookies.length} cookies`);
  }

  /**
   * Save cookies to file
   * @returns {Promise<void>}
   * @private
   */
  async _saveCookies() {
    const cookiePath = this.options.sessionPath.replace('.json', '_cookies.json');
    const cookies = await this.ig.state.cookieJar.getCookies('https://instagram.com');

    const cookieData = cookies.map(cookie => ({
      name: cookie.key,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly
    }));

    const dir = path.dirname(cookiePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(cookiePath, JSON.stringify(cookieData, null, 2));
    logger.info(`🍪 Saved ${cookieData.length} cookies`);
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
      lastMessageCheck: this.lastMessageCheck
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

/**
 * Emitted when a message is sent in a chat the bot is in
 * @event InstagramClient#messageCreate
 * @param {Message} message The message that was sent
 */

/**
 * Emitted when a message is deleted in a chat the bot is in
 * @event InstagramClient#messageDelete
 * @param {Message} message The message that was deleted
 */

/**
 * Emitted when a user adds a like to a message
 * @event InstagramClient#likeAdd
 * @param {User} user The user who added the like
 * @param {Message} message The message on which the like was added
 */

/**
 * Emitted when a user removes a like from a message
 * @event InstagramClient#likeRemove
 * @param {User} user The user who removed the like
 * @param {Message} message The message on which the like was removed
 */

/**
 * Emitted when someone starts following the bot
 * @event InstagramClient#newFollower
 * @param {User} user The user that started following the bot
 */

/**
 * Emitted when someone wants to follow the bot
 * @event InstagramClient#followRequest
 * @param {User} user The user who wants to follow the bot
 */

/**
 * Emitted when someone wants to send a message to the bot
 * @event InstagramClient#pendingRequest
 * @param {Chat} chat The chat that needs to be approved
 */

/**
 * Emitted when the name of a chat changes
 * @event InstagramClient#chatNameUpdate
 * @param {Chat} chat The chat whose name has changed
 * @param {string} oldName The previous name of the chat
 * @param {string} newName The new name of the chat
 */

/**
 * Emitted when a user is added to a chat
 * @event InstagramClient#chatUserAdd
 * @param {Chat} chat The chat in which the user has been added
 * @param {User} user The user who has been added
 */

/**
 * Emitted when a user is removed from a chat
 * @event InstagramClient#chatUserRemove
 * @param {Chat} chat The chat from which the user has been removed
 * @param {User} user The user who has been removed
 */

/**
 * Emitted when a user becomes an administrator in a chat
 * @event InstagramClient#chatAdminAdd
 * @param {Chat} chat The chat in which the user has become an administrator
 * @param {User} user The user who has become admin
 */

/**
 * Emitted when a user is removed as an administrator in a chat
 * @event InstagramClient#chatAdminRemove
 * @param {Chat} chat The chat in which the user has been removed as admin
 * @param {User} user The user who has been removed
 */

/**
 * Emitted when a call starts in a chat
 * @event InstagramClient#callStart
 * @param {Chat} chat The chat in which the call has started
 */

/**
 * Emitted when a call ends in a chat
 * @event InstagramClient#callEnd
 * @param {Chat} chat The chat in which the call has ended
 */

/**
 * Emitted when raw Realtime data is received
 * @event InstagramClient#rawRealtime
 * @param {Object} topic The topic data
 * @param {Object} payload The payload data
 */

/**
 * Emitted when raw FBNS data is received
 * @event InstagramClient#rawFbns
 * @param {Object} data The FBNS data
 */

/**
 * Emitted when the client connects
 * @event InstagramClient#connected
 */

/**
 * Emitted for debug messages
 * @event InstagramClient#debug
 * @param {string} type The debug message type
 * @param {...any} args Additional arguments
 */

/**
 * Emitted when the client is ready
 * @event InstagramClient#ready
 */

/**
 * Emitted when the client disconnects
 * @event InstagramClient#disconnect
 */

/**
 * Emitted on errors
 * @event InstagramClient#error
 * @param {Error} error The error object
 */

/**
 * Emitted when max reconnect attempts are reached
 * @event InstagramClient#maxRetriesReached
 */

/**
 * Emitted when a message is sent by the bot
 * @event InstagramClient#messageSent
 * @param {Message} message The message sent
 */

/**
 * Emitted when a message is received
 * @event InstagramClient#messageReceived
 * @param {Message} message The message received
 */
