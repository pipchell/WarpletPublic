// Tiny JSON-file-backed store with the same shape as the Cloudflare KV calls
// used elsewhere in this project: get / put / delete / list.
// Whole file is kept in memory and rewritten atomically on every change —
// completely fine at personal-project scale (dozens to low-thousands of links).

import fs from 'node:fs';
import path from 'node:path';

export function createStore(filePath) {
  let data = {};

  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error('Could not parse', filePath, '— starting with an empty store. Original error:', err.message);
      data = {};
    }
  } else {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{}');
  }

  function persist() {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath); // atomic on POSIX filesystems
  }

  return {
    async get(code) {
      return Object.prototype.hasOwnProperty.call(data, code) ? data[code] : null;
    },
    async put(code, value) {
      data[code] = value;
      persist();
    },
    async delete(code) {
      delete data[code];
      persist();
    },
    async list() {
      return Object.keys(data);
    }
  };
}
