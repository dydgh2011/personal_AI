import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { openDatabase } from './sqlite-database.js';

export const SQLITE_CONNECTION = Symbol('SQLITE_CONNECTION');

@Global()
@Module({
  providers: [
    {
      provide: SQLITE_CONNECTION,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => openDatabase(config.databasePath),
    },
  ],
  exports: [SQLITE_CONNECTION],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database) {}

  onApplicationShutdown(): void {
    if (this.db.open) {
      this.db.close();
    }
  }
}
