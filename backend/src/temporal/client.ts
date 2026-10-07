import { Client, Connection } from '@temporalio/client';

let connectionPromise: Promise<Connection> | undefined;

export async function getTemporalClient(): Promise<Client> {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  connectionPromise ??= Connection.connect({
    address,
    connectTimeout: '3 seconds',
  }).catch(error => {
    connectionPromise = undefined;
    throw error;
  });

  const connection = await connectionPromise;
  return new Client({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  });
}

export function getTaskQueue(): string {
  return process.env.TEMPORAL_TASK_QUEUE ?? 'sundebt-sun-sessions';
}
