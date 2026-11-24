/**
 * 索引文件 <dataDir>/apps-index.enc 的读写。
 *
 * - saveIndex：加密后原子写（临时文件 + fsync + rename），文件权限 0600。
 * - loadIndex：缺失返回 null；解密/解析失败把坏文件改名 .corrupt-<ts> 并返回 null，绝不让启动失败。
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppIndex } from './types.ts';
import { decrypt, encrypt } from './crypto.ts';

const INDEX_FILE = 'apps-index.enc';
const renameAttempts = 10;
const transientRename = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 索引文件路径：<dataDir>/apps-index.enc。 */
export function indexFile(dataDir: string): string {
  return join(dataDir, INDEX_FILE);
}

/** 原子写二进制文件，权限 0600；Windows 上 rename 被短暂占用时重试。 */
function atomicWrite(file: string, data: Buffer): void {
  const temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        renameSync(temporary, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (attempt >= renameAttempts || !transientRename.has(code)) throw error;
        sleepSync(Math.min(100, 10 * 2 ** (attempt - 1)));
      }
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  try { chmodSync(file, 0o600); } catch { /* Windows 上 chmod 语义有限，忽略 */ }
}

/** 校验解密出来的对象看起来像 AppIndex。 */
function isAppIndex(value: unknown): value is AppIndex {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.version === 1 && Array.isArray(v.apps) && typeof v.dirs === 'object' && v.dirs !== null;
}

/**
 * 读取索引。文件缺失返回 null。解密失败（换机器、被篡改、版本不符）或 JSON/形状不对时：
 * 把坏文件改名 <file>.corrupt-<ts>，返回 null，绝不抛出。
 */
export function loadIndex(dataDir: string): AppIndex | null {
  const file = indexFile(dataDir);
  if (!existsSync(file)) return null;
  let raw: Buffer;
  try {
    raw = readFileSync(file);
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(decrypt(raw));
    if (!isAppIndex(parsed)) throw new Error('apps index has an unexpected shape');
    return parsed;
  } catch {
    quarantine(file);
    return null;
  }
}

/** 把坏文件挪到一边，保留现场；改名/删除都失败也只是放弃这个文件。 */
function quarantine(file: string): void {
  const target = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, target);
  } catch {
    try { rmSync(file, { force: true }); } catch { /* 放弃 */ }
  }
}

/** 加密并原子写入索引（目录自动创建，文件权限 0600）。 */
export function saveIndex(dataDir: string, index: AppIndex): void {
  atomicWrite(indexFile(dataDir), encrypt(JSON.stringify(index)));
}
