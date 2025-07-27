import { Collection } from './Collection.js';
import { MessageCollector } from './MessageCollector.js';

/**
 * Represents an Instagram chat/thread with enhanced functionality
 */
export class Chat {
  constructor(client, threadId, data) {
    /**
     * The client that instantiated this chat
     * @type {Client}
     */
    this.client = client;

    /**
     * The chat's ID
     * @type {string}
     */
    this.id = threadId;

    /**
     * Collection of messages in this chat
     * @type {Collection<string, Message>}
     */
    this.messages = new Collection();

    /**
     * Collection of users in this chat
     * @type {Collection<string, User>}
     */
    this.users = new Collection();

    /**
     * Collection of users who left this chat
     * @type {Collection<string, User>}
     */
    this.leftUsers = new Collection();

    /**
     * Whether the client is currently typing
     * @type {boolean}
     */
    this.typing = false;

    /**
     * Whether to disable typing on send
     * @type {boolean|null}
     * @private
     */
    this._disableTypingOnSend = null;

    /**
     * Typing timeout reference
     * @type {NodeJS.Timeout|null}
     * @private
     */
    this._stopTypingTimeout = null;

    /**
     * Keep typing alive interval
     * @type {NodeJS.Timeout|null}
     * @private
     */
    this._keepTypingAliveInterval = null;

    /**
     * Sent message promises for tracking
     * @type {Collection<string, Function>}
     * @private
     */
    this._sentMessagePromises = new Collection();

    this._patch(data);
  }

  /**
   * The Instagram thread entity
   * @type {Object}
   */
  get threadEntity() {
    return this.client.ig.entity.directThread(this.id);
  }

  /**
   * Whether this is a group chat
   * @type {boolean}
   */
  get isGroup() {
    return this.users.size > 1;
  }

  /**
   * Whether this is a direct message
   * @type {boolean}
   */
  get isDM() {
    return !this.isGroup;
  }

  /**
   * The other user in a DM (null for group chats)
   * @type {User|null}
   */
  get recipient() {
    if (this.isGroup) return null;
    return this.users.find(user => user.id !== this.client.user?.id);
  }

  /**
   * Update chat data
   * @param {Object} data - Chat data from Instagram API
   * @private
   */
  _patch(data) {
    if ('users' in data) {
      this.users.clear();
      for (const user of data.users) {
        const userObj = this.client._patchOrCreateUser(user.pk, user);
        this.users.set(userObj.id, userObj);
      }
    }

    if ('left_users' in data) {
      this.leftUsers.clear();
      for (const user of data.left_users) {
        const userObj = this.client._patchOrCreateUser(user.pk, user);
        this.leftUsers.set(userObj.id, userObj);
      }
    }

    if ('items' in data) {
      // Don't clear existing messages, just add new ones
      for (const item of data.items) {
        if (!this.messages.has(item.item_id)) {
          const message = this.client._createMessage(this.id, item);
          this.messages.set(message.id, message);
        }
      }
    }

    /**
     * Admin user IDs
     * @type {string[]}
     */
    this.adminUserIds = data.admin_user_ids ?? this.adminUserIds ?? [];

    /**
     * Last activity timestamp
     * @type {Date|null}
     */
    this.lastActivityAt = data.last_activity_at ? 
      new Date(data.last_activity_at / 1000) : this.lastActivityAt;

    /**
     * Whether the chat is muted
     * @type {boolean}
     */
    this.muted = data.muted ?? this.muted ?? false;

    /**
     * Whether the chat is pinned
     * @type {boolean}
     */
    this.pinned = data.is_pin ?? this.pinned ?? false;

    /**
     * Whether the chat has a custom name
     * @type {boolean}
     */
    this.named = data.named ?? this.named ?? false;

    /**
     * The chat's name/title
     * @type {string|null}
     */
    this.name = data.thread_title ?? this.name;

    /**
     * Whether the chat is pending approval
     * @type {boolean}
     */
    this.pending = data.pending ?? this.pending ?? false;

    /**
     * The chat type
     * @type {string}
     */
    this.type = data.thread_type ?? this.type ?? 'private';

    /**
     * Whether there's an ongoing call
     * @type {boolean}
     */
    this.calling = 'video_call_id' in data;
  }

  /**
   * Approve pending chat
   * @returns {Promise<void>}
   */
  async approve() {
    if (!this.pending) return;
    
    await this.client.ig.directThread.approve(this.id);
    this.pending = false;
    
    if (!this.client.cache.chats.has(this.id)) {
      this.client.cache.chats.set(this.id, this);
    }
    this.client.cache.pendingChats.delete(this.id);
  }

  /**
   * Send a text message
   * @param {string} content - Message content
   * @param {Object} options - Send options
   * @returns {Promise<Message>}
   */
  async sendMessage(content, options = {}) {
    return new Promise((resolve, reject) => {
      const urls = this._extractUrls(content);
      const promise = urls.length > 0 ? 
        this.threadEntity.broadcastText(content, urls) : 
        this.threadEntity.broadcastText(content);

      promise.then(({ item_id: itemId }) => {
        if (this.typing && this._disableTypingOnSend) {
          this._keepTypingAlive();
        }
        this._sentMessagePromises.set(itemId, resolve);
        
        // Check if message already exists
        if (this.messages.has(itemId)) {
          this._sentMessagePromises.delete(itemId);
          resolve(this.messages.get(itemId));
        }
      }).catch(reject);
    });
  }

  /**
   * Send a photo
   * @param {string|Buffer|Attachment} attachment - Photo to send
   * @returns {Promise<Message>}
   */
  async sendPhoto(attachment) {
    const { Attachment } = await import('./Attachment.js');
    
    if (!(attachment instanceof Attachment)) {
      attachment = new Attachment(attachment);
    }

    await attachment._verify();

    return new Promise((resolve, reject) => {
      this.threadEntity.broadcastPhoto({ file: attachment.file })
        .then(({ item_id: itemId }) => {
          if (this.typing && this._disableTypingOnSend) {
            this._keepTypingAlive();
          }
          this._sentMessagePromises.set(itemId, resolve);
          
          if (this.messages.has(itemId)) {
            this._sentMessagePromises.delete(itemId);
            resolve(this.messages.get(itemId));
          }
        })
        .catch(reject);
    });
  }

  /**
   * Send a voice message
   * @param {Buffer} buffer - Audio buffer (MP4 format)
   * @returns {Promise<Message>}
   */
  async sendVoice(buffer) {
    return new Promise((resolve, reject) => {
      this.threadEntity.broadcastVoice({ file: buffer })
        .then((upload) => {
          const itemId = upload.message_metadata[0].item_id;
          if (this.typing && this._disableTypingOnSend) {
            this._keepTypingAlive();
          }
          this._sentMessagePromises.set(itemId, resolve);
          
          if (this.messages.has(itemId)) {
            this._sentMessagePromises.delete(itemId);
            resolve(this.messages.get(itemId));
          }
        })
        .catch(reject);
    });
  }

  /**
   * Start typing indicator
   * @param {Object} options - Typing options
   * @param {number} options.duration - How long to type (ms)
   * @param {boolean} options.disableOnSend - Stop typing when sending message
   * @returns {Promise<void>}
   */
  async startTyping({ duration = 10000, disableOnSend = true } = {}) {
    if (this.typing) return;

    this.typing = true;
    await this.client.ig.realtime.direct.indicateActivity({
      threadId: this.id,
      isActive: true
    });

    this._disableTypingOnSend = disableOnSend;

    // Stop typing after duration
    this._stopTypingTimeout = setTimeout(() => this.stopTyping(), duration);

    // Keep typing alive
    this._keepTypingAliveInterval = setInterval(async () => {
      await this._keepTypingAlive();
    }, 9000);
  }

  /**
   * Keep typing alive (internal method)
   * @returns {Promise<void>}
   * @private
   */
  async _keepTypingAlive() {
    if (this.typing) {
      await this.client.ig.realtime.direct.indicateActivity({
        threadId: this.id,
        isActive: true
      });
    } else if (this._keepTypingAliveInterval) {
      clearInterval(this._keepTypingAliveInterval);
    }
  }

  /**
   * Stop typing indicator
   * @returns {Promise<void>}
   */
  async stopTyping() {
    if (!this.typing) return;

    this.typing = false;
    
    if (this._stopTypingTimeout) {
      clearTimeout(this._stopTypingTimeout);
      this._stopTypingTimeout = null;
    }

    if (this._keepTypingAliveInterval) {
      clearInterval(this._keepTypingAliveInterval);
      this._keepTypingAliveInterval = null;
    }

    await this.client.ig.realtime.direct.indicateActivity({
      threadId: this.id,
      isActive: false
    });
  }

  /**
   * Start typing indicator (legacy method name for compatibility)
   * @param {Object} options - Typing options
   * @returns {Promise<void>}
   * @deprecated Use startTyping instead
   */
  async startTyping_legacy({ duration, disableOnSend } = {}) {
    return this.startTyping({ duration, disableOnSend });
  }

  /**
   * Stop typing indicator (ensure compatibility)
   * @returns {Promise<void>}
   */
  async stopTyping_legacy() {
    return this.stopTyping();
  }

  /**
   * Keep typing alive method (for compatibility)
   * @returns {Promise<void>}
   * @private
   */
  async _keepTypingAlive_legacy() {
    return this._keepTypingAlive();
  }

  /**
   * Send a text message (legacy method for compatibility)
   * @param {string} content - Message content
   * @param {Object} options - Send options
   * @returns {Promise<Message>}
   * @deprecated Use sendMessage instead
   */
  async sendMessage_legacy(content, options) {
    return new Promise((resolve) => {
      const urls = this._extractUrls(content);
      const promise = urls.length >= 1 ? 
        this.threadEntity.broadcastText(content, Array.from(urls)) : 
        this.threadEntity.broadcastText(content);
      
      promise.then(({ item_id: itemId }) => {
        if (this.typing && !this._disableTypingOnSend) this._keepTypingAlive();
        this._sentMessagePromises.set(itemId, resolve);
        if (this.messages.has(itemId)) {
          this._sentMessagePromises.delete(itemId);
          resolve(this.messages.get(itemId));
        }
      });
    });
  }

  /**
   * Send a photo (legacy method for compatibility)
   * @param {string|Buffer|Attachment} attachment - Photo to send
   * @returns {Promise<Message>}
   * @deprecated Use sendPhoto instead
   */
  async sendPhoto_legacy(attachment) {
    const { Attachment } = await import('./Attachment.js');
    
    if (!(attachment instanceof Attachment)) {
      attachment = new Attachment(attachment);
    }
    
    return new Promise((resolve) => {
      attachment._verify().then(() => {
        this.threadEntity.broadcastPhoto({ file: attachment.file }).then(({ item_id: itemId }) => {
          if (this.typing && !this._disableTypingOnSend) this._keepTypingAlive();
          this._sentMessagePromises.set(itemId, resolve);
          if (this.messages.has(itemId)) {
            this._sentMessagePromises.delete(itemId);
            resolve(this.messages.get(itemId));
          }
        });
      });
    });
  }

  /**
   * Send a voice message (legacy method for compatibility)
   * @param {Buffer} buffer - Audio buffer (MP4 format)
   * @returns {Promise<Message>}
   * @deprecated Use sendVoice instead
   */
  async sendVoice_legacy(buffer) {
    return new Promise((resolve) => {
      this.threadEntity.broadcastVoice({ file: buffer }).then((upload) => {
        const itemId = upload.message_metadata[0].item_id;
        if (this.typing && !this._disableTypingOnSend) this._keepTypingAlive();
        this._sentMessagePromises.set(itemId, resolve);
        if (this.messages.has(itemId)) {
          this._sentMessagePromises.delete(itemId);
          resolve(this.messages.get(itemId));
        }
      });
    });
  }

  /**
   * Mark a message as seen
   * @param {string} messageId - Message ID to mark as seen
   * @returns {Promise<void>}
   */
  async markMessageSeen(messageId) {
    await this.threadEntity.markItemSeen(messageId);
  }

  /**
   * Delete a message
   * @param {string} messageId - Message ID to delete
   * @returns {Promise<void>}
   */
  async deleteMessage(messageId) {
    await this.threadEntity.deleteItem(messageId);
    this.messages.delete(messageId);
  }

  /**
   * Create a message collector
   * @param {Object} options - Collector options
   * @returns {MessageCollector}
   */
  createMessageCollector(options) {
    return new MessageCollector(this, options);
  }

  /**
   * Add user to group chat
   * @param {string|User} user - User to add
   * @returns {Promise<void>}
   */
  async addUser(user) {
    const userId = typeof user === 'string' ? user : user.id;
    await this.threadEntity.addUser(userId);
  }

  /**
   * Remove user from group chat
   * @param {string|User} user - User to remove
   * @returns {Promise<void>}
   */
  async removeUser(user) {
    const userId = typeof user === 'string' ? user : user.id;
    await this.threadEntity.removeUser(userId);
  }

  /**
   * Change chat name
   * @param {string} name - New chat name
   * @returns {Promise<void>}
   */
  async setName(name) {
    await this.threadEntity.updateTitle(name);
    this.name = name;
    this.named = true;
  }

  /**
   * Leave the chat
   * @returns {Promise<void>}
   */
  async leave() {
    await this.threadEntity.leave();
  }

  /**
   * Extract URLs from text
   * @param {string} text - Text to extract URLs from
   * @returns {string[]}
   * @private
   */
  _extractUrls(text) {
    try {
      // Use get-urls if available, otherwise fallback to regex
      const getUrls = require('get-urls');
      return Array.from(getUrls(text));
    } catch {
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      return text.match(urlRegex) || [];
    }
  }

  /**
   * Handle sent message promise resolution
   * @param {string} messageId - Message ID
   * @param {Message} message - Message object
   * @private
   */
  _resolveSentMessage(messageId, message) {
    const resolve = this._sentMessagePromises.get(messageId);
    if (resolve) {
      this._sentMessagePromises.delete(messageId);
      resolve(message);
    }
  }

  /**
   * String representation
   * @returns {string}
   */
  toString() {
    return this.name || `Chat ${this.id}`;
  }

  /**
   * JSON representation
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      name: this.name,
      isGroup: this.isGroup,
      pending: this.pending,
      muted: this.muted,
      pinned: this.pinned,
      calling: this.calling,
      userCount: this.users.size,
      messageCount: this.messages.size,
      lastActivityAt: this.lastActivityAt
    };
  }
}
export default Chat;
