
export function printHelp(cmd: string, helpText: string): void {
  console.log(`\nUsage: bun run ${cmd}\n${helpText}`);
}
