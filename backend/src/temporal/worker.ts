import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities.js';

async function runWorker() {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  try {
    const worker = await Worker.create({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
      taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'sundebt-sun-sessions',
      workflowsPath: fileURLToPath(new URL(
        import.meta.url.endsWith('.ts') ? './sun-session.workflow.ts' : './sun-session.workflow.js',
        import.meta.url,
      )),
      activities,
    });
    console.info(`SUNDEBT Temporal worker listening on ${process.env.TEMPORAL_TASK_QUEUE ?? 'sundebt-sun-sessions'}`);
    await worker.run();
  } finally {
    await connection.close();
  }
}

runWorker().catch(error => {
  console.error('SUNDEBT Temporal worker failed:', error);
  process.exitCode = 1;
});
