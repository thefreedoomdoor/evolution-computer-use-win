/**
 * 加密软件位置表的类型定义。
 *
 * 这里只放数据形状，不含任何 IO：写入/读取在 store.ts，扫描在 scan.ts，
 * 名称解析与合并去重（纯函数）在 library.ts。
 */

/** 一条软件记录。id 稳定（exe 小写路径的 sha1 前 16 位，或 appId / 名称派生）。 */
export interface AppEntry {
  id: string;
  name: string;
  exe?: string;
  args?: string;
  appId?: string;
  source: 'start-apps' | 'start-menu' | 'app-paths' | 'uninstall' | 'program-files';
  installDir?: string;
  aliases?: string[];
  lastSeen: string;
  exists: boolean;
}

/** 索引文件 <dataDir>/apps-index.enc 解密后的内容。 */
export interface AppIndex {
  version: 1;
  updatedAt: string;
  machine: string;
  scan: {
    mode: 'full' | 'incremental';
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    dirsScanned: number;
    exeFound: number;
    appEntries: number;
  };
  apps: AppEntry[];
  dirs: Record<string, { mtimeMs: number; scannedAt: string }>;
}

/** scanApps 的选项。除了稳定字段外，附带几个仅供测试/高级场景注入的可选字段。 */
export interface ScanOptions {
  dataDir: string;
  full?: boolean;
  log?: (text: string) => void;
  /** 测试/高级：替代运行 scripts/scan-apps.ps1，直接返回单个 JSON 对象文本（不传则真的运行脚本）。 */
  powershell?: () => string | Promise<string>;
  /** 测试/高级：覆盖 Program Files 根目录（默认 C:\Program Files、C:\Program Files (x86)、%LOCALAPPDATA%\Programs）。 */
  programRoots?: string[];
  /** 测试/高级：Program Files 扫描时间预算（毫秒），默认 12000。 */
  budgetMs?: number;
  /** 测试/高级：Program Files 收编的 exe 上限，默认 6000。 */
  maxExe?: number;
}
