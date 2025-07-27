import { InstagramClient } from './client.js';
import { ModuleManager } from './module-manager.js';
import { MessageHandler } from './message-handler.js';
import { logger } from '../utils/utils.js';

export class InstagramBot {
  constructor() {
    /**
     * Enhanced Instagram client
     * @type {InstagramClient}
     */
    this.client = new InstagramClient();
    
    /**
     * Module manager for dynamic module loading
     * @type {ModuleManager}
     */
    this.moduleManager = new ModuleManager(this);
    
    /**
     * Message handler for processing incoming messages
     * @type {MessageHandler}
     */
    this.messageHandler = new MessageHandler(this, this.moduleManager);
    
    /**
     * Whether the bot is running
     * @type {boolean}
     */
    this.running = false;
    
    this._setupEventHandlers();
  }

  /**
   * Setup event handlers for the client
   * @private
   */
  _setupEventHandlers() {
    // Handle incoming messages
    this.client.on('messageCreate', (message) => {
      this.messageHandler.handleMessage(message);
    });

    // Handle client events
    this.client.on('ready', () => {
      logger.info('🚀 Instagram client ready');
    });

    this.client.on('disconnect', () => {
      logger.warn('🔌 Instagram client disconnected');
    });

    this.client.on('error', (error) => {
      logger.error('❌ Instagram client error:', error.message);
    });
  }

  /**
   * Login to Instagram
   * @param {string} username - Instagram username
   * @param {string} password - Instagram password
   * @returns {Promise<void>}
   */
  async login() {
    try {
      const username = process.env.INSTAGRAM_USERNAME;
      const password = process.env.INSTAGRAM_PASSWORD;

      logger.info('🔑 Starting Instagram bot login...');
      
      // Login to Instagram
      await this.client.login(username, password);
      
      // Load modules
      await this.moduleManager.init()
      
      this.running = true;
      logger.info('✅ Instagram bot is ready and running');

    } catch (error) {
      logger.error('❌ Failed to start bot:', error.message);
      throw error;
    }
  }

  /**
   * Send a message to a thread
   * @param {string} threadId - Thread ID
   * @param {string} text - Message text
   * @returns {Promise<Message>}
   */
  async sendMessage(threadId, text) {
    try {
      const chat = await this.client.fetchChat(threadId);
      return await chat.sendMessage(text);
    } catch (error) {
      logger.error('❌ Error sending message:', error.message);
      throw error;
    }
  }

  /**
   * Disconnect from Instagram
   * @returns {Promise<void>}
   */
  async disconnect() {
    logger.info('🔌 Disconnecting Instagram bot...');
    this.running = false;
    
    try {
      await this.moduleManager.cleanup();
      await this.client.disconnect();
      logger.info('✅ Bot disconnected successfully');
    } catch (error) {
      logger.warn('⚠️ Error during disconnect:', error.message);
    }
  }

  /**
   * Get bot statistics
   * @returns {Object}
   */
  getStats() {
    return {
      running: this.running,
      client: this.client.getStats(),
      modules: this.moduleManager.modules.length,
      commands: this.moduleManager.getAllCommands().size
    };
  }
}
