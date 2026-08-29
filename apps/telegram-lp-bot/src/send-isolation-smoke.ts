import './load-env.js';
import { pathToFileURL } from 'node:url';
import { sendFuniMessage } from './telegram-sender.js';

export async function main() {
  const result = await sendFuniMessage(
    'FUNI_TELEGRAM_ISOLATION_SMOKE',
    'telegram_isolation_smoke',
  );
  if (!result.delivered) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
