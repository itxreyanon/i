import { EventEmitter } from 'events';
import { Collection } from './Collection.js';

/**
 * Collects messages in a chat based on filters and conditions
 * @extends {EventEmitter}
 */
export class MessageCollector extends EventEmitter {
  constructor(chat, options = {}) {
    super();

    /**
     * The client that instantiated this collector
     * @type {Client}
     */
    this.client = chat.client;

    /**
     * The chat to collect messages from
     * @type {Chat}
     */
    this.chat = chat;

    /**
     * Filter function for messages
     * @type {Function}
     */
    this.filter = options.filter || (() => true);

    /**
     * Maximum number of messages to collect
     * @type {number|null}
     */
    this.max = options.max || null;

    /**
     * Maximum time to collect messages (ms)
     * @type {number|null}
     */
    this.time = options.time || null;

    /**
     * Idle time before stopping collection (ms)
     * @type {number|null}
     */
    this.idle = options.idle || null;

    /**
     * Whether to dispose of the collector after ending
     * @type {boolean}
     */
    this.dispose = options.dispose !== false;

    /**
     * Collected messages
     * @type {Collection<string, Message>}
     */
    this.collected = new Collection();


    /**
     * Whether the collector has ended
     * @type {boolean}
     */
    this.ended = false;

    /**
     * Timeout references
     * @type {Object}
     * @private
     */
    this._timeouts = {
      time: null,
      idle: null
    };

    this._handleMessage = this._handleMessage.bind(this);
    this.client.on('messageCreate', this._handleMessage);

    // Set up timeouts
    if (this.time) {
      this._timeouts.time = setTimeout(() => this.stop('time'), this.time);
    }

    if (this.idle) {
      this._resetIdleTimeout();
    }
  }

  /**
   * Handle incoming messages
   * @param {Message} message - The message to handle
   * @private
   */
  async _handleMessage(message) {
    if (this.ended) return;
    if (message.chatId !== this.chat.id) return;

    try {
      const passed = await this.filter(message);
      if (!passed) return;

      this.collected.set(message.id, message);
      this.emit('collect', message);

      // Reset idle timeout
      if (this.idle) {
        this._resetIdleTimeout();
      }

      // Check if we've reached the maximum
      if (this.max && this.collected.size >= this.max) {
        this.stop('limit');
      }

    } catch (error) {
      this.emit('error', error);
    }
  }

  /**
   * Reset the idle timeout
   * @private
   */
  _resetIdleTimeout() {
    if (this._timeouts.idle) {
      clearTimeout(this._timeouts.idle);
    }
    
    this._timeouts.idle = setTimeout(() => this.stop('idle'), this.idle);
  }

  /**
   * Stop the collector
   * @param {string} reason - Reason for stopping
   */
  stop(reason = 'user') {
    if (this.ended) return;

    this.ended = true;

    // Clear timeouts
    for (const timeout of Object.values(this._timeouts)) {
      if (timeout) clearTimeout(timeout);
    }

    // Remove event listener
    this.client.removeListener('messageCreate', this._handleMessage);

    this.emit('end', this.collected, reason);

    // Dispose if requested
    if (this.dispose) {
      this.removeAllListeners();
    }
  }

  /**
   * Get the next message that passes the filter
   * @param {Object} options - Options for awaiting
   * @param {number} options.time - Time to wait (ms)
   * @param {Function} options.filter - Additional filter
   * @returns {Promise<Message>}
   */
  async awaitMessage(options = {}) {
    return new Promise((resolve, reject) => {
      const timeout = options.time ? setTimeout(() => {
        reject(new Error('Time limit exceeded'));
      }, options.time) : null;

      const filter = options.filter || (() => true);

      const onCollect = (message) => {
        if (filter(message)) {
          if (timeout) clearTimeout(timeout);
          this.removeListener('collect', onCollect);
          this.removeListener('end', onEnd);
          resolve(message);
        }
      };

      const onEnd = () => {
        if (timeout) clearTimeout(timeout);
        this.removeListener('collect', onCollect);
        this.removeListener('end', onEnd);
        reject(new Error('Collector ended'));
      };

      this.on('collect', onCollect);
      this.on('end', onEnd);
    });
  }

  /**
   * Get the first collected message
   * @returns {Message|null}
   */
  first() {
    return this.collected.first();
  }

  /**
   * Get the last collected message
   * @returns {Message|null}
   */
  last() {
    return this.collected.last();
  }

  /**
   * Get a random collected message
   * @returns {Message|null}
   */
  random() {
    return this.collected.random();
  }

  /**
   * Find a message in the collection
   * @param {Function} fn - Function to test messages
   * @returns {Message|undefined}
   */
  find(fn) {
    return this.collected.find(fn);
  }

  /**
   * Filter messages in the collection
   * @param {Function} fn - Function to test messages
   * @returns {Collection<string, Message>}
   */
  filter(fn) {
    return this.collected.filter(fn);
  }

  /**
   * Map over collected messages
   * @param {Function} fn - Function to map messages
   * @returns {Array}
   */
  map(fn) {
    return this.collected.map(fn);
  }

  /**
   * Get collected messages as array
   * @returns {Message[]}
   */
  array() {
    return this.collected.array();
  }

  /**
   * JSON representation
   * @returns {Object}
   */
  toJSON() {
    return {
      chatId: this.chat.id,
      collected: this.collected.size,
      ended: this.ended,
      max: this.max,
      time: this.time,
      idle: this.idle
    };
  }
}
export default MessageCollector;

/**
 * Emitted when a message is collected
 * @event MessageCollector#collect
 * @param {Message} message - The collected message
 */

/**
 * Emitted when the collector ends
 * @event MessageCollector#end
 * @param {Collection<string, Message>} collected - All collected messages
 * @param {string} reason - Reason for ending
 */

/**
 * Emitted when an error occurs
 * @event MessageCollector#error
 * @param {Error} error - The error that occurred
 */
