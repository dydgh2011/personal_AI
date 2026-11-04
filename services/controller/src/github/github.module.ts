import { Logger, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { GitHubClient } from './github-client.js';
import { AnonymousCredentials, TokenFileCredentials, type GitHubCredentials } from './github-credentials.js';

/** Overridable in tests to inject a fake fetch. */
export const GITHUB_FETCH = Symbol('GITHUB_FETCH');

@Module({
  providers: [
    { provide: GITHUB_FETCH, useValue: fetch },
    {
      provide: GitHubClient,
      inject: [APP_CONFIG, GITHUB_FETCH],
      useFactory: (config: AppConfig, fetchImpl: typeof fetch) => {
        const credentials: GitHubCredentials = config.github.tokenFile
          ? new TokenFileCredentials(config.github.tokenFile)
          : new AnonymousCredentials();
        new Logger('GitHub').log(
          credentials.mode === 'none'
            ? 'No GitHub credentials configured: public repositories only'
            : `GitHub credentials: ${credentials.mode}`,
        );
        return new GitHubClient({
          baseUrl: config.github.apiUrl,
          credentials,
          fetchImpl,
          maxRateLimitWaitMs: 5_000,
          maxPages: 10,
        });
      },
    },
  ],
  exports: [GitHubClient],
})
export class GitHubModule {}
