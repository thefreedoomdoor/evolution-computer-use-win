/**
 * 软件位置表的“混淆加密”（防直接读取，不是高安全凭据库）。
 *
 * - AES-256-GCM：随机 12 字节 IV，16 字节认证标签；任何篡改都会在解密时被拒绝。
 * - 密钥用 scrypt 从 hostname + 用户名 + Windows MachineGuid 派生（固定域 salt，keylen 32）。
 * - MachineGuid 用 reg.exe 读取；失败退化到 hostname+用户名；全部失败也不抛。
 * - 文件头写魔数 + 版本，方便以后升级格式。
 * - 不引入任何第三方依赖。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname, userInfo } from 'node:os';

/** 文件魔数（8 字节 ASCII）。 */
const MAGIC = Buffer.from('EVAPPIDX', 'ascii');
/** 文件格式版本（写入文件头的第 9 个字节）。 */
export const FORMAT_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
/** 固定的域分隔 salt（不是机密，只用于把派生限制在本用途）。 */
const SALT = 'evolution-computer-use/apps-index/v1';

/** 读 Windows MachineGuid；非 Windows 或失败返回 null，绝不抛。 */
function machineGuid(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync(
      'reg.exe',
      ['QUERY', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const match = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/i.exec(out);
    return match && match[1] ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** hostname / 用户名 / MachineGuid 拼出的派生种子；每一步失败都退化为空串。 */
function identitySeed(): string {
  let host = '';
  let user = '';
  try { host = hostname(); } catch { host = ''; }
  try { user = userInfo().username; } catch { user = ''; }
  const guid = machineGuid();
  return guid ? `${host}\u0000${user}\u0000${guid}` : `${host}\u0000${user}`;
}

let cachedKey: Buffer | null = null;
/** 本进程内缓存的 32 字节密钥（scrypt 偏慢，避免每次读写都重算）。 */
function key(): Buffer {
  if (!cachedKey) cachedKey = scryptSync(identitySeed(), SALT, KEY_LENGTH);
  return cachedKey;
}

/** 仅供测试：清掉缓存的密钥（模拟换机器 / 换身份）。 */
export function resetKeyCache(): void {
  cachedKey = null;
}

/** 加密一段 UTF-8 文本，返回完整文件字节（魔数 + 版本 + IV + 标签 + 密文）。 */
export function encrypt(plaintext: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const version = Buffer.from([FORMAT_VERSION]);
  return Buffer.concat([MAGIC, version, iv, tag, ciphertext]);
}

/** 解密文件字节。任何格式/版本/认证失败都抛错，由调用方决定如何处理。 */
export function decrypt(file: Buffer): string {
  const headerLength = MAGIC.length + 1 + IV_LENGTH + TAG_LENGTH;
  if (file.length < headerLength) throw new Error('apps index file too short');
  if (!file.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an apps index file');
  const version = file[MAGIC.length];
  if (version !== FORMAT_VERSION) throw new Error(`unsupported apps index version ${version}`);
  const ivStart = MAGIC.length + 1;
  const iv = file.subarray(ivStart, ivStart + IV_LENGTH);
  const tag = file.subarray(ivStart + IV_LENGTH, ivStart + IV_LENGTH + TAG_LENGTH);
  const ciphertext = file.subarray(headerLength);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** 暴露魔数文本，供测试断言文件头。 */
export function magic(): Buffer {
  return Buffer.from(MAGIC);
}
