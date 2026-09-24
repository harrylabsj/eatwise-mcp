import os from 'node:os';
import path from 'node:path';

export function localHistoryDatabasePath({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Chichulaide', 'history.sqlite3');
  if (platform === 'win32') return path.win32.join(env.LOCALAPPDATA || env.APPDATA || path.win32.join(home, 'AppData', 'Local'), 'Chichulaide', 'history.sqlite3');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'chichulaide', 'history.sqlite3');
}
