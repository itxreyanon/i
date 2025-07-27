import { InstagramBot } from './core/bot.js';
import { logger } from './utils/utils.js';
import { config } from './config.js';

console.clear();

class HyperInsta {
  constructor() {
    this.startTime = new Date();
    this.instagramBot = new InstagramBot();
  }

  async initialize() {
    try {
      this.showStartupBanner();

      console.log('📱 Connecting to Instagram...');
console.log('🔍 Config loaded:', config.instagram);

      const username = process.env.INSTAGRAM_USERNAME || config.instagram.username;
      const password = process.env.INSTAGRAM_PASSWORD || config.instagram.password;

      if (!username || !password) {
        throw new Error('Instagram credentials not provided');
      }

      // ✅ Login first
      await this.instagramBot.login(username, password);

      // ✅ Then show status
      this.showLiveStatus();

    } catch (error) {
      console.error(`❌ Startup failed: ${error.stack || error.message}`);
      process.exit(1);
    }
  }

  showStartupBanner() {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║    🚀 HYPER INSTA - INITIALIZING                           ║
║                                                              ║
║    ⚡ Ultra Fast • 🔌 Modular • 🛡️ Robust                  ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
  }

  showLiveStatus() {
    const uptime = Date.now() - this.startTime;
    const stats = this.instagramBot.getStats() || { modules: 0, commands: 0 };

    console.clear();
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║    🚀 HYPER INSTA - LIVE & OPERATIONAL                     ║
║                                                              ║
║    ✅ Instagram: Connected & Active                         ║
║    📦 Modules: ${stats.modules} loaded                                      ║
║    ⚡ Commands: ${stats.commands} available                              ║
║    ⚡ Startup Time: ${Math.round(uptime)}ms                                  ║
║    🕒 Started: ${this.startTime.toLocaleTimeString()}                                ║
║                                                              ║
║    🎯 Ready for INSTANT commands...                        ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

🔥 Bot is running at MAXIMUM PERFORMANCE!
💡 Type .help in Instagram to see all commands
    `);
  }

  async start() {
    await this.initialize();

    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down gracefully...');
      await this.instagramBot.disconnect();
      console.log('✅ Hyper Insta stopped');
      process.exit(0);
    });
  }
}

const bot = new HyperInsta();
bot.start().catch(console.error);
