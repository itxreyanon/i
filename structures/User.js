
import { Collection } from './Collection.js';

/**
 * Represents an Instagram user with enhanced functionality
 */
export class User {
  constructor(client, data) {
    /**
     * The client that instantiated this user
     * @type {Client}
     */
    this.client = client;

    /**
     * The user's ID
     * @type {string}
     */
    this.id = data.pk || data.id;

    /**
     * Collection of users that follow this user
     * @type {Collection<string, User>}
     */
    this.followers = new Collection();

    /**
     * Collection of users this user follows
     * @type {Collection<string, User>}
     */
    this.following = new Collection();

    this._patch(data);
  }

  /**
   * The private chat between the client and this user
   * @type {Chat|null}
   */
  get privateChat() {
    return this.client.cache.chats.find(chat => 
      chat.users.size === 1 && chat.users.first().id === this.id
    );
  }

  /**
   * Whether this user is the bot itself
   * @type {boolean}
   */
  get isBot() {
    return this.id === this.client.user?.id;
  }

  /**
   * Update user data
   * @param {Object} data - User data from Instagram API
   * @private
   */
  _patch(data) {
    /**
     * The user's username
     * @type {string}
     */
    this.username = data.username ?? this.username;

    /**
     * The user's full name
     * @type {string}
     */
    this.fullName = data.full_name ?? this.fullName;

    /**
     * Whether the user's account is private
     * @type {boolean}
     */
    this.isPrivate = data.is_private ?? this.isPrivate;

    /**
     * Whether the user is verified
     * @type {boolean}
     */
    this.isVerified = data.is_verified ?? this.isVerified;

    /**
     * Whether the user has a business account
     * @type {boolean}
     */
    this.isBusiness = data.is_business ?? this.isBusiness;

    /**
     * The user's profile picture URL
     * @type {string}
     */
    this.avatarURL = data.profile_pic_url ?? this.avatarURL;

    /**
     * The user's biography
     * @type {string|null}
     */
    this.biography = data.biography ?? this.biography;

    /**
     * Number of posts by the user
     * @type {number|null}
     */
    this.mediaCount = data.media_count ?? this.mediaCount;

    /**
     * Number of followers
     * @type {number|null}
     */
    this.followerCount = data.follower_count ?? this.followerCount;

    /**
     * Number of users this user follows
     * @type {number|null}
     */
    this.followingCount = data.following_count ?? this.followingCount;

    /**
     * Timestamp when user was last seen
     * @type {Date|null}
     */
    this.lastSeen = data.last_seen ? new Date(data.last_seen * 1000) : this.lastSeen;

    /**
     * Total IGTV videos count
     * @type {number|null}
     * @private
     */
    this._totalIgtvVideos = data.total_igtv_videos ?? this._totalIgtvVideos;
  }

  /**
   * Fetch fresh user data from Instagram
   * @param {boolean} force - Whether to force fetch even if cached
   * @returns {Promise<User>}
   */
  async fetch(force = false) {
    return await this.client.fetchUser(this.id, force);
  }

  /**
   * Get or create a private chat with this user
   * @returns {Promise<Chat>}
   */
  async createPrivateChat() {
    if (this.privateChat) return this.privateChat;
    return await this.client.createChat([this.id]);
  }

  /**
   * Send a message to this user
   * @param {string} content - Message content
   * @returns {Promise<Message>}
   */
  async send(content) {
    const chat = await this.createPrivateChat();
    return await chat.sendMessage(content);
  }

  /**
   * Send a photo to this user
   * @param {string|Buffer|Attachment} attachment - Photo to send
   * @returns {Promise<Message>}
   */
  async sendPhoto(attachment) {
    const chat = await this.createPrivateChat();
    return await chat.sendPhoto(attachment);
  }

  /**
   * Follow this user
   * @returns {Promise<void>}
   */
  async follow() {
    if (this.isBot) throw new Error('Cannot follow yourself');
    await this.client.ig.friendship.create(this.id);
  }

  /**
   * Unfollow this user
   * @returns {Promise<void>}
   */
  async unfollow() {
    if (this.isBot) throw new Error('Cannot unfollow yourself');
    await this.client.ig.friendship.destroy(this.id);
  }

  /**
   * Block this user
   * @returns {Promise<void>}
   */
  async block() {
    if (this.isBot) throw new Error('Cannot block yourself');
    await this.client.ig.friendship.block(this.id);
  }

  /**
   * Unblock this user
   * @returns {Promise<void>}
   */
  async unblock() {
    await this.client.ig.friendship.unblock(this.id);
  }

  /**
   * Approve follow request from this user
   * @returns {Promise<void>}
   */
  async approveFollow() {
    await this.client.ig.friendship.approve(this.id);
  }

  /**
   * Deny follow request from this user
   * @returns {Promise<void>}
   */
  async denyFollow() {
    await this.client.ig.friendship.deny(this.id);
  }

  /**
   * Remove this user from followers
   * @returns {Promise<void>}
   */
  async removeFollower() {
    await this.client.ig.friendship.removeFollower(this.id);
  }

  /**
   * Fetch users that follow this user
   * @returns {Promise<Collection<string, User>>}
   */
  async fetchFollowers() {
    const followers = await this.client.ig.feed.accountFollowers(this.id).items();
    this.followers.clear();
    
    for (const follower of followers) {
      const user = this.client._patchOrCreateUser(follower.pk, follower);
      this.followers.set(user.id, user);
    }
    
    return this.followers;
  }

  /**
   * Fetch users this user follows
   * @returns {Promise<Collection<string, User>>}
   */
  async fetchFollowing() {
    const following = await this.client.ig.feed.accountFollowing(this.id).items();
    this.following.clear();
    
    for (const user of following) {
      const userObj = this.client._patchOrCreateUser(user.pk, user);
      this.following.set(userObj.id, userObj);
    }
    
    return this.following;
  }

  /**
   * Check if this user follows another user
   * @param {string|User} user - User to check
   * @returns {Promise<boolean>}
   */
  async isFollowing(user) {
    const userId = typeof user === 'string' ? user : user.id;
    const friendship = await this.client.ig.friendship.show(userId);
    return friendship.following;
  }

  /**
   * Check if this user is followed by another user
   * @param {string|User} user - User to check
   * @returns {Promise<boolean>}
   */
  async isFollowedBy(user) {
    const userId = typeof user === 'string' ? user : user.id;
    const friendship = await this.client.ig.friendship.show(userId);
    return friendship.followed_by;
  }

  /**
   * Get display name (full name or username)
   * @returns {string}
   */
  get displayName() {
    return this.fullName || this.username;
  }

  /**
   * Get user mention string
   * @returns {string}
   */
  get mention() {
    return `@${this.username}`;
  }

  /**
   * The user's total IGTV videos count
   * @type {number|null}
   */
  get totalIgtvVideos() {
    return this._totalIgtvVideos;
  }

  /**
   * String representation
   * @returns {string}
   */
  toString() {
    return this.mention;
  }

  /**
   * JSON representation
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      username: this.username,
      fullName: this.fullName,
      isPrivate: this.isPrivate,
      isVerified: this.isVerified,
      isBusiness: this.isBusiness,
      avatarURL: this.avatarURL,
      biography: this.biography,
      mediaCount: this.mediaCount,
      followerCount: this.followerCount,
      followingCount: this.followingCount,
      lastSeen: this.lastSeen,
      totalIgtvVideos: this.totalIgtvVideos
    };
  }
}
export default User;
