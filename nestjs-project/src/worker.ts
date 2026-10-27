import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

async function bootstrap() {
  // Standalone application context: no HTTP server, no port bound.
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  Logger.log('Video worker started (no HTTP listener)', 'Worker');
}
void bootstrap();
