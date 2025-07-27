import { withRealtime, withFbns, withFbnsAndRealtime } from 'instagram_mqtt';
import { IgApiClient } from 'instagram-private-api';
import { EventEmitter } from 'events';
import Collection from './structures/Collection.js'; // Add .js extension for local modules in ESM

import {
  existsSync,
  readFileSync,
  writeFileSync,
  promises as fsPromises
} from 'fs';

import tough from 'tough-cookie'; // Default import (depends on the package export style)

import ClientUser from './structures/ClientUser.js';
import Message from './structures/Message.js';
import Chat from './structures/Chat.js';
import User from './structures/User.js';
import Util from './utils/utils.js'; // If utils exports multiple named exports

/**
 * Enhanced Instagram client with improved functionality
 * @extends {EventEmitter}
 */
class Client extends EventEmitter {
    /**
     * @typedef {object} ClientOptions
     * @property {boolean} disableReplyPrefix Whether the bot should disable user mention for the Message#reply() method
     * @property {string} sessionPath Path to save session data
     * @property {boolean} autoReconnect Whether to automatically reconnect on disconnect
     * @property {number} maxRetries Maximum number of reconnection attempts
     */
    /**
     * @param {ClientOptions} options
     */
    constructor(options = {}) {
        super();
        /**
         * @type {?ClientUser}
         * The bot's user object.
         */
        this.user = null;
        /**
         * @type {?IgApiClient}
         * @private
         */
        this.ig = null;
        /**
         * @type {boolean}
         * Whether the bot is connected and ready.
         */
        this.ready = false;
        /**
         * @type {ClientOptions}
         * The options for the client.
         */
        this.options = {
            disableReplyPrefix: false,
            sessionPath: './session.json',
            autoReconnect: true,
            maxRetries: 3,
            ...options
        };
        /**
         * @typedef {Object} Cache
         * @property {Collection<string, Message>} messages The bot's messages cache.
         * @property {Collection<string, User>} users The bot's users cache.
         * @property {Collection<string, Chat>} chats The bot's chats cache.
         * @property {Collection<string, Chat>} pendingChats The bot's pending chats cache.
         */
        /**
         * @type {Cache}
         * The bot's cache.
         */
        this.cache = {
            messages: new Collection(),
            users: new Collection(),
            chats: new Collection(),
            pendingChats: new Collection()
        };
        /**
         * @type {...any[]}
         */
        this.eventsToReplay = [];
        /**
         * @type {number}
         * @private
         */
        this._retryCount = 0;
    }

    /**
     * Load cookies from a JSON file (similar to your original InstagramBot logic)
     * @private
     * @param {string} path Path to the cookies.json file
     * @returns {Promise<void>}
     */
    async _loadCookiesFromJson(path = './cookies.json') {
        try {
            const raw = await fsPromises.readFile(path, 'utf-8');
            const cookies = JSON.parse(raw);
            let cookiesLoaded = 0;
            for (const cookie of cookies) {
                const toughCookie = new tough.Cookie({
                    key: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain.replace(/^\./, ''),
                    path: cookie.path || '/',
                    secure: cookie.secure !== false,
                    httpOnly: cookie.httpOnly !== false,
                });
                await this.ig.state.cookieJar.setCookie(
                    toughCookie.toString(),
                    `https://${toughCookie.domain}${toughCookie.path}`
                );
                cookiesLoaded++;
            }
            console.log(`[INFO] [Client] 🍪 Successfully loaded ${cookiesLoaded}/${cookies.length} cookies from file`);
        } catch (error) {
            console.error(`[ERROR] [Client] ❌ Critical error loading cookies from ${path}:`, error.message);
            throw error; // Re-throw to stop the login process
        }
    }

    /**
     * Create a new user or patch the cache one with the payload
     * @private
     * @param {string} userID The ID of the user to patch
     * @param {object} userPayload The data of the user
     * @returns {User}
     */
    _patchOrCreateUser(userID, userPayload) {
        if (this.cache.users.has(userID)) {
            this.cache.users.get(userID)._patch(userPayload);
        } else {
            this.cache.users.set(userID, new User(this, userPayload));
        }
        return this.cache.users.get(userID);
    }

    /**
     * Create a message object
     * @private
     * @param {string} chatID The ID of the chat
     * @param {object} messageData The message data
     * @returns {Message}
     */
    _createMessage(chatID, messageData) {
        const message = new Message(this, chatID, messageData);
        this.cache.messages.set(message.id, message);
        return message;
    }

    /**
     * Create a chat (or return the existing one) between one (a dm chat) or multiple users (a group).
     * @param {string[]} userIDs The users to include in the group
     * @returns {Promise<Chat>} The created chat
     */
    async createChat(userIDs) {
        const threadPayload = await this.ig.direct.createGroupThread(userIDs);
        const chat = new Chat(this, threadPayload.thread_id, threadPayload);
        this.cache.chats.set(chat.id, chat);
        return chat;
    }

    /**
     * Fetch a chat and cache it.
     * @param {string} chatID The ID of the chat to fetch.
     * @param {boolean} [force=false] Whether the cache should be ignored
     * @returns {Promise<Chat>}
     */
    async fetchChat(chatID, force = false) {
        if (!this.cache.chats.has(chatID) || force) {
            const { thread: chatPayload } = await this.ig.feed.directThread({ thread_id: chatID }).request();
            if (!this.cache.chats.has(chatID)) {
                const chat = new Chat(this, chatID, chatPayload);
                this.cache.chats.set(chatID, chat);
            } else {
                this.cache.chats.get(chatID)._patch(chatPayload);
            }
        }
        return this.cache.chats.get(chatID);
    }

    /**
     * Fetch a user and cache it.
     * @param {string} query The ID or the username of the user to fetch.
     * @param {boolean} [force=false] Whether the cache should be ignored
     * @returns {Promise<User>}
     */
    async fetchUser(query, force = false) {
        const userID = Util.isID(query) ? query : await this.ig.user.getIdByUsername(query);
        if (!this.cache.users.has(userID) || force) {
            const userPayload = await this.ig.user.info(userID);
            this._patchOrCreateUser(userID, userPayload);
        }
        return this.cache.users.get(userID);
    }

    /**
     * Handle Realtime messages
     * @param {object} topic
     * @param {object} payload
     * @private
     */
    handleRealtimeReceive(topic, payload) {
        if (!this.ready) {
            this.eventsToReplay.push([
                'realtime',
                topic,
                payload
            ]);
            return;
        }
        this.emit('rawRealtime', topic, payload);
        if (topic.id === '146') {
            const rawMessages = JSON.parse(payload);
            rawMessages.forEach(async (rawMessage) => {
                rawMessage.data.forEach((data) => {
                    // Emit right event
                    switch (data.op) {
                        case 'replace': {
                            const isInboxThreadPath = Util.matchInboxThreadPath(data.path, false);
                            if (isInboxThreadPath) {
                                const [threadID] = Util.matchInboxThreadPath(data.path, true);
                                if (this.cache.chats.has(threadID)) {
                                    const chat = this.cache.chats.get(threadID);
                                    const oldChat = Object.assign(Object.create(chat), chat);
                                    this.cache.chats.get(threadID)._patch(JSON.parse(data.value));
                                    /* Compare name */
                                    if (oldChat.name !== chat.name) {
                                        this.emit('chatNameUpdate', chat, oldChat.name, chat.name);
                                    }
                                    /* Compare users */
                                    if (oldChat.users.size < chat.users.size) {
                                        const userAdded = chat.users.find((u) => !oldChat.users.has(u.id));
                                        if (userAdded) this.emit('chatUserAdd', chat, userAdded);
                                    } else if (oldChat.users.size > chat.users.size) {
                                        const userRemoved = oldChat.users.find((u) => !chat.users.has(u.id));
                                        if (userRemoved) this.emit('chatUserRemove', chat, userRemoved);
                                    }
                                    /* Compare calling status */
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
                                this.fetchChat(threadID).then((chat) => {
                                    const messagePayload = JSON.parse(data.value);
                                    if (chat.messages.has(messagePayload.item_id)) {
                                        const message = chat.messages.get(messagePayload.item_id);
                                        const oldMessage = Object.assign(Object.create(message), message);
                                        chat.messages.get(messagePayload.item_id)._patch(messagePayload);
                                        /* Compare likes */
                                        if (oldMessage.likes.length > message.likes.length) {
                                            const removed = oldMessage.likes.find((like) => !message.likes.some((l) => l.userID === like.userID));
                                            this.fetchUser(removed.userID).then((user) => {
                                                if (removed) this.emit('likeRemove', user, message);
                                            });
                                        } else if (message.likes.length > oldMessage.likes.length) {
                                            const added = message.likes.find((like) => !oldMessage.likes.some((l) => l.userID === like.userID));
                                            if (added) {
                                                this.fetchUser(added.userID).then((user) => {
                                                    this.emit('likeAdd', user, message);
                                                });
                                            }
                                        }
                                    }
                                });
                            }
                            break;
                        }
                        case 'add': {
                            const isAdminPath = Util.matchAdminPath(data.path, false);
                            if (isAdminPath) {
                                const [threadID, userID] = Util.matchAdminPath(data.path, true);
                                this.fetchChat(threadID).then((chat) => {
                                    // Mark the user as an admin
                                    chat.adminUserIDs.push(userID);
                                    this.fetchUser(userID).then((user) => {
                                        this.emit('chatAdminAdd', chat, user);
                                    });
                                });
                                return;
                            }
                            const isMessagePath = Util.matchMessagePath(data.path, false);
                            if (isMessagePath) {
                                const [threadID] = Util.matchMessagePath(data.path, true);
                                this.fetchChat(threadID).then((chat) => {
                                    // Create a new message
                                    const messagePayload = JSON.parse(data.value);
                                    if (messagePayload.item_type === 'action_log' || messagePayload.item_type === 'video_call_event') return;
                                    const message = this._createMessage(threadID, messagePayload);
                                    chat.messages.set(message.id, message);
                                    if (Util.isMessageValid(message)) this.emit('messageCreate', message);
                                });
                            }
                            break;
                        }
                        case 'remove': {
                            const isAdminPath = Util.matchAdminPath(data.path, false);
                            if (isAdminPath) {
                                const [threadID, userID] = Util.matchAdminPath(data.path, true);
                                this.fetchChat(threadID).then((chat) => {
                                    // Remove the user from the administrators
                                    chat.adminUserIDs = chat.adminUserIDs.filter(id => id !== userID);
                                    this.fetchUser(userID).then((user) => {
                                        this.emit('chatAdminRemove', chat, user);
                                    });
                                });
                                return;
                            }
                            const isMessagePath = Util.matchMessagePath(data.path, false);
                            if (isMessagePath) {
                                const [threadID] = Util.matchMessagePath(data.path, true);
                                this.fetchChat(threadID).then((chat) => {
                                    // Emit message delete event
                                    const messageID = data.value;
                                    const existing = chat.messages.get(messageID);
                                    if (existing) this.emit('messageDelete', existing);
                                });
                            }
                            break;
                        }
                        default:
                            break;
                    }
                });
            });
        }
    }

    /**
     * Handle FBNS messages
     * @param {object} data
     * @private
     */
    async handleFbnsReceive(data) {
        if (!this.ready) {
            this.eventsToReplay.push([
                'fbns',
                data
            ]);
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
     * Log the bot out from Instagram
     * @returns {Promise<void>}
     */
    async logout() {
        try {
            await this.ig.account.logout();
        } catch (logoutError) {
            console.error('[WARN] [Client] Error during account logout:', logoutError.message);
        }
        try {
            if (this.ig.realtime) await this.ig.realtime.disconnect();
        } catch (rtError) {
            console.error('[WARN] [Client] Error during realtime disconnect:', rtError.message);
        }
        try {
            if (this.ig.fbns) await this.ig.fbns.disconnect();
        } catch (fbnsError) {
            console.error('[WARN] [Client] Error during FBNS disconnect:', fbnsError.message);
        }
        this.ready = false;
        this.emit('disconnect');
        console.log('[INFO] [Client] 🚪 Logged out and disconnected successfully.');
    }

    /**
     * Log the bot in to Instagram
     * @param {string} username The username of the Instagram account.
     * @param {string} password The password of the Instagram account (can be dummy if using cookies).
     */
    async login(username, password) {
        const ig = withFbnsAndRealtime(new IgApiClient());
        ig.state.generateDevice(username);
        let loginSuccess = false;

        // --- MODIFIED LOGIN LOGIC: Prioritize cookies.json ---
        try {
            // 1. Try loading from cookies.json first
            await fsPromises.access('./cookies.json');
            console.log('[INFO] [Client] 📂 Attempting login using cookies.json...');
            await this._loadCookiesFromJson('./cookies.json');

            try {
                const currentUserResponse = await ig.account.currentUser(); // Validate cookies
                console.log(`[INFO] [Client] ✅ Logged in using cookies.json as @${currentUserResponse.username}`);
                loginSuccess = true;

                // Save session after successful cookie login (like your original bot)
                const session = await ig.state.serialize();
                delete session.constants;
                await fsPromises.writeFile(this.options.sessionPath, JSON.stringify(session, null, 2));
                console.log(`[INFO] [Client] 💾 session.json saved from cookie-based login to ${this.options.sessionPath}`);

            } catch (cookieValidationError) {
                console.error('[WARN] [Client] ⚠️ Cookie validation failed:', cookieValidationError.message);
                // Fall through to session or username/password login
            }

        } catch (cookieAccessError) {
            console.log('[INFO] [Client] 📂 cookies.json not found or invalid, trying session.json or username/password...', cookieAccessError?.message);
            // Fall through to session or username/password login
        }

        // 2. If cookies failed, try session.json
        if (!loginSuccess) {
            try {
                if (existsSync(this.options.sessionPath)) {
                    try {
                        console.log(`[INFO] [Client] 📂 Found ${this.options.sessionPath}, trying to login from session...`);
                        const sessionData = JSON.parse(readFileSync(this.options.sessionPath, 'utf-8'));
                        await ig.state.deserialize(sessionData);
                        await ig.account.currentUser(); // Validate session
                        console.log('[INFO] [Client] ✅ Logged in from session');
                        loginSuccess = true;
                    } catch (sessionError) {
                         console.error('[WARN] [Client] ⚠️ Session invalid or validation failed:', sessionError.message);
                         // Fall through to username/password login
                    }
                }
            } catch (sessionAccessError) {
                 console.log(`[INFO] [Client] 📂 ${this.options.sessionPath} not found or invalid, trying username/password...`, sessionAccessError?.message);
                 // Fall through to username/password login
            }
        }

        // 3. If all else fails, use username/password (might trigger challenges)
        if (!loginSuccess) {
             console.log('[INFO] [Client] 🔐 Attempting login using username/password...');
             await ig.account.login(username, password);
             // Save session
             const state = await ig.state.serialize();
             delete state.constants;
             writeFileSync(this.options.sessionPath, JSON.stringify(state, null, 2));
             console.log(`[INFO] [Client] 💾 session.json saved from username/password login to ${this.options.sessionPath}`);
             loginSuccess = true; // Assume success after login call
        }

        if (!loginSuccess) {
            throw new Error('[Client] ❌ No valid login method succeeded (cookies, session, or username/password).');
        }
        // --- END MODIFIED LOGIN LOGIC ---

        // Fetch user data and set up caches
        const response = await ig.user.usernameinfo(username);
        const userData = await ig.user.info(response.pk);
        this.user = new ClientUser(this, {
            ...response,
            ...userData
        });
        this.cache.users.set(this.user.id, this.user);
        this.emit('debug', 'logged', this.user);

        // Load chats (inbox and pending)
        try {
            const inboxThreads = await ig.feed.directInbox().items();
            const pendingThreads = await ig.feed.directPending().items();
            const threads = [...inboxThreads, ...pendingThreads];
            threads.forEach((thread) => {
                const chat = new Chat(this, thread.thread_id, thread);
                this.cache.chats.set(thread.thread_id, chat);
                if (chat.pending) {
                    this.cache.pendingChats.set(thread.thread_id, chat);
                }
            });
             console.log(`[INFO] [Client] 📬 Loaded ${threads.length} chats (${pendingThreads.length} pending) into cache.`);
        } catch (chatLoadError) {
             console.error('[WARN] [Client] ⚠️ Error loading initial chats into cache:', chatLoadError.message);
             // Continue, cache will populate via events
        }

        // Setup realtime handlers
        ig.realtime.on('receive', (topic, messages) => this.handleRealtimeReceive(topic, messages));
        ig.realtime.on('error', (error) => {
            console.error('[ERROR] [Client] 🚨 Realtime error:', error);
            this.emit('error', error);
            if (this.options.autoReconnect && this._retryCount < this.options.maxRetries) {
                this._attemptReconnect();
            }
        });
        ig.realtime.on('close', () => {
            console.log('[WARN] [Client] 🔌 RealtimeClient closed');
            this.emit('disconnect');
            if (this.options.autoReconnect && this._retryCount < this.options.maxRetries) {
                this._attemptReconnect();
            }
        });
        // Connect to Realtime
        try {
             await ig.realtime.connect({
                autoReconnect: this.options.autoReconnect,
                irisData: await ig.feed.directInbox().request()
            });
             console.log('[INFO] [Client] 📡 Instagram Realtime connected successfully');
        } catch (realtimeConnectError) {
             console.error('[ERROR] [Client] ❌ Failed to connect to Instagram Realtime:', realtimeConnectError.message);
             throw realtimeConnectError; // Re-throw to potentially stop the client init
        }

        // Setup FBNS
        ig.fbns.push$.subscribe((data) => this.handleFbnsReceive(data));
        try {
            await ig.fbns.connect({
                autoReconnect: this.options.autoReconnect,
                // Pass irisData if needed, similar to Realtime connection
                irisData: await ig.feed.directInbox().request() // ADDED: Pass irisData
            });
             console.log('[INFO] [Client] 🔔 Instagram FBNS (Push Notifications) connected successfully');
        } catch (fbnsConnectError) {
             console.error('[WARN] [Client] ⚠️ Failed to connect to Instagram FBNS (Push Notifications):', fbnsConnectError.message);
             // Do not throw, allow client to run without FBNS if it fails
        }

        this.ig = ig;
        this.ready = true;
        this._retryCount = 0;
        this.emit('connected');
        console.log('[INFO] [Client] 🚀 Client is now ready and listening for events');

        // Replay events (if any were queued before ready)
        this.eventsToReplay.forEach((event) => {
            const eventType = event.shift();
            if (eventType === 'realtime') {
                this.handleRealtimeReceive(...event);
            } else if (eventType === 'fbns') {
                this.handleFbnsReceive(...event);
            }
        });
        this.eventsToReplay = [];
    }

    /**
     * Attempt to reconnect
     * @private
     */
    async _attemptReconnect() {
        this._retryCount++;
        console.log(`[INFO] [Client] 🔁 Attempting to reconnect (${this._retryCount}/${this.options.maxRetries})...`);
        const delay = Math.min(1000 * Math.pow(2, this._retryCount), 30000);
        setTimeout(async () => {
            try {
                await this.ig.realtime.connect({
                    autoReconnect: this.options.autoReconnect,
                    irisData: await this.ig.feed.directInbox().request()
                });
                this._retryCount = 0;
                this.emit('reconnected');
                console.log('[INFO] [Client] 🔗 Reconnected successfully.');
            } catch (error) {
                console.error('[ERROR] [Client] Reconnect failed:', error.message);
                if (this._retryCount >= this.options.maxRetries) {
                    this.emit('maxRetriesReached');
                    console.error('[ERROR] [Client] Maximum reconnection retries reached. Client likely stopped.');
                }
            }
        }, delay);
    }

    toJSON() {
        const json = {
            ready: this.ready,
            options: this.options,
            id: this.user?.id
        };
        return json;
    }
}

export default Client;
