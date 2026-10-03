import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests never read the project's .env: no real API key, no real calls, no cost. The model is mocked per test.
    env: { ENV_FILE: 'no-env-file-in-tests', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
  },
});
