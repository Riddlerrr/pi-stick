// Imported first by the agent entry point: only protocol records may reach stdout.
export const writeProtocol = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
