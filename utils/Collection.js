/**
 * Enhanced Collection class similar to Discord.js Collections
 * Provides powerful data manipulation methods for caching and data management
 */
export class Collection extends Map {
  constructor(entries) {
    super(entries);
  }

  /**
   * Get the first item in the collection
   * @returns {*} The first item or undefined
   */
  first() {
    return this.values().next().value;
  }

  /**
   * Get the last item in the collection
   * @returns {*} The last item or undefined
   */
  last() {
    const arr = Array.from(this.values());
    return arr[arr.length - 1];
  }

  /**
   * Get a random item from the collection
   * @returns {*} A random item or undefined
   */
  random() {
    const arr = Array.from(this.values());
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * Find an item in the collection
   * @param {Function} fn - Function to test items
   * @returns {*} The found item or undefined
   */
  find(fn) {
    for (const [key, val] of this) {
      if (fn(val, key, this)) return val;
    }
    return undefined;
  }

  /**
   * Filter items in the collection
   * @param {Function} fn - Function to test items
   * @returns {Collection} New filtered collection
   */
  filter(fn) {
    const results = new Collection();
    for (const [key, val] of this) {
      if (fn(val, key, this)) results.set(key, val);
    }
    return results;
  }

  /**
   * Map over the collection
   * @param {Function} fn - Function to map items
   * @returns {Array} Array of mapped results
   */
  map(fn) {
    const results = [];
    for (const [key, val] of this) {
      results.push(fn(val, key, this));
    }
    return results;
  }

  /**
   * Check if some items match the condition
   * @param {Function} fn - Function to test items
   * @returns {boolean} True if any item matches
   */
  some(fn) {
    for (const [key, val] of this) {
      if (fn(val, key, this)) return true;
    }
    return false;
  }

  /**
   * Check if all items match the condition
   * @param {Function} fn - Function to test items
   * @returns {boolean} True if all items match
   */
  every(fn) {
    for (const [key, val] of this) {
      if (!fn(val, key, this)) return false;
    }
    return true;
  }

  /**
   * Reduce the collection to a single value
   * @param {Function} fn - Reducer function
   * @param {*} initialValue - Initial value
   * @returns {*} Reduced value
   */
  reduce(fn, initialValue) {
    let accumulator = initialValue;
    for (const [key, val] of this) {
      accumulator = fn(accumulator, val, key, this);
    }
    return accumulator;
  }

  /**
   * Get an array of all values
   * @returns {Array} Array of values
   */
  array() {
    return Array.from(this.values());
  }

  /**
   * Get an array of all keys
   * @returns {Array} Array of keys
   */
  keyArray() {
    return Array.from(this.keys());
  }

  /**
   * Clone the collection
   * @returns {Collection} Cloned collection
   */
  clone() {
    return new Collection(this);
  }

  /**
   * Combine with another collection
   * @param {...Collection} collections - Collections to combine
   * @returns {Collection} Combined collection
   */
  concat(...collections) {
    const newColl = this.clone();
    for (const coll of collections) {
      for (const [key, val] of coll) {
        newColl.set(key, val);
      }
    }
    return newColl;
  }

  /**
   * Sort the collection
   * @param {Function} compareFunction - Compare function
   * @returns {Collection} Sorted collection
   */
  sort(compareFunction = (a, b) => a > b ? 1 : -1) {
    const entries = Array.from(this.entries());
    entries.sort((a, b) => compareFunction(a[1], b[1], a[0], b[0]));
    return new Collection(entries);
  }

  /**
   * Convert to JSON
   * @returns {Object} JSON representation
   */
  toJSON() {
    return Object.fromEntries(this);
  }
}