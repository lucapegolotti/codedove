import { appendFileSync, readFileSync } from 'fs';
import { homedir } from 'os';
import chokidar from 'chokidar';
import { PROJECTS_PATH } from './src/session/history.js';

const ATTACHED = `${homedir()}/.claude-voice/attached`;
const sessionId = readFileSync(ATTACHED, 'utf8').split('\n')[0].trim();
const jsonlPath = `${PROJECTS_PATH}/-Users-luca-repositories-claude-voice/${sessionId}.jsonl`;

console.log('PROJECTS_PATH:', PROJECTS_PATH);
console.log('Watching directory...');

const watcher = chokidar.watch(PROJECTS_PATH, {
  persistent: false,
  ignoreInitial: true,
  depth: 2,
});

watcher.on('all', (event: string, path: string) => {
  console.log('chokidar event:', event, path.split('/').slice(-2).join('/'));
});

watcher.on('ready', () => {
  console.log('ready — appending blank line now');
  appendFileSync(jsonlPath, '\n');
  setTimeout(() => { watcher.close(); process.exit(0); }, 3000);
});

watcher.on('error', (e: unknown) => console.log('error:', e));
