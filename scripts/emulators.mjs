// Starts the Firebase emulator suite for the offline demo project.
// Imports previously exported data only when it exists (a bare --import with a
// missing directory makes the emulators exit).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = ['emulators:start', '--project', 'demo-asm'];
if (existsSync(new URL('../.emulator-data', import.meta.url))) {
  args.push('--import', '.emulator-data');
}
args.push('--export-on-exit', '.emulator-data');

const child = spawn('firebase', args, { stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (code) => process.exit(code ?? 0));
