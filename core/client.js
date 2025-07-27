import { withRealtime, withFbns, withFbnsAndRealtime } from 'instagram_mqtt';
import { IgApiClient } from 'instagram-private-api';
import { EventEmitter } from 'events';


import { existsSync, readFileSync, writeFileSync } from 'fs';
import Collection from './structures/Collection.js';
import ClientUser from './structures/ClientUser.js';
import Message from './structures/Message.js';
import Chat from './structures/Chat.js';
import User from './structures/User.js';
import Logger from '../utils/Util.js';


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
        super()
        
        /**
         * @type {?ClientUser}
         * The bot's user object.
         */
        this.user = null
        
        /**
         * @type {?IgApiClient}
         * @private
         */
        this.ig = null
        
        /**
         * @type {boolean}
         * Whether the bot is connected and ready.
         */
        this.ready = false
        
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
        }

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
        }

        /**
         * @type {...any[]}
         */
        this.eventsToReplay = []

        /**
         * @type {number}
         * @private
         */
        this._retryCount = 0
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
            this.cache.users.get(userID)._patch(userPayload)
        } else {
            this.cache.users.set(userID, new User(this, userPayload))
        }
        return this.cache.users.get(userID)
    }

    /**
     * Create a message object
     * @private
     * @param {string} chatID The ID of the chat
     * @param {object} messageData The message data
     * @returns {Message}
     */
    _createMessage(chatID, messageData) {
        const message = new Message(this, chatID, messageData)
        this.cache.messages.set(message.id, message)
        return message
    }

    /**
     * Create a chat (or return the existing one) between one (a dm chat) or multiple users (a group).
     * @param {string[]} userIDs The users to include in the group
     * @returns {Promise<Chat>} The created chat
     */
    async createChat(userIDs) {
        const threadPayload = await this.ig.direct.createGroupThread(userIDs)
        const chat = new Chat(this, threadPayload.thread_id, threadPayload)
        this.cache.chats.set(chat.id, chat)
        return chat
    }

    /**
     * Fetch a chat and cache it.
     * @param {string} chatID The ID of the chat to fetch.
     * @param {boolean} [force=false] Whether the cache should be ignored
     * @returns {Promise<Chat>}
     */
    async fetchChat(chatID, force = false) {
        if (!this.cache.chats.has(chatID) || force) {
            const { thread: chatPayload } = await this.ig.feed.directThread({ thread_id: chatID }).request()
            if (!this.cache.chats.has(chatID)) {
                const chat = new Chat(this, chatID, chatPayload)
                this.cache.chats.set(chatID, chat)
            } else {
                this.cache.chats.get(chatID)._patch(chatPayload)
            }
        }
        return this.cache.chats.get(chatID)
    }

    /**
     * Fetch a user and cache it.
     * @param {string} query The ID or the username of the user to fetch.
     * @param {boolean} [force=false] Whether the cache should be ignored
     * @returns {Promise<User>}
     */
    async fetchUser(query, force = false) {
        const userID = Util.isID(query) ? query : await this.ig.user.getIdByUsername(query)
        if (!this.cache.users.has(userID) || force) {
            const userPayload = await this.ig.user.info(userID)
            this._patchOrCreateUser(userID, userPayload)
        }
        return this.cache.users.get(userID)
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
            ])
            return
        }
        this.emit('rawRealtime', topic, payload)
        if (topic.id === '146') {
            const rawMessages = JSON.parse(payload)
            rawMessages.forEach(async (rawMessage) => {
                rawMessage.data.forEach((data) => {
                    // Emit right event
                    switch (data.op) {
                        case 'replace': {
                            const isInboxThreadPath = Util.matchInboxThreadPath(data.path, false)
                            if (isInboxThreadPath) {
                                const [threadID] = Util.matchInboxThreadPath(data.path, true)
                                if (this.cache.chats.has(threadID)) {
                                    const chat = this.cache.chats.get(threadID)
                                    const oldChat = Object.assign(Object.create(chat), chat)
                                    this.cache.chats.get(threadID)._patch(JSON.parse(data.value))

                                    /* Compare name */
                                    if (oldChat.name !== chat.name) {
                                        this.emit('chatNameUpdate', chat, oldChat.name, chat.name)
                                    }

                                    /* Compare users */
                                    if (oldChat.users.size < chat.users.size) {
                                        const userAdded = chat.users.find((u) => !oldChat.users.has(u.id))
                                        if (userAdded) this.emit('chatUserAdd', chat, userAdded)
                                    } else if (oldChat.users.size > chat.users.size) {
                                        const userRemoved = oldChat.users.find((u) => !chat.users.has(u.id))
                                        if (userRemoved) this.emit('chatUserRemove', chat, userRemoved)
                                    }

                                    /* Compare calling status */
                                    if (!oldChat.calling && chat.calling) {
                                        this.emit('callStart', chat)
                                    } else if (oldChat.calling && !chat.calling) {
                                        this.emit('callEnd', chat)
                                    }
                                } else {
                                    const chat = new Chat(this, threadID, JSON.parse(data.value))
                                    this.cache.chats.set(chat.id, chat)
                                }
                                return
                            }
                            const isMessagePath = Util.matchMessagePath(data.path, false)
                            if (isMessagePath) {
                                const [threadID] = Util.matchMessagePath(data.path, true)
                                this.fetchChat(threadID).then((chat) => {
                                    const messagePayload = JSON.parse(data.value)
                                    if (chat.messages.has(messagePayload.item_id)) {
                                        const message = chat.messages.get(messagePayload.item_id)
                                        const oldMessage = Object.assign(Object.create(message), message)
                                        chat.messages.get(messagePayload.item_id)._patch(messagePayload)

                                        /* Compare likes */
                                        if (oldMessage.likes.length > message.likes.length) {
                                            const removed = oldMessage.likes.find((like) => !message.likes.some((l) => l.userID === like.userID))
                                            this.fetchUser(removed.userID).then((user) => {
                                                if (removed) this.emit('likeRemove', user, message)
                                            })
                                        } else if (message.likes.length > oldMessage.likes.length) {
                                            const added = message.likes.find((like) => !oldMessage.likes.some((l) => l.userID === like.userID))
                                            if (added) {
                                                this.fetchUser(added.userID).then((user) => {
                                                    this.emit('likeAdd', user, message)
                                                })
                                            }
                                        }
                                    }
                                })
                            }
                            break
                        }

                        case 'add': {
                            const isAdminPath = Util.matchAdminPath(data.path, false)
                            if (isAdminPath) {
                                const [threadID, userID] = Util.matchAdminPath(data.path, true)
                                this.fetchChat(threadID).then((chat) => {
                                    // Mark the user as an admin
                                    chat.adminUserIDs.push(userID)
                                    this.fetchUser(userID).then((user) => {
                                        this.emit('chatAdminAdd', chat, user)
                                    })
                                })
                                return
                            }
                            const isMessagePath = Util.matchMessagePath(data.path, false)
                            if (isMessagePath) {
                                const [threadID] = Util.matchMessagePath(data.path, true)
                                this.fetchChat(threadID).then((chat) => {
                                    // Create a new message
                                    const messagePayload = JSON.parse(data.value)
                                    if (messagePayload.item_type === 'action_log' || messagePayload.item_type === 'video_call_event') return
                                    const message = this._createMessage(threadID, messagePayload)
                                    chat.messages.set(message.id, message)
                                    if (Util.isMessageValid(message)) this.emit('messageCreate', message)
                                })
                            }
                            break
                        }

                        case 'remove': {
                            const isAdminPath = Util.matchAdminPath(data.path, false)
                            if (isAdminPath) {
                                const [threadID, userID] = Util.matchAdminPath(data.path, true)
                                this.fetchChat(threadID).then((chat) => {
                                    // Remove the user from the administrators
                                    chat.adminUserIDs = chat.adminUserIDs.filter(id => id !== userID)
                                    this.fetchUser(userID).then((user) => {
                                        this.emit('chatAdminRemove', chat, user)
                                    })
                                })
                                return
                            }
                            const isMessagePath = Util.matchMessagePath(data.path, false)
                            if (isMessagePath) {
                                const [threadID] = Util.matchMessagePath(data.path, true)
                                this.fetchChat(threadID).then((chat) => {
                                    // Emit message delete event
                                    const messageID = data.value
                                    const existing = chat.messages.get(messageID)
                                    if (existing) this.emit('messageDelete', existing)
                                })
                            }
                            break
                        }

                        default:
                            break
                    }
                })
            })
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
            ])
            return
        }
        this.emit('rawFbns', data)
        if (data.pushCategory === 'new_follower') {
            const user = await this.fetchUser(data.sourceUserId)
            this.emit('newFollower', user)
        }
        if (data.pushCategory === 'private_user_follow_request') {
            const user = await this.fetchUser(data.sourceUserId)
            this.emit('followRequest', user)
        }
        if (data.pushCategory === 'direct_v2_pending') {
            if (!this.cache.pendingChats.get(data.actionParams.id)) {
                const pendingRequests = await this.ig.feed.directPending().items()
                pendingRequests.forEach((thread) => {
                    const chat = new Chat(this, thread.thread_id, thread)
                    this.cache.chats.set(thread.thread_id, chat)
                    this.cache.pendingChats.set(thread.thread_id, chat)
                })
            }
            const pendingChat = this.cache.pendingChats.get(data.actionParams.id)
            if (pendingChat) {
                this.emit('pendingRequest', pendingChat)
            }
        }
    }

    /**
     * Log the bot out from Instagram
     * @returns {Promise<void>}
     */
    async logout() {
        await this.ig.account.logout()
        if (this.ig.realtime) await this.ig.realtime.disconnect()
        if (this.ig.fbns) await this.ig.fbns.disconnect()
        this.ready = false
        this.emit('disconnect')
    }

    /**
     * Log the bot in to Instagram
     * @param {string} username The username of the Instagram account.
     * @param {string} password The password of the Instagram account.
     */
    async login(username, password) {
        const ig = withFbnsAndRealtime(new IgApiClient())
        ig.state.generateDevice(username)

        // Try to load session first
        if (existsSync(this.options.sessionPath)) {
            try {
                const sessionData = JSON.parse(readFileSync(this.options.sessionPath, 'utf-8'))
                await ig.state.deserialize(sessionData)
                await ig.account.currentUser()
                this.emit('debug', 'Logged in from session')
            } catch (error) {
                this.emit('debug', 'Session invalid, logging in with credentials')
                await ig.account.login(username, password)
                // Save session
                const state = await ig.state.serialize()
                delete state.constants
                writeFileSync(this.options.sessionPath, JSON.stringify(state, null, 2))
            }
        } else {
            await ig.account.login(username, password)
            // Save session
            const state = await ig.state.serialize()
            delete state.constants
            writeFileSync(this.options.sessionPath, JSON.stringify(state, null, 2))
        }

        const response = await ig.user.usernameinfo(username)
        const userData = await ig.user.info(response.pk)
        this.user = new ClientUser(this, {
            ...response,
            ...userData
        })
        this.cache.users.set(this.user.id, this.user)
        this.emit('debug', 'logged', this.user)

        // Load chats
        const threads = [
            ...await ig.feed.directInbox().items(),
            ...await ig.feed.directPending().items()
        ]
        threads.forEach((thread) => {
            const chat = new Chat(this, thread.thread_id, thread)
            this.cache.chats.set(thread.thread_id, chat)
            if (chat.pending) {
                this.cache.pendingChats.set(thread.thread_id, chat)
            }
        })

        // Setup realtime handlers
        ig.realtime.on('receive', (topic, messages) => this.handleRealtimeReceive(topic, messages))
        ig.realtime.on('error', (error) => {
            console.error('Realtime error:', error)
            this.emit('error', error)
            if (this.options.autoReconnect && this._retryCount < this.options.maxRetries) {
                this._attemptReconnect()
            }
        })
        ig.realtime.on('close', () => {
            console.error('RealtimeClient closed')
            this.emit('disconnect')
            if (this.options.autoReconnect && this._retryCount < this.options.maxRetries) {
                this._attemptReconnect()
            }
        })

        await ig.realtime.connect({
            autoReconnect: this.options.autoReconnect,
            irisData: await ig.feed.directInbox().request()
        })

        // Setup FBNS
        ig.fbns.push$.subscribe((data) => this.handleFbnsReceive(data))
        await ig.fbns.connect({
            autoReconnect: this.options.autoReconnect
        })

        this.ig = ig
        this.ready = true
        this._retryCount = 0
        this.emit('connected')
        
        // Replay events
        this.eventsToReplay.forEach((event) => {
            const eventType = event.shift()
            if (eventType === 'realtime') {
                this.handleRealtimeReceive(...event)
            } else if (eventType === 'fbns') {
                this.handleFbnsReceive(...event)
            }
        })
        this.eventsToReplay = []
    }

    /**
     * Attempt to reconnect
     * @private
     */
    async _attemptReconnect() {
        this._retryCount++
        const delay = Math.min(1000 * Math.pow(2, this._retryCount), 30000)
        
        setTimeout(async () => {
            try {
                await this.ig.realtime.connect({
                    autoReconnect: this.options.autoReconnect,
                    irisData: await this.ig.feed.directInbox().request()
                })
                this._retryCount = 0
                this.emit('reconnected')
            } catch (error) {
                console.error('Reconnect failed:', error)
                if (this._retryCount >= this.options.maxRetries) {
                    this.emit('maxRetriesReached')
                }
            }
        }, delay)
    }

    toJSON() {
        const json = {
            ready: this.ready,
            options: this.options,
            id: this.user?.id
        }
        return json
    }
}

export default Client;
