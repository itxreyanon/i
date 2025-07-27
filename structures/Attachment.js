import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

/**
 * Represents a media attachment for Instagram messages
 */
export class Attachment {
  constructor(data) {
    /**
     * The attachment data (URL, file path, or Buffer)
     * @type {string|Buffer}
     */
    this.data = data;

    /**
     * The processed file buffer
     * @type {Buffer|null}
     */
    this.file = null;

    /**
     * The attachment type
     * @type {string|null}
     */
    this.type = null;

    /**
     * The file extension
     * @type {string|null}
     */
    this.extension = null;

    /**
     * File size in bytes
     * @type {number|null}
     */
    this.size = null;

    /**
     * Image dimensions (if applicable)
     * @type {Object|null}
     */
    this.dimensions = null;
  }

  /**
   * Verify and process the attachment
   * @returns {Promise<void>}
   */
  async _verify() {
    if (!this.data) {
      throw new Error('Cannot create empty attachment');
    }

    if (Buffer.isBuffer(this.data)) {
      return this._handleBuffer(this.data);
    }

    if (typeof this.data === 'string') {
      if (this._isURL(this.data)) {
        return this._handleURL(this.data);
      } else {
        return this._handleFile(this.data);
      }
    }

    throw new Error('Unsupported attachment type');
  }

  /**
   * Handle file path input
   * @param {string} filePath - Path to the file
   * @returns {Promise<void>}
   * @private
   */
  async _handleFile(filePath) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stats = fs.statSync(filePath);
    this.size = stats.size;
    this.extension = path.extname(filePath).toLowerCase();

    const fileBuffer = fs.readFileSync(filePath);
    
    // If it's already a JPEG, use as-is
    if (this.extension === '.jpg' || this.extension === '.jpeg') {
      this.file = fileBuffer;
      this.type = 'image';
      return;
    }

    return this._processImage(fileBuffer);
  }

  /**
   * Handle Buffer input
   * @param {Buffer} buffer - File buffer
   * @returns {Promise<void>}
   * @private
   */
  async _handleBuffer(buffer) {
    this.size = buffer.length;
    return this._processImage(buffer);
  }

  /**
   * Handle URL input
   * @param {string} url - File URL
   * @returns {Promise<void>}
   * @private
   */
  async _handleURL(url) {
    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }

      const buffer = await response.buffer();
      this.size = buffer.length;

      // Try to determine type from URL or content-type
      const contentType = response.headers.get('content-type');
      if (contentType?.startsWith('image/')) {
        this.type = 'image';
      } else if (contentType?.startsWith('video/')) {
        this.type = 'video';
      } else if (contentType?.startsWith('audio/')) {
        this.type = 'audio';
      }

      return this._processImage(buffer);
    } catch (error) {
      throw new Error(`Failed to download from URL: ${error.message}`);
    }
  }

  /**
   * Process image buffer (convert to JPEG if needed)
   * @param {Buffer} buffer - Image buffer
   * @returns {Promise<void>}
   * @private
   */
  async _processImage(buffer) {
    try {
      // Try to use jimp first (as in original insta.js)
      let Jimp;
      try {
        Jimp = (await import('jimp')).default;
        const image = await Jimp.read(buffer);
        
        this.dimensions = {
          width: image.getWidth(),
          height: image.getHeight()
        };
        
        this.file = await image.getBufferAsync(Jimp.MIME_JPEG);
        this.type = 'image';
        this.extension = '.jpg';
        return;
      } catch {
        // Try sharp as fallback
        try {
          const sharp = (await import('sharp')).default;
          const image = sharp(buffer);
          const metadata = await image.metadata();
          
          this.dimensions = {
            width: metadata.width,
            height: metadata.height
          };

          // Convert to JPEG
          this.file = await image.jpeg({ quality: 90 }).toBuffer();
          this.type = 'image';
          this.extension = '.jpg';
          return;
        } catch {
          // Neither jimp nor sharp available, use buffer as-is
          this.file = buffer;
          this.type = this._detectTypeFromBuffer(buffer);
        }
      }
    } catch (error) {
      // If image processing fails, assume it's not an image
      this.file = buffer;
      this.type = this._detectTypeFromBuffer(buffer);
    }
  }

  /**
   * Detect file type from buffer
   * @param {Buffer} buffer - File buffer
   * @returns {string}
   * @private
   */
  _detectTypeFromBuffer(buffer) {
    // Check magic numbers for common file types
    const header = buffer.toString('hex', 0, 8).toUpperCase();
    
    if (header.startsWith('FFD8FF')) return 'image'; // JPEG
    if (header.startsWith('89504E47')) return 'image'; // PNG
    if (header.startsWith('47494638')) return 'image'; // GIF
    if (header.startsWith('52494646')) return 'video'; // RIFF (WebP/AVI)
    if (header.startsWith('00000018') || header.startsWith('00000020')) return 'video'; // MP4
    if (header.startsWith('1A45DFA3')) return 'video'; // WebM
    if (header.startsWith('494433') || header.startsWith('FFFB')) return 'audio'; // MP3
    if (header.startsWith('4F676753')) return 'audio'; // OGG
    
    return 'unknown';
  }

  /**
   * Check if string is a URL
   * @param {string} str - String to check
   * @returns {boolean}
   * @private
   */
  _isURL(str) {
    try {
      new URL(str);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file info
   * @returns {Object}
   */
  getInfo() {
    return {
      type: this.type,
      extension: this.extension,
      size: this.size,
      dimensions: this.dimensions,
      hasFile: Boolean(this.file)
    };
  }

  /**
   * Save attachment to file
   * @param {string} filePath - Path to save file
   * @returns {Promise<void>}
   */
  async save(filePath) {
    if (!this.file) {
      throw new Error('No file data available. Call _verify() first.');
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, this.file);
  }

  /**
   * Get file size in human readable format
   * @returns {string}
   */
  getFormattedSize() {
    if (!this.size) return 'Unknown';

    const units = ['B', 'KB', 'MB', 'GB'];
    let size = this.size;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }

  /**
   * String representation
   * @returns {string}
   */
  toString() {
    return `Attachment(${this.type || 'unknown'}, ${this.getFormattedSize()})`;
  }

  /**
   * JSON representation
   * @returns {Object}
   */
  toJSON() {
    return {
      type: this.type,
      extension: this.extension,
      size: this.size,
      dimensions: this.dimensions,
      hasFile: Boolean(this.file)
    };
  }
}
export default Attachment;
